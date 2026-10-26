/**
 * bankTransfer.ts — our own checkout with bank transfer / PayID (no card processor).
 *
 * - Australian shipping address → PayID and/or Bank Transfer; any other country → International
 *   Bank Transfer. The method is checked on the server against the shipping country.
 * - Payment details are configured in Admin → Settings → Bank transfer & PayID
 *   (PaymentSettings.bankTransfer). Empty fields fall back to these env variables, so a fresh
 *   install can be configured from .env:
 *     BANK_TRANSFER_ACCOUNT_NAME, BANK_TRANSFER_BANK_NAME, BANK_TRANSFER_BSB,
 *     BANK_TRANSFER_ACCOUNT_NUMBER, BANK_TRANSFER_PAYID, BANK_TRANSFER_SWIFT
 * - Prices are AUD incl. GST; no separate GST/tax amount is stored or shown.
 * - Payment details are only ever returned for an order the caller holds the access token for.
 */
import PaymentSettings from '../../models/PaymentSettings';

export const BANK_METHODS = ['payid', 'bank_transfer', 'international_bank_transfer'] as const;
export type BankMethod = (typeof BANK_METHODS)[number];
export const isBankMethod = (m: unknown): m is BankMethod => typeof m === 'string' && (BANK_METHODS as readonly string[]).includes(m);

export const METHOD_LABELS: Record<BankMethod, string> = {
  payid: 'PayID',
  bank_transfer: 'Bank Transfer',
  international_bank_transfer: 'International Bank Transfer',
};

/** Customer-facing label for a payment method (falls back to the raw value). */
export const methodLabel = (m: unknown): string => (isBankMethod(m) ? METHOD_LABELS[m as BankMethod] : String(m ?? ''));

export const AU_STATES = ['ACT', 'NSW', 'NT', 'QLD', 'SA', 'TAS', 'VIC', 'WA'];

export interface BankTransferSettings {
  enabled: boolean;
  accountName: string;
  bankName: string;
  bsb: string;
  accountNumber: string;
  payId: string;
  swiftBic: string;
  shippingFeeAU: number;
  shippingFeeInternational: number;
  freeShippingThresholdAU: number;
  internationalEnabled: boolean;
  unpaidCancelDays: number;
  notifyAdminOnOrder: boolean;
}

const envStr = (k: string): string => (process.env[k] || '').trim();
const num = (v: unknown, d = 0): number => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : d);

export async function getBankTransferSettings(): Promise<BankTransferSettings> {
  const doc: any = await PaymentSettings.findOne().select('bankTransfer').lean();
  const b = doc?.bankTransfer || {};
  const pick = (v: unknown, env: string) => (typeof v === 'string' && v.trim() ? v.trim() : envStr(env));
  return {
    enabled: b.enabled === true,
    accountName: pick(b.accountName, 'BANK_TRANSFER_ACCOUNT_NAME'),
    bankName: pick(b.bankName, 'BANK_TRANSFER_BANK_NAME'),
    bsb: pick(b.bsb, 'BANK_TRANSFER_BSB'),
    accountNumber: pick(b.accountNumber, 'BANK_TRANSFER_ACCOUNT_NUMBER'),
    payId: pick(b.payId, 'BANK_TRANSFER_PAYID'),
    swiftBic: pick(b.swiftBic, 'BANK_TRANSFER_SWIFT'),
    shippingFeeAU: num(b.shippingFeeAU),
    shippingFeeInternational: num(b.shippingFeeInternational),
    freeShippingThresholdAU: num(b.freeShippingThresholdAU),
    internationalEnabled: b.internationalEnabled !== false,
    unpaidCancelDays: Math.min(60, Math.max(1, Math.floor(num(b.unpaidCancelDays, 3)) || 3)),
    notifyAdminOnOrder: b.notifyAdminOnOrder !== false,
  };
}

