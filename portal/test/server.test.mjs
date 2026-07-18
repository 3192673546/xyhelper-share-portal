import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { epaySign } from '../src/payment.mjs';
import { createPortalServer } from '../src/server.mjs';
import { Store } from '../src/store.mjs';

const cars = [
  { carID: 'normal-car', status: true, isPlus: false },
  { carID: 'plus-car', status: true, isPlus: true }
];

function testConfig() {
  return {
    siteName: 'Test Portal', dataPath: ':memory:', port: 0,
    shareInternalUrl: 'http://share:8001', sharePublicUrl: 'https://chat.example.com',
    sharePublicPort: 8300,
    portalPublicUrl: 'https://portal.example.com', oauthSecret: 'oauth-test-secret',
    adminEmail: 'admin@example.com', adminPassword: 'strong-password-123',
    registrationEnabled: true, trialHours: 24, sessionHours: 1, handoffMinutes: 5,
    cookieSecure: false, cookieDomain: '', trustProxy: false,
    epay: { url: '', pid: '', key: '', type: 'alipay', device: 'pc', signMode: 'append' }
  };
}

async function jsonRequest(base, path, { method = 'GET', body, cookie, csrf } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  if (csrf) headers['x-csrf-token'] = csrf;
  const response = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json();
  return { response, data, cookie: response.headers.get('set-cookie')?.split(';')[0] };
}

test('registration, car entitlement, handoff and XYHelper OAuth work end to end', async (t) => {
  const config = testConfig();
  const store = new Store(':memory:', config);
  const shareClient = {
    async listCars() { return cars; },
    async getCar(id) { return cars.find((car) => car.carID === id) || null; }
  };
  const server = createPortalServer({ config, store, shareClient });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.close();
    await once(server, 'close');
    store.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  const page = await fetch(base);
  const html = await page.text();
  assert.equal(page.status, 200);
  assert.match(html, /id="auth-screen"/);
  assert.match(html, /src="\/app\.js"/);
  assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
  const script = await fetch(`${base}/app.js`);
  assert.equal(script.status, 200);
  assert.match(await script.text(), /async function initialize/);
  const payScript = await fetch(`${base}/pay.js`);
  assert.equal(payScript.status, 200);
  assert.match(await payScript.text(), /querySelector\('#pay'\)/);

  const registered = await jsonRequest(base, '/api/register', {
    method: 'POST',
    body: { email: 'user@example.com', name: 'User', password: 'long-password-123' }
  });
  assert.equal(registered.response.status, 201);
  assert.ok(registered.cookie?.startsWith('portal_session='));
  const cookie = registered.cookie;
  const csrf = registered.data.csrfToken;

  const carList = await jsonRequest(base, '/api/cars', { cookie });
  assert.equal(carList.data.cars[0].allowed, true);
  assert.equal(carList.data.cars[1].allowed, false);

  const rejected = await jsonRequest(base, '/api/handoff', { method: 'POST', cookie, body: { carid: 'normal-car' } });
  assert.equal(rejected.response.status, 403);

  const handoff = await jsonRequest(base, '/api/handoff', { method: 'POST', cookie, csrf, body: { carid: 'normal-car' } });
  assert.equal(handoff.response.status, 200);
  const handoffUrl = new URL(handoff.data.url);
  assert.equal(handoffUrl.hostname, 'chat.example.com');
  const ticket = handoffUrl.searchParams.get('usertoken');
  assert.ok(ticket.startsWith('ho_'));

  config.sharePublicUrl = 'auto';
  const autoHandoff = await jsonRequest(base, '/api/handoff', {
    method: 'POST', cookie, csrf, body: { carid: 'normal-car' }
  });
  const autoHandoffUrl = new URL(autoHandoff.data.url);
  assert.equal(autoHandoffUrl.hostname, '127.0.0.1');
  assert.equal(autoHandoffUrl.port, '8300');

  const oauthResponse = await fetch(`${base}/api/xyhelper/oauth?secret=oauth-test-secret`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ usertoken: ticket, carid: 'normal-car' })
  });
  const oauth = await oauthResponse.json();
  assert.equal(oauth.code, 1);
  assert.ok(oauth.usertoken.startsWith('xyu_'));
  assert.notEqual(oauth.usertoken, ticket);
  assert.equal(oauth.carid, 'normal-car');
  assert.match(oauth.expireTime, /^\d{4}-\d{2}-\d{2} /);
});

test('verified payment callback activates an order exactly once', async (t) => {
  const config = testConfig();
  config.epay = {
    url: 'https://pay.example.com/easy/pay', pid: '1000', key: 'merchant-secret',
    type: 'alipay', device: 'pc', signMode: 'append'
  };
  const store = new Store(':memory:', config);
  const user = store.createUser({
    email: 'buyer@example.com', name: 'Buyer', password: 'long-password-123',
    expiresAt: new Date().toISOString()
  });
  const order = store.createOrder(user.id, 'plus-month');
  const shareClient = { async listCars() { return cars; }, async getCar(id) { return cars.find((car) => car.carID === id) || null; } };
  const server = createPortalServer({ config, store, shareClient });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.close();
    await once(server, 'close');
    store.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const fields = {
    pid: '1000', type: 'alipay', out_trade_no: order.id, money: '19.90',
    trade_status: 'TRADE_SUCCESS', trade_no: 'trade-123'
  };
  fields.sign = epaySign(fields, config.epay.key);
  fields.sign_type = 'MD5';

  const callback = await fetch(`${base}/api/payments/epay/notify?${new URLSearchParams(fields)}`);
  assert.equal(callback.status, 200);
  assert.equal(await callback.text(), 'success');
  const activated = store.getUserById(user.id);
  assert.equal(activated.tier, 'plus');
  const firstExpiry = activated.expiresAt;

  const repeated = await fetch(`${base}/api/payments/epay/notify?${new URLSearchParams(fields)}`);
  assert.equal(await repeated.text(), 'success');
  assert.equal(store.getUserById(user.id).expiresAt, firstExpiry);
});
