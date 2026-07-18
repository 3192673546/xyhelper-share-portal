import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildEpayFields,
  centsToMoney,
  epaySign,
  moneyToCents,
  renderAutoSubmitForm,
  verifyEpaySign
} from '../src/payment.mjs';

test('money conversion uses integer cents', () => {
  assert.equal(centsToMoney(990), '9.90');
  assert.equal(centsToMoney(12_345), '123.45');
  assert.equal(moneyToCents('9.9'), 990);
  assert.equal(moneyToCents('123.45'), 12_345);
  assert.throws(() => moneyToCents('1.234'));
});

test('epay signatures ignore sign fields and detect tampering', () => {
  const params = { pid: '1000', money: '9.90', name: '基础月卡', out_trade_no: 'ord_123' };
  const sign = epaySign(params, 'secret');
  assert.equal(verifyEpaySign({ ...params, sign, sign_type: 'MD5' }, 'secret'), true);
  assert.equal(verifyEpaySign({ ...params, money: '0.01', sign }, 'secret'), false);
  assert.notEqual(epaySign(params, 'secret', 'append'), epaySign(params, 'secret', 'key_param'));
});

test('payment fields contain signed callback addresses', () => {
  const epay = { url: 'https://pay.example.com/easy/pay', pid: '1000', key: 'secret', type: 'alipay', device: 'pc', signMode: 'append' };
  const order = { id: 'ord_123', amountCents: 990 };
  const plan = { name: '基础月卡' };
  const fields = buildEpayFields({ epay, order, plan, portalPublicUrl: 'https://portal.example.com' });
  assert.equal(fields.money, '9.90');
  assert.equal(fields.notify_url, 'https://portal.example.com/api/payments/epay/notify');
  assert.equal(verifyEpaySign(fields, 'secret'), true);
  const html = renderAutoSubmitForm(epay.url, fields);
  assert.match(html, /<script src="\/pay\.js" defer><\/script>/);
  assert.doesNotMatch(html, /<script>.*submit/);
});
