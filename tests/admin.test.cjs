'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const T = path.join(__dirname, '..', 'skills', 'miniapp-from-a-sentence', 'templates');
const { buildInitData } = require(path.join(T, '_lib', 'initdata.cjs'));
const TOKEN = '123456:ABC-test-token';
const ADMIN = '5005';
const user = { id: 42, first_name: 'Ali' };

async function start(dataDir, extraEnv = {}) {
  delete require.cache[require.resolve(path.join(T, 'ordering', 'server.js'))];
  const saved = { ...process.env };
  Object.assign(process.env, { NODE_ENV: 'test', BOT_TOKEN: TOKEN, ADMIN_CHAT_ID: ADMIN, WEBHOOK_SECRET: 'hook', DATA_DIR: dataDir, PAYME_MERCHANT_ID: '', PAYME_KEY: '', CLICK_SERVICE_ID: '', ...extraEnv });
  const app = require(path.join(T, 'ordering', 'server.js'));
  process.env = saved;
  const port = await app.listen(0);
  const base = `http://127.0.0.1:${port}`;
  const say = async (text, chatId = ADMIN) => {
    const before = app.botOutbox.length;
    const r = await fetch(base + '/bot/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': 'hook' }, body: JSON.stringify({ message: { text, chat: { id: Number(chatId) }, from: { id: Number(chatId) } } }) });
    assert.strictEqual(r.status, 200);
    const sent = app.botOutbox.slice(before);
    return sent.length ? sent.at(-1).payload.text : null;
  };
  const auth = () => ({ 'X-Telegram-Init-Data': buildInitData({ user, auth_date: String(Math.floor(Date.now() / 1000)) }, TOKEN) });
  const api = async (p, body) => (await fetch(base + p, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...auth() }, body: body ? JSON.stringify(body) : undefined })).json();
  return { app, say, api, stop: () => new Promise((r) => app.server.close(r)) };
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mafs-admin-'));

test('admin: /price changes what customers pay; bad input gets usage help', async () => {
  const s = await start(tmp());
  try {
    assert.match(await s.say('/price latte 30000'), /Latte: 28 000 UZS → <b>30 000 UZS<\/b>/);
    const r = await s.api('/api/order', { items: [{ id: 'latte', qty: 1 }] });
    assert.strictEqual(r.total, 30000);
    assert.match(await s.say('/price latte -5'), /Usage/);
    assert.match(await s.say('/price nothing 100'), /Usage/);
  } finally { await s.stop(); }
});

test('admin: /hide removes an item from the menu and from orders; /show brings it back', async () => {
  const s = await start(tmp());
  try {
    await s.say('/hide cheesecake');
    const cat = await s.api('/api/catalog');
    assert.ok(!cat.categories.flatMap((c) => c.items).some((i) => i.id === 'cheesecake'));
    assert.strictEqual((await s.api('/api/order', { items: [{ id: 'cheesecake', qty: 1 }] })).error, 'An item in your cart is no longer available');
    assert.match(await s.say('/items'), /🚫 <code>cheesecake<\/code>/);
    await s.say('/show cheesecake');
    assert.strictEqual((await s.api('/api/order', { items: [{ id: 'cheesecake', qty: 1 }] })).total, 32000);
  } finally { await s.stop(); }
});

test('admin: /add creates an item with a unique id; HTML in names is escaped', async () => {
  const s = await start(tmp());
  try {
    assert.match(await s.say('/add food | Honey Cake | 25000 | Layers of honey sponge'), /Added <code>honey-cake<\/code>/);
    assert.match(await s.say('/add food | Honey Cake | 26000'), /<code>honey-cake-2<\/code>/);
    assert.match(await s.say('/add food | <b>x</b> | 1000'), /&lt;b&gt;x&lt;\/b&gt;/);
    const cat = await s.api('/api/catalog');
    const food = cat.categories.find((c) => c.id === 'food').items.map((i) => i.id);
    assert.deepStrictEqual(food.slice(-3), ['honey-cake', 'honey-cake-2', 'b-x-b']);
    assert.match(await s.say('/add drinks | Tea | 5000'), /Usage/);
  } finally { await s.stop(); }
});

test('admin: commands from any other chat are ignored', async () => {
  const s = await start(tmp());
  try {
    assert.strictEqual(await s.say('/price latte 1', '777'), null);
    assert.strictEqual((await s.api('/api/order', { items: [{ id: 'latte', qty: 1 }] })).total, 28000);
  } finally { await s.stop(); }
});

test('admin: /orders lists recent orders and /done marks one handed over', async () => {
  const s = await start(tmp());
  try {
    await s.api('/api/order', { items: [{ id: 'espresso', qty: 2 }] });
    assert.match(await s.say('/orders'), /#1 36 000 UZS unpaid/);
    assert.match(await s.say('/done 1'), /Order #1 marked handed over/);
    assert.match(await s.say('/orders'), /handed over/);
    assert.match(await s.say('/help'), /Shop commands/);
  } finally { await s.stop(); }
});

test('store: catalog changes, orders and order numbers survive a restart', async () => {
  const dir = tmp();
  const a = await start(dir);
  await a.say('/price espresso 20000');
  await a.api('/api/order', { items: [{ id: 'espresso', qty: 1 }] });
  await a.stop();
  const b = await start(dir);
  try {
    const r = await b.api('/api/order', { items: [{ id: 'espresso', qty: 1 }] });
    assert.strictEqual(r.orderId, '2');
    assert.strictEqual(r.total, 20000);
    assert.match(await b.say('/orders'), /#2[\s\S]*#1/);
    assert.ok(fs.existsSync(path.join(dir, 'store.json')));
    assert.deepStrictEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), []);
  } finally { await b.stop(); }
});

test('store: a paid Payme order is still paid after a restart', async () => {
  const dir = tmp();
  const env = { PAYME_MERCHANT_ID: 'm', PAYME_KEY: 'k' };
  const auth = 'Basic ' + Buffer.from('Paycom:k').toString('base64');
  const a = await start(dir, env);
  const { orderId } = await a.api('/api/order', { items: [{ id: 'latte', qty: 1 }] });
  const port = a.app.server.address().port;
  const rpc = (method, params) => fetch(`http://127.0.0.1:${port}/payments/payme`, { method: 'POST', headers: { Authorization: auth }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }).then((r) => r.json());
  await rpc('CreateTransaction', { id: 'p1', time: Date.now(), amount: 2800000, account: { order_id: orderId } });
  await rpc('PerformTransaction', { id: 'p1' });
  await a.stop();
  const b = await start(dir, env);
  try {
    assert.strictEqual((await b.api(`/api/order-status?id=${orderId}`)).status, 'paid');
    const p2 = b.app.server.address().port;
    const again = await fetch(`http://127.0.0.1:${p2}/payments/payme`, { method: 'POST', headers: { Authorization: auth }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'PerformTransaction', params: { id: 'p1' } }) }).then((r) => r.json());
    assert.strictEqual(again.result.state, 2);
  } finally { await b.stop(); }
});
