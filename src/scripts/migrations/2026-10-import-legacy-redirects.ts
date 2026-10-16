/**
 * 2026-10-import-legacy-redirects.ts — move the hard-coded legacy redirects (exact
 * `location = /old { return 301 /new; }` rules in the storefront nginx config, and the
 * `<Navigate>` routes in Client/src/routes/AppRoutes.jsx) into the central `redirects`
 * collection, so they are managed in Admin → Content → Redirects (hits, edit, disable).
 *
 * DRY RUN BY DEFAULT. Nothing is written unless --apply is passed.
 * Does NOT read .env: the target database must be given explicitly.
 *
 *   npx ts-node --transpile-only src/scripts/migrations/2026-10-import-legacy-redirects.ts --uri "mongodb://..."          # report only
 *   npx ts-node --transpile-only src/scripts/migrations/2026-10-import-legacy-redirects.ts --uri "mongodb://..." --apply  # insert
 *
 * INSERT-ONLY: never updates or deletes anything. Safe to run more than once (an old URL that
 * already has an active redirect is skipped). The nginx rules and <Navigate> routes are NOT
 * touched — they keep working (and win) until removed separately after verification.
 *
 * NOT imported (they stay in nginx): /index.html, /index.php, /home.html, /cart (real files /
 * system routes), /admin* (hub host), the regex rules (/product/:x, /collections/x/products/:y,
 * trailing slash) and the 410 rules (/_t/, *.atom, /74918658214/orders/).
 *
 * Snapshot taken 16 Oct 2026 from the live nginx config and AppRoutes.jsx. Where the two
 * disagreed, the more specific target was chosen (noted below).
 */
import mongoose from 'mongoose';

type Origin = 'nginx' | 'app' | 'nginx+app';
const LEGACY: Array<{ from: string; to: string; origin: Origin; note?: string }> = [
  // Legacy product URLs
  { from: '/products/kpv-10mg-lyophilised-peptide', to: '/products/kpv-10mg', origin: 'nginx+app' },
  { from: '/products/mots-c-10mg-lyophilised-peptide', to: '/products/mots-c-10mg', origin: 'nginx+app' },
  { from: '/products/ss-31-elamipretide-10mg-lyophilised-peptide', to: '/products/ss-31-elamipretide-10mg', origin: 'nginx+app' },
  { from: '/products/selank-semax-20mg', to: '/products/selank-10mg', origin: 'nginx+app' },
  { from: '/products/semaglutide-5mg-lyophilised-peptide', to: '/products/semaglutide-5mg', origin: 'nginx+app' },
  { from: '/products/semaglutide-10mg-lyophilised-peptide', to: '/products/semaglutide-10mg', origin: 'nginx+app' },
  { from: '/products/retatrutide-5mg-lyophilised-peptide', to: '/products/retatrutide-5mg', origin: 'nginx+app' },
  { from: '/products/retatrutide-10mg-lyophilised-peptide', to: '/products/retatrutide-10mg', origin: 'nginx+app' },
  // Legacy pages & policies
  { from: '/contact', to: '/pages/contact-us', origin: 'nginx+app' },
  { from: '/coa', to: '/pages/coa', origin: 'nginx+app' },
  { from: '/privacy-policy', to: '/pages/privacy-policy', origin: 'nginx+app' },
  { from: '/policies/shipping-policy', to: '/pages/shipping-policy', origin: 'nginx+app' },
  { from: '/policies/refund-policy', to: '/pages/refund-policy', origin: 'nginx+app' },
  { from: '/policies/privacy-policy', to: '/pages/privacy-policy', origin: 'nginx+app' },
  { from: '/policies/terms-of-service', to: '/pages/terms-of-services', origin: 'nginx+app' },
  { from: '/pages/data-sharing-opt-out-1', to: '/pages/data-sharing-opt-out', origin: 'nginx+app' },
  { from: '/pages/terms', to: '/pages/terms-of-services', origin: 'nginx+app' },
  // Former SPA-only routes
  { from: '/shop', to: '/collections/all', origin: 'nginx+app' },
  { from: '/faq', to: '/pages/faq', origin: 'nginx+app' },
  { from: '/faqs', to: '/pages/faq', origin: 'nginx' },
  { from: '/pages/faqs', to: '/pages/faq', origin: 'nginx' },
  { from: '/researchpage', to: '/pages/research-library', origin: 'nginx+app' },
  { from: '/research-insight', to: '/pages/research-library', origin: 'nginx+app' },
  // Legacy research / blog URLs
  { from: '/blogs/research-insights', to: '/pages/research-library', origin: 'nginx+app' },
  { from: '/research-insight/nnmt-article', to: '/pages/research-library', origin: 'nginx+app' },
  { from: '/blogs/research-insights/glp1-receptor-pathways', to: '/pages/glp1-receptor-pathways', origin: 'nginx+app' },
  { from: '/blogs/research-insights/retatrutide-vs-semaglutide-research', to: '/pages/retatrutide-vs-semaglutide-research', origin: 'nginx+app' },
  { from: '/blogs/research-insights/triple-agonist-peptide-research', to: '/pages/triple-agonist-peptide-research', origin: 'nginx+app' },
  { from: '/blogs/research-insights/cagrilintide-semaglutide-dual-receptor-synergies', to: '/pages/cagrisema-research-overview', origin: 'nginx' },
  { from: '/pages/research-insights/cagrilintide-semaglutide-dual-receptor-synergies', to: '/pages/cagrisema-research-overview', origin: 'nginx' },
  {
    from: '/blogs/research-insights/nnmt-inhibition-5-amino-1mq',
    to: '/pages/nnmt-inhibition-the-role-of-5-amino-1mq-in-cellular-energy-and-nad-related-pathways',
    origin: 'nginx+app',
    note: 'nginx sent this to /pages/research-library; the app (and this import) use the dedicated NNMT article',
  },
  // Legacy collection URLs
  { from: '/collections/frontpage', to: '/collections/all', origin: 'nginx' },
  { from: '/collections/metabolic-research', to: '/collections/glp-1-metabolic-peptides', origin: 'nginx+app' },
  { from: '/collections/repair-recovery-research', to: '/collections/tissue-cellular-research-peptides', origin: 'nginx+app' },
];

