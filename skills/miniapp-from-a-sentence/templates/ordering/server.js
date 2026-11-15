'use strict';
// Ordering Mini App: catalog -> cart -> order sent to the admin chat.
// Prices live here on the server. The client sends only item ids and quantities.
const path = require('path');
const { createApp, badRequest } = require('../_lib/server-core.cjs');
const data = require('./data.json');

const items = new Map(data.categories.flatMap((c) => c.items.map((i) => [i.id, i])));
const MAX_QTY = 20;
let nextOrder = 1;

const money = (n) => `${n.toLocaleString('en-US').replace(/,/g, ' ')} ${data.currency}`;

const app = createApp({
  publicDir: path.join(__dirname, 'public'),
  api: {
    'GET /api/catalog': async () => data,

    'POST /api/order': async ({ user, body, notifyAdmin, escapeHtml }) => {
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
      const orderId = nextOrder++;
      const who = user.username ? `@${escapeHtml(user.username)}` : escapeHtml(user.first_name || 'customer');
      await notifyAdmin(
        `<b>New order #${orderId}</b>\nFrom: ${who} (id ${user.id})\n\n${lines.join('\n')}\n\n<b>Total: ${money(total)}</b>` +
        (note ? `\nNote: ${escapeHtml(note)}` : '')
      );
      return { orderId, total, totalText: money(total) };
    },
  },
});

if (require.main === module) app.listen().then((port) => console.log(`ordering app on http://localhost:${port}${app.cfg.dev ? '  (dev mode: mock Telegram)' : ''}`));
module.exports = app;
