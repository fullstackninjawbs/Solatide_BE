import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, stub, req, fakeQuery, fakeUser, OID, signTestToken } from './helpers/setup';
import Product from '../src/models/product.model';
import Review from '../src/models/review.model';
import Order from '../src/models/order.model';
import User from '../src/models/user.model';
import AnalyticsEvent from '../src/models/analyticsEvent.model';
import PaymentSettings from '../src/models/PaymentSettings';
import { buildErrorHandler } from '../src/middleware/errorHandler';
import AppError from '../src/utils/appError';
import { validateCoaUrl } from '../src/utils/coaProxy';
import { sanitizeRichHtml } from '../src/utils/sanitizeHtml';
import { escapeHtml } from '../src/utils/escapeHtml';

let ctx: Awaited<ReturnType<typeof startApp>>;
const restores: Array<() => void> = [];
const staff = fakeUser(OID(0xa1), 'admin');
const customer = fakeUser(OID(0xa2), 'user');

before(async () => {
  restores.push(stub(User, 'findById', async (id: string) => [staff, customer].find((u) => u._id === id) || null));
  ctx = await startApp();
});

after(async () => {
  restores.forEach((r) => r());
  await ctx.close();
});

// ── Health / errors ─────────────────────────────────────────────────────────
test('/api/health exposes only status, db, timestamp', async () => {
  const res = await req(ctx.base + '/api/health');
  assert.deepEqual(Object.keys(res.body).sort(), ['db', 'status', 'timestamp']);
  for (const k of ['env', 'node', 'memory', 'uptime']) assert.ok(!(k in res.body));
  assert.equal(typeof res.body.db, 'string');
});

test('/api/status has no env', async () => {
  const res = await req(ctx.base + '/api/status');
  assert.equal(res.status, 200);
  assert.ok(!('env' in res.body));
});

const fakeRes = () => {
  const r: any = { statusCode: 0, body: null, headersSent: false };
  r.status = (c: number) => ((r.statusCode = c), r);
  r.json = (b: unknown) => ((r.body = b), r);
  return r;
};

test('production error handler returns generic 500 without stack/details', () => {
  const handler = buildErrorHandler('production');
  const res = fakeRes();
  const origError = console.error;
  console.error = () => undefined;
  try {
    handler(new Error('secret internal detail: mongodb://user:pass@host'), {} as any, res, () => undefined);
  } finally {
    console.error = origError;
  }
  assert.equal(res.statusCode, 500);
  assert.deepEqual(res.body, { success: false, status: 'error', message: 'Something went wrong' });
});

test('production error handler passes operational messages through', () => {
  const handler = buildErrorHandler('production');
  const res = fakeRes();
  handler(new AppError('Not found here', 404), {} as any, res, () => undefined);
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.message, 'Not found here');
  assert.ok(!('stack' in res.body));
});

test('unknown route in test/prod mode returns no stack', async () => {
  const res = await req(ctx.base + '/api/does-not-exist');
  assert.equal(res.status, 404);
  assert.ok(!('stack' in res.body));
});

// ── SSRF ────────────────────────────────────────────────────────────────────
test('proxy-coa URL validation: only https://res.cloudinary.com/<cloud>/...', () => {
  const bad = [
    'http://res.cloudinary.com/testcloud/image/upload/coa.pdf',
    'https://evil.example/testcloud/coa.pdf',
    'https://res.cloudinary.com.evil.example/testcloud/coa.pdf',
    'https://res.cloudinary.com/othercloud/image/upload/coa.pdf',
    'https://user:pw@res.cloudinary.com/testcloud/coa.pdf',
    'https://res.cloudinary.com:8443/testcloud/coa.pdf',
    'https://169.254.169.254/latest/meta-data/',
    'file:///etc/passwd',
    'not a url',
  ];
  for (const u of bad) assert.equal(validateCoaUrl(u, 'testcloud').ok, false, u);
  assert.equal(validateCoaUrl('https://res.cloudinary.com/testcloud/image/upload/v1/coas/a.pdf', 'testcloud').ok, true);
  assert.equal(validateCoaUrl('https://res.cloudinary.com/testcloud/x.pdf', '').ok, false, 'unconfigured cloud name');
});

