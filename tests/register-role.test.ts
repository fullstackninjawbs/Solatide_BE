import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, stub, req, fakeUser, OID, signTestToken } from './helpers/setup';
import User from '../src/models/user.model';

/** C-2 regression: public registration can never choose its role. */

let ctx: Awaited<ReturnType<typeof startApp>>;
const restores: Array<() => void> = [];
let created: any[] = [];
let existing: any = null;

before(async () => {
  restores.push(stub(User, 'findOne', async () => existing));
  restores.push(
    stub(User, 'create', async (doc: any) => {
      created.push(doc);
      return { ...doc, _id: OID(0x1234), password: 'hashed' };
    })
  );
  ctx = await startApp();
});

after(async () => {
  restores.forEach((r) => r());
  await ctx.close();
});

const register = (body: Record<string, unknown>) =>
  req(ctx.base + '/api/v1/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

test('register with role super_admin → User.create called with role user', async () => {
  created = [];
  existing = null;
  const res = await register({ name: 'Mallory', email: 'mallory@example.test', password: 'a-long-password-1', role: 'super_admin' });
  assert.equal(res.status, 201);
  assert.equal(created.length, 1);
  assert.equal(created[0].role, 'user');
  assert.equal(res.body.token, undefined, 'register must not issue a token');
  assert.ok(!JSON.stringify(res.body).includes('super_admin'));
});

test('register with existing email → identical generic response, no create', async () => {
  created = [];
  existing = null;
  const fresh = await register({ name: 'A', email: 'new@example.test', password: 'a-long-password-1' });
  existing = { _id: OID(1), email: 'taken@example.test' };
  created = [];
  const dup = await register({ name: 'B', email: 'taken@example.test', password: 'a-long-password-1' });
  assert.equal(dup.status, fresh.status);
  assert.deepEqual(dup.body, fresh.body);
  assert.equal(created.length, 0);
});

test('register rejects short passwords (< 10 chars)', async () => {
  created = [];
  existing = null;
  const res = await register({ name: 'C', email: 'c@example.test', password: 'short123' });
  assert.equal(res.status, 400);
  assert.equal(created.length, 0);
});

test('forgot-password does not reveal whether the account exists', async () => {
  existing = null;
  const a = await req(ctx.base + '/api/v1/auth/forgot-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'nobody@example.test' }),
  });
  assert.equal(a.status, 200);
  assert.match(a.body.message, /If an account exists/);
});

test('GET /me never returns password or reset token fields', async () => {
  const u: any = fakeUser(OID(0x77), 'user');
  u.password = '$2a$10$hash';
  u.passwordResetToken = 'deadbeef';
  u.passwordResetExpires = new Date();
  const restore = stub(User, 'findById', async () => u);
  try {
    const res = await req(ctx.base + '/api/v1/auth/me', { headers: { Authorization: `Bearer ${signTestToken(u._id)}` } });
    assert.equal(res.status, 200);
    const keys = Object.keys(res.body.data.user);
    for (const k of ['password', 'passwordResetToken', 'passwordResetExpires']) assert.ok(!keys.includes(k), k);
  } finally {
    restore();
  }
});

test('token issued before passwordChangedAt is rejected', async () => {
  const u: any = fakeUser(OID(0x78), 'user');
  const token = signTestToken(u._id);
  u.passwordChangedAt = new Date(Date.now() + 60_000);
  const restore = stub(User, 'findById', async () => u);
  try {
    const res = await req(ctx.base + '/api/v1/auth/me', { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(res.status, 401);
  } finally {
    restore();
  }
});
