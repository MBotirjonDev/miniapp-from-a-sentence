'use strict';
// Ordering Mini App: catalog -> cart -> order -> optional Payme / Click payment -> admin chat.
// - Prices live on the server. The client sends only item ids and quantities.
// - Payments turn on when their environment variables are set (see .env.example); without them
//   orders are taken as "pay on pickup".
// - The shop owner manages items from the admin chat with bot commands (/help).
// - Catalog, orders and payment records are saved to DATA_DIR/store.json, so a restart loses nothing.
const path = require('path');
const { createApp, badRequest } = require('../_lib/server-core.cjs');
const pay = require('../_lib/payments.cjs');
const { createStore } = require('../_lib/store.cjs');
const seed = require('./data.json');

const MAX_QTY = 20;
const env = process.env;

const store = createStore(path.join(env.DATA_DIR || path.join(__dirname, '..', 'data'), 'store.json'), () => ({
  catalog: JSON.parse(JSON.stringify(seed)), orders: {}, paymeTx: {}, clickPrepares: {}, nextOrder: 1, nextPrepare: 1,
}));
const db = store.data;

const payme = env.PAYME_MERCHANT_ID && env.PAYME_KEY ? { merchantId: env.PAYME_MERCHANT_ID, key: env.PAYME_KEY, test: env.PAYME_TEST === '1' } : null;
const click = env.CLICK_SERVICE_ID && env.CLICK_MERCHANT_ID && env.CLICK_SECRET_KEY
  ? { serviceId: Number(env.CLICK_SERVICE_ID), merchantId: Number(env.CLICK_MERCHANT_ID), secretKey: env.CLICK_SECRET_KEY } : null;
if ((payme || click) && db.catalog.currency !== 'UZS') throw new Error('Payme and Click accept UZS only: set "currency": "UZS" in data.json');
const returnUrl = env.WEBAPP_URL || undefined;

const money = (n) => `${n.toLocaleString('en-US').replace(/,/g, ' ')} ${db.catalog.currency}`;
const allItems = () => db.catalog.categories.flatMap((c) => c.items.map((i) => ({ ...i, category: c.id })));
const findItem = (id) => { for (const c of db.catalog.categories) for (const i of c.items) if (i.id === id) return i; return null; };
// What customers see: hidden items left out.
const publicCatalog = () => ({ ...db.catalog, categories: db.catalog.categories.map((c) => ({ ...c, items: c.items.filter((i) => !i.hidden) })).filter((c) => c.items.length) });

let app; // set below; payment callbacks use app.notifyAdmin

async function markPaid(order, via) {
  if (order.status === 'paid') return;
  order.status = 'paid';
  order.paidVia = via;
  store.save();
  await app.notifyAdmin(`<b>Order #${order.id} PAID</b> via ${via}\nTotal: ${money(order.total)}`);
}
async function markCancelled(order, via, wasPaid) {
  order.status = 'cancelled';
  store.save();
  await app.notifyAdmin(`<b>Order #${order.id} ${wasPaid ? 'REFUNDED' : 'payment cancelled'}</b> (${via})`);
}

const paymeStore = {
  findOrder: async (account) => db.orders[String(account.order_id)] || null,
  findTx: async (id) => db.paymeTx[id] || null,
  openTxForOrder: async (orderId) => Object.values(db.paymeTx).find((t) => t.orderId === orderId && (t.state === pay.PAYME_STATE.CREATED || t.state === pay.PAYME_STATE.PERFORMED)) || null,
  saveTx: async (tx) => { db.paymeTx[tx.paymeId] = tx; store.save(); },
  txBetween: async (from, to) => Object.values(db.paymeTx).filter((t) => t.paymeTime >= from && t.paymeTime <= to),
  onPaid: async (orderId) => markPaid(db.orders[orderId], 'Payme'),
  onCancelled: async (orderId, tx, wasPaid) => markCancelled(db.orders[orderId], 'Payme', wasPaid),
  // A paid order can be refunded until the admin marks it handed over with /done.
  canCancelPaid: async (orderId) => !db.orders[orderId].handedOver,
};

