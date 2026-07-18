import { createHash } from 'node:crypto';
import { safeEqual } from './security.mjs';

function normalizedEntries(input) {
  const source = input instanceof URLSearchParams ? [...input.entries()] : Object.entries(input || {});
  return source
    .filter(([key, value]) => !['sign', 'sign_type'].includes(key) && value !== '' && value !== null && value !== undefined)
    .map(([key, value]) => [String(key), String(value)])
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
}

export function epaySign(input, key, mode = 'append') {
  const query = normalizedEntries(input).map(([name, value]) => `${name}=${value}`).join('&');
  const payload = mode === 'key_param' ? `${query}&key=${key}` : `${query}${key}`;
  return createHash('md5').update(payload, 'utf8').digest('hex');
}

export function verifyEpaySign(input, key, mode = 'append') {
  const provided = input instanceof URLSearchParams ? input.get('sign') : input?.sign;
  if (!provided) return false;
  return safeEqual(String(provided).toLowerCase(), epaySign(input, key, mode).toLowerCase());
}

export function centsToMoney(cents) {
  if (!Number.isInteger(cents) || cents < 0) throw new Error('金额无效');
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

export function moneyToCents(value) {
  const match = String(value || '').trim().match(/^(\d{1,9})(?:\.(\d{1,2}))?$/);
  if (!match) throw new Error('支付金额格式无效');
  return Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0'));
}

export function paymentEnabled(epay) {
  return Boolean(epay?.url && epay?.pid && epay?.key);
}

export function buildEpayFields({ epay, order, plan, portalPublicUrl }) {
  if (!paymentEnabled(epay)) throw new Error('站点尚未配置支付渠道');
  const fields = {
    pid: epay.pid,
    type: epay.type,
    out_trade_no: order.id,
    notify_url: `${portalPublicUrl}/api/payments/epay/notify`,
    return_url: `${portalPublicUrl}/?payment=return&order=${encodeURIComponent(order.id)}`,
    name: plan.name,
    money: centsToMoney(order.amountCents),
    device: epay.device
  };
  fields.sign = epaySign(fields, epay.key, epay.signMode);
  fields.sign_type = 'MD5';
  return fields;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export function renderAutoSubmitForm(action, fields) {
  const inputs = Object.entries(fields)
    .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`)
    .join('\n');
  return `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>正在前往支付</title>
<style>body{font-family:system-ui,sans-serif;background:#f7f5ff;color:#27223b;display:grid;place-items:center;min-height:100vh;margin:0}.box{background:#fff;padding:32px;border-radius:20px;box-shadow:0 18px 60px #7464aa26;text-align:center}.dot{width:38px;height:38px;border:4px solid #ddd4ff;border-top-color:#7357d9;border-radius:50%;margin:0 auto 18px;animation:s 1s linear infinite}@keyframes s{to{transform:rotate(360deg)}}</style></head>
<body><div class="box"><div class="dot"></div><strong>正在安全跳转到支付页面…</strong><p>若没有自动跳转，请点击下面按钮。</p>
<form id="pay" method="post" action="${escapeHtml(action)}">${inputs}<button type="submit">继续支付</button></form></div>
<script src="/pay.js" defer></script></body></html>`;
}
