'use strict';
// Ordering Mini App: catalog -> cart -> order -> optional Payme / Click payment -> admin chat.
// Prices live here on the server. The client sends only item ids and quantities.
// Payments turn on when their environment variables are set (see .env.example); without them
// orders are taken as "pay on pickup".
const path = require('path');
const { createApp, badRequest } = require('../_lib/server-core.cjs');
const pay = require('../_lib/payments.cjs');
const data = require('./data.json');

const items = new Map(data.categories.flatMap((c) => c.items.map((i) => [i.id, i])));
const MAX_QTY = 20;
const env = process.env;

const payme = env.PAYME_MERCHANT_ID && env.PAYME_KEY ? { merchantId: env.PAYME_MERCHANT_ID, key: env.PAYME_KEY, test: env.PAYME_TEST === '1' } : null;
const click = env.CLICK_SERVICE_ID && env.CLICK_MERCHANT_ID && env.CLICK_SECRET_KEY
  ? { serviceId: Number(env.CLICK_SERVICE_ID), merchantId: Number(env.CLICK_MERCHANT_ID), secretKey: env.CLICK_SECRET_KEY } : null;
if ((payme || click) && data.currency !== 'UZS') throw new Error('Payme and Click accept UZS only: set "currency": "UZS" in data.json');
const returnUrl = env.WEBAPP_URL || undefined;

// ── in-memory storage: replace with a database before real customers ──────
const orders = new Map(); // id -> order
const paymeTx = new Map(); // paymeId -> tx
const clickPrepares = new Map(); // id -> prepare
let nextOrder = 1, nextPrepare = 1;

const money = (n) => `${n.toLocaleString('en-US').replace(/,/g, ' ')} ${data.currency}`;
let notify = async () => {}; // set on first request; payment callbacks reuse it

async function markPaid(order, via) {
  if (order.status === 'paid') return;
  order.status = 'paid';
  order.paidVia = via;
  await notify(`<b>Order #${order.id} PAID</b> via ${via}\nTotal: ${money(order.total)}`);
}
async function markCancelled(order, via, wasPaid) {
  order.status = 'cancelled';
  await notify(`<b>Order #${order.id} ${wasPaid ? 'REFUNDED' : 'payment cancelled'}</b> (${via})`);
}

const paymeStore = {
  findOrder: async (account) => orders.get(String(account.order_id)) || null,
  findTx: async (id) => paymeTx.get(id) || null,
  openTxForOrder: async (orderId) => [...paymeTx.values()].find((t) => t.orderId === orderId && (t.state === pay.PAYME_STATE.CREATED || t.state === pay.PAYME_STATE.PERFORMED)) || null,
  saveTx: async (tx) => { paymeTx.set(tx.paymeId, tx); },
  txBetween: async (from, to) => [...paymeTx.values()].filter((t) => t.paymeTime >= from && t.paymeTime <= to),
  onPaid: async (orderId) => markPaid(orders.get(orderId), 'Payme'),
  onCancelled: async (orderId, tx, wasPaid) => markCancelled(orders.get(orderId), 'Payme', wasPaid),
  // A paid order can be refunded until the shop marks it handed over (not modelled here).
  canCancelPaid: async (orderId) => !orders.get(orderId).handedOver,
};

const clickStore = {
  findOrder: async (id) => orders.get(String(id)) || null,
  findPrepare: async (id) => clickPrepares.get(id) || null,
  prepare: async (order, req) => {
    const existing = [...clickPrepares.values()].find((p) => p.clickTransId === req.clickTransId);
    if (existing) return existing.id;
    const p = { id: nextPrepare++, orderId: order.id, clickTransId: req.clickTransId, amountTiyin: req.amountTiyin };
    clickPrepares.set(p.id, p);
    return p.id;
  },
  complete: async (order, prepare) => { await markPaid(order, 'Click'); return prepare.id; },
  cancel: async (order) => markCancelled(order, 'Click', false),
};

const hooks = {};
if (payme) {
  const handle = pay.createPaymeHandler({ key: payme.key, store: paymeStore });
  hooks['POST /payments/payme'] = async ({ headers, text, notifyAdmin }) => { notify = notifyAdmin; return handle(headers, text); };
}
if (click) {
  const handle = pay.createClickHandler({ serviceId: click.serviceId, secretKey: click.secretKey, store: clickStore });
  hooks['POST /payments/click'] = async ({ text, notifyAdmin }) => { notify = notifyAdmin; return handle(text); };
}

function payLinks(order) {
  const links = {};
  const amountTiyin = order.amountTiyin;
  if (payme) links.payme = pay.paymeCheckoutUrl({ merchantId: payme.merchantId, account: { order_id: order.id }, amountTiyin, returnUrl, test: payme.test });
  if (click) links.click = pay.clickCheckoutUrl({ serviceId: click.serviceId, merchantId: click.merchantId, transactionParam: order.id, amountTiyin, returnUrl });
  return links;
}

const app = createApp({
  publicDir: path.join(__dirname, 'public'),
  hooks,
  api: {
    'GET /api/catalog': async () => ({ ...data, payments: { payme: !!payme, click: !!click } }),

    'POST /api/order': async ({ user, body, notifyAdmin, escapeHtml }) => {
      notify = notifyAdmin;
      if (!Array.isArray(body.items) || body.items.length === 0 || body.items.length > 50) throw badRequest('Your cart is empty');
      const lines = [];
      let total = 0;
      for (const { id, qty } of body.items) {
        const item = items.get(id);
        if (!item) throw badRequest('An item in your cart is no longer available');
        if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) throw badRequest(`Quantity must be 1 to ${MAX_QTY}`);
        total += item.price * qty;
        lines.push(`${qty} × ${escapeHtml(item.name)} = ${money(item.price * qty)}`);
      }
      const note = typeof body.note === 'string' ? body.note.trim().slice(0, 300) : '';
      const online = !!(payme || click);
      const order = { id: String(nextOrder++), userId: user.id, total, amountTiyin: total * 100, status: online ? 'pending' : 'unpaid', createdAt: Date.now() };
      orders.set(order.id, order);
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
      const order = orders.get(String(query.get('id') || ''));
      if (!order || order.userId !== user.id) throw badRequest('Order not found');
      return { orderId: order.id, status: order.status, paidVia: order.paidVia || null };
    },
  },
});

if (require.main === module) {
  app.listen().then((port) => {
    const p = [payme && `Payme${payme.test ? ' (test)' : ''}`, click && 'Click'].filter(Boolean).join(' + ') || 'off (pay on pickup)';
    console.log(`ordering app on http://localhost:${port}${app.cfg.dev ? '  (dev mode: mock Telegram)' : ''}\npayments: ${p}`);
  });
}
module.exports = app;
module.exports._state = { orders, paymeTx, clickPrepares };
