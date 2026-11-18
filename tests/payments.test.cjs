'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');

const T = path.join(__dirname, '..', 'skills', 'miniapp-from-a-sentence', 'templates');
const pay = require(path.join(T, '_lib', 'payments.cjs'));
const { buildInitData } = require(path.join(T, '_lib', 'initdata.cjs'));

const TOKEN = '123456:ABC-test-token';
const PAYME_KEY = 'payme-test-key';
const CLICK_SECRET = 'click-secret';
const user = { id: 42, first_name: 'Ali', username: 'ali' };

// ---------- helpers ----------

test('money: tiyin <-> so\'m without floating point', () => {
  assert.strictEqual(pay.formatSom(150000), '1500.00');
  assert.strictEqual(pay.formatSom(5), '0.05');
  assert.strictEqual(pay.parseSomToTiyin('1000'), 100000);
  assert.strictEqual(pay.parseSomToTiyin('1000.5'), 100050);
  assert.strictEqual(pay.parseSomToTiyin('1000.50'), 100050);
  assert.strictEqual(pay.parseSomToTiyin('1000.500'), 100050);
  for (const bad of ['-1', '1e3', '1000.555', '', 'abc', '10,5']) assert.strictEqual(pay.parseSomToTiyin(bad), null, bad);
});

test('checkout: Payme link matches the documented format; ";" injection is refused', () => {
  // Example from the Payme docs: m=587f72c72cac0d162c722ae2;ac.order_id=197;a=500
  assert.strictEqual(
    pay.paymeCheckoutUrl({ merchantId: '587f72c72cac0d162c722ae2', account: { order_id: '197' }, amountTiyin: 500 }),
    'https://checkout.paycom.uz/bT01ODdmNzJjNzJjYWMwZDE2MmM3MjJhZTI7YWMub3JkZXJfaWQ9MTk3O2E9NTAw'
  );
  assert.match(pay.paymeCheckoutUrl({ merchantId: 'm', account: { order_id: '1' }, amountTiyin: 1, test: true }), /^https:\/\/test\.paycom\.uz\//);
  assert.throws(() => pay.paymeCheckoutUrl({ merchantId: 'm', account: { order_id: '1;a=1' }, amountTiyin: 500 }), /must not contain/);
  assert.throws(() => pay.paymeCheckoutUrl({ merchantId: 'm', account: { order_id: '1' }, amountTiyin: 0 }));
});

test('checkout: Click link carries so\'m with two decimals', () => {
  const u = new URL(pay.clickCheckoutUrl({ serviceId: 36, merchantId: 46, transactionParam: '197', amountTiyin: 100000, returnUrl: 'https://shop.uz' }));
  assert.strictEqual(u.origin + u.pathname, 'https://my.click.uz/services/pay');
  assert.deepStrictEqual(Object.fromEntries(u.searchParams), { service_id: '36', merchant_id: '46', amount: '1000.00', transaction_param: '197', return_url: 'https://shop.uz' });
});

// ---------- app with payments on ----------

async function start(extraEnv = {}) {
  for (const f of ['server.js']) delete require.cache[require.resolve(path.join(T, 'ordering', f))];
  const saved = { ...process.env };
  Object.assign(process.env, {
    NODE_ENV: 'test', BOT_TOKEN: TOKEN, ADMIN_CHAT_ID: '', WEBHOOK_SECRET: 'x', WEBAPP_URL: 'https://shop.example',
    PAYME_MERCHANT_ID: 'merchant123', PAYME_KEY, PAYME_TEST: '1',
    CLICK_SERVICE_ID: '36', CLICK_MERCHANT_ID: '46', CLICK_SECRET_KEY: CLICK_SECRET,
    DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'mafs-')), ...extraEnv,
  });
  const app = require(path.join(T, 'ordering', 'server.js'));
  process.env = saved;
  const port = await app.listen(0);
  const base = `http://127.0.0.1:${port}`;
  const auth = (u = user) => ({ 'X-Telegram-Init-Data': buildInitData({ user: u, auth_date: String(Math.floor(Date.now() / 1000)) }, TOKEN) });
  const json = async (p, body, headers = {}) => (await fetch(base + p, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) })).json();
  let rpc = 0;
  const payme = (method, params, key = PAYME_KEY) => json('/payments/payme', { jsonrpc: '2.0', id: ++rpc, method, params }, { Authorization: 'Basic ' + Buffer.from(`Paycom:${key}`).toString('base64') });
  const clickSign = (f) => crypto.createHash('md5').update([f.click_trans_id, f.service_id, CLICK_SECRET, f.merchant_trans_id, f.action === '1' ? f.merchant_prepare_id : '', f.amount, f.action, f.sign_time].join('')).digest('hex');
  const click = async (fields, sign = true) => {
    const f = { click_trans_id: '9001', service_id: '36', click_paydoc_id: '777', error: '0', error_note: 'Success', sign_time: '2026-11-18 10:00:00', ...fields };
    f.sign_string = sign ? clickSign(f) : 'deadbeef';
    return (await fetch(base + '/payments/click', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(f).toString() })).json();
  };
  const order = async (items = [{ id: 'latte', qty: 2 }]) => json('/api/order', { items }, auth());
  return { app, json, auth, payme, click, order, stop: () => new Promise((r) => app.server.close(r)) };
}