test('proxy-coa endpoint requires auth and rejects non-cloudinary / http URLs', async () => {
  const unauth = await req(ctx.base + '/api/admin/batches/proxy-coa?url=' + encodeURIComponent('https://res.cloudinary.com/testcloud/a.pdf'));
  assert.equal(unauth.status, 401);
  const h = { Authorization: `Bearer ${signTestToken(staff._id)}` };
  for (const u of ['http://169.254.169.254/latest/meta-data/', 'http://res.cloudinary.com/testcloud/a.pdf', 'https://evil.example/testcloud/a.pdf']) {
    const res = await req(ctx.base + '/api/admin/batches/proxy-coa?url=' + encodeURIComponent(u), { headers: h });
    assert.equal(res.status, 400, u);
  }
});

// ── Products ────────────────────────────────────────────────────────────────
test('public product list forces publishStatus active, clamps limit, escapes regex', async () => {
  let filter: any = null;
  const calls: Record<string, unknown[]> = {};
  const r1 = stub(Product, 'find', (f: any) => {
    filter = f;
    return fakeQuery([], calls);
  });
  const r2 = stub(Product, 'countDocuments', async () => 0);
  try {
    const res = await req(ctx.base + '/api/products?status=draft&limit=100000&search=' + encodeURIComponent('a.*(b+'));
    assert.equal(res.status, 200);
    assert.equal(filter.publishStatus, 'active');
    assert.equal(res.body.data.pagination.limit, 100);
    assert.deepEqual(calls.limit?.[0], [100]);
    assert.equal(filter.$or[0].name.$regex, 'a\\.\\*\\(b\\+');
    const projection = String((calls.select as any)?.[0]?.[0] || '');
    for (const f of ['-costPerItem', '-lowStockThreshold', '-tagadaSync', '-pendingBatchDocs', '-hsCode']) {
      assert.ok(projection.includes(f), `projection excludes ${f}`);
    }
  } finally {
    r1();
    r2();
  }
});

test('search input is capped at 100 chars', async () => {
  let filter: any = null;
  const r1 = stub(Product, 'find', (f: any) => ((filter = f), fakeQuery([])));
  const r2 = stub(Product, 'countDocuments', async () => 0);
  try {
    await req(ctx.base + '/api/products?search=' + 'x'.repeat(5000));
    assert.equal(filter.$or[0].name.$regex.length, 100);
  } finally {
    r1();
    r2();
  }
});

test('staff token may list drafts (status honoured) with no public projection', async () => {
  let filter: any = null;
  const calls: Record<string, unknown[]> = {};
  const r1 = stub(Product, 'find', (f: any) => ((filter = f), fakeQuery([], calls)));
  const r2 = stub(Product, 'countDocuments', async () => 0);
  try {
    const res = await req(ctx.base + '/api/products?status=draft', { headers: { Authorization: `Bearer ${signTestToken(staff._id)}` } });
    assert.equal(res.status, 200);
    assert.equal(filter.publishStatus, 'draft');
    assert.equal(calls.select, undefined);
  } finally {
    r1();
    r2();
  }
});

test('public product detail only matches active products (404 otherwise)', async () => {
  const filters: any[] = [];
  const r1 = stub(Product, 'findOne', (f: any) => (filters.push(f), fakeQuery(null)));
  try {
    const res = await req(ctx.base + '/api/products/some-draft-slug');
    assert.equal(res.status, 404);
    assert.ok(filters.length > 0);
    for (const f of filters) assert.equal(f.publishStatus, 'active');
  } finally {
    r1();
  }
});