const clickStore = {
  findOrder: async (id) => db.orders[String(id)] || null,
  findPrepare: async (id) => db.clickPrepares[id] || null,
  prepare: async (order, req) => {
    const existing = Object.values(db.clickPrepares).find((p) => p.clickTransId === req.clickTransId);
    if (existing) return existing.id;
    const p = { id: db.nextPrepare++, orderId: order.id, clickTransId: req.clickTransId, amountTiyin: req.amountTiyin };
    db.clickPrepares[p.id] = p;
    store.save();
    return p.id;
  },
  complete: async (order, prepare) => { await markPaid(order, 'Click'); return prepare.id; },
  cancel: async (order) => markCancelled(order, 'Click', false),
};

const hooks = {};
if (payme) {
  const handle = pay.createPaymeHandler({ key: payme.key, store: paymeStore });
  hooks['POST /payments/payme'] = async ({ headers, text }) => handle(headers, text);
}
if (click) {
  const handle = pay.createClickHandler({ serviceId: click.serviceId, secretKey: click.secretKey, store: clickStore });
  hooks['POST /payments/click'] = async ({ text }) => handle(text);
}

function payLinks(order) {
  const links = {};
  if (payme) links.payme = pay.paymeCheckoutUrl({ merchantId: payme.merchantId, account: { order_id: order.id }, amountTiyin: order.amountTiyin, returnUrl, test: payme.test });
  if (click) links.click = pay.clickCheckoutUrl({ serviceId: click.serviceId, merchantId: click.merchantId, transactionParam: order.id, amountTiyin: order.amountTiyin, returnUrl });
  return links;
}

// ── admin commands, from the ADMIN_CHAT_ID chat only (checked in server-core) ──────────────
const HELP = [
  '<b>Shop commands</b>',
  '/items: all items with ids and prices',
  '/price &lt;id&gt; &lt;price&gt;: change a price, e.g. /price latte 30000',
  '/hide &lt;id&gt; and /show &lt;id&gt;: take an item off the menu or put it back',
  '/add &lt;category&gt; | &lt;name&gt; | &lt;price&gt; | &lt;description&gt;: add an item',
  '/orders: the last 10 orders',
  '/done &lt;order&gt;: mark an order handed over (it can no longer be refunded online)',
].join('\n');

const slug = (s) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'item';
const priceArg = (s) => (/^\d{1,9}$/.test(s) && Number(s) > 0 ? Number(s) : null);

async function onBotMessage({ text, escapeHtml: e }) {
  const [cmd, ...rest] = text.split(/\s+/);
  const arg = rest.join(' ');
  switch (cmd.replace(/@\w+$/, '')) {
    case '/help': case '/start': return HELP;
    case '/items':
      return db.catalog.categories.map((c) => `<b>${e(c.name)}</b> (${e(c.id)})\n` + (c.items.map((i) => `${i.hidden ? '🚫 ' : ''}<code>${e(i.id)}</code> ${e(i.name)}: ${money(i.price)}`).join('\n') || '(empty)')).join('\n\n');
    case '/price': {
      const [id, p] = rest;
      const item = findItem(id || ''), price = priceArg(p || '');
      if (!item || !price) return 'Usage: /price &lt;id&gt; &lt;price&gt;, for example /price latte 30000. See /items for ids.';
      const old = item.price;
      item.price = price;
      store.save();
      return `${e(item.name)}: ${money(old)} → <b>${money(price)}</b>`;
    }
    case '/hide': case '/show': {
      const item = findItem(rest[0] || '');
      if (!item) return 'Unknown item. See /items for ids.';
      item.hidden = cmd === '/hide';
      store.save();
      return `${e(item.name)} is ${item.hidden ? 'hidden from' : 'back on'} the menu.`;
    }
    case '/add': {
      const [catId, name, p, description = ''] = arg.split('|').map((s) => s.trim());
      const cat = db.catalog.categories.find((c) => c.id === catId || c.name.toLowerCase() === (catId || '').toLowerCase());
      const price = priceArg(p || '');
      if (!cat || !name || name.length > 60 || !price || description.length > 120) {
        return 'Usage: /add &lt;category&gt; | &lt;name&gt; | &lt;price&gt; | &lt;description&gt;\nCategories: ' + db.catalog.categories.map((c) => e(c.id)).join(', ');
      }
      let id = slug(name), n = 2;
      while (findItem(id)) id = `${slug(name)}-${n++}`;
      cat.items.push({ id, name, description, price });
      store.save();
      return `Added <code>${e(id)}</code> ${e(name)} to ${e(cat.name)}: ${money(price)}`;
    }
    case '/orders': {
      const list = Object.values(db.orders).slice(-10).reverse();
      return list.length ? list.map((o) => `#${o.id} ${money(o.total)} ${o.status}${o.paidVia ? ` (${o.paidVia})` : ''}${o.handedOver ? ', handed over' : ''}`).join('\n') : 'No orders yet.';
    }
    case '/done': {
      const order = db.orders[(rest[0] || '').replace('#', '')];
      if (!order) return 'Usage: /done &lt;order number&gt;';
      order.handedOver = true;
      store.save();
      return `Order #${order.id} marked handed over.`;
    }
    default: return null; // ignore normal chat in the admin group
  }
}

