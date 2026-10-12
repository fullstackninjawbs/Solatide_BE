/**
 * 2026-10-payment-indexes.ts — data clean-up required before the new
 * payment/DB unique indexes can build (audit H-7, M-15, H-6).
 *
 * DRY RUN BY DEFAULT. Nothing is written unless --apply is passed.
 * Does NOT read .env: the target database must be given explicitly.
 *
 *   npx ts-node --transpile-only src/scripts/migrations/2026-10-payment-indexes.ts --uri "mongodb://..."          # report only
 *   npx ts-node --transpile-only src/scripts/migrations/2026-10-payment-indexes.ts --uri "mongodb://..." --apply  # perform
 *
 * Take a backup (mongodump) before --apply.
 *
 * NON-DESTRUCTIVE: this script never deletes documents, never drops collections or
 * indexes, and never creates TTL (auto-expiry) indexes. It only $set-updates placeholder
 * values and reports anything that needs a manual decision. The existing
 * `tagadaPaymentId_1` index is left in place; the new partial unique index
 * `tagadaPaymentId_unique_str` coexists with it (verified on MongoDB 7).
 *
 * Steps
 *  1. orders.tagadaPaymentId: 'unknown' / '' / 'null' / 'undefined' → null
 *  2. orders.tagadaPaymentId: report duplicate real values (blocks the unique index; resolve manually)
 *  3. refunds.tagadaRefundId: '' / 'unknown' → null; report duplicates
 *  4. customers.email: lowercase + trim where no collision; report collisions (merge manually)
 */
import mongoose from 'mongoose';

const BAD_IDS = ['unknown', 'UNKNOWN', 'Unknown', '', 'null', 'undefined'];

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const uri = arg('--uri') || process.env.MIGRATION_MONGO_URI;
  const apply = process.argv.includes('--apply');
  if (!uri) {
    console.error('Refusing to run: pass --uri <mongodb uri> (or MIGRATION_MONGO_URI). .env is intentionally not read.');
    process.exit(2);
  }
  console.log(`Mode: ${apply ? 'APPLY (updates only — nothing is deleted or dropped)' : 'DRY RUN (no writes)'}`);
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000, autoIndex: false, autoCreate: false });
  const db = mongoose.connection.db!;
  console.log(`Connected to database: ${db.databaseName}`);

  const orders = db.collection('orders');
  const refunds = db.collection('refunds');
  const customers = db.collection('customers');

  // 1
  const badPay = await orders.countDocuments({ tagadaPaymentId: { $in: BAD_IDS } });
  console.log(`[1] orders with placeholder tagadaPaymentId: ${badPay}`);
  if (apply && badPay) {
    const r = await orders.updateMany({ tagadaPaymentId: { $in: BAD_IDS } }, { $set: { tagadaPaymentId: null } });
    console.log(`    → set to null: ${r.modifiedCount}`);
  }

  // 2
  const dupPay = await orders.aggregate([
    { $match: { tagadaPaymentId: { $type: 'string', $nin: BAD_IDS } } },
    { $group: { _id: '$tagadaPaymentId', n: { $sum: 1 }, ids: { $push: '$_id' } } },
    { $match: { n: { $gt: 1 } } },
  ]).toArray();
  console.log(`[2] duplicate tagadaPaymentId values: ${dupPay.length}`);
  for (const d of dupPay.slice(0, 50)) console.log(`    ${d._id}: orders ${d.ids.join(', ')}`);
  if (dupPay.length) console.log('    !! Resolve these manually before the unique index can build.');

  // 3
  const badRef = await refunds.countDocuments({ tagadaRefundId: { $in: BAD_IDS } });
  console.log(`[3] refunds with placeholder tagadaRefundId: ${badRef}`);
  if (apply && badRef) {
    const r = await refunds.updateMany({ tagadaRefundId: { $in: BAD_IDS } }, { $set: { tagadaRefundId: null } });
    console.log(`    → set to null: ${r.modifiedCount}`);
  }
  const dupRef = await refunds.aggregate([
    { $match: { tagadaRefundId: { $type: 'string', $nin: BAD_IDS } } },
    { $group: { _id: '$tagadaRefundId', n: { $sum: 1 }, ids: { $push: '$_id' } } },
    { $match: { n: { $gt: 1 } } },
  ]).toArray();
  console.log(`    duplicate tagadaRefundId values: ${dupRef.length}`);
  for (const d of dupRef.slice(0, 50)) console.log(`    ${d._id}: refunds ${d.ids.join(', ')}`);

  // 4
  const mixed = await customers.find({ email: { $regex: /[A-Z]|^\s|\s$/ } }, { projection: { email: 1 } }).toArray();
  let fixed = 0;
  let collisions = 0;
  console.log(`[4] customers with non-normalised email: ${mixed.length}`);
  for (const c of mixed) {
    const norm = String(c.email).trim().toLowerCase();
    const clash = await customers.findOne({ email: norm, _id: { $ne: c._id } }, { projection: { _id: 1 } });
    if (clash) {
      collisions++;
      console.log(`    collision: ${c._id} "${c.email}" vs ${clash._id} — merge manually`);
    } else if (apply) {
      await customers.updateOne({ _id: c._id }, { $set: { email: norm } });
      fixed++;
    }
  }
  console.log(`    ${apply ? `lowercased: ${fixed}, ` : ''}collisions: ${collisions}`);

  console.log('\nNote: orders paid before this release have no paidAt, so onOrderPaid never re-runs their side effects (no duplicate emails).');
  console.log(apply ? 'Done.' : 'Dry run complete — re-run with --apply to make these changes.');
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('Migration failed:', err?.message ?? err);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
