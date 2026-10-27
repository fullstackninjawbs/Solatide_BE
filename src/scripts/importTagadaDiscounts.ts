import fs from 'fs';
import path from 'path';
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import Discount from '../models/Discount';
import Product from '../models/product.model';
import { cleanRules, type Rule } from '../domain/discountEngine';
import { escapeRegExp } from '../domain/escapeRegExp';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

/**
 * importTagadaDiscounts.ts — one-time copy of the Tagada promotions (codes, limits, dates, rules,
 * action) into the hub's Discounts, so they keep working at our own checkout.
 *
 * DRY RUN BY DEFAULT. Nothing is written unless --commit is passed.
 *
 *   npx ts-node --transpile-only src/scripts/importTagadaDiscounts.ts                 # fetch + preview
 *   npx ts-node --transpile-only src/scripts/importTagadaDiscounts.ts --commit        # fetch + write
 *   options: --from-file=tagada-discounts-raw.json  (use the saved Tagada data, no API call)
 *            --uri=mongodb://...                    (default: MONGO_URI from .env)
 *            --allow-partial                         (also import promotions with a rule that could not be read)
 *
 * Every run saves what Tagada returned to tagada-discounts-raw.json (codes and settings only, no
 * keys) so the preview can be checked and the import re-run without Tagada.
 *
 * Safe to re-run: a code that already exists in the hub is updated (rules, limits, dates, value),
 * never duplicated, and its usage count never goes down.
 */

type Json = Record<string, any>;
const RAW_FILE = 'tagada-discounts-raw.json';

const arg = (name: string) => process.argv.slice(2).find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
const argValue = (name: string) => arg(name)?.split('=').slice(1).join('=') || '';

const asList = (data: any, keys: string[]): Json[] => {
  if (Array.isArray(data)) return data;
  for (const k of keys) if (Array.isArray(data?.[k])) return data[k];
  return [];
};
/** First present value among several possible field names (Tagada's payload is untyped). */
const pick = (o: Json | undefined, keys: string[]): any => {
  if (!o) return undefined;
  for (const k of keys) if (o[k] !== undefined && o[k] !== null && o[k] !== '') return o[k];
  return undefined;
};
const norm = (s: unknown) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
const num = (v: unknown) => (v === undefined || v === null || v === '' ? undefined : Number(v));
const date = (v: unknown) => {
  if (!v) return null;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
};

async function fetchFromTagada(): Promise<{ promotions: Json[]; codes: Json[] }> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { getTagadaClient } = require('../services/tagadaClient');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const config = require('../config').default;
  const storeId = config.tagadaStoreId;
  if (!storeId) throw new Error('TAGADA_STORE_ID is not configured.');
  const client: any = await getTagadaClient();
  const list = asList(await client.promotions.list({ storeId }), ['items', 'data', 'promotions']);
  const codes = asList(await client.promotionCodes.list({ storeId }), ['items', 'data', 'promotionCodes']);
  // The list may leave out rules/actions: read each promotion in full
  const promotions: Json[] = [];
  for (const p of list) {
    try {
      promotions.push({ ...p, ...(await client.promotions.retrieve(p.id, storeId)) });
    } catch {
      promotions.push(p);
    }
  }
  return { promotions, codes };
}

interface Mapped {
  code: string;
  tagadaPromotionId?: string;
  tagadaPromotionCodeId?: string;
  data?: Json;
  issues: string[];
  preview: string[];
}

/** Our product ids for Tagada product / variant ids (or our own ids). */
async function productIdsFor(refs: unknown[], issues: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const ref of refs) {
    const id = typeof ref === 'object' && ref ? pick(ref as Json, ['productId', 'id', '_id', 'variantId']) : ref;
    const s = String(id || '');
    if (!s) continue;
    const p: any = await Product.findOne({
      $or: [
        ...(/^[0-9a-fA-F]{24}$/.test(s) ? [{ _id: s }] : []),
        { tagadaProductId: s },
        { tagadaVariantId: s },
        { 'variants.tagadaVariantId': s },
      ],
    }).select('_id name').lean();
    if (p) out.push(String(p._id));
    else issues.push(`product "${s}" not found in the hub`);
  }
  return [...new Set(out)];
}