/** Which methods a country may use, given what is configured. */
export function methodsForCountry(country: string, s: BankTransferSettings): BankMethod[] {
  const hasBank = !!(s.accountName && s.bsb && s.accountNumber);
  if (String(country).toUpperCase() === 'AU') {
    const m: BankMethod[] = [];
    if (s.payId && s.accountName) m.push('payid');
    if (hasBank) m.push('bank_transfer');
    return m;
  }
  return s.internationalEnabled && hasBank && s.swiftBic ? ['international_bank_transfer'] : [];
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function shippingFor(country: string, subtotal: number, s: BankTransferSettings): { amount: number; name: string } {
  if (String(country).toUpperCase() === 'AU') {
    const free = s.freeShippingThresholdAU > 0 && subtotal >= s.freeShippingThresholdAU;
    return { amount: free ? 0 : round2(s.shippingFeeAU), name: free ? 'Free shipping' : 'Standard shipping' };
  }
  return { amount: round2(s.shippingFeeInternational), name: 'International shipping' };
}

/** Public checkout settings for the storefront (never the payment details). */
export function publicCheckoutConfig(s: BankTransferSettings) {
  const au = methodsForCountry('AU', s);
  const intl = methodsForCountry('ZZ', s);
  const enabled = s.enabled && (au.length > 0 || intl.length > 0);
  return {
    mode: enabled ? 'bank_transfer' : 'tagada',
    currency: 'AUD',
    methods: { AU: au, international: intl },
    shipping: { AU: round2(s.shippingFeeAU), international: round2(s.shippingFeeInternational), freeThresholdAU: round2(s.freeShippingThresholdAU) },
  };
}

export interface PaymentInstructions {
  method: BankMethod;
  label: string;
  fields: Array<{ key: string; label: string; value: string; copy: boolean }>;
  notes: string[];
}

/** The details for ONE method (the order's), with the order's amount and reference. */
export function instructionsFor(method: BankMethod, s: BankTransferSettings, order: { orderNumber: string; grandTotal: number }): PaymentInstructions {
  const amount = `$${Number(order.grandTotal || 0).toFixed(2)} AUD`;
  const ref = String(order.orderNumber);
  const f = (key: string, label: string, value: string, copy: boolean) => ({ key, label, value, copy });
  if (method === 'payid') {
    return {
      method, label: 'Pay with PayID — Australia Only',
      fields: [
        f('payId', 'PayID', s.payId, true),
        f('accountName', 'Account Name', s.accountName, false),
        f('amount', 'Amount', amount, true),
        f('reference', 'Reference', ref, true),
      ],
      notes: [],
    };
  }
  if (method === 'bank_transfer') {
    return {
      method, label: 'Pay by Bank Transfer — Australia Only',
      fields: [
        f('bankName', 'Bank', s.bankName, false),
        f('accountName', 'Account Name', s.accountName, false),
        f('bsb', 'BSB', s.bsb, true),
        f('accountNumber', 'Account Number', s.accountNumber, true),
        f('amount', 'Amount', amount, true),
        f('reference', 'Reference', ref, true),
      ].filter((x) => x.value),
      notes: [],
    };
  }
  return {
    method, label: 'Pay by International Bank Transfer',
    fields: [
      f('bankName', 'Bank', s.bankName, false),
      f('accountName', 'Account Name', s.accountName, false),
      f('bsb', 'BSB', s.bsb, false),
      f('accountNumber', 'Account Number', s.accountNumber, true),
      f('swiftBic', 'SWIFT / BIC', s.swiftBic, true),
      f('currency', 'Currency', 'AUD', false),
      f('amount', 'Amount', amount, true),
      f('reference', 'Reference', ref, true),
    ].filter((x) => x.value),
    notes: [
      "Please send the payment in Australian Dollars (AUD). The full order total must be received. Any international bank or currency-conversion fees are the customer's responsibility.",
    ],
  };
}

export const ORDER_NUMBER_ONLY_WARNING = [
  'Use only the order number shown above as your payment reference.',
  'Do not enter “peptides”, product names, item descriptions or any other wording in the payment reference or description field.',
  'Your order will be cancelled if anything other than your order number is used as the payment reference.',
];

// ─── Input validation (storefront checkout form) ────────────────────────────

export class CheckoutInputError extends Error { statusCode = 400; }

const clean = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');

export interface CheckoutCustomer { email: string; firstName: string; lastName: string; phone: string }
export interface CheckoutAddress { street1: string; street2: string; city: string; state: string; zip: string; country: string; company: string }

export function validateCheckoutInput(body: any): { customer: CheckoutCustomer; address: CheckoutAddress; method: BankMethod } {
  const c = body?.customer || {};
  const a = body?.shippingAddress || {};
  const customer: CheckoutCustomer = {
    email: clean(c.email, 254).toLowerCase(),
    firstName: clean(c.firstName, 60),
    lastName: clean(c.lastName, 60),
    phone: clean(c.phone, 30),
  };
  const address: CheckoutAddress = {
    street1: clean(a.street1, 120),
    street2: clean(a.street2, 120),
    city: clean(a.city, 80),
    state: clean(a.state, 80),
    zip: clean(a.zip, 20),
    country: clean(a.country, 2).toUpperCase(),
    company: clean(a.company, 120),
  };
  const errors: string[] = [];
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(customer.email)) errors.push('a valid email address');
  if (!customer.firstName) errors.push('first name');
  if (!customer.lastName) errors.push('last name');
  if (!/^\+?[0-9 ()-]{6,30}$/.test(customer.phone) || customer.phone.replace(/\D/g, '').length < 6) errors.push('a valid phone number');
  if (!/^[A-Z]{2}$/.test(address.country)) errors.push('country');
  if (!address.street1) errors.push('street address');
  if (!address.city) errors.push(address.country === 'AU' ? 'suburb / city' : 'city');
  if (address.country === 'AU') {
    if (!AU_STATES.includes(address.state.toUpperCase())) errors.push('state');
    else address.state = address.state.toUpperCase();
    if (!/^\d{4}$/.test(address.zip)) errors.push('a 4-digit postcode');
  } else if (!address.zip) {
    errors.push('postal code');
  }
  if (errors.length) throw new CheckoutInputError(`Please enter ${errors.join(', ')}.`);
  const method = body?.paymentMethod;
  if (!isBankMethod(method)) throw new CheckoutInputError('Please choose a payment method.');
  return { customer, address, method };
}