const PROTECTED = ['/admin', '/api', '/checkout', '/account', '/order', '/orders', '/review', '/assets'];
const isProtected = (p: string) => p === '/' || p === '/collections/all' || PROTECTED.some((x) => p === x || p.startsWith(x + '/'));
const validTarget = (t: string) => t.startsWith('/') && !t.startsWith('//') && !/[\\\s]/.test(t) && !/^\/[^/]*:/.test(t);

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
  console.log(`Connected to database: ${db.databaseName}\n`);
  const redirects = db.collection('redirects');

  // Live storefront item at a path? (a real page always wins over a redirect)
  const liveAt = async (path: string): Promise<boolean> => {
    const m = path.match(/^\/(products|collections|pages)\/([a-z0-9-]+)$/);
    if (!m) return false;
    const [, type, slug] = m;
    if (type === 'products') return !!(await db.collection('products').findOne({ slug, publishStatus: 'active' }, { projection: { _id: 1 } }));
    if (type === 'collections') return !!(await db.collection('collections').findOne({ slug, status: 'active' }, { projection: { _id: 1 } }));
    return !!(await db.collection('pages').findOne({ slug, status: 'published' }, { projection: { _id: 1 } }));
  };

  let toInsert = 0, skipped = 0, targetWarnings = 0;
  for (const r of LEGACY) {
    const from = r.from.toLowerCase();
    const label = `${from} → ${r.to}`;
    if (isProtected(from) || !validTarget(r.to)) { console.log(`  skip ${label}: protected or invalid`); skipped++; continue; }
    if (await liveAt(from)) { console.log(`  skip ${label}: a live page exists at the old URL (real page wins)`); skipped++; continue; }
    const existing = await redirects.findOne({ fromPath: from, active: true });
    if (existing) { console.log(`  skip ${label}: already redirects to ${existing.toPath}`); skipped++; continue; }
    const targetLive = r.to === '/collections/all' || (await liveAt(r.to));
    if (!targetLive) { targetWarnings++; console.log(`  WARNING ${label}: the target is not a live page in this database (imported anyway; shown as a warning in admin)`); }
    console.log(`  ${apply ? 'insert' : 'would insert'} ${label}`);
    toInsert++;
    if (apply) {
      const now = new Date();
      await redirects.insertOne({
        fromPath: from, toPath: r.to, statusCode: 301, source: 'import', active: true, hits: 0, lastHitAt: null,
        note: `Imported from ${r.origin === 'nginx+app' ? 'nginx + app routes' : r.origin === 'nginx' ? 'nginx' : 'app routes'}${r.note ? ` — ${r.note}` : ''}`,
        createdBy: null, updatedBy: null, createdAt: now, updatedAt: now,
      });
    }
  }
  console.log(`\nLegacy redirects: ${LEGACY.length}. ${apply ? 'Inserted' : 'To insert'}: ${toInsert}. Skipped: ${skipped}. Target warnings: ${targetWarnings}.`);
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