test('order: returns Payme and Click links for the server total, admin sees "waiting"', async () => {
  const s = await start();
  try {
    const r = await s.order([{ id: 'latte', qty: 2, price: 1 }]);
    assert.strictEqual(r.total, 56000);
    assert.strictEqual(r.status, 'pending');
    const decoded = Buffer.from(r.pay.payme.split('/').pop(), 'base64').toString();
    assert.strictEqual(decoded, `m=merchant123;ac.order_id=${r.orderId};a=5600000;c=https://shop.example`);
    assert.strictEqual(new URL(r.pay.click).searchParams.get('amount'), '56000.00');
    assert.match(s.app.outbox.at(-1), /Waiting for online payment/);
    assert.deepStrictEqual((await s.json('/api/catalog', undefined, s.auth())).payments, { payme: true, click: true });
  } finally { await s.stop(); }
});

test('payme: wrong key, wrong amount, unknown order and unknown method are refused', async () => {
  const s = await start();
  try {
    const { orderId } = await s.order();
    assert.strictEqual((await s.payme('CheckPerformTransaction', { amount: 5600000, account: { order_id: orderId } }, 'wrong')).error.code, -32504);
    assert.strictEqual((await s.payme('CheckPerformTransaction', { amount: 100, account: { order_id: orderId } })).error.code, -31001);
    const nf = await s.payme('CheckPerformTransaction', { amount: 5600000, account: { order_id: '999' } });
    assert.strictEqual(nf.error.code, -31050);
    assert.strictEqual(nf.error.data, 'order_id');
    assert.strictEqual((await s.payme('Hack', {})).error.code, -32601);
    assert.strictEqual((await s.payme('CheckPerformTransaction', { amount: 5600000, account: { order_id: orderId } })).result.allow, true);
  } finally { await s.stop(); }
});

test('payme: create -> perform marks the order paid once; retries are idempotent', async () => {
  const s = await start();
  try {
    const { orderId } = await s.order();
    const params = { id: 'payme-tx-1', time: Date.now(), amount: 5600000, account: { order_id: orderId } };
    const c1 = (await s.payme('CreateTransaction', params)).result;
    const c2 = (await s.payme('CreateTransaction', params)).result;
    assert.strictEqual(c1.state, 1);
    assert.strictEqual(c2.transaction, c1.transaction);
    // a second Payme transaction for the same order is refused
    assert.strictEqual((await s.payme('CreateTransaction', { ...params, id: 'payme-tx-2' })).error.code, -31050);
    const p1 = (await s.payme('PerformTransaction', { id: 'payme-tx-1' })).result;
    const p2 = (await s.payme('PerformTransaction', { id: 'payme-tx-1' })).result;
    assert.strictEqual(p1.state, 2);
    assert.strictEqual(p2.perform_time, p1.perform_time);
    assert.strictEqual(s.app.outbox.filter((m) => m.includes('PAID')).length, 1);
    const st = await s.json(`/api/order-status?id=${orderId}`, undefined, s.auth());
    assert.deepStrictEqual(st, { orderId, status: 'paid', paidVia: 'Payme' });
    assert.strictEqual((await s.payme('CheckTransaction', { id: 'payme-tx-1' })).result.state, 2);
    const stmt = (await s.payme('GetStatement', { from: 0, to: Date.now() + 1 })).result.transactions;
    assert.strictEqual(stmt.length, 1);
  } finally { await s.stop(); }
});

test('payme: cancel before and after perform; expired transactions are cancelled', async () => {
  const s = await start();
  try {
    const a = await s.order();
    await s.payme('CreateTransaction', { id: 'tx-a', time: Date.now(), amount: 5600000, account: { order_id: a.orderId } });
    const ca = (await s.payme('CancelTransaction', { id: 'tx-a', reason: 3 })).result;
    assert.strictEqual(ca.state, -1);

    const b = await s.order();
    await s.payme('CreateTransaction', { id: 'tx-b', time: Date.now(), amount: 5600000, account: { order_id: b.orderId } });
    await s.payme('PerformTransaction', { id: 'tx-b' });
    assert.strictEqual((await s.payme('CancelTransaction', { id: 'tx-b', reason: 5 })).result.state, -2);
    assert.match(s.app.outbox.at(-1), /REFUNDED/);

    const c = await s.order();
    assert.strictEqual((await s.payme('CreateTransaction', { id: 'tx-old', time: Date.now() - 13 * 3600 * 1000, amount: 5600000, account: { order_id: c.orderId } })).error.code, -31008);

    const d = await s.order();
    await s.payme('CreateTransaction', { id: 'tx-d', time: Date.now(), amount: 5600000, account: { order_id: d.orderId } });
    s.app._store.data.paymeTx['tx-d'].createTime -= 13 * 3600 * 1000;
    assert.strictEqual((await s.payme('PerformTransaction', { id: 'tx-d' })).error.code, -31008);
    assert.strictEqual((await s.payme('CheckTransaction', { id: 'tx-d' })).result.reason, 4);
  } finally { await s.stop(); }
});

