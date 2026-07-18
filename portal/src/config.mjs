import { randomToken } from './security.mjs';

function integer(name, fallback, { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function bool(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw.toLowerCase())) return true;
  if (['0', 'false', 'no', 'off'].includes(raw.toLowerCase())) return false;
  throw new Error(`${name} must be true or false`);
}

function url(name, fallback) {
  const value = process.env[name] || fallback;
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('unsupported protocol');
    return parsed.toString().replace(/\/$/, '');
  } catch {
    throw new Error(`${name} must be a valid HTTP(S) URL`);
  }
}

function optionalUrl(name) {
  const value = (process.env[name] || '').trim();
  return value ? url(name, value) : '';
}

export function loadConfig() {
  const oauthSecret = process.env.OAUTH_SHARED_SECRET || randomToken(32);
  if (!process.env.OAUTH_SHARED_SECRET) {
    console.warn('[portal] OAUTH_SHARED_SECRET is not set; a temporary secret was generated. Set it in .env before deployment.');
  }
  if (oauthSecret.length < 32) throw new Error('OAUTH_SHARED_SECRET must be at least 32 characters');

  const sharePublicRaw = (process.env.SHARE_PUBLIC_URL || 'auto').trim();
  const adminPassword = process.env.ADMIN_PASSWORD || 'change-me-now';
  if (adminPassword.length < 8 || adminPassword.length > 128) {
    throw new Error('ADMIN_PASSWORD must be between 8 and 128 characters');
  }
  const epaySignMode = (process.env.EPAY_SIGN_MODE || 'append').trim();
  if (!['append', 'key_param'].includes(epaySignMode)) {
    throw new Error('EPAY_SIGN_MODE must be append or key_param');
  }
  const siteName = (process.env.SITE_NAME || 'Pastel Share').trim().slice(0, 80) || 'Pastel Share';

  return Object.freeze({
    port: integer('PORT', 8080, { min: 1, max: 65535 }),
    dataPath: process.env.DATA_PATH || '/data/portal.db',
    siteName,
    shareInternalUrl: url('SHARE_INTERNAL_URL', 'http://chatgpt-share-server:8001'),
    sharePublicUrl: sharePublicRaw.toLowerCase() === 'auto' ? 'auto' : url('SHARE_PUBLIC_URL', sharePublicRaw),
    sharePublicPort: integer('SHARE_PUBLIC_PORT', 8300, { min: 1, max: 65535 }),
    portalPublicUrl: url('PORTAL_PUBLIC_URL', 'http://localhost:8800'),
    oauthSecret,
    adminEmail: (process.env.ADMIN_EMAIL || 'admin@example.com').trim().toLowerCase(),
    adminPassword,
    registrationEnabled: bool('REGISTRATION_ENABLED', true),
    trialHours: integer('TRIAL_HOURS', 0, { min: 0, max: 24 * 365 }),
    sessionHours: integer('SESSION_HOURS', 168, { min: 1, max: 24 * 90 }),
    handoffMinutes: integer('HANDOFF_MINUTES', 5, { min: 1, max: 30 }),
    cookieSecure: bool('COOKIE_SECURE', false),
    cookieDomain: (process.env.COOKIE_DOMAIN || '').trim(),
    trustProxy: bool('TRUST_PROXY', false),
    epay: Object.freeze({
      url: optionalUrl('EPAY_URL'),
      pid: (process.env.EPAY_PID || '').trim(),
      key: process.env.EPAY_KEY || '',
      type: (process.env.EPAY_TYPE || 'alipay').trim(),
      device: (process.env.EPAY_DEVICE || 'pc').trim(),
      signMode: epaySignMode
    })
  });
}
