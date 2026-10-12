// End-to-end smoke test against a REAL running API process (test DB only: solatide_smoke on :27018).
import { createRequire } from 'node:module';
const require = createRequire('D:/Clients/Solatide/Server/package.json');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const BASE = 'http://localhost:5099';
const DB = 'mongodb://127.0.0.1:27018/solatide_smoke?directConnection=true';
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`); };
const req = async (method, path, { token, body, headers = {} } = {}) => {
  const r = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
  let json = null; const text = await r.text(); try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
};

// Safety: this test resets its own throwaway database. Refuse anything that is not a local *_smoke DB.
if (!/^mongodb:\/\/(127\.0\.0\.1|localhost):\d+\/[a-z_]*_smoke(\?|$)/.test(DB)) {
  throw new Error(`Refusing to run smoke test against non-local / non-_smoke database: ${DB}`);
}
await mongoose.connect(DB);
if (!/_smoke$/.test(mongoose.connection.db.databaseName)) throw new Error('Refusing: connected database is not a _smoke test DB');
const db = mongoose.connection.db;
for (const c of ['users', 'products', 'orders']) await db.collection(c).deleteMany({});
const hash = await bcrypt.hash('SuperAdminPass!2026', 12);
await db.collection('users').insertMany([
  { name: 'SA', email: 'sa@test.local', password: hash, role: 'super_admin', createdAt: new Date() },
  { name: 'Ad', email: 'admin@test.local', password: hash, role: 'admin', createdAt: new Date() },
  { name: 'Sup', email: 'support@test.local', password: hash, role: 'support', createdAt: new Date() },
]);
const prod = { id: 9001, name: 'Active P', slug: 'active-p', price: 10, publishStatus: 'active', costPerItem: 3, tagadaVariantId: 'v1', inStock: true, stockQuantity: 5, variants: [], images: [], createdAt: new Date(), updatedAt: new Date() };
await db.collection('products').insertMany([prod, { ...prod, id: 9002, name: 'Draft P', slug: 'draft-p', publishStatus: 'draft' }]);

// 1. Health: no internals
let r = await req('GET', '/api/health');
check('health exposes only status/db/timestamp', r.json && Object.keys(r.json).sort().join(',') === 'db,status,timestamp', JSON.stringify(r.json));

// 2. C-1: admin endpoints require auth
for (const [m, p] of [['GET', '/api/admin/settings/tagada'], ['PUT', '/api/admin/settings/tagada'], ['POST', '/api/admin/discount'], ['GET', '/api/admin/customer'], ['GET', '/api/admin/dashboard'], ['GET', '/api/admin/batches/proxy-coa?url=https://example.com/x.pdf'], ['POST', '/api/admin/tagada/products/sync']]) {
  r = await req(m, p, { body: m === 'GET' ? undefined : {} });
  check(`anon ${m} ${p} → 401`, r.status === 401, `got ${r.status}`);
}

// 3. C-2: register ignores role
r = await req('POST', '/api/v1/auth/register', { body: { name: 'Eve', email: 'eve@example.com', password: 'EvePassword123', role: 'super_admin' } });
const eve = await db.collection('users').findOne({ email: 'eve@example.com' });
check('register with role=super_admin stores role "user"', eve?.role === 'user', `status ${r.status}, stored role ${eve?.role}`);
check('register response has no token', !r.text.includes('"token"'));
r = await req('POST', '/api/v1/auth/register', { body: { name: 'Eve2', email: 'eve@example.com', password: 'EvePassword123' } });
check('register does not reveal existing account (same status)', r.status === 201, `got ${r.status}`);

const login = async (email, password) => (await req('POST', '/api/v1/auth/login', { body: { email, password } })).json?.token;
const eveTok = await login('eve@example.com', 'EvePassword123');
const saTok = await login('sa@test.local', 'SuperAdminPass!2026');
const adTok = await login('admin@test.local', 'SuperAdminPass!2026');
const supTok = await login('support@test.local', 'SuperAdminPass!2026');
check('logins succeed', !!(eveTok && saTok && adTok && supTok));

// 4. H-1: customer token rejected on admin routes
for (const [m, p] of [['GET', '/api/admin/order'], ['POST', '/api/admin/order/000000000000000000000000/refund'], ['GET', '/api/admin/order/export/csv'], ['POST', '/api/admin/content/pages']]) {
  r = await req(m, p, { token: eveTok, body: m === 'GET' ? undefined : {} });
  check(`customer ${m} ${p} → 403`, r.status === 403, `got ${r.status}`);
}

// 5. Role matrix + H-2
r = await req('GET', '/api/admin/settings/tagada', { token: saTok });
check('super_admin GET settings/tagada → 200', r.status === 200, `got ${r.status}`);
check('tagada settings secrets are masked', !/stub|sk_/.test(r.text));
r = await req('PUT', '/api/admin/settings/tagada', { token: supTok, body: { tagadaWebhookSecret: 'x' } });
check('support PUT settings/tagada → 403', r.status === 403, `got ${r.status}`);
r = await req('PUT', '/api/admin/settings/tagada', { token: adTok, body: { tagadaWebhookSecret: 'x' } });
check('admin PUT settings/tagada → 403 (super_admin only)', r.status === 403, `got ${r.status}`);
const adUser = await db.collection('users').findOne({ email: 'admin@test.local' });
r = await req('PUT', `/api/admin/users/${adUser._id}`, { token: adTok, body: { role: 'super_admin' } });
const adAfter = await db.collection('users').findOne({ _id: adUser._id });
check('admin cannot self-promote to super_admin', r.status === 403 && adAfter.role === 'admin', `status ${r.status}, role ${adAfter.role}`);
r = await req('POST', '/api/admin/users', { token: adTok, body: { name: 'X', email: 'x@test.local', password: 'XPassword12345', role: 'super_admin' } });
check('admin cannot create super_admin', r.status === 403, `got ${r.status}`);

// 6. H-3 Starshipit webhook
r = await req('POST', '/api/v1/orders/webhook/starshipit', { body: { order_number: 'SLT0000001B', tracking_status: 'Delivered' } });
check('starshipit webhook without secret → 401', r.status === 401, `got ${r.status}`);

// 7. Public products: active only, no internal fields, clamped limit
r = await req('GET', '/api/products?status=draft&limit=100000');
const list = r.json?.data?.products || [];
check('public list ignores ?status=draft', list.length === 1 && list[0].slug === 'active-p', `slugs ${list.map(p => p.slug)}`);
check('public list has no costPerItem', !r.text.includes('costPerItem'));
r = await req('GET', '/api/products/draft-p');
check('draft product by slug → 404', r.status === 404, `got ${r.status}`);
r = await req('GET', '/api/products?search=' + encodeURIComponent('(a+)+$'));
check('regex search input does not error', r.status === 200, `got ${r.status}`);

// 8. Order IDOR
const order = await db.collection('orders').insertOne({ orderNumber: 'SLT1234567B', publicAccessToken: 'a'.repeat(64), customerEmail: 'victim@test.local', products: [], paymentStatus: 'paid', status: 'processing', createdAt: new Date() });
r = await req('GET', `/api/v1/orders/${order.insertedId}`);
check('order lookup without token → 404', r.status === 404 && !r.text.includes('victim@'), `got ${r.status}`);
r = await req('GET', `/api/v1/orders/${order.insertedId}?accessToken=${'a'.repeat(64)}`);
check('order lookup with token → 200 without email', r.status === 200 && !r.text.includes('victim@'), `got ${r.status}`);
r = await req('POST', `/api/payments/tagada/sync/${order.insertedId}`);
check('payment sync without token → 404', r.status === 404 && !r.text.includes('victim@'), `got ${r.status}`);

// 9. Production error handling: malformed JSON → 4xx, no stack
r = await req('POST', '/api/v1/auth/login', { body: '{"email":' });
check('malformed JSON → 400 without stack', r.status === 400 && !r.text.includes('stack') && !r.text.includes('at '), `got ${r.status} ${r.text.slice(0, 80)}`);

// 10. Brute force: login limiter
let last = 0;
for (let i = 0; i < 15; i++) last = (await req('POST', '/api/v1/auth/login', { body: { email: 'sa@test.local', password: 'wrong-password-123' } })).status;
check('repeated failed logins hit 429', last === 429, `last status ${last}`);

await mongoose.disconnect();
const failed = results.filter(x => !x.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
