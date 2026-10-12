import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, stub, req, fakeUser, OID, signTestToken, FakeUser } from './helpers/setup';
import User from '../src/models/user.model';

/** H-2 regression: admin → super_admin escalation paths. */

let ctx: Awaited<ReturnType<typeof startApp>>;
const restores: Array<() => void> = [];
let users: Record<string, FakeUser>;
let created: any[];
let adminCount = 1;

const reset = () => {
  users = {
    superA: fakeUser(OID(0x51), 'super_admin'),
    superB: fakeUser(OID(0x52), 'super_admin'),
    adminA: fakeUser(OID(0x61), 'admin'),
    adminB: fakeUser(OID(0x62), 'admin'),
    customer: fakeUser(OID(0x71), 'user'),
  };
  created = [];
  adminCount = 2;
};
reset();

const byId = (id: string) => Object.values(users).find((u) => String(u._id) === String(id)) || null;

before(async () => {
  restores.push(stub(User, 'findById', async (id: string) => byId(id)));
  restores.push(stub(User, 'findOne', async () => null));
  restores.push(stub(User, 'countDocuments', async (filter: any) => (filter?.role === 'super_admin' ? 2 : adminCount)));
  restores.push(
    stub(User, 'create', async (doc: any) => {
      created.push(doc);
      return { ...doc, _id: OID(0x99), createdAt: new Date(), updatedAt: new Date() };
    })
  );
  ctx = await startApp();
});

beforeEach(() => reset());

after(async () => {
  restores.forEach((r) => r());
  await ctx.close();
});

const as = (actor: FakeUser, method: string, path: string, body?: unknown) =>
  req(ctx.base + path, {
    method,
    headers: { Authorization: `Bearer ${signTestToken(actor._id)}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });

const newUser = (role: string) => ({ name: 'New', email: 'new-admin@example.test', password: 'a-very-long-password', role });

test('admin cannot create a super_admin', async () => {
  const res = await as(users.adminA, 'POST', '/api/admin/users', newUser('super_admin'));
  assert.equal(res.status, 403);
  assert.equal(created.length, 0);
});

test('admin cannot promote self', async () => {
  const res = await as(users.adminA, 'PUT', `/api/admin/users/${users.adminA._id}`, { role: 'super_admin' });
  assert.equal(res.status, 403);
  assert.equal(users.adminA.role, 'admin');
  assert.ok(!users.adminA.saved);
});

test("admin cannot change another admin's password", async () => {
  const res = await as(users.adminA, 'PUT', `/api/admin/users/${users.adminB._id}`, { password: 'another-long-password' });
  assert.equal(res.status, 403);
  assert.ok(!users.adminB.saved);
});

test("admin cannot change another admin's email or role", async () => {
  const e = await as(users.adminA, 'PUT', `/api/admin/users/${users.adminB._id}`, { email: 'evil@example.test' });
  assert.equal(e.status, 403);
  const r = await as(users.adminA, 'PUT', `/api/admin/users/${users.adminB._id}`, { role: 'super_admin' });
  assert.equal(r.status, 403);
  assert.equal(users.adminB.role, 'admin');
});

test('admin cannot edit a super_admin', async () => {
  const res = await as(users.adminA, 'PUT', `/api/admin/users/${users.superA._id}`, { name: 'pwned' });
  assert.equal(res.status, 403);
});

test('admin cannot promote a customer account (target must be staff)', async () => {
  const res = await as(users.adminA, 'PUT', `/api/admin/users/${users.customer._id}`, { role: 'admin' });
  assert.equal(res.status, 404);
  assert.equal(users.customer.role, 'user');
});

test('super_admin cannot change own role', async () => {
  const res = await as(users.superA, 'PUT', `/api/admin/users/${users.superA._id}`, { role: 'admin' });
  assert.equal(res.status, 403);
});

test('super_admin can create a super_admin', async () => {
  const res = await as(users.superA, 'POST', '/api/admin/users', newUser('super_admin'));
  assert.equal(res.status, 201);
  assert.equal(created.length, 1);
  assert.equal(created[0].role, 'super_admin');
  assert.equal(res.body.data.user.password, undefined);
});

test("super_admin can change another admin's password and role", async () => {
  const res = await as(users.superA, 'PUT', `/api/admin/users/${users.adminB._id}`, {
    password: 'another-long-password',
    role: 'super_admin',
  });
  assert.equal(res.status, 200);
  assert.ok(users.adminB.saved);
  assert.equal(users.adminB.role, 'super_admin');
  assert.ok(users.adminB.extra.passwordChangedAt instanceof Date, 'passwordChangedAt set');
});

test('promotions respect MAX_ADMIN_USERS', async () => {
  adminCount = 3;
  const res = await as(users.superA, 'PUT', `/api/admin/users/${users.customer._id}`, { role: 'admin' });
  assert.equal(res.status, 403);
  assert.equal(users.customer.role, 'user');
  adminCount = 3;
  const c = await as(users.superA, 'POST', '/api/admin/users', newUser('admin'));
  assert.equal(c.status, 403);
});

test('admin-create enforces min password length 10', async () => {
  const res = await as(users.superA, 'POST', '/api/admin/users', { ...newUser('admin'), password: 'short' });
  assert.equal(res.status, 400);
});
