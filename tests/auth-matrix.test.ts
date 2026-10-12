import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, signTestToken, fakeUser, stub, OID, req } from './helpers/setup';
import User from '../src/models/user.model';

/**
 * C-1 / H-1 regression: every /api/admin/* route requires auth + a staff role,
 * and per-area role restrictions match the admin UI matrix.
 */

// Routes intentionally reachable without a token. Must stay empty unless a public
// admin route is deliberately added (admin login lives at /api/v1/auth/login).
const PUBLIC_ADMIN_ALLOW_LIST: string[] = [];

const ROLES = ['super_admin', 'admin', 'operations', 'content_manager', 'support', 'user'] as const;
const users: Record<string, ReturnType<typeof fakeUser>> = {};
ROLES.forEach((r, i) => {
  users[r] = fakeUser(OID(0xa000 + i), r);
});
const tokenFor = (role: string) => signTestToken(users[role]._id);

let ctx: Awaited<ReturnType<typeof startApp>>;
let restoreFindById: () => void;

type RouteDef = { method: string; path: string };

/** Turn an express 4 layer regexp back into its mount path. */
const regexpToPath = (layer: any): string => {
  if (layer.regexp?.fast_slash) return '';
  const src: string = layer.regexp.toString();
  const m = src
    .replace('\\/?', '')
    .replace('(?=\\/|$)', '$')
    .match(/^\/\^((?:\\[.*+?^${}()|[\]\\/]|[^.*+?^${}()|[\]\\/])*)\$\//);
  if (!m) throw new Error(`Cannot derive mount path from ${src}`);
  return m[1].replace(/\\(.)/g, '$1');
};

const collectRoutes = (stack: any[], prefix: string, out: RouteDef[]) => {
  for (const layer of stack) {
    if (layer.route) {
      const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
      for (const p of paths) {
        for (const method of Object.keys(layer.route.methods)) {
          if (method === '_all') continue;
          out.push({ method: method.toUpperCase(), path: prefix + p });
        }
      }
    } else if (layer.name === 'router' && layer.handle?.stack) {
      collectRoutes(layer.handle.stack, prefix + regexpToPath(layer), out);
    }
  }
};

const enumerateAdminRoutes = (app: any): RouteDef[] => {
  const out: RouteDef[] = [];
  const all: RouteDef[] = [];
  collectRoutes(app._router.stack, '', all);
  for (const r of all) if (r.path.startsWith('/api/admin/') || r.path === '/api/admin') out.push(r);
  return out;
};

const concrete = (p: string) =>
  p.replace(/:([A-Za-z_]+)/g, (_m, name) => (/id$/i.test(name) ? OID(0xbeef) : 'x'));

const call = (r: RouteDef, token?: string) =>
  req(ctx.base + concrete(r.path), {
    method: r.method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(r.method !== 'GET' && r.method !== 'DELETE' ? { 'Content-Type': 'application/json' } : {}),
    },
    body: r.method !== 'GET' && r.method !== 'DELETE' ? '{}' : undefined,
    timeoutMs: 4000,
  });

before(async () => {
  restoreFindById = stub(User, 'findById', async (id: string) =>
    Object.values(users).find((u) => String(u._id) === String(id)) || null
  );
  ctx = await startApp();
});

after(async () => {
  restoreFindById();
  await ctx.close();
});

test('route walker finds every admin route (> 50)', () => {
  const routes = enumerateAdminRoutes(ctx.app);
  assert.ok(routes.length > 50, `expected > 50 admin routes, found ${routes.length}`);
});

test('no token → 401 on every non-allow-listed admin route', async () => {
  const routes = enumerateAdminRoutes(ctx.app);
  const failures: string[] = [];
  for (const r of routes) {
    if (PUBLIC_ADMIN_ALLOW_LIST.includes(`${r.method} ${r.path}`)) continue;
    const res = await call(r);
    if (res.status !== 401) failures.push(`${r.method} ${r.path} → ${res.status}`);
  }
  assert.deepEqual(failures, []);
});

test('invalid / alg:none token → 401', async () => {
  const forged =
    Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url') +
    '.' +
    Buffer.from(JSON.stringify({ id: users.super_admin._id })).toString('base64url') +
    '.';
  const res = await req(ctx.base + '/api/admin/dashboard', { headers: { Authorization: `Bearer ${forged}` } });
  assert.equal(res.status, 401);
});

