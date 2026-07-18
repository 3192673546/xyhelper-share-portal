import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildEpayFields,
  moneyToCents,
  paymentEnabled,
  renderAutoSubmitForm,
  verifyEpaySign
} from './payment.mjs';
import {
  normalizeEmail,
  safeEqual,
  sanitizeName,
  verifyPassword
} from './security.mjs';
import { canUseCar } from './share-client.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

class Router {
  constructor() { this.routes = []; }

  add(method, path, handler) {
    const names = [];
    const expression = path
      .split('/')
      .map((part) => {
        if (!part.startsWith(':')) return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        names.push(part.slice(1));
        return '([^/]+)';
      })
      .join('/');
    this.routes.push({ method, regex: new RegExp(`^${expression}$`), names, handler });
  }

  match(method, path) {
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const match = path.match(route.regex);
      if (!match) continue;
      const params = {};
      route.names.forEach((name, index) => { params[name] = decodeURIComponent(match[index + 1]); });
      return { handler: route.handler, params };
    }
    return null;
  }
}

class RateLimiter {
  constructor() { this.entries = new Map(); }

  consume(key, limit, windowMs) {
    const now = Date.now();
    let entry = this.entries.get(key);
    if (!entry || entry.resetAt <= now) {
      if (!entry && this.entries.size >= 10_000) {
        for (const [entryKey, value] of this.entries) if (value.resetAt <= now) this.entries.delete(entryKey);
        while (this.entries.size >= 10_000) this.entries.delete(this.entries.keys().next().value);
      }
      entry = { count: 0, resetAt: now + windowMs };
    }
    entry.count += 1;
    this.entries.set(key, entry);
    return entry.count <= limit;
  }
}

function parseCookies(header = '') {
  const cookies = {};
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    try { cookies[key] = decodeURIComponent(value); } catch { cookies[key] = value; }
  }
  return cookies;
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store'
  });
  res.end(body);
}

function sendText(res, status, body, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store'
  });
  res.end(body);
}

async function readBody(req, limit = 64 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, '请求内容过大');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  const type = String(req.headers['content-type'] || '').split(';')[0].trim();
  if (!raw) return {};
  if (type === 'application/json') {
    try { return JSON.parse(raw); } catch { throw new HttpError(400, 'JSON 格式不正确'); }
  }
  if (type === 'application/x-www-form-urlencoded' || type === 'multipart/form-data') {
    return Object.fromEntries(new URLSearchParams(raw));
  }
  try { return JSON.parse(raw); } catch { return Object.fromEntries(new URLSearchParams(raw)); }
}

function publicUser(user, { adminView = false } = {}) {
  const value = {
    id: user.id,
    email: user.email,
    name: user.name,
    tier: user.tier,
    allowedCars: user.allowedCars,
    expiresAt: user.expiresAt,
    active: !user.disabled && new Date(user.expiresAt).getTime() > Date.now(),
    disabled: user.disabled,
    isAdmin: user.isAdmin,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt
  };
  if (adminView) value.shareToken = user.shareToken;
  return value;
}

function formatShareTime(value) {
  const date = new Date(value);
  const pad = (part) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function allowedCarsForUser(cars, user) {
  return cars.map((car) => ({ ...car, allowed: canUseCar(user, car) }));
}

function cookieValue(config, token, maxAge) {
  const attributes = [
    `portal_session=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.max(0, Math.floor(maxAge))}`
  ];
  if (config.cookieSecure) attributes.push('Secure');
  if (config.cookieDomain) attributes.push(`Domain=${config.cookieDomain}`);
  return attributes.join('; ');
}

function clientIp(req, config) {
  if (config.trustProxy) {
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (forwarded) return forwarded;
  }
  return req.socket.remoteAddress || 'unknown';
}

function effectiveSharePublicUrl(req, config) {
  if (config.sharePublicUrl !== 'auto') return config.sharePublicUrl;
  const forwardedProto = config.trustProxy ? String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() : '';
  const protocol = forwardedProto || (req.socket.encrypted ? 'https' : 'http');
  let hostname;
  try { hostname = new URL(`${protocol}://${req.headers.host || 'localhost'}`).hostname; }
  catch { hostname = 'localhost'; }
  const defaultPort = protocol === 'https' ? 443 : 80;
  const port = config.sharePublicPort === defaultPort ? '' : `:${config.sharePublicPort}`;
  return `${protocol}://${hostname}${port}`;
}

function assertInteger(value, name, min, max) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new HttpError(400, `${name}无效`);
  return parsed;
}