test('payme: an order paid through Payme cannot be paid again', async () => {
  const s = await start();
  try {
    const { orderId } = await s.order();
    await s.payme('CreateTransaction', { id: 't1', time: Date.now(), amount: 5600000, account: { order_id: orderId } });
    await s.payme('PerformTransaction', { id: 't1' });
    assert.strictEqual((await s.payme('CheckPerformTransaction', { amount: 5600000, account: { order_id: orderId } })).error.code, -31008);
  } finally { await s.stop(); }
});

test('click: bad signature, wrong amount, wrong service and unknown order are refused', async () => {
  const s = await start();
  try {
    const { orderId } = await s.order();
    assert.strictEqual((await s.click({ merchant_trans_id: orderId, amount: '56000', action: '0' }, false)).error, -1);
    assert.strictEqual((await s.click({ merchant_trans_id: orderId, amount: '1', action: '0' })).error, -2);
    assert.strictEqual((await s.click({ merchant_trans_id: orderId, amount: '56000', action: '0', service_id: '99' })).error, -8);
    assert.strictEqual((await s.click({ merchant_trans_id: '999', amount: '56000', action: '0' })).error, -5);
  } finally { await s.stop(); }
});

test('click: prepare -> complete marks paid; a repeat says "already paid"', async () => {
  const s = await start();
  try {
    const { orderId } = await s.order();
    const prep = await s.click({ merchant_trans_id: orderId, amount: '56000.00', action: '0' });
    assert.strictEqual(prep.error, 0);
    const done = await s.click({ merchant_trans_id: orderId, amount: '56000.00', action: '1', merchant_prepare_id: String(prep.merchant_prepare_id) });
    assert.strictEqual(done.error, 0);
    assert.strictEqual(done.merchant_confirm_id, prep.merchant_prepare_id);
    assert.strictEqual((await s.json(`/api/order-status?id=${orderId}`, undefined, s.auth())).paidVia, 'Click');
    const again = await s.click({ merchant_trans_id: orderId, amount: '56000.00', action: '1', merchant_prepare_id: String(prep.merchant_prepare_id) });
    assert.strictEqual(again.error, -4);
  } finally { await s.stop(); }
});

test('click: a failed charge (error < 0) cancels; complete with a foreign prepare id fails', async () => {
  const s = await start();
  try {
    const a = await s.order();
    const pa = await s.click({ merchant_trans_id: a.orderId, amount: '56000', action: '0' });
    const failed = await s.click({ merchant_trans_id: a.orderId, amount: '56000', action: '1', merchant_prepare_id: String(pa.merchant_prepare_id), error: '-5017', error_note: 'Insufficient funds' });
    assert.strictEqual(failed.error, -9);
    assert.strictEqual((await s.json(`/api/order-status?id=${a.orderId}`, undefined, s.auth())).status, 'cancelled');

    const b = await s.order();
    assert.strictEqual((await s.click({ merchant_trans_id: b.orderId, amount: '56000', action: '1', merchant_prepare_id: String(pa.merchant_prepare_id) })).error, -6);
  } finally { await s.stop(); }
});

test('order status is private to the customer who placed it', async () => {
  const s = await start();
  try {
    const { orderId } = await s.order();
    const r = await fetch(`http://127.0.0.1:${s.app.server.address().port}/api/order-status?id=${orderId}`, { headers: s.auth({ id: 7, first_name: 'Eve' }) });
    assert.strictEqual(r.status, 400);
  } finally { await s.stop(); }
});

test('without payment env the order is "pay on pickup" and payment URLs do not exist', async () => {
  const s = await start({ PAYME_MERCHANT_ID: '', PAYME_KEY: '', CLICK_SERVICE_ID: '', CLICK_MERCHANT_ID: '', CLICK_SECRET_KEY: '' });
  try {
    const r = await s.order();
    assert.strictEqual(r.pay, null);
    assert.strictEqual(r.status, 'unpaid');
    assert.match(s.app.outbox.at(-1), /Pay on pickup/);
    const hook = await fetch(`http://127.0.0.1:${s.app.server.address().port}/payments/payme`, { method: 'POST', body: '{}' });
    assert.notStrictEqual(hook.status, 200);
  } finally { await s.stop(); }
});
