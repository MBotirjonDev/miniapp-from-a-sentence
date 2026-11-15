'use strict';
// Booking Mini App: service -> day -> free slot -> contact -> booking sent to the admin chat.
// The server owns the schedule: it computes free slots and rejects a slot that was taken a second ago.
const path = require('path');
const { createApp, badRequest } = require('../_lib/server-core.cjs');
const data = require('./data.json');

const services = new Map(data.services.map((s) => [s.id, s]));
const booked = new Map(); // "YYYY-MM-DD HH:MM" -> booking. Use a database in production.
let nextId = 1;

// "Now" in the business's time zone, as a Date whose UTC fields hold local wall-clock time.
const localNow = (now = Date.now()) => new Date(now + data.utcOffsetMinutes * 60000);
const ymd = (d) => d.toISOString().slice(0, 10);
const hhmm = (h, m) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;

function days(now) {
  const out = [];
  const base = localNow(now);
  for (let i = 0; out.length < data.daysAhead && i < 31; i++) {
    const d = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + i));
    if (!data.closedWeekdays.includes(d.getUTCDay())) out.push(ymd(d));
  }
  return out;
}

function freeSlots(date, now) {
  if (!days(now).includes(date)) return [];
  const cur = localNow(now);
  const today = ymd(cur);
  const out = [];
  for (let t = data.openHour * 60; t + data.slotMinutes <= data.closeHour * 60; t += data.slotMinutes) {
    const time = hhmm(Math.floor(t / 60), t % 60);
    const past = date === today && t <= cur.getUTCHours() * 60 + cur.getUTCMinutes();
    out.push({ time, free: !past && !booked.has(`${date} ${time}`) });
  }
  return out;
}

const app = createApp({
  publicDir: path.join(__dirname, 'public'),
  api: {
    'GET /api/config': async ({ user }) => ({ firstName: user.first_name || '', business: data.business, tagline: data.tagline, currency: data.currency, services: data.services, days: days() }),
    'GET /api/slots': async ({ query }) => ({ slots: freeSlots(String(query.get('date') || '')) }),

    'POST /api/book': async ({ user, body, notifyAdmin, escapeHtml }) => {
      const service = services.get(body.serviceId);
      if (!service) throw badRequest('Choose a service');
      const slot = freeSlots(String(body.date || '')).find((s) => s.time === body.time);
      if (!slot) throw badRequest('Choose a day and time');
      if (!slot.free) throw Object.assign(new Error('This time was just taken. Please choose another one.'), { status: 409 });
      const name = String(body.name || '').trim().slice(0, 60);
      const phone = String(body.phone || '').replace(/[^\d+]/g, '').slice(0, 16);
      if (name.length < 2) throw badRequest('Enter your name');
      if (!/^\+?\d{7,15}$/.test(phone)) throw badRequest('Enter a phone number, for example +998 90 123 45 67');

      const key = `${body.date} ${body.time}`;
      if (booked.has(key)) throw Object.assign(new Error('This time was just taken. Please choose another one.'), { status: 409 });
      const booking = { id: nextId++, service: service.name, date: body.date, time: body.time, userId: user.id };
      booked.set(key, booking);
      const who = user.username ? `@${escapeHtml(user.username)}` : `id ${user.id}`;
      await notifyAdmin(`<b>New booking #${booking.id}</b>\n${escapeHtml(service.name)}\n${body.date} at ${body.time}\n\n${escapeHtml(name)}, ${escapeHtml(phone)} (${who})`);
      return { bookingId: booking.id, service: service.name, date: body.date, time: body.time };
    },
  },
});

if (require.main === module) app.listen().then((port) => console.log(`booking app on http://localhost:${port}${app.cfg.dev ? '  (dev mode: mock Telegram)' : ''}`));
module.exports = Object.assign(app, { _test: { freeSlots, days, booked } });
