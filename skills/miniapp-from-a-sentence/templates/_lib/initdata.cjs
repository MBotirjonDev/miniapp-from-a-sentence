'use strict';
// Telegram Mini App initData validation (server side).
// Algorithm from https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
//   secret = HMAC_SHA256(key = "WebAppData", data = bot_token)
//   hash   = hex(HMAC_SHA256(key = secret, data = data_check_string))
//   data_check_string = every field except "hash", as key=value, sorted by key, joined by "\n"
// Never trust initDataUnsafe on the client: send the raw initData string to the server and check it here.
const crypto = require('crypto');

function dataCheckString(params) {
  return [...params.entries()]
    .filter(([k]) => k !== 'hash')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
}

function sign(params, botToken) {
  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  return crypto.createHmac('sha256', secret).update(dataCheckString(params)).digest('hex');
}

/**
 * Validate a raw initData query string.
 * @returns {{ok: true, user: object|null, authDate: number, params: URLSearchParams} | {ok: false, reason: string}}
 */
function validateInitData(initData, botToken, { maxAgeSeconds = 3600, now = Date.now() } = {}) {
  if (!botToken) return { ok: false, reason: 'server has no bot token' };
  if (typeof initData !== 'string' || initData.length === 0 || initData.length > 4096) {
    return { ok: false, reason: 'missing initData' };
  }
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash || !/^[0-9a-f]{64}$/.test(hash)) return { ok: false, reason: 'missing or malformed hash' };

  const expected = Buffer.from(sign(params, botToken), 'hex');
  const given = Buffer.from(hash, 'hex');
  // Constant-time compare: a plain === leaks how many leading characters matched.
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    return { ok: false, reason: 'bad hash' };
  }

  const authDate = Number(params.get('auth_date'));
  if (!Number.isFinite(authDate) || authDate <= 0) return { ok: false, reason: 'missing auth_date' };
  const age = Math.floor(now / 1000) - authDate;
  if (age > maxAgeSeconds) return { ok: false, reason: 'initData expired' };
  if (age < -60) return { ok: false, reason: 'auth_date is in the future' };

  let user = null;
  try { user = params.has('user') ? JSON.parse(params.get('user')) : null; } catch { return { ok: false, reason: 'bad user json' }; }
  return { ok: true, user, authDate, params };
}

/** Build a signed initData string. Used by tests and by the local dev mock, never in production. */
function buildInitData(fields, botToken) {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) params.set(k, typeof v === 'string' ? v : JSON.stringify(v));
  params.set('hash', sign(params, botToken));
  return params.toString();
}

module.exports = { validateInitData, buildInitData, dataCheckString };
