'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const crypto = require('crypto');

const T = path.join(__dirname, '..', 'skills', 'miniapp-from-a-sentence', 'templates');
const { validateInitData, buildInitData, dataCheckString } = require(path.join(T, '_lib', 'initdata.cjs'));
const { createApp, DEV_TOKEN } = require(path.join(T, '_lib', 'server-core.cjs'));

const TOKEN = '123456:ABC-test-token';
const now = Date.now();
const fresh = () => String(Math.floor(now / 1000));
const user = { id: 42, first_name: 'Ali', username: 'ali' };

// ---------- initData ----------

test('initData: hash follows the documented algorithm (independent implementation)', () => {
  const init = buildInitData({ user, auth_date: fresh(), query_id: 'q1' }, TOKEN);
  const p = new URLSearchParams(init);
  const secret = crypto.createHmac('sha256', 'WebAppData').update(TOKEN).digest();
  const check = [...p.keys()].filter((k) => k !== 'hash').sort().map((k) => `${k}=${p.get(k)}`).join('\n');
  assert.strictEqual(check, dataCheckString(p));
  assert.strictEqual(p.get('hash'), crypto.createHmac('sha256', secret).update(check).digest('hex'));
});

test('initData: valid data passes and returns the user', () => {
  const r = validateInitData(buildInitData({ user, auth_date: fresh() }, TOKEN), TOKEN, { now });
  assert.ok(r.ok);
  assert.strictEqual(r.user.id, 42);
});

test('initData: a changed user id fails', () => {
  const init = buildInitData({ user, auth_date: fresh() }, TOKEN);
  const forged = init.replace(encodeURIComponent('"id":42'), encodeURIComponent('"id":1'));
  assert.notStrictEqual(forged, init);
  assert.deepStrictEqual(validateInitData(forged, TOKEN, { now }), { ok: false, reason: 'bad hash' });
});

test('initData: another bot token fails', () => {
  const r = validateInitData(buildInitData({ user, auth_date: fresh() }, 'other:token'), TOKEN, { now });
  assert.strictEqual(r.reason, 'bad hash');
});

test('initData: expired, future, missing and malformed data fail', () => {
  const old = String(Math.floor(now / 1000) - 7200);
  assert.strictEqual(validateInitData(buildInitData({ user, auth_date: old }, TOKEN), TOKEN, { now }).reason, 'initData expired');
  const future = String(Math.floor(now / 1000) + 3600);
  assert.strictEqual(validateInitData(buildInitData({ user, auth_date: future }, TOKEN), TOKEN, { now }).reason, 'auth_date is in the future');
  assert.strictEqual(validateInitData('', TOKEN).reason, 'missing initData');
  assert.strictEqual(validateInitData('user=%7B%7D&hash=zz', TOKEN).reason, 'missing or malformed hash');
  assert.strictEqual(validateInitData(buildInitData({ user }, TOKEN), TOKEN, { now }).reason, 'missing auth_date');
  assert.strictEqual(validateInitData('a=b', '').reason, 'server has no bot token');
});

// ---------- server helpers ----------