async function mapRule(r: Json, issues: string[]): Promise<Rule | null> {
  const t = norm(pick(r, ['type', 'ruleType', 'kind', 'name']));
  const body: Json = { ...r, ...(typeof r.config === 'object' ? r.config : {}), ...(typeof r.params === 'object' ? r.params : {}), ...(typeof r.value === 'object' && r.value ? r.value : {}) };
  const qty = num(pick(body, ['minimumQuantity', 'minQuantity', 'maximumQuantity', 'maxQuantity', 'quantity', 'value']));
  const amt = num(pick(body, ['minimumAmount', 'minAmount', 'maximumAmount', 'maxAmount', 'amount', 'total', 'value']));
  const listOf = (keys: string[]) => { const v = pick(body, keys); return Array.isArray(v) ? v : []; };
  const excluded = listOf(['excludedProducts', 'excludedProductIds', 'excludeProductIds', 'excludedProductsIds', 'excludedVariantIds']);
  const included = listOf(['products', 'productIds', 'variantIds', 'requiredProducts', 'includedProducts']);

  if (t.includes('minimumquantity') || t.includes('minquantity')) {
    if (t.includes('cart') || !t.includes('product')) return { type: 'cart_min_quantity', quantity: qty, products: await productIdsFor(excluded, issues) };
  }
  if (t.includes('maximumquantity') || t.includes('maxquantity')) {
    if (t.includes('product')) return { type: 'max_product_quantity', quantity: qty };
    issues.push('rule "cart maximum quantity" is not supported in the hub');
    return null;
  }
  if ((t.includes('total') || t.includes('subtotal') || t.includes('amount')) && (t.includes('min'))) return { type: 'cart_total_min', amount: amt };
  if ((t.includes('total') || t.includes('subtotal') || t.includes('amount')) && (t.includes('max'))) return { type: 'cart_total_max', amount: amt };
  if (t.includes('contains')) return { type: 'cart_contains_product', products: await productIdsFor(included, issues) };
  if (t.includes('excluded') || t.includes('exclude')) return { type: 'excluded_products', products: await productIdsFor(included.length ? included : excluded, issues) };
  issues.push(`rule "${pick(r, ['type', 'ruleType', 'kind', 'name']) || JSON.stringify(r).slice(0, 60)}" is not supported in the hub`);
  return null;
}

async function mapPromotion(p: Json, codeObj: Json | undefined): Promise<Mapped> {
  const issues: string[] = [];
  const code = String(pick(codeObj, ['code']) || pick(p, ['code']) || '').trim();
  const m: Mapped = { code, tagadaPromotionId: p.id, tagadaPromotionCodeId: codeObj?.id, issues, preview: [] };
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(code)) {
    issues.push(`no usable promotion code (name: ${p.name || p.id})`);
    return m;
  }

  // Action: order discount, percentage or fixed amount
  const actions = asList(p.actions, []);
  const action: Json = actions.find((a) => /order/.test(norm(pick(a, ['type', 'actionType', 'kind'])))) || actions[0] || p;
  const aBody: Json = { ...action, ...(typeof action.config === 'object' ? action.config : {}), ...(typeof action.params === 'object' ? action.params : {}) };
  const dtype = norm(pick(aBody, ['discountType', 'valueType', 'amountType', 'type']));
  const type = dtype.includes('percent') ? 'percent' : dtype.includes('fixed') || dtype.includes('amount') ? 'fixed' : undefined;
  const value = num(pick(aBody, ['discountValue', 'percentage', 'percent', 'value', 'amount']));
  if (!type || value === undefined || !Number.isFinite(value)) issues.push('could not read the discount (percentage / fixed amount)');
  if (actions.length > 1) issues.push(`${actions.length} actions in Tagada; only the order discount is imported`);

  // Limits and dates
  const usageLimit = num(pick(p, ['usageLimit', 'maxUses', 'maxRedemptions', 'redemptionLimit', 'limit'])) ?? num(pick(codeObj, ['usageLimit', 'maxUses', 'maxRedemptions']));
  const onePer = pick(p, ['limitOnePerCustomer', 'oncePerCustomer', 'onePerCustomer', 'limitToOneUsePerCustomer', 'perCustomer']) ?? pick(codeObj, ['oncePerCustomer', 'limitOnePerCustomer']);
  const activeFrom = date(pick(p, ['startDate', 'startsAt', 'startAt', 'activeFrom', 'validFrom']));
  const activeTo = date(pick(p, ['endDate', 'endsAt', 'endAt', 'activeTo', 'validUntil', 'expiresAt']));
  const match = norm(pick(p, ['ruleMatchingMode', 'ruleMatchMode', 'rulesOperator', 'conditionOperator', 'matchMode', 'operator']));
  const used = Number(pick(codeObj, ['timesUsed', 'usageCount', 'redemptions']) ?? pick(p, ['timesUsed', 'usageCount']) ?? 0) || 0;
  const active = (codeObj ? codeObj.active !== false : true) && (pick(p, ['enabled', 'active']) ?? true) !== false;

  const rawRules = asList(pick(p, ['rules', 'conditions']), []);
  const rules: Rule[] = [];
  for (const r of rawRules) {
    const mapped = await mapRule(r, issues);
    if (mapped) rules.push(mapped);
  }
  const cleaned = cleanRules(rules);
  if (cleaned.errors.length) issues.push(...cleaned.errors);

  m.data = {
    code,
    type,
    value,
    maxUses: usageLimit && usageLimit > 0 ? Math.floor(usageLimit) : 0,
    perCustomerLimit: onePer === true || onePer === 'true' || Number(onePer) === 1 ? 1 : 0,
    activeFrom,
    activeTo,
    ruleMatch: match.includes('or') || match.includes('any') ? 'any' : 'all',
    rules: cleaned.rules,
    status: active ? 'active' : 'disabled',
    usesSoFar: used,
    minPurchase: 0,
    minQuantity: 0,
    tagadaPromotionId: p.id,
    tagadaPromotionCodeId: codeObj?.id,
  };
  const fmtDate = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : '—');
  m.preview.push(
    `${type === 'percent' ? `${value}% off` : `$${value} off`} · uses ${used}/${m.data.maxUses || '∞'}${m.data.perCustomerLimit ? ' · one per customer' : ''} · ${fmtDate(activeFrom)} → ${fmtDate(activeTo)} · ${active ? 'active' : 'disabled'}`,
    ...cleaned.rules.map((r) => `  rule (${m.data!.ruleMatch}): ${r.type}${r.quantity != null ? ` qty=${r.quantity}` : ''}${r.amount != null ? ` amount=$${r.amount}` : ''}${r.products?.length ? ` products=${r.products.length}` : ''}`)
  );
  if (value !== undefined && type === 'fixed' && value >= 1000) issues.push(`fixed amount ${value} looks like cents — check it`);
  return m;
}