function validateAdminPassword(config) {
  return config.adminPassword !== 'change-me-now' && config.adminPassword.length >= 12;
}

export function createPortalServer({ config, store, shareClient }) {
  const router = new Router();
  const limiter = new RateLimiter();
  const staticFiles = new Map([
    ['/', ['index.html', 'text/html; charset=utf-8']],
    ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
    ['/pay.js', ['pay.js', 'text/javascript; charset=utf-8']],
    ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
    ['/favicon.svg', ['favicon.svg', 'image/svg+xml']]
  ]);
  const staticRoot = join(__dirname, 'static');

  function currentSession(req) {
    const token = parseCookies(req.headers.cookie).portal_session;
    return { token, session: store.getSession(token) };
  }

  function guard(handler, { admin = false, csrf = true } = {}) {
    return async (req, res, context) => {
      const auth = currentSession(req);
      if (!auth.session || auth.session.user.disabled) throw new HttpError(401, '请先登录');
      if (admin && !auth.session.user.isAdmin) throw new HttpError(403, '需要管理员权限');
      if (csrf && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
        const provided = req.headers['x-csrf-token'];
        if (!provided || !safeEqual(provided, auth.session.csrfToken)) throw new HttpError(403, '页面凭证已失效，请刷新后重试');
      }
      return handler(req, res, { ...context, ...auth, user: auth.session.user });
    };
  }

  router.add('GET', '/healthz', async (_req, res) => sendJson(res, 200, { status: 'ok', time: new Date().toISOString() }));

  router.add('GET', '/api/config', async (_req, res) => sendJson(res, 200, {
    siteName: config.siteName,
    registrationEnabled: config.registrationEnabled,
    paymentEnabled: paymentEnabled(config.epay),
    sharePublicUrl: config.sharePublicUrl,
    defaultAdminSecure: validateAdminPassword(config)
  }));

  router.add('POST', '/api/register', async (req, res) => {
    if (!config.registrationEnabled) throw new HttpError(403, '站点暂未开放注册');
    if (!limiter.consume(`register:${clientIp(req, config)}`, 8, 15 * 60_000)) throw new HttpError(429, '注册尝试过于频繁，请稍后重试');
    const body = await readBody(req);
    let email;
    try { email = normalizeEmail(body.email); } catch (error) { throw new HttpError(400, error.message); }
    if (String(body.password || '').length < 8) throw new HttpError(400, '密码至少需要 8 位');
    const expiresAt = new Date(Date.now() + config.trialHours * 3600_000).toISOString();
    let user;
    try {
      user = store.createUser({
        email,
        name: sanitizeName(body.name, email.split('@')[0]),
        password: String(body.password || ''),
        tier: 'normal',
        expiresAt
      });
    } catch (error) { throw new HttpError(409, error.message); }
    const session = store.createSession(user.id, config.sessionHours);
    res.setHeader('set-cookie', cookieValue(config, session.rawToken, config.sessionHours * 3600));
    sendJson(res, 201, { user: publicUser(user), csrfToken: session.csrfToken });
  });

  router.add('POST', '/api/login', async (req, res) => {
    const ip = clientIp(req, config);
    if (!limiter.consume(`login:${ip}`, 15, 15 * 60_000)) throw new HttpError(429, '登录尝试过于频繁，请稍后重试');
    const body = await readBody(req);
    const user = store.getUserByEmail(body.email);
    if (!user || !verifyPassword(String(body.password || ''), user.passwordHash)) throw new HttpError(401, '邮箱或密码错误');
    if (user.disabled) throw new HttpError(403, '账号已被停用');
    const session = store.createSession(user.id, config.sessionHours);
    res.setHeader('set-cookie', cookieValue(config, session.rawToken, config.sessionHours * 3600));
    sendJson(res, 200, { user: publicUser(user), csrfToken: session.csrfToken });
  });

  router.add('POST', '/api/logout', guard(async (_req, res, context) => {
    store.deleteSession(context.token);
    res.setHeader('set-cookie', cookieValue(config, '', 0));
    sendJson(res, 200, { ok: true });
  }));

  router.add('GET', '/api/me', guard(async (_req, res, context) => sendJson(res, 200, {
    user: publicUser(context.user),
    csrfToken: context.session.csrfToken
  }), { csrf: false }));

  router.add('POST', '/api/account/password', guard(async (req, res, context) => {
    const body = await readBody(req);
    if (!verifyPassword(String(body.currentPassword || ''), context.user.passwordHash)) throw new HttpError(400, '当前密码不正确');
    try { store.setUserPassword(context.user.id, String(body.newPassword || '')); }
    catch (error) { throw new HttpError(400, error.message); }
    store.deleteUserSessions(context.user.id);
    res.setHeader('set-cookie', cookieValue(config, '', 0));
    sendJson(res, 200, { ok: true, relogin: true });
  }));

  router.add('GET', '/api/plans', guard(async (_req, res) => sendJson(res, 200, {
    plans: store.listPlans({ activeOnly: true }),
    paymentEnabled: paymentEnabled(config.epay)
  }), { csrf: false }));

  router.add('GET', '/api/cars', guard(async (_req, res, context) => {
    try {
      const cars = await shareClient.listCars();
      sendJson(res, 200, { cars: allowedCarsForUser(cars, context.user) });
    } catch (error) {
      throw new HttpError(502, `无法读取 XYHelper 车队：${error.message}`);
    }
  }, { csrf: false }));

  router.add('POST', '/api/handoff', guard(async (req, res, context) => {
    if (!limiter.consume(`handoff:${context.user.id}`, 30, 60_000)) throw new HttpError(429, '进入车队过于频繁');
    const body = await readBody(req);
    const carId = String(body.carid || '').trim();
    if (!carId) throw new HttpError(400, '请选择车队');
    let car;
    try { car = await shareClient.getCar(carId); } catch (error) { throw new HttpError(502, error.message); }
    if (!car) throw new HttpError(404, '车队不存在');
    if (!car.status) throw new HttpError(409, '该车队当前处于离线或维护状态');
    if (!canUseCar(context.user, car)) throw new HttpError(403, '当前套餐无权使用该车队，或账号已经到期');
    const handoff = store.createHandoff(context.user.id, car.carID, config.handoffMinutes);
    const url = new URL('/auth/logintoken', `${effectiveSharePublicUrl(req, config)}/`);
    url.searchParams.set('usertoken', handoff.rawToken);
    url.searchParams.set('carid', car.carID);
    sendJson(res, 200, { url: url.toString(), expiresAt: handoff.expiresAt });
  }));

  router.add('POST', '/api/redeem', guard(async (req, res, context) => {
    const body = await readBody(req);
    try {
      const result = store.redeemCode(context.user.id, body.code);
      sendJson(res, 200, { user: publicUser(result.user), code: result.code.code });
    } catch (error) { throw new HttpError(400, error.message); }
  }));

  router.add('GET', '/api/orders', guard(async (_req, res, context) => sendJson(res, 200, {
    orders: store.listOrders(context.user.id)
  }), { csrf: false }));

  router.add('POST', '/api/orders', guard(async (req, res, context) => {
    if (!paymentEnabled(config.epay)) throw new HttpError(503, '站点尚未配置支付渠道，请使用兑换码或联系管理员');
    const body = await readBody(req);
    let order;
    try { order = store.createOrder(context.user.id, String(body.planId || ''), 'epay'); }
    catch (error) { throw new HttpError(400, error.message); }
    sendJson(res, 201, { order, paymentUrl: `${config.portalPublicUrl}/pay/epay/${encodeURIComponent(order.id)}` });
  }));

  router.add('GET', '/pay/epay/:id', guard(async (_req, res, context) => {
    const order = store.getOrder(context.params.id);
    if (!order || order.userId !== context.user.id) throw new HttpError(404, '订单不存在');
    if (order.status !== 'pending') throw new HttpError(400, '订单已经处理');
    const plan = store.getPlan(order.planId);
    const fields = buildEpayFields({ epay: config.epay, order, plan, portalPublicUrl: config.portalPublicUrl });
    sendText(res, 200, renderAutoSubmitForm(config.epay.url, fields), 'text/html; charset=utf-8');
  }, { csrf: false }));

  async function epayNotify(req, res, context) {
    if (!paymentEnabled(config.epay)) return sendText(res, 503, 'fail');
    let params;
    if (req.method === 'GET') params = context.url.searchParams;
    else params = new URLSearchParams(Object.entries(await readBody(req)).map(([key, value]) => [key, String(value)]));
    try {
      if (!verifyEpaySign(params, config.epay.key, config.epay.signMode)) throw new Error('签名不正确');
      if (!safeEqual(params.get('pid') || '', config.epay.pid)) throw new Error('商户号不匹配');
      if (!['TRADE_SUCCESS', 'SUCCESS'].includes(params.get('trade_status') || '')) throw new Error('支付状态未成功');
      const order = store.getOrder(params.get('out_trade_no'));
      if (!order) throw new Error('订单不存在');
      if (moneyToCents(params.get('money')) !== order.amountCents) throw new Error('订单金额不匹配');
      store.markOrderPaidAndActivate(order.id, params.get('trade_no') || '');
      sendText(res, 200, 'success');
    } catch (error) {
      console.warn('[portal] rejected epay callback:', error.message);
      sendText(res, 400, 'fail');
    }
  }
  router.add('GET', '/api/payments/epay/notify', epayNotify);
  router.add('POST', '/api/payments/epay/notify', epayNotify);

  router.add('POST', '/api/xyhelper/oauth', async (req, res, context) => {
    const secret = context.url.searchParams.get('secret') || req.headers['x-xyhelper-secret'] || '';
    if (!secret || !safeEqual(secret, config.oauthSecret)) throw new HttpError(403, '授权服务密钥不正确');
    const body = await readBody(req);
    const token = String(body.usertoken || '').trim();
    const requestedCar = String(body.carid || '').trim();
    let user = null;
    let carId = requestedCar;
    if (token.startsWith('ho_')) {
      const handoff = store.getHandoff(token);
      if (!handoff || handoff.carId !== requestedCar) return sendJson(res, 200, { code: 0, msg: '登录链接无效或已过期' });
      user = store.getUserById(handoff.userId);
      carId = handoff.carId;
    } else {
      user = store.getUserByShareToken(token);
    }
    if (!user) return sendJson(res, 200, { code: 0, msg: '用户不存在' });
    if (user.disabled) return sendJson(res, 200, { code: 0, msg: '账号已被停用' });
    if (new Date(user.expiresAt).getTime() <= Date.now()) return sendJson(res, 200, { code: 0, msg: '套餐已经到期' });
    try {
      const car = await shareClient.getCar(carId);
      if (!car) return sendJson(res, 200, { code: 0, msg: '车队不存在' });
      if (!car.status) return sendJson(res, 200, { code: 0, msg: '车队当前不可用' });
      if (!canUseCar(user, car)) return sendJson(res, 200, { code: 0, msg: '当前套餐无权使用该车队' });
    } catch (error) {
      console.error('[portal] oauth car check failed:', error);
      return sendJson(res, 200, { code: 0, msg: '暂时无法验证车队状态，请稍后重试' });
    }
    sendJson(res, 200, {
      code: 1,
      msg: '登录成功',
      usertoken: user.shareToken,
      carid: carId,
      expireTime: formatShareTime(user.expiresAt)
    });
  });

  router.add('GET', '/api/admin/overview', guard(async (_req, res) => sendJson(res, 200, store.overview()), { admin: true, csrf: false }));

  router.add('GET', '/api/admin/users', guard(async (_req, res, context) => {
    const query = context.url.searchParams.get('query') || '';
    sendJson(res, 200, { users: store.listUsers(query).map((user) => publicUser(user, { adminView: true })) });
  }, { admin: true, csrf: false }));

  router.add('PATCH', '/api/admin/users/:id', guard(async (req, res, context) => {
    const body = await readBody(req);
    let user;
    try {
      user = store.updateUser(context.params.id, {
        name: body.name,
        tier: body.tier,
        allowedCars: body.allowedCars,
        expiresAt: body.expiresAt,
        disabled: body.disabled,
        isAdmin: body.isAdmin
      });
    } catch (error) { throw new HttpError(400, error.message); }
    sendJson(res, 200, { user: publicUser(user, { adminView: true }) });
  }, { admin: true }));

  router.add('POST', '/api/admin/users/:id/extend', guard(async (req, res, context) => {
    const body = await readBody(req);
    const days = assertInteger(body.days, '天数', 1, 3650);
    try {
      const user = store.activateUser(context.params.id, days, body.tier || 'normal');
      sendJson(res, 200, { user: publicUser(user, { adminView: true }) });
    } catch (error) { throw new HttpError(400, error.message); }
  }, { admin: true }));

  router.add('POST', '/api/admin/users/:id/reset-token', guard(async (_req, res, context) => {
    const user = store.resetShareToken(context.params.id);
    sendJson(res, 200, { user: publicUser(user, { adminView: true }) });
  }, { admin: true }));

  router.add('POST', '/api/admin/users/:id/reset-password', guard(async (req, res, context) => {
    const body = await readBody(req);
    try { store.setUserPassword(context.params.id, String(body.password || '')); }
    catch (error) { throw new HttpError(400, error.message); }
    store.deleteUserSessions(context.params.id);
    sendJson(res, 200, { ok: true });
  }, { admin: true }));

  router.add('GET', '/api/admin/plans', guard(async (_req, res) => sendJson(res, 200, { plans: store.listPlans() }), { admin: true, csrf: false }));

  router.add('POST', '/api/admin/plans', guard(async (req, res) => {
    const body = await readBody(req);
    try { sendJson(res, 201, { plan: store.upsertPlan(body) }); }
    catch (error) { throw new HttpError(400, error.message); }
  }, { admin: true }));

  router.add('PATCH', '/api/admin/plans/:id', guard(async (req, res, context) => {
    const existing = store.getPlan(context.params.id);
    if (!existing) throw new HttpError(404, '套餐不存在');
    const body = await readBody(req);
    try { sendJson(res, 200, { plan: store.upsertPlan({ ...existing, ...body, id: existing.id }) }); }
    catch (error) { throw new HttpError(400, error.message); }
  }, { admin: true }));

  router.add('DELETE', '/api/admin/plans/:id', guard(async (_req, res, context) => {
    store.deactivatePlan(context.params.id);
    sendJson(res, 200, { ok: true });
  }, { admin: true }));

  router.add('GET', '/api/admin/codes', guard(async (_req, res) => sendJson(res, 200, { codes: store.listCodes() }), { admin: true, csrf: false }));

  router.add('POST', '/api/admin/codes', guard(async (req, res) => {
    const body = await readBody(req);
    try { sendJson(res, 201, { codes: store.createCodes(body) }); }
    catch (error) { throw new HttpError(400, error.message); }
  }, { admin: true }));

  router.add('DELETE', '/api/admin/codes/:code', guard(async (_req, res, context) => {
    store.deleteCode(context.params.code);
    sendJson(res, 200, { ok: true });
  }, { admin: true }));

  router.add('GET', '/api/admin/orders', guard(async (_req, res) => {
    const users = new Map(store.listUsers().map((user) => [user.id, user]));
    const plans = new Map(store.listPlans().map((plan) => [plan.id, plan]));
    const orders = store.listOrders().map((order) => ({
      ...order,
      userEmail: users.get(order.userId)?.email || '已删除用户',
      planName: plans.get(order.planId)?.name || order.planId
    }));
    sendJson(res, 200, { orders });
  }, { admin: true, csrf: false }));

  const server = createServer(async (req, res) => {
    const startedAt = Date.now();
    try {
      res.setHeader('x-content-type-options', 'nosniff');
      res.setHeader('x-frame-options', 'DENY');
      res.setHeader('referrer-policy', 'same-origin');
      res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()');
      res.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self' https:");
      if (config.cookieSecure) res.setHeader('strict-transport-security', 'max-age=31536000; includeSubDomains');

      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const staticEntry = staticFiles.get(url.pathname);
      if (req.method === 'GET' && staticEntry) {
        const [fileName, type] = staticEntry;
        const body = readFileSync(join(staticRoot, fileName));
        res.writeHead(200, {
          'content-type': type,
          'content-length': body.length,
          'cache-control': fileName === 'index.html' ? 'no-cache' : 'public, max-age=3600'
        });
        res.end(body);
        return;
      }

      const match = router.match(req.method, url.pathname);
      if (!match) throw new HttpError(404, '接口不存在');
      await match.handler(req, res, { url, params: match.params });
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      if (status >= 500) console.error('[portal] request failed:', error);
      if (!res.headersSent) sendJson(res, status, { error: status === 500 ? '服务器内部错误' : error.message });
      else if (!res.writableEnded) res.end();
    } finally {
      if (Date.now() - startedAt > 1000) console.warn(`[portal] slow request ${req.method} ${req.url}: ${Date.now() - startedAt}ms`);
    }
  });

  return server;
}
