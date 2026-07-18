import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  hashPassword,
  normalizeEmail,
  normalizeTier,
  randomToken,
  sanitizeName,
  sha256
} from './security.mjs';

function nowIso() {
  return new Date().toISOString();
}

function parseArray(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function rowToUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    passwordHash: row.password_hash,
    shareToken: row.share_token,
    tier: row.tier,
    allowedCars: parseArray(row.allowed_cars),
    expiresAt: row.expires_at,
    disabled: Boolean(row.disabled),
    isAdmin: Boolean(row.is_admin),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function rowToPlan(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    tier: row.tier,
    days: row.days,
    priceCents: row.price_cents,
    currency: row.currency,
    active: Boolean(row.active),
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function rowToCode(row) {
  if (!row) return null;
  return {
    code: row.code,
    planId: row.plan_id,
    days: row.days,
    tier: row.tier,
    maxUses: row.max_uses,
    uses: row.uses,
    expiresAt: row.expires_at,
    createdAt: row.created_at
  };
}

function rowToOrder(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    planId: row.plan_id,
    planDays: row.plan_days,
    planTier: row.plan_tier,
    provider: row.provider,
    amountCents: row.amount_cents,
    currency: row.currency,
    status: row.status,
    tradeNo: row.trade_no,
    createdAt: row.created_at,
    paidAt: row.paid_at
  };
}

export class Store {
  constructor(path, config) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    if (path !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    this.migrate();
    this.seed(config);
  }

  close() {
    this.db.close();
  }

  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = fn();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        share_token TEXT NOT NULL UNIQUE,
        tier TEXT NOT NULL DEFAULT 'normal' CHECK (tier IN ('normal', 'plus')),
        allowed_cars TEXT NOT NULL DEFAULT '[]',
        expires_at TEXT NOT NULL,
        disabled INTEGER NOT NULL DEFAULT 0,
        is_admin INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        csrf_token TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);

      CREATE TABLE IF NOT EXISTS plans (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        tier TEXT NOT NULL CHECK (tier IN ('normal', 'plus')),
        days INTEGER NOT NULL CHECK (days > 0),
        price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
        currency TEXT NOT NULL DEFAULT 'CNY',
        active INTEGER NOT NULL DEFAULT 1,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS redemption_codes (
        code TEXT PRIMARY KEY,
        plan_id TEXT REFERENCES plans(id) ON DELETE SET NULL,
        days INTEGER NOT NULL CHECK (days > 0),
        tier TEXT NOT NULL CHECK (tier IN ('normal', 'plus')),
        max_uses INTEGER NOT NULL DEFAULT 1 CHECK (max_uses > 0),
        uses INTEGER NOT NULL DEFAULT 0 CHECK (uses >= 0),
        expires_at TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS redemptions (
        code TEXT NOT NULL REFERENCES redemption_codes(code) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        redeemed_at TEXT NOT NULL,
        PRIMARY KEY (code, user_id)
      );

      CREATE TABLE IF NOT EXISTS orders (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE RESTRICT,
        plan_days INTEGER NOT NULL CHECK (plan_days > 0),
        plan_tier TEXT NOT NULL CHECK (plan_tier IN ('normal', 'plus')),
        provider TEXT NOT NULL,
        amount_cents INTEGER NOT NULL,
        currency TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'cancelled', 'failed')),
        trade_no TEXT,
        created_at TEXT NOT NULL,
        paid_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_trade_no ON orders(trade_no)
        WHERE trade_no IS NOT NULL AND trade_no <> '';

      CREATE TABLE IF NOT EXISTS handoffs (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        car_id TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_handoffs_expiry ON handoffs(expires_at);

      CREATE TABLE IF NOT EXISTS schema_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT OR REPLACE INTO schema_meta(key, value) VALUES ('version', '3');
    `);

    // v3 snapshots purchased entitlements so later plan edits cannot alter paid orders.
    const orderColumns = new Set(this.db.prepare('PRAGMA table_info(orders)').all().map((row) => row.name));
    if (!orderColumns.has('plan_days')) this.db.exec('ALTER TABLE orders ADD COLUMN plan_days INTEGER;');
    if (!orderColumns.has('plan_tier')) this.db.exec('ALTER TABLE orders ADD COLUMN plan_tier TEXT;');
    this.db.exec(`
      UPDATE orders
      SET plan_days = COALESCE(plan_days, (SELECT days FROM plans WHERE plans.id = orders.plan_id), 1),
          plan_tier = COALESCE(plan_tier, (SELECT tier FROM plans WHERE plans.id = orders.plan_id), 'normal')
      WHERE plan_days IS NULL OR plan_tier IS NULL;
    `);
  }

  seed(config) {
    const admin = this.getUserByEmail(config.adminEmail);
    if (!admin) {
      this.createUser({
        email: config.adminEmail,
        name: '管理员',
        password: config.adminPassword,
        tier: 'plus',
        expiresAt: new Date(Date.now() + 10 * 365 * 86400_000).toISOString(),
        isAdmin: true
      });
    } else if (!admin.isAdmin) {
      this.db.prepare('UPDATE users SET is_admin = 1, updated_at = ? WHERE id = ?').run(nowIso(), admin.id);
    }

    const { count } = this.db.prepare('SELECT COUNT(*) AS count FROM plans').get();
    if (count === 0) {
      this.upsertPlan({
        id: 'basic-month',
        name: '示例基础月卡',
        description: '普通车队，30 天有效期；请在后台修改名称和价格。',
        tier: 'normal',
        days: 30,
        priceCents: 990,
        currency: 'CNY',
        active: true,
        sortOrder: 10
      });
      this.upsertPlan({
        id: 'plus-month',
        name: '示例 Plus 月卡',
        description: '普通及 Plus 车队，30 天有效期；请在后台修改。',
        tier: 'plus',
        days: 30,
        priceCents: 1990,
        currency: 'CNY',
        active: true,
        sortOrder: 20
      });
    }
  }

  createUser({ email, name, password, tier = 'normal', expiresAt, isAdmin = false }) {
    const createdAt = nowIso();
    const user = {
      id: randomToken(16, 'usr_'),
      email: normalizeEmail(email),
      name: sanitizeName(name, String(email).split('@')[0]),
      passwordHash: hashPassword(password),
      shareToken: randomToken(24, 'xyu_'),
      tier: normalizeTier(tier),
      allowedCars: [],
      expiresAt: expiresAt || createdAt,
      disabled: false,
      isAdmin: Boolean(isAdmin),
      createdAt,
      updatedAt: createdAt
    };
    try {
      this.db.prepare(`
        INSERT INTO users (
          id, email, name, password_hash, share_token, tier, allowed_cars,
          expires_at, disabled, is_admin, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        user.id, user.email, user.name, user.passwordHash, user.shareToken,
        user.tier, '[]', user.expiresAt, 0, user.isAdmin ? 1 : 0,
        user.createdAt, user.updatedAt
      );
    } catch (error) {
      if (String(error.message).includes('UNIQUE')) throw new Error('该邮箱已经注册');
      throw error;
    }
    return user;
  }

  getUserById(id) {
    return rowToUser(this.db.prepare('SELECT * FROM users WHERE id = ?').get(id));
  }

  getUserByEmail(email) {
    let value;
    try { value = normalizeEmail(email); } catch { return null; }
    return rowToUser(this.db.prepare('SELECT * FROM users WHERE email = ?').get(value));
  }

  getUserByShareToken(token) {
    return rowToUser(this.db.prepare('SELECT * FROM users WHERE share_token = ?').get(token));
  }

  listUsers(query = '') {
    const value = `%${String(query).trim().toLowerCase()}%`;
    const rows = this.db.prepare(`
      SELECT * FROM users
      WHERE lower(email) LIKE ? OR lower(name) LIKE ? OR share_token LIKE ?
      ORDER BY created_at DESC LIMIT 500
    `).all(value, value, value);
    return rows.map(rowToUser);
  }

  updateUser(id, patch) {
    const user = this.getUserById(id);
    if (!user) throw new Error('用户不存在');
    const updated = {
      name: patch.name === undefined ? user.name : sanitizeName(patch.name, user.name),
      tier: patch.tier === undefined ? user.tier : normalizeTier(patch.tier),
      allowedCars: patch.allowedCars === undefined
        ? user.allowedCars
        : [...new Set((Array.isArray(patch.allowedCars) ? patch.allowedCars : []).map(String).map((v) => v.trim()).filter(Boolean))].slice(0, 200),
      expiresAt: patch.expiresAt === undefined ? user.expiresAt : new Date(patch.expiresAt).toISOString(),
      disabled: patch.disabled === undefined ? user.disabled : Boolean(patch.disabled),
      isAdmin: patch.isAdmin === undefined ? user.isAdmin : Boolean(patch.isAdmin)
    };
    if (user.isAdmin && !user.disabled && (!updated.isAdmin || updated.disabled)) {
      const { count } = this.db.prepare(
        'SELECT COUNT(*) AS count FROM users WHERE is_admin = 1 AND disabled = 0 AND id <> ?'
      ).get(id);
      if (count === 0) throw new Error('至少需要保留一个未停用的管理员账号');
    }
    this.db.prepare(`
      UPDATE users SET name = ?, tier = ?, allowed_cars = ?, expires_at = ?,
        disabled = ?, is_admin = ?, updated_at = ? WHERE id = ?
    `).run(
      updated.name, updated.tier, JSON.stringify(updated.allowedCars), updated.expiresAt,
      updated.disabled ? 1 : 0, updated.isAdmin ? 1 : 0, nowIso(), id
    );
    return this.getUserById(id);
  }

  setUserPassword(id, password) {
    const result = this.db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?')
      .run(hashPassword(password), nowIso(), id);
    if (result.changes !== 1) throw new Error('用户不存在');
  }

  resetShareToken(id) {
    const token = randomToken(24, 'xyu_');
    const result = this.db.prepare('UPDATE users SET share_token = ?, updated_at = ? WHERE id = ?')
      .run(token, nowIso(), id);
    if (result.changes !== 1) throw new Error('用户不存在');
    return this.getUserById(id);
  }

  activateUser(id, days, tier) {
    if (!Number.isInteger(days) || days < 1 || days > 3650) throw new Error('有效天数必须在 1 到 3650 之间');
    const user = this.getUserById(id);
    if (!user) throw new Error('用户不存在');
    const current = new Date(user.expiresAt).getTime();
    const base = Math.max(Date.now(), Number.isFinite(current) ? current : 0);
    return this.updateUser(id, {
      tier: normalizeTier(tier),
      expiresAt: new Date(base + days * 86400_000).toISOString(),
      disabled: false
    });
  }

  createSession(userId, hours) {
    const rawToken = randomToken(32, 'ses_');
    const session = {
      tokenHash: sha256(rawToken),
      rawToken,
      userId,
      csrfToken: randomToken(24, 'csrf_'),
      expiresAt: new Date(Date.now() + hours * 3600_000).toISOString(),
      createdAt: nowIso()
    };
    this.db.prepare('INSERT INTO sessions(token_hash, user_id, csrf_token, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(session.tokenHash, userId, session.csrfToken, session.expiresAt, session.createdAt);
    return session;
  }

  getSession(rawToken) {
    if (!rawToken) return null;
    const row = this.db.prepare(`
      SELECT s.token_hash, s.user_id, s.csrf_token, s.expires_at, s.created_at,
        u.id AS u_id, u.email, u.name, u.password_hash, u.share_token, u.tier,
        u.allowed_cars, u.expires_at AS u_expires_at, u.disabled, u.is_admin,
        u.created_at AS u_created_at, u.updated_at AS u_updated_at
      FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ?
    `).get(sha256(rawToken), nowIso());
    if (!row) return null;
    return {
      tokenHash: row.token_hash,
      userId: row.user_id,
      csrfToken: row.csrf_token,
      expiresAt: row.expires_at,
      createdAt: row.created_at,
      user: rowToUser({
        id: row.u_id,
        email: row.email,
        name: row.name,
        password_hash: row.password_hash,
        share_token: row.share_token,
        tier: row.tier,
        allowed_cars: row.allowed_cars,
        expires_at: row.u_expires_at,
        disabled: row.disabled,
        is_admin: row.is_admin,
        created_at: row.u_created_at,
        updated_at: row.u_updated_at
      })
    };
  }

  deleteSession(rawToken) {
    if (rawToken) this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(rawToken));
  }

  deleteUserSessions(userId) {
    this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  }

  listPlans({ activeOnly = false } = {}) {
    const rows = this.db.prepare(`SELECT * FROM plans ${activeOnly ? 'WHERE active = 1' : ''} ORDER BY sort_order, price_cents, created_at`).all();
    return rows.map(rowToPlan);
  }

  getPlan(id) {
    return rowToPlan(this.db.prepare('SELECT * FROM plans WHERE id = ?').get(id));
  }

  upsertPlan(input) {
    const id = String(input.id || randomToken(10, 'plan_')).trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]{2,39}$/.test(id)) throw new Error('套餐 ID 只能包含小写字母、数字、下划线和连字符');
    const plan = {
      id,
      name: sanitizeName(input.name, '未命名套餐'),
      description: String(input.description || '').trim().slice(0, 300),
      tier: normalizeTier(input.tier || 'normal'),
      days: Number(input.days),
      priceCents: Number(input.priceCents),
      currency: String(input.currency || 'CNY').trim().toUpperCase().slice(0, 8),
      active: input.active === undefined ? true : Boolean(input.active),
      sortOrder: Number(input.sortOrder || 0)
    };
    if (!Number.isInteger(plan.days) || plan.days < 1 || plan.days > 3650) throw new Error('套餐天数必须在 1 到 3650 之间');
    if (!Number.isInteger(plan.priceCents) || plan.priceCents < 0 || plan.priceCents > 100_000_000) throw new Error('套餐价格无效');
    if (!/^[A-Z]{3}$/.test(plan.currency)) throw new Error('货币代码必须是 3 位大写字母，例如 CNY');
    if (!Number.isInteger(plan.sortOrder)) plan.sortOrder = 0;
    const timestamp = nowIso();
    this.db.prepare(`
      INSERT INTO plans(id, name, description, tier, days, price_cents, currency, active, sort_order, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description,
        tier = excluded.tier, days = excluded.days, price_cents = excluded.price_cents,
        currency = excluded.currency, active = excluded.active, sort_order = excluded.sort_order,
        updated_at = excluded.updated_at
    `).run(
      plan.id, plan.name, plan.description, plan.tier, plan.days, plan.priceCents,
      plan.currency, plan.active ? 1 : 0, plan.sortOrder, timestamp, timestamp
    );
    return this.getPlan(plan.id);
  }

  deactivatePlan(id) {
    const result = this.db.prepare('UPDATE plans SET active = 0, updated_at = ? WHERE id = ?').run(nowIso(), id);
    if (result.changes !== 1) throw new Error('套餐不存在');
  }

  createCodes({ count = 1, planId = null, days, tier, maxUses = 1, expiresAt = null, prefix = 'XY' }) {
    const plan = planId ? this.getPlan(planId) : null;
    const finalDays = Number(days || plan?.days);
    const finalTier = normalizeTier(tier || plan?.tier || 'normal');
    const total = Number(count);
    const uses = Number(maxUses);
    if (!Number.isInteger(total) || total < 1 || total > 100) throw new Error('每次只能生成 1 到 100 个兑换码');
    if (!Number.isInteger(finalDays) || finalDays < 1 || finalDays > 3650) throw new Error('兑换天数无效');
    if (!Number.isInteger(uses) || uses < 1 || uses > 10000) throw new Error('最大使用次数无效');
    const expiry = expiresAt ? new Date(expiresAt).toISOString() : null;
    const cleanPrefix = String(prefix || 'XY').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8) || 'XY';
    const created = [];
    this.transaction(() => {
      const stmt = this.db.prepare(`
        INSERT INTO redemption_codes(code, plan_id, days, tier, max_uses, uses, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?, 0, ?, ?)
      `);
      for (let index = 0; index < total; index += 1) {
        const code = `${cleanPrefix}-${randomToken(9).toUpperCase()}`;
        stmt.run(code, plan?.id || null, finalDays, finalTier, uses, expiry, nowIso());
        created.push(this.getCode(code));
      }
    });
    return created;
  }

  getCode(code) {
    return rowToCode(this.db.prepare('SELECT * FROM redemption_codes WHERE code = ?').get(String(code).trim().toUpperCase()));
  }

  listCodes() {
    return this.db.prepare('SELECT * FROM redemption_codes ORDER BY created_at DESC LIMIT 1000').all().map(rowToCode);
  }

  deleteCode(code) {
    this.db.prepare('DELETE FROM redemption_codes WHERE code = ?').run(String(code).trim().toUpperCase());
  }

  redeemCode(userId, rawCode) {
    const codeValue = String(rawCode || '').trim().toUpperCase();
    return this.transaction(() => {
      const code = this.getCode(codeValue);
      if (!code) throw new Error('兑换码不存在');
      if (code.uses >= code.maxUses) throw new Error('兑换码已达到使用次数');
      if (code.expiresAt && new Date(code.expiresAt).getTime() <= Date.now()) throw new Error('兑换码已经过期');
      const existing = this.db.prepare('SELECT 1 AS found FROM redemptions WHERE code = ? AND user_id = ?').get(codeValue, userId);
      if (existing) throw new Error('当前账号已经使用过这个兑换码');
      const result = this.db.prepare('UPDATE redemption_codes SET uses = uses + 1 WHERE code = ? AND uses < max_uses').run(codeValue);
      if (result.changes !== 1) throw new Error('兑换码已经失效');
      this.db.prepare('INSERT INTO redemptions(code, user_id, redeemed_at) VALUES (?, ?, ?)').run(codeValue, userId, nowIso());
      const user = this.activateUser(userId, code.days, code.tier);
      return { user, code: this.getCode(codeValue) };
    });
  }

  createOrder(userId, planId, provider = 'epay') {
    const plan = this.getPlan(planId);
    if (!plan || !plan.active) throw new Error('套餐不存在或已下架');
    if (plan.priceCents <= 0) throw new Error('零元套餐不能通过支付接口购买');
    const order = {
      id: randomToken(14, 'ord_'),
      userId,
      planId: plan.id,
      planDays: plan.days,
      planTier: plan.tier,
      provider,
      amountCents: plan.priceCents,
      currency: plan.currency,
      status: 'pending',
      tradeNo: null,
      createdAt: nowIso(),
      paidAt: null
    };
    this.db.prepare(`
      INSERT INTO orders(
        id, user_id, plan_id, plan_days, plan_tier, provider,
        amount_cents, currency, status, trade_no, created_at, paid_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL)
    `).run(
      order.id, order.userId, order.planId, order.planDays, order.planTier,
      order.provider, order.amountCents, order.currency, order.status, order.createdAt
    );
    return order;
  }

  getOrder(id) {
    return rowToOrder(this.db.prepare('SELECT * FROM orders WHERE id = ?').get(id));
  }

  listOrders(userId = null) {
    const rows = userId
      ? this.db.prepare('SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC LIMIT 500').all(userId)
      : this.db.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT 1000').all();
    return rows.map(rowToOrder);
  }

  markOrderPaidAndActivate(orderId, tradeNo = '') {
    return this.transaction(() => {
      const order = this.getOrder(orderId);
      if (!order) throw new Error('订单不存在');
      if (order.status === 'paid') return { order, user: this.getUserById(order.userId), activated: false };
      if (order.status !== 'pending') throw new Error('订单状态不允许支付');
      const plan = this.getPlan(order.planId);
      const days = Number(order.planDays || plan?.days);
      const tier = order.planTier || plan?.tier;
      if (!Number.isInteger(days) || !tier) throw new Error('订单套餐不存在');
      const paidAt = nowIso();
      this.db.prepare("UPDATE orders SET status = 'paid', trade_no = ?, paid_at = ? WHERE id = ? AND status = 'pending'")
        .run(String(tradeNo).slice(0, 160), paidAt, orderId);
      const user = this.activateUser(order.userId, days, tier);
      return { order: this.getOrder(orderId), user, activated: true };
    });
  }

  createHandoff(userId, carId, minutes) {
    const rawToken = randomToken(24, 'ho_');
    const record = {
      tokenHash: sha256(rawToken),
      rawToken,
      userId,
      carId: String(carId),
      expiresAt: new Date(Date.now() + minutes * 60_000).toISOString(),
      createdAt: nowIso()
    };
    this.db.prepare('INSERT INTO handoffs(token_hash, user_id, car_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(record.tokenHash, record.userId, record.carId, record.expiresAt, record.createdAt);
    return record;
  }

  getHandoff(rawToken) {
    if (!rawToken) return null;
    const row = this.db.prepare('SELECT * FROM handoffs WHERE token_hash = ? AND expires_at > ?').get(sha256(rawToken), nowIso());
    if (!row) return null;
    return {
      tokenHash: row.token_hash,
      userId: row.user_id,
      carId: row.car_id,
      expiresAt: row.expires_at,
      createdAt: row.created_at
    };
  }

  cleanup() {
    const now = nowIso();
    this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
    this.db.prepare('DELETE FROM handoffs WHERE expires_at <= ?').run(now);
    this.db.prepare("UPDATE orders SET status = 'cancelled' WHERE status = 'pending' AND created_at < ?")
      .run(new Date(Date.now() - 24 * 3600_000).toISOString());
  }

  overview() {
    const one = (sql) => this.db.prepare(sql).get().count;
    return {
      users: one('SELECT COUNT(*) AS count FROM users'),
      activeUsers: this.db.prepare(
        'SELECT COUNT(*) AS count FROM users WHERE disabled = 0 AND expires_at > ?'
      ).get(nowIso()).count,
      pendingOrders: one("SELECT COUNT(*) AS count FROM orders WHERE status = 'pending'"),
      paidOrders: one("SELECT COUNT(*) AS count FROM orders WHERE status = 'paid'")
    };
  }
}
