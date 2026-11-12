/**
 * 2026-11-fix-defunct-shipping-packages.ts
 *
 * Finds product variants whose `shippingPackage` points to a package that is inactive or no longer
 * exists (e.g. Bacteriostatic Water → legacy package 6a858369c1c4bbc2ff5d19b9). "Create shipping
 * label" then falls back to the Default package and shows the warning
 * '"…" uses a shipping package that is inactive or no longer exists'.
 * Points those variants at a valid package: --to <packageId>, or the active Default package.
 *
 * Safe to run on a live store:
 *  - DRY RUN unless --apply (lists what would change, writes nothing)
 *  - only `variants.$[v].shippingPackage` is set (array filter on the variant's own _id and its
 *    old package), so stock, prices and everything else on the product are never rewritten —
 *    an order placed at the same moment keeps its stock change
 *  - deletes nothing
 *
 * Usage (from Server/):
 *   npx ts-node --transpile-only src/scripts/migrations/2026-11-fix-defunct-shipping-packages.ts
 *   npx ts-node --transpile-only src/scripts/migrations/2026-11-fix-defunct-shipping-packages.ts --to <packageId>
 *   npx ts-node --transpile-only src/scripts/migrations/2026-11-fix-defunct-shipping-packages.ts --to <packageId> --apply
 *   (--uri "<mongodb uri>" to use another database than MONGO_URI in .env)
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const uri = arg('--uri') || process.env.MONGO_URI;
  const apply = process.argv.includes('--apply');
  const toId = arg('--to');
  if (!uri) {
    console.error('Refusing to run: pass --uri <mongodb uri> or set MONGO_URI in .env');
    process.exit(2);
  }
  if (toId && !/^[0-9a-fA-F]{24}$/.test(toId)) {
    console.error('--to must be a shipping package id (24 hex characters)');
    process.exit(2);
  }

  console.log(`Mode: ${apply ? 'APPLY (writing to database)' : 'DRY RUN (no writes)'}`);
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000, autoIndex: false, autoCreate: false });
  const db = mongoose.connection.db!;
  console.log(`Connected to database: ${db.databaseName}\n`);

  const packages = db.collection('shippingpackages');
  const products = db.collection('products');

  const activePackages = await packages.find({ active: true }).toArray();
  console.log('Active shipping packages:');
  for (const p of activePackages) console.log(`  ${p._id}  ${p.name}${p.isDefault ? '  (Default)' : ''}`);
  console.log('');

  const target = toId
    ? activePackages.find((p) => String(p._id) === toId)
    : activePackages.find((p) => p.isDefault);
  if (!target) {
    console.error(toId ? `Package ${toId} is not an active shipping package.` : 'No active Default package. Pass --to <packageId>.');
    await mongoose.disconnect();
    process.exit(1);
  }
  console.log(`Target package: "${target.name}" (${target._id})\n`);

  const activeIds = new Set(activePackages.map((p) => String(p._id)));
  const list = await products.find({ 'variants.shippingPackage': { $exists: true, $ne: null } })
    .project({ name: 1, variants: { _id: 1, sku: 1, title: 1, shippingPackage: 1 } }).toArray();

  let variantsFound = 0;
  let variantsUpdated = 0;
  for (const prod of list) {
    for (const v of (prod.variants || []) as any[]) {
      if (!v?.shippingPackage || activeIds.has(String(v.shippingPackage))) continue;
      variantsFound++;
      console.log(`"${prod.name}" ${v.title ? `/ ${v.title} ` : ''}(${v.sku || 'no SKU'}): package ${v.shippingPackage} is inactive/missing → "${target.name}"`);
      if (!apply) continue;
      // Only this variant, and only if it still has the old package (nothing else is rewritten)
      const r = await products.updateOne(
        { _id: prod._id },
        { $set: { 'variants.$[v].shippingPackage': target._id } },
        { arrayFilters: [{ 'v._id': v._id, 'v.shippingPackage': v.shippingPackage }] },
      );
      variantsUpdated += r.modifiedCount;
    }
  }

  console.log(apply
    ? `\nDone: ${variantsUpdated} of ${variantsFound} variant(s) updated.`
    : `\nDry run: ${variantsFound} variant(s) would be updated. Re-run with --apply to change them.`);
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('Migration failed:', err);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