async function main() {
  const commit = !!arg('commit');
  const allowPartial = !!arg('allow-partial');
  const fromFile = argValue('from-file');
  const mongoUri = argValue('uri') || process.env.MONGO_URI || '';
  if (!mongoUri) throw new Error('MONGO_URI is not set (or pass --uri=...)');

  await mongoose.connect(mongoUri);
  const { host, name: dbName } = mongoose.connection;
  console.log(`\n${commit ? 'COMMIT' : 'DRY RUN (nothing is written)'} — database ${dbName} on ${host}\n`);

  let raw: { promotions: Json[]; codes: Json[] };
  if (fromFile) {
    raw = JSON.parse(fs.readFileSync(path.resolve(fromFile), 'utf8'));
    console.log(`Using saved Tagada data from ${fromFile}`);
  } else {
    raw = await fetchFromTagada();
    fs.writeFileSync(path.resolve(RAW_FILE), JSON.stringify(raw, null, 2));
    console.log(`Saved what Tagada returned to ${RAW_FILE} (${raw.promotions.length} promotions, ${raw.codes.length} codes)`);
  }

  const results: Mapped[] = [];
  for (const p of raw.promotions) {
    const promoCodes = raw.codes.filter((c) => c.promotionId === p.id);
    if (!promoCodes.length) results.push(await mapPromotion(p, undefined));
    for (const c of promoCodes) results.push(await mapPromotion(p, c));
  }

  let created = 0, updated = 0, skipped = 0;
  for (const m of results) {
    const blocking = m.issues.filter((i) => !/only the order discount|looks like cents/.test(i));
    const ok = m.data && m.data.type && m.data.value !== undefined && (allowPartial || !blocking.length);
    const existing: any = m.code ? await Discount.findOne({ code: { $regex: `^${escapeRegExp(m.code, 64)}$`, $options: 'i' } }).lean() : null;
    console.log(`${ok ? (existing ? 'UPDATE' : 'CREATE') : 'SKIP  '} ${m.code || '(no code)'}`);
    for (const line of m.preview) console.log(`        ${line}`);
    for (const i of m.issues) console.log(`        ! ${i}`);
    if (!ok) { skipped++; continue; }
    if (!commit) { if (existing) updated++; else created++; continue; }
    const { usesSoFar, ...fields } = m.data!;
    if (existing) {
      await Discount.updateOne({ _id: existing._id }, { $set: fields, $max: { usesSoFar } });
      updated++;
    } else {
      await Discount.create({ ...fields, code: m.code, usesSoFar });
      created++;
    }
  }

  console.log(`\n${commit ? 'Done' : 'Would do'}: ${created} created, ${updated} updated, ${skipped} skipped${commit ? '' : ' — run again with --commit to write'}.`);
  if (skipped) console.log('Skipped codes can be created by hand in Admin → Discounts (or re-run with --allow-partial).');
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('Import failed:', err?.message || err);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
