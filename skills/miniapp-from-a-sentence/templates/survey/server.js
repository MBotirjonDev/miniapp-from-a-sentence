'use strict';
// Survey / lead form Mini App: one question per screen, answers validated against data.json,
// one response per Telegram user, sent to the admin chat.
const path = require('path');
const { createApp, badRequest } = require('../_lib/server-core.cjs');
const data = require('./data.json');

const answeredBy = new Set(); // Telegram user ids. Use a database in production.

function validate(answers) {
  if (!answers || typeof answers !== 'object') throw badRequest('No answers');
  const out = [];
  for (const q of data.questions) {
    let v = answers[q.id];
    if (q.type === 'choice') {
      if (!q.options.includes(v)) throw badRequest(`Choose an answer: ${q.text}`);
    } else if (q.type === 'phone') {
      v = String(v || '').replace(/[^\d+]/g, '');
      if (!/^\+?\d{7,15}$/.test(v)) throw badRequest('Enter a valid phone number');
    } else {
      v = String(v || '').trim().slice(0, q.max || 500);
      if (!v && !q.optional) throw badRequest(`Please answer: ${q.text}`);
    }
    out.push([q, v]);
  }
  return out;
}

const app = createApp({
  publicDir: path.join(__dirname, 'public'),
  api: {
    'GET /api/survey': async ({ user }) => ({ ...data, alreadyAnswered: answeredBy.has(user.id) }),

    'POST /api/answer': async ({ user, body, notifyAdmin, escapeHtml }) => {
      if (answeredBy.has(user.id)) throw Object.assign(new Error('You have already sent your answers. Thank you!'), { status: 409 });
      const pairs = validate(body.answers);
      answeredBy.add(user.id);
      const who = user.username ? `@${escapeHtml(user.username)}` : escapeHtml(user.first_name || 'user');
      await notifyAdmin(`<b>New lead: ${escapeHtml(data.title)}</b>\nFrom: ${who} (id ${user.id})\n\n` +
        pairs.filter(([, v]) => v).map(([q, v]) => `<b>${escapeHtml(q.text)}</b>\n${escapeHtml(v)}`).join('\n\n'));
      return { ok: true, thanks: data.thanks };
    },
  },
});

if (require.main === module) app.listen().then((port) => console.log(`survey app on http://localhost:${port}${app.cfg.dev ? '  (dev mode: mock Telegram)' : ''}`));
module.exports = Object.assign(app, { _test: { answeredBy } });