// ── Reviews ─────────────────────────────────────────────────────────────────
test('review create response lacks verificationToken/email', async () => {
  const r1 = stub(Product, 'findOne', () => fakeQuery({ _id: OID(0xc1), name: 'Test Peptide', images: [] }));
  const r2 = stub(Review, 'create', async (doc: any) => ({ ...doc, _id: OID(0xd1) }));
  try {
    const res = await req(ctx.base + '/api/v1/reviews', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId: OID(0xc1), rating: 5, title: 'Great', review: 'Nice <b>stuff</b>', name: 'Ann' }),
    });
    assert.equal(res.status, 201);
    assert.deepEqual(Object.keys(res.body.data).sort(), ['_id', 'status']);
    assert.ok(!res.text.includes('verificationToken'));
  } finally {
    r1();
    r2();
  }
});

test('review create validates rating and product id', async () => {
  const bad1 = await req(ctx.base + '/api/v1/reviews', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ productId: OID(0xc1), rating: 9, review: 'x' }),
  });
  assert.equal(bad1.status, 400);
  const bad2 = await req(ctx.base + '/api/v1/reviews', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ productId: { $gt: '' }, rating: 5, review: 'x' }),
  });
  assert.equal(bad2.status, 400);
});

// ── Analytics ───────────────────────────────────────────────────────────────
test('analytics rejects oversize / wrongly typed fields, ignores client timestamp, flags purchases', async () => {
  const saved: any[] = [];
  const proto: any = AnalyticsEvent.prototype;
  const origSave = proto.save;
  proto.save = async function () {
    saved.push(this);
    return this;
  };
  try {
    const post = (body: unknown) =>
      req(ctx.base + '/api/analytics/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    assert.equal((await post({ sessionId: 's1', eventType: 'page_view', productName: 'x'.repeat(201) })).status, 400);
    assert.equal((await post({ sessionId: 's1', eventType: 'page_view', path: { $ne: 1 } })).status, 400);
    assert.equal((await post({ sessionId: 's1', eventType: 'hacked' })).status, 400);
    assert.equal((await post({ sessionId: 's1', eventType: 'add_to_cart', cartValue: 'lots' })).status, 400);

    const ok = await post({ sessionId: 's1', eventType: 'purchase', timestamp: '2001-01-01T00:00:00Z', cartValue: 10 });
    assert.equal(ok.status, 200);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(saved.length, 1);
    assert.ok(Math.abs(new Date(saved[0].timestamp).getTime() - Date.now()) < 60_000, 'server time used');
    assert.equal(saved[0].get('clientReported'), true);

    const big = await post({ sessionId: 's1', eventType: 'page_view', junk: 'x'.repeat(150 * 1024) });
    assert.equal(big.status, 413);
  } finally {
    proto.save = origSave;
  }
});

// ── Orders (M-4) ────────────────────────────────────────────────────────────
const fakeOrder = () => ({
  _id: OID(0xe1),
  orderNumber: 'SOL-00042',
  user: OID(0xa9),
  publicAccessToken: 'a'.repeat(64),
  customerEmail: 'victim@example.test',
  customer: { email: 'victim@example.test', phone: '0400000000' },
  shippingAddressObj: { name: 'Vic', street1: '1 Secret St', city: 'Sydney', country: 'AU', phone: '0400' },
  attribution: { firstTouch: { utmSource: 'x' } },
  adminNotes: 'internal',
  lineItems: [{ title: 'Peptide', quantity: 1, unitPrice: 10, subtotal: 10 }],
  toObject() {
    const { toObject, ...rest } = this as any;
    return JSON.parse(JSON.stringify(rest));
  },
});

test('public order lookup requires owner/staff/accessToken and returns minimal projection', async () => {
  const r1 = stub(Order, 'findById', () => fakeQuery(fakeOrder()));
  try {
    const none = await req(ctx.base + `/api/v1/orders/${OID(0xe1)}`);
    assert.equal(none.status, 404);
    const wrong = await req(ctx.base + `/api/v1/orders/${OID(0xe1)}?accessToken=${'b'.repeat(64)}`);
    assert.equal(wrong.status, 404);
    const other = await req(ctx.base + `/api/v1/orders/${OID(0xe1)}`, { headers: { Authorization: `Bearer ${signTestToken(customer._id)}` } });
    assert.equal(other.status, 404);

    const ok = await req(ctx.base + `/api/v1/orders/${OID(0xe1)}?accessToken=${'a'.repeat(64)}`);
    assert.equal(ok.status, 200);
    const text = ok.text;
    for (const leak of ['victim@example.test', '1 Secret St', '0400', 'internal', 'utmSource', 'publicAccessToken']) {
      assert.ok(!text.includes(leak), `leaked ${leak}`);
    }
    assert.equal(ok.body.data.order.orderNumber, 'SOL-00042');
    assert.equal(ok.body.data.order.shippingAddressObj.city, 'Sydney');

    const st = await req(ctx.base + `/api/v1/orders/${OID(0xe1)}`, { headers: { Authorization: `Bearer ${signTestToken(staff._id)}` } });
    assert.equal(st.status, 200);
    assert.ok(!st.text.includes('publicAccessToken'));
  } finally {
    r1();
  }
});

test('/my-orders is not shadowed by /:id', async () => {
  const res = await req(ctx.base + '/api/v1/orders/my-orders');
  assert.equal(res.status, 401);
});

test('createOrder validates quantities and product ids', async () => {
  const post = (products: unknown) =>
    req(ctx.base + '/api/v1/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ products }),
    });
  assert.equal((await post([{ product: OID(1), quantity: 0 }])).status, 400);
  assert.equal((await post([{ product: OID(1), quantity: 101 }])).status, 400);
  assert.equal((await post([{ product: OID(1), quantity: 1.5 }])).status, 400);
  assert.equal((await post([{ product: 'not-an-id', quantity: 1 }])).status, 400);
});