async function start(template, env = {}) {
  delete require.cache[require.resolve(path.join(T, template, 'server.js'))];
  const saved = { ...process.env };
  Object.assign(process.env, { NODE_ENV: 'test', BOT_TOKEN: TOKEN, ADMIN_CHAT_ID: '', WEBHOOK_SECRET: 'hook-secret', ...env });
  const app = require(path.join(T, template, 'server.js'));
  process.env = saved;
  const port = await app.listen(0);
  const base = `http://127.0.0.1:${port}`;
  const call = (p, body, headers = {}) => fetch(base + p, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const auth = (u = user) => ({ 'X-Telegram-Init-Data': buildInitData({ user: u, auth_date: String(Math.floor(Date.now() / 1000)) }, TOKEN) });
  return { app, base, call, auth, stop: () => new Promise((r) => app.server.close(r)) };
}

test('server: API rejects requests without valid initData', async () => {
  const s = await start('ordering');
  try {
    assert.strictEqual((await s.call('/api/catalog')).status, 401);
    const forged = { 'X-Telegram-Init-Data': buildInitData({ user, auth_date: fresh() }, 'attacker:token') };
    assert.strictEqual((await s.call('/api/catalog', null, forged)).status, 401);
    assert.strictEqual((await s.call('/api/catalog', null, s.auth())).status, 200);
  } finally { await s.stop(); }
});

test('ordering: total is computed from server prices, client prices are ignored', async () => {
  const s = await start('ordering');
  try {
    const r = await s.call('/api/order', { items: [{ id: 'latte', qty: 2, price: 1 }, { id: 'croissant', qty: 1 }], total: 1 }, s.auth());
    const out = await r.json();
    assert.strictEqual(r.status, 200);
    assert.strictEqual(out.total, 28000 * 2 + 15000);
    assert.match(s.app.outbox.at(-1), /Total: 71 000 UZS/);
    assert.match(s.app.outbox.at(-1), /id 42/);
  } finally { await s.stop(); }
});

test('ordering: unknown items, bad quantities and empty carts are rejected', async () => {
  const s = await start('ordering');
  try {
    for (const items of [[{ id: 'nope', qty: 1 }], [{ id: 'latte', qty: 0 }], [{ id: 'latte', qty: 21 }], [{ id: 'latte', qty: 1.5 }], []]) {
      assert.strictEqual((await s.call('/api/order', { items }, s.auth())).status, 400, JSON.stringify(items));
    }
  } finally { await s.stop(); }
});

test('ordering: user text is HTML-escaped in the admin message', async () => {
  const s = await start('ordering');
  try {
    await s.call('/api/order', { items: [{ id: 'espresso', qty: 1 }], note: '<b>hi</b>' }, s.auth({ id: 7, first_name: '<script>' }));
    const msg = s.app.outbox.at(-1);
    assert.ok(msg.includes('&lt;b&gt;hi&lt;/b&gt;') && msg.includes('&lt;script&gt;') && !msg.includes('<script>'));
  } finally { await s.stop(); }
});

test('booking: a slot can be booked once; the second request gets 409', async () => {
  const s = await start('booking');
  try {
    const cfg = await (await s.call('/api/config', null, s.auth())).json();
    let date, time;
    for (const d of cfg.days) {
      const { slots } = await (await s.call(`/api/slots?date=${d}`, null, s.auth())).json();
      const free = slots.find((x) => x.free);
      if (free) { date = d; time = free.time; break; }
    }
    assert.ok(date && time, 'a free slot exists');
    const req = { serviceId: 'haircut', date, time, name: 'Ali', phone: '+998901234567' };
    assert.strictEqual((await s.call('/api/book', req, s.auth())).status, 200);
    assert.strictEqual((await s.call('/api/book', req, s.auth({ id: 99, first_name: 'B' }))).status, 409);
    const { slots } = await (await s.call(`/api/slots?date=${date}`, null, s.auth())).json();
    assert.strictEqual(slots.find((x) => x.time === time).free, false);
  } finally { await s.stop(); }
});

test('booking: invalid service, day, time, name and phone are rejected', async () => {
  const s = await start('booking');
  try {
    const cfg = await (await s.call('/api/config', null, s.auth())).json();
    const d = cfg.days.at(-1);
    const ok = { serviceId: 'beard', date: d, time: '12:00', name: 'Ali', phone: '+998901234567' };
    for (const bad of [{ serviceId: 'x' }, { date: '2000-01-01' }, { time: '03:00' }, { name: 'A' }, { phone: '12' }]) {
      assert.strictEqual((await s.call('/api/book', { ...ok, ...bad }, s.auth())).status, 400, JSON.stringify(bad));
    }
  } finally { await s.stop(); }
});

test('survey: answers are validated and each user can answer once', async () => {
  const s = await start('survey');
  try {
    const good = { goal: 'Telegram bot', budget: 'Under $500', details: '', phone: '+998 90 123 45 67' };
    assert.strictEqual((await s.call('/api/answer', { answers: { ...good, goal: 'Rocket' } }, s.auth())).status, 400);
    assert.strictEqual((await s.call('/api/answer', { answers: { ...good, phone: '1' } }, s.auth())).status, 400);
    assert.strictEqual((await s.call('/api/answer', { answers: good }, s.auth())).status, 200);
    assert.strictEqual((await s.call('/api/answer', { answers: good }, s.auth())).status, 409);
    assert.strictEqual((await (await s.call('/api/survey', null, s.auth())).json()).alreadyAnswered, true);
  } finally { await s.stop(); }
});

test('webhook: requires the secret token header', async () => {
  const s = await start('ordering');
  try {
    assert.strictEqual((await s.call('/bot/webhook', { message: { text: '/start', chat: { id: 1 } } })).status, 401);
    assert.strictEqual((await s.call('/bot/webhook', {}, { 'X-Telegram-Bot-Api-Secret-Token': 'wrong' })).status, 401);
  } finally { await s.stop(); }
});

test('dev mode: mock initData only exists without a real BOT_TOKEN', async () => {
  const prod = await start('ordering');
  try { assert.strictEqual((await prod.call('/dev/init-data')).status, 404); } finally { await prod.stop(); }

  const dev = await start('ordering', { BOT_TOKEN: '' });
  try {
    assert.ok(dev.app.cfg.dev);
    const { initData } = await (await dev.call('/dev/init-data')).json();
    assert.ok(validateInitData(initData, DEV_TOKEN).ok);
    assert.strictEqual((await dev.call('/api/catalog', null, { 'X-Telegram-Init-Data': initData })).status, 200);
  } finally { await dev.stop(); }
});

test('production: refuses to start without BOT_TOKEN', () => {
  assert.throws(() => require(path.join(T, '_lib', 'server-core.cjs')).config({ NODE_ENV: 'production' }), /BOT_TOKEN is required/);
});

test('static: path traversal is blocked and pages are served', async () => {
  const s = await start('ordering');
  try {
    assert.strictEqual((await s.call('/')).status, 200);
    assert.strictEqual((await s.call('/_lib/tma.js')).status, 200);
    assert.notStrictEqual((await s.call('/..%2f..%2fpackage.json')).status, 200);
    assert.notStrictEqual((await s.call('/_lib/..%2finitdata.cjs')).status, 200);
  } finally { await s.stop(); }
});