app = createApp({
  publicDir: path.join(__dirname, 'public'),
  hooks,
  onBotMessage,
  api: {
    'GET /api/catalog': async () => ({ ...publicCatalog(), payments: { payme: !!payme, click: !!click } }),

    'POST /api/order': async ({ user, body, notifyAdmin, escapeHtml }) => {
      if (!Array.isArray(body.items) || body.items.length === 0 || body.items.length > 50) throw badRequest('Your cart is empty');
      const lines = [];
      let total = 0;
      for (const { id, qty } of body.items) {
        const item = typeof id === 'string' ? findItem(id) : null;
        if (!item || item.hidden) throw badRequest('An item in your cart is no longer available');
        if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) throw badRequest(`Quantity must be 1 to ${MAX_QTY}`);
        total += item.price * qty;
        lines.push(`${qty} × ${escapeHtml(item.name)} = ${money(item.price * qty)}`);
      }
      const note = typeof body.note === 'string' ? body.note.trim().slice(0, 300) : '';
      const online = !!(payme || click);
      const order = { id: String(db.nextOrder++), userId: user.id, total, amountTiyin: total * 100, status: online ? 'pending' : 'unpaid', createdAt: Date.now() };
      db.orders[order.id] = order;
      store.save();
      const who = user.username ? `@${escapeHtml(user.username)}` : escapeHtml(user.first_name || 'customer');
      await notifyAdmin(
        `<b>New order #${order.id}</b>\nFrom: ${who} (id ${user.id})\n\n${lines.join('\n')}\n\n<b>Total: ${money(total)}</b>` +
        (note ? `\nNote: ${escapeHtml(note)}` : '') +
        `\n${online ? 'Waiting for online payment' : 'Pay on pickup'}`
      );
      return { orderId: order.id, total, totalText: money(total), status: order.status, pay: online ? payLinks(order) : null };
    },

    // The customer polls this after returning from Payme/Click. Only the owner can see an order.
    'GET /api/order-status': async ({ user, query }) => {
      const order = db.orders[String(query.get('id') || '')];
      if (!order || order.userId !== user.id) throw badRequest('Order not found');
      return { orderId: order.id, status: order.status, paidVia: order.paidVia || null };
    },
  },
});

if (require.main === module) {
  app.listen().then((port) => {
    const p = [payme && `Payme${payme.test ? ' (test)' : ''}`, click && 'Click'].filter(Boolean).join(' + ') || 'off (pay on pickup)';
    console.log(`ordering app on http://localhost:${port}${app.cfg.dev ? '  (dev mode: mock Telegram)' : ''}\npayments: ${p}\ndata: ${store.file}`);
  });
}
module.exports = app;
module.exports._store = store;