test("customer ('user') token → 403 on every admin route", async () => {
  const routes = enumerateAdminRoutes(ctx.app);
  const token = tokenFor('user');
  const failures: string[] = [];
  for (const r of routes) {
    const res = await call(r, token);
    if (res.status !== 403) failures.push(`${r.method} ${r.path} → ${res.status}`);
  }
  assert.deepEqual(failures, []);
});

// [role, allowed route, forbidden route]
const MATRIX: Array<[string, RouteDef, RouteDef | null]> = [
  ['super_admin', { method: 'GET', path: '/api/admin/dashboard' }, null],
  ['admin', { method: 'GET', path: '/api/admin/dashboard' }, { method: 'PUT', path: '/api/admin/settings/tagada' }],
  ['operations', { method: 'GET', path: '/api/admin/dashboard' }, { method: 'GET', path: '/api/admin/settings/store' }],
  ['content_manager', { method: 'GET', path: '/api/admin/dashboard' }, { method: 'GET', path: '/api/admin/order' }],
  ['support', { method: 'GET', path: '/api/admin/dashboard' }, { method: 'PUT', path: '/api/admin/settings/tagada' }],
];

for (const [role, allowed, forbidden] of MATRIX) {
  test(`${role}: allowed on ${allowed.method} ${allowed.path}${forbidden ? `, 403 on ${forbidden.method} ${forbidden.path}` : ''}`, async () => {
    const token = tokenFor(role);
    const ok = await call(allowed, token);
    // Handlers hit the (unconnected) DB after auth, so 500/timeout are fine here.
    assert.ok(ok.status === 'timeout' || ![401, 403].includes(ok.status as number), `${role} got ${ok.status}`);
    if (forbidden) {
      const no = await call(forbidden, token);
      assert.equal(no.status, 403, `${role} expected 403 on ${forbidden.path}, got ${no.status}`);
    }
  });
}

test('role matrix spot checks', async () => {
  const cases: Array<[string, RouteDef, number | 'pass']> = [
    ['support', { method: 'GET', path: '/api/admin/customer' }, 'pass'],
    ['support', { method: 'POST', path: '/api/admin/order/:id/refund' }, 403],
    ['support', { method: 'POST', path: '/api/admin/order/:id/shipment' }, 403],
    ['operations', { method: 'POST', path: '/api/admin/order/:id/refund' }, 403],
    ['operations', { method: 'POST', path: '/api/admin/order' }, 403],
    ['operations', { method: 'POST', path: '/api/admin/order/bulk-soft-delete' }, 403],
    ['operations', { method: 'PATCH', path: '/api/admin/order/:id/status' }, 'pass'],
    ['support', { method: 'GET', path: '/api/admin/growth/subscribers' }, 403],
    ['content_manager', { method: 'GET', path: '/api/admin/content/faqs' }, 'pass'],
    ['operations', { method: 'GET', path: '/api/admin/content/faqs' }, 403],
    ['operations', { method: 'GET', path: '/api/admin/analytics/overview' }, 'pass'],
    ['support', { method: 'GET', path: '/api/admin/analytics/overview' }, 403],
    ['admin', { method: 'GET', path: '/api/admin/tagada/products/sync-history' }, 'pass'],
    ['support', { method: 'POST', path: '/api/admin/tagada/products/sync' }, 403],
    ['admin', { method: 'DELETE', path: '/api/admin/discount/:id' }, 403],
    ['operations', { method: 'GET', path: '/api/admin/shipping/packages' }, 403],
    ['admin', { method: 'GET', path: '/api/admin/settings/tagada/test' }, 403],
    ['operations', { method: 'GET', path: '/api/admin/users' }, 403],
  ];
  const failures: string[] = [];
  for (const [role, r, expected] of cases) {
    const res = await call(r, tokenFor(role));
    const pass = expected === 'pass' ? res.status === 'timeout' || ![401, 403].includes(res.status as number) : res.status === expected;
    if (!pass) failures.push(`${role} ${r.method} ${r.path}: expected ${expected}, got ${res.status}`);
  }
  assert.deepEqual(failures, []);
});

test('operations cannot set paymentStatus via status endpoint; admin can pass the guard', async () => {
  const r = { method: 'PATCH', path: `/api/admin/order/${OID(0xbeef)}/status` };
  const ops = await req(ctx.base + r.path, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${tokenFor('operations')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ paymentStatus: 'paid' }),
  });
  assert.equal(ops.status, 403);
  const adm = await req(ctx.base + r.path, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${tokenFor('admin')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ paymentStatus: 'paid' }),
  });
  assert.ok(adm.status === 'timeout' || ![401, 403].includes(adm.status as number));
});
