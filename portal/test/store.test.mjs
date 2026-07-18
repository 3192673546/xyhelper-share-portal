import assert from 'node:assert/strict';
import test from 'node:test';
import { Store } from '../src/store.mjs';

function createStore() {
  return new Store(':memory:', { adminEmail: 'admin@example.com', adminPassword: 'strong-password-123' });
}

test('users, sessions, handoffs and redemption codes persist consistently', (t) => {
  const store = createStore();
  t.after(() => store.close());
  const user = store.createUser({
    email: 'user@example.com',
    name: 'Test User',
    password: 'long-password-123',
    expiresAt: new Date(Date.now() + 3600_000).toISOString()
  });
  assert.throws(() => store.createUser({ email: 'USER@example.com', name: 'Duplicate', password: 'long-password-123' }), /已经注册/);

  const session = store.createSession(user.id, 1);
  assert.equal(store.getSession(session.rawToken).user.email, 'user@example.com');

  const handoff = store.createHandoff(user.id, 'car-a', 5);
  assert.equal(store.getHandoff(handoff.rawToken).carId, 'car-a');

  const [code] = store.createCodes({ count: 1, days: 30, tier: 'plus', prefix: 'TEST' });
  const redeemed = store.redeemCode(user.id, code.code.toLowerCase());
  assert.equal(redeemed.user.tier, 'plus');
  assert.ok(new Date(redeemed.user.expiresAt) > new Date(user.expiresAt));
  assert.throws(() => store.redeemCode(user.id, code.code), /使用次数/);

  const [sharedCode] = store.createCodes({ count: 1, days: 1, tier: 'normal', maxUses: 10, prefix: 'PROMO' });
  store.redeemCode(user.id, sharedCode.code);
  assert.throws(() => store.redeemCode(user.id, sharedCode.code), /已经使用过/);
});

test('paid order activation is idempotent', (t) => {
  const store = createStore();
  t.after(() => store.close());
  const user = store.createUser({
    email: 'buyer@example.com', name: 'Buyer', password: 'long-password-123',
    expiresAt: new Date().toISOString()
  });
  const order = store.createOrder(user.id, 'plus-month');
  const originalPlan = store.getPlan('plus-month');
  store.upsertPlan({ ...originalPlan, tier: 'normal', days: 1 });
  const first = store.markOrderPaidAndActivate(order.id, 'gateway-trade-1');
  const expiry = first.user.expiresAt;
  assert.equal(first.activated, true);
  assert.equal(first.user.tier, 'plus');
  const second = store.markOrderPaidAndActivate(order.id, 'gateway-trade-1');
  assert.equal(second.activated, false);
  assert.equal(second.user.expiresAt, expiry);
});

test('the last enabled administrator cannot be disabled or demoted', (t) => {
  const store = createStore();
  t.after(() => store.close());
  const admin = store.getUserByEmail('admin@example.com');
  assert.throws(() => store.updateUser(admin.id, { isAdmin: false }), /至少需要保留/);
  assert.throws(() => store.updateUser(admin.id, { disabled: true }), /至少需要保留/);

  const second = store.createUser({
    email: 'admin2@example.com', name: 'Second Admin', password: 'long-password-123',
    expiresAt: new Date().toISOString(), isAdmin: true
  });
  assert.equal(store.updateUser(admin.id, { isAdmin: false }).isAdmin, false);
  assert.equal(store.getUserById(second.id).isAdmin, true);
});