test('old Tagada checkout calls are refused when Admin chose another checkout mode (stale browser tab)', async () => {
  const undo = stub(PaymentSettings, 'findOne', () => fakeQuery({ checkoutMode: 'order_request', bankTransfer: {} }));
  let orderLookups = 0;
  const undoOrder = stub(Order, 'findById', () => { orderLookups++; return fakeQuery(null); });
  try {
    const json = (body: unknown) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const placeholder = await req(ctx.base + '/api/v1/orders', json({ products: [{ product: OID(1), quantity: 1 }], paymentMethod: 'tagada' }));
    assert.equal(placeholder.status, 503);
    assert.match(placeholder.body.message, /refresh the page/);
    const session = await req(ctx.base + '/api/payments/tagada/create', json({ orderId: OID(2), accessToken: 'a'.repeat(64) }));
    assert.equal(session.status, 503);
    assert.match(session.body.message, /refresh the page/);
    assert.equal(orderLookups, 0, 'no order is read or created');
  } finally {
    undo();
    undoOrder();
  }
});

// ── HTML sanitising / escaping ──────────────────────────────────────────────
test('shared sanitizer strips scripts/handlers/ids, unsafe styles, forces rel on _blank', () => {
  const out = sanitizeRichHtml(
    '<p id="x" style="color:red;position:fixed;background-image:url(javascript:1)" onclick="a()">hi</p>' +
      '<a href="javascript:alert(1)">j</a><a href="https://e.x" target="_blank">t</a><script>alert(1)</script><img src="data:image/png;base64,AA">'
  );
  assert.ok(!out.includes('script'));
  assert.ok(!out.includes('onclick'));
  assert.ok(!out.includes('id="x"'));
  assert.ok(!out.includes('position'));
  assert.ok(!out.includes('javascript'));
  assert.ok(!out.includes('data:'));
  assert.ok(out.includes('color:red'));
  assert.ok(out.includes('rel="noopener noreferrer"'));
});

test('escapeHtml escapes markup', () => {
  assert.equal(escapeHtml('<img src=x onerror="a">&\''), '&lt;img src=x onerror=&quot;a&quot;&gt;&amp;&#39;');
});
