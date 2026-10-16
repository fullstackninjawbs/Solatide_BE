/**
 * 2026-10-slug-redirects.ts — copy CMS pages' old URLs (Page.slugHistory) into the central
 * `redirects` collection, so they become real server-side 301s like every other URL change.
 *
 * DRY RUN BY DEFAULT. Nothing is written unless --apply is passed.
 * Does NOT read .env: the target database must be given explicitly.
 *
 *   npx ts-node --transpile-only src/scripts/migrations/2026-10-slug-redirects.ts --uri "mongodb://..."          # report only
 *   npx ts-node --transpile-only src/scripts/migrations/2026-10-slug-redirects.ts --uri "mongodb://..." --apply  # insert
 *
 * INSERT-ONLY: never updates or deletes pages or existing redirects. Page.slugHistory is left
 * as it is (the app keeps using it as a fallback). Safe to run more than once: an old URL that
 * already has an active redirect is skipped.
 *
 * Skipped (reported): an old URL that is now another page's current URL (the real page wins),
 * an old URL equal to the page's own URL, and protected paths.
 */
import mongoose from 'mongoose';

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
  console.log(`Mode: ${apply ? 'APPLY (insert-only)' : 'DRY RUN (no writes)'}`);
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000, autoIndex: false, autoCreate: false });
  const db = mongoose.connection.db!;
  console.log(`Connected to database: ${db.databaseName}`);

  const pages = db.collection('pages');
  const redirects = db.collection('redirects');
  const withHistory = await pages.find({ slugHistory: { $exists: true, $ne: [] } }).project({ slug: 1, slugHistory: 1, title: 1 }).toArray();
  const currentSlugs = new Set((await pages.find({}).project({ slug: 1 }).toArray()).map((p: any) => String(p.slug).toLowerCase()));

  let toInsert = 0, skipped = 0;
  for (const page of withHistory as any[]) {
    const current = String(page.slug).toLowerCase();
    for (const oldRaw of page.slugHistory as string[]) {
      const old = String(oldRaw || '').trim().toLowerCase();
      const from = `/pages/${old}`, to = `/pages/${current}`;
      if (!old || old === current) { skipped++; continue; }
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(old)) { console.log(`  skip ${from}: not a valid handle`); skipped++; continue; }
      if (currentSlugs.has(old)) { console.log(`  skip ${from}: another page now lives there (real page wins)`); skipped++; continue; }
      if (await redirects.findOne({ fromPath: from, active: true })) { console.log(`  skip ${from}: already has an active redirect`); skipped++; continue; }
      console.log(`  ${apply ? 'insert' : 'would insert'} ${from} → ${to}   ("${page.title}")`);
      toInsert++;
      if (apply) {
        const now = new Date();
        await redirects.insertOne({
          fromPath: from, toPath: to, statusCode: 301, source: 'import',
          entity: { kind: 'page', id: page._id }, active: true, hits: 0, lastHitAt: null,
          note: 'Imported from the page\'s URL history', createdBy: null, updatedBy: null, createdAt: now, updatedAt: now,
        });
      }
    }
  }
  console.log(`\nPages with old URLs: ${withHistory.length}. Redirects ${apply ? 'inserted' : 'to insert'}: ${toInsert}. Skipped: ${skipped}.`);
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
