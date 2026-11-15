'use strict';
// Zero-dependency server core shared by the templates (Node 18+).
// - serves the Mini App from public/
// - validates Telegram initData on every /api call (never trusts a user id from the client)
// - sends notifications to the admin chat through the Bot API
// - optional bot webhook protected by X-Telegram-Bot-Api-Secret-Token
// - local dev mode: a mock Telegram object with initData signed by a dev token, so the real
//   validation path runs in a normal browser
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { validateInitData, buildInitData } = require('./initdata.cjs');

const DEV_TOKEN = '000000:dev-token-for-local-testing-only';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

function config(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const botToken = env.BOT_TOKEN || '';
  if (production && !botToken) throw new Error('BOT_TOKEN is required in production');
  const dev = !production && !botToken;
  return {
    production,
    dev,
    botToken: botToken || DEV_TOKEN,
    adminChatId: env.ADMIN_CHAT_ID || '',
    webhookSecret: env.WEBHOOK_SECRET || '',
    webAppUrl: env.WEBAPP_URL || '',
    port: Number(env.PORT || 3000),
    maxAge: Number(env.INITDATA_MAX_AGE || 3600),
  };
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  res.writeHead(status, {
    'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
}

function readJson(req, limit = 16 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('body too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(Object.assign(new Error('bad json'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/**
 * @param {object} opts
 * @param {string} opts.publicDir
 * @param {Record<string, (ctx) => Promise<object>>} opts.api  e.g. { 'GET /api/catalog': fn, 'POST /api/order': fn }
 * @param {object} [opts.env]
 */
function createApp({ publicDir, api, env }) {
  const cfg = config(env);
  const outbox = []; // messages sent (or that would be sent) to the admin, kept for tests and dev logs

  async function notifyAdmin(html) {
    outbox.push(html);
    if (cfg.dev || !cfg.adminChatId) { console.log('[admin message]', html.replace(/<[^>]+>/g, '')); return; }
    const r = await fetch(`https://api.telegram.org/bot${cfg.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: cfg.adminChatId, text: html, parse_mode: 'HTML' }),
    });
    if (!r.ok) console.error('sendMessage failed', r.status);
  }

  async function botApi(method, payload) {
    if (cfg.dev) { console.log('[bot api]', method, JSON.stringify(payload)); return; }
    await fetch(`https://api.telegram.org/bot${cfg.botToken}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
  }

  function authenticate(req) {
    const result = validateInitData(req.headers['x-telegram-init-data'], cfg.botToken, { maxAgeSeconds: cfg.maxAge });
    if (!result.ok || !result.user || !Number.isInteger(result.user.id)) {
      throw Object.assign(new Error(result.ok ? 'no user in initData' : result.reason), { status: 401 });
    }
    return result.user;
  }

  async function handleWebhook(req, res) {
    // Without a secret anyone could POST fake updates to this URL.
    if (!cfg.webhookSecret || !safeEqual(req.headers['x-telegram-bot-api-secret-token'] || '', cfg.webhookSecret)) {
      return send(res, 401, { error: 'bad secret' });
    }
    const update = await readJson(req, 64 * 1024);
    const msg = update.message;
    if (msg && typeof msg.text === 'string' && msg.text.startsWith('/start') && cfg.webAppUrl) {
      await botApi('sendMessage', {
        chat_id: msg.chat.id,
        text: 'Open the app:',
        reply_markup: { inline_keyboard: [[{ text: 'Open', web_app: { url: cfg.webAppUrl } }]] },
      });
    }
    return send(res, 200, { ok: true });
  }

  function serveStatic(req, res, urlPath) {
    let rel = decodeURIComponent(urlPath);
    if (rel === '/') rel = '/index.html';
    const libClient = rel.startsWith('/_lib/');
    const base = libClient ? path.join(__dirname, 'client') : publicDir;
    const file = path.normalize(path.join(base, libClient ? rel.slice('/_lib'.length) : rel));
    if (!file.startsWith(base + path.sep)) return send(res, 403, 'forbidden');
    if (libClient && rel === '/_lib/mock-telegram.js' && !cfg.dev) return send(res, 200, '/* mock disabled outside dev */', { 'Content-Type': 'text/javascript' });
    fs.readFile(file, (err, data) => {
      if (err) return send(res, 404, 'not found');
      send(res, 200, data, {
        'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
    });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (req.method === 'POST' && url.pathname === '/bot/webhook') return await handleWebhook(req, res);

      if (cfg.dev && req.method === 'GET' && url.pathname === '/dev/init-data') {
        // Local testing only: a signed initData for a fake user, so the browser exercises the real check.
        const user = { id: 1001, first_name: 'Test', username: 'test_user', language_code: 'en' };
        return send(res, 200, { initData: buildInitData({ user, auth_date: String(Math.floor(Date.now() / 1000)), query_id: 'dev' }, cfg.botToken) });
      }

      const route = api[`${req.method} ${url.pathname}`];
      if (route) {
        const user = authenticate(req);
        const body = req.method === 'GET' ? {} : await readJson(req);
        const out = await route({ user, body, query: url.searchParams, notifyAdmin, escapeHtml, cfg });
        return send(res, 200, out);
      }
      if (url.pathname.startsWith('/api/')) return send(res, 404, { error: 'not found' });
      if (req.method === 'GET') return serveStatic(req, res, url.pathname);
      return send(res, 405, { error: 'method not allowed' });
    } catch (e) {
      const status = e.status || 500;
      if (status === 500) console.error(e);
      return send(res, status, { error: status === 500 ? 'server error' : e.message });
    }
  });

  return { server, cfg, outbox, listen: (port = cfg.port) => new Promise((r) => server.listen(port, () => r(server.address().port))) };
}

/** Throw a 400 with a message the client can show. */
function badRequest(message) { return Object.assign(new Error(message), { status: 400 }); }

module.exports = { createApp, badRequest, config, DEV_TOKEN };
