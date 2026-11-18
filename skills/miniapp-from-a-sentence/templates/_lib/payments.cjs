'use strict';
// Payme and Click for the templates, zero dependencies (Node 18+).
// A JavaScript port of the uz_payments Dart package (github.com/MBotirjonDev/uz_payments):
// - checkout links for the Mini App (public ids only, never secrets)
// - Payme Merchant API (JSON-RPC: all 7 methods, 12-hour timeout, idempotent retries)
// - Click SHOP-API (Prepare / Complete, MD5 sign check)
// Money is always an integer number of tiyin (1 so'm = 100 tiyin). No floating point.
const crypto = require('crypto');

function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/** 150000 -> "1500.00" */
function formatSom(tiyin) {
  if (!Number.isSafeInteger(tiyin) || tiyin < 0) throw new Error('tiyin must be a non-negative integer');
  return `${Math.floor(tiyin / 100)}.${String(tiyin % 100).padStart(2, '0')}`;
}

/** "1000", "1000.5", "1000.50" -> tiyin, without floating point. null if malformed. */
function parseSomToTiyin(value) {
  const m = /^(\d{1,15})(?:\.(\d{1,2})0*)?$/.exec(String(value).trim());
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] || '').padEnd(2, '0'));
}

// ── checkout links ─────────────────────────────────────────────────────────

function noSemicolon(name, v) {
  // ';' separates Payme parameters; a value containing it could inject a different amount.
  if (String(v).includes(';')) throw new Error(`${name} must not contain ";"`);
}

function paymeCheckoutUrl({ merchantId, account, amountTiyin, lang, returnUrl, test = false }) {
  if (!merchantId) throw new Error('merchantId is required');
  if (!Number.isSafeInteger(amountTiyin) || amountTiyin <= 0) throw new Error('amountTiyin must be a positive integer');
  noSemicolon('merchantId', merchantId);
  const parts = [`m=${merchantId}`];
  for (const [k, v] of Object.entries(account || {})) { noSemicolon('account key', k); noSemicolon(`account.${k}`, v); parts.push(`ac.${k}=${v}`); }
  if (parts.length === 1) throw new Error('account must contain at least one field');
  parts.push(`a=${amountTiyin}`);
  if (lang) { if (!['uz', 'ru', 'en'].includes(lang)) throw new Error('lang must be uz, ru or en'); parts.push(`l=${lang}`); }
  if (returnUrl) { noSemicolon('returnUrl', returnUrl); parts.push(`c=${returnUrl}`); }
  const base = test ? 'https://test.paycom.uz' : 'https://checkout.paycom.uz';
  return `${base}/${Buffer.from(parts.join(';'), 'utf8').toString('base64')}`;
}

function clickCheckoutUrl({ serviceId, merchantId, transactionParam, amountTiyin, returnUrl }) {
  if (!(Number(serviceId) > 0) || !(Number(merchantId) > 0)) throw new Error('serviceId and merchantId are required');
  if (!transactionParam) throw new Error('transactionParam is required');
  const q = new URLSearchParams({ service_id: String(serviceId), merchant_id: String(merchantId), amount: formatSom(amountTiyin), transaction_param: String(transactionParam) });
  if (returnUrl) q.set('return_url', returnUrl);
  return `https://my.click.uz/services/pay?${q}`;
}

// ── Payme Merchant API ─────────────────────────────────────────────────────

const PAYME_STATE = { CREATED: 1, PERFORMED: 2, CANCELLED: -1, CANCELLED_AFTER_PERFORM: -2 };
const PAYME_ERR = {
  internal: -32400, privilege: -32504, invalidRequest: -32600, methodNotFound: -32601, parse: -32700,
  amount: -31001, notFound: -31003, cannotCancel: -31007, cannotPerform: -31008, account: -31050,
};
const PAYME_MSG = {
  [PAYME_ERR.internal]: ['Внутренняя ошибка системы.', 'Tizimning ichki xatosi.', 'Internal system error.'],
  [PAYME_ERR.privilege]: ['Недостаточно привилегий для выполнения метода.', 'Ushbu amalni bajarish uchun huquq yetarli emas.', 'Insufficient privilege to perform this method.'],
  [PAYME_ERR.invalidRequest]: ['Неверный JSON-RPC запрос.', "JSON-RPC so'rovi noto'g'ri.", 'Invalid JSON-RPC object.'],
  [PAYME_ERR.methodNotFound]: ['Метод не найден.', 'Metod topilmadi.', 'Method not found.'],
  [PAYME_ERR.parse]: ['Ошибка разбора JSON.', "JSON'ni o'qishda xato.", 'Parse error.'],
  [PAYME_ERR.amount]: ['Неверная сумма.', "Summa noto'g'ri.", 'Incorrect amount.'],
  [PAYME_ERR.notFound]: ['Транзакция не найдена.', 'Tranzaksiya topilmadi.', 'Transaction not found.'],
  [PAYME_ERR.cannotCancel]: ['Невозможно отменить транзакцию.', "Tranzaksiyani bekor qilib bo'lmaydi.", 'Could not cancel transaction.'],
  [PAYME_ERR.cannotPerform]: ['Невозможно выполнить данную операцию.', "Bu amalni bajarib bo'lmaydi.", 'Could not perform this operation.'],
  [PAYME_ERR.account]: ['Заказ не найден.', 'Buyurtma topilmadi.', 'Order not found.'],
};
class PaymeError extends Error {
  constructor(code, data) { super(PAYME_MSG[code][2]); this.code = code; this.data = data; }
  toJSON() { const [ru, uz, en] = PAYME_MSG[this.code]; return { code: this.code, message: { ru, uz, en }, ...(this.data !== undefined ? { data: this.data } : {}) }; }
}

/**
 * @param {object} o
 * @param {string} o.key        cashbox key (server only)
 * @param {object} o.store      { findOrder(account), findTx(paymeId), openTxForOrder(orderId), saveTx(tx), txBetween(from, to), onPaid(order, tx), onCancelled(order, tx, wasPaid), canCancelPaid(order) }
 */
function createPaymeHandler({ key, store, login = 'Paycom', timeoutMs = 12 * 3600 * 1000, accountField = 'order_id', now = Date.now }) {
  if (!key) throw new Error('PAYME_KEY is required');

  function authorized(header) {
    const m = /^\s*Basic\s+(\S+)\s*$/i.exec(header || '');
    if (!m) return false;
    return safeEqual(Buffer.from(m[1], 'base64').toString('utf8'), `${login}:${key}`);
  }
  const int = (p, n) => { const v = p[n]; if (Number.isSafeInteger(v)) return v; throw new PaymeError(PAYME_ERR.invalidRequest, n); };
  const str = (p, n) => { const v = p[n]; if (typeof v === 'string' && v) return v; throw new PaymeError(PAYME_ERR.invalidRequest, n); };
  const amountOf = (p) => { const a = p.amount; if (Number.isSafeInteger(a) && a > 0) return a; throw new PaymeError(PAYME_ERR.amount); };
  const accountOf = (p) => { if (p.account && typeof p.account === 'object' && !Array.isArray(p.account)) return p.account; throw new PaymeError(PAYME_ERR.account, accountField); };
  const active = (tx) => tx.state === PAYME_STATE.CREATED;
  const expired = (tx, t) => active(tx) && t - tx.createTime > timeoutMs;

  async function payableOrder(account, amount) {
    const order = await store.findOrder(account);
    if (!order) throw new PaymeError(PAYME_ERR.account, accountField);
    if (order.amountTiyin !== amount) throw new PaymeError(PAYME_ERR.amount);
    if (order.status !== 'pending') throw new PaymeError(PAYME_ERR.cannotPerform);
    return order;
  }
  async function found(id) { const tx = await store.findTx(id); if (!tx) throw new PaymeError(PAYME_ERR.notFound); return tx; }
  async function cancelTx(tx, reason, t) {
    const wasPaid = tx.state === PAYME_STATE.PERFORMED;
    Object.assign(tx, { state: wasPaid ? PAYME_STATE.CANCELLED_AFTER_PERFORM : PAYME_STATE.CANCELLED, cancelTime: t, reason });
    await store.saveTx(tx);
    await store.onCancelled(tx.orderId, tx, wasPaid);
  }
  const createResult = (tx) => ({ create_time: tx.createTime, transaction: tx.id, state: tx.state, receivers: null });

  const methods = {
    async CheckPerformTransaction(p) {
      const order = await payableOrder(accountOf(p), amountOf(p));
      if (await store.openTxForOrder(order.id)) throw new PaymeError(PAYME_ERR.cannotPerform);
      return { allow: true };
    },
    async CreateTransaction(p) {
      const id = str(p, 'id'), time = int(p, 'time'), amount = amountOf(p), account = accountOf(p), t = now();
      const existing = await store.findTx(id);
      if (existing) {
        if (!active(existing)) throw new PaymeError(PAYME_ERR.cannotPerform);
        if (expired(existing, t)) { await cancelTx(existing, 4, t); throw new PaymeError(PAYME_ERR.cannotPerform); }
        return createResult(existing);
      }
      const order = await payableOrder(account, amount);
      const open = await store.openTxForOrder(order.id);
      if (open && open.paymeId !== id) throw new PaymeError(PAYME_ERR.account, accountField);
      if (t - time > timeoutMs) throw new PaymeError(PAYME_ERR.cannotPerform);
      const tx = { id: crypto.randomUUID(), paymeId: id, paymeTime: time, amount, account, orderId: order.id, createTime: t, performTime: 0, cancelTime: 0, state: PAYME_STATE.CREATED, reason: null };
      await store.saveTx(tx);
      return createResult(tx);
    },
    async PerformTransaction(p) {
      const tx = await found(str(p, 'id')), t = now();
      if (tx.state === PAYME_STATE.CREATED) {
        if (expired(tx, t)) { await cancelTx(tx, 4, t); throw new PaymeError(PAYME_ERR.cannotPerform); }
        Object.assign(tx, { state: PAYME_STATE.PERFORMED, performTime: t });
        await store.saveTx(tx);
        await store.onPaid(tx.orderId, tx);
      } else if (tx.state !== PAYME_STATE.PERFORMED) throw new PaymeError(PAYME_ERR.cannotPerform);
      return { transaction: tx.id, perform_time: tx.performTime, state: tx.state };
    },
    async CancelTransaction(p) {
      const tx = await found(str(p, 'id')), reason = int(p, 'reason'), t = now();
      if (tx.state === PAYME_STATE.CREATED) await cancelTx(tx, reason, t);
      else if (tx.state === PAYME_STATE.PERFORMED) {
        if (!(await store.canCancelPaid(tx.orderId))) throw new PaymeError(PAYME_ERR.cannotCancel);
        await cancelTx(tx, reason, t);
      }
      return { transaction: tx.id, cancel_time: tx.cancelTime, state: tx.state };
    },
    async CheckTransaction(p) {
      const tx = await found(str(p, 'id'));
      return { create_time: tx.createTime, perform_time: tx.performTime, cancel_time: tx.cancelTime, transaction: tx.id, state: tx.state, reason: tx.reason };
    },
    async GetStatement(p) {
      const from = int(p, 'from'), to = int(p, 'to');
      if (from >= to) throw new PaymeError(PAYME_ERR.invalidRequest, 'from');
      const list = await store.txBetween(from, to);
      return { transactions: list.map((tx) => ({ id: tx.paymeId, time: tx.paymeTime, amount: tx.amount, account: tx.account, create_time: tx.createTime, perform_time: tx.performTime, cancel_time: tx.cancelTime, transaction: tx.id, state: tx.state, reason: tx.reason, receivers: null })) };
    },
    async ChangePassword() { throw new PaymeError(PAYME_ERR.internal); }, // store the new key in your env by hand
  };

  /** @returns {Promise<object>} the JSON body to send with HTTP 200 */
  return async function handle(headers, bodyText) {
    let id = null;
    try {
      let payload;
      try { payload = JSON.parse(bodyText); } catch { throw new PaymeError(PAYME_ERR.parse); }
      if (!payload || typeof payload !== 'object') throw new PaymeError(PAYME_ERR.invalidRequest);
      id = payload.id ?? null;
      if (!authorized(headers.authorization)) throw new PaymeError(PAYME_ERR.privilege);
      const { method, params } = payload;
      if (typeof method !== 'string' || !params || typeof params !== 'object') throw new PaymeError(PAYME_ERR.invalidRequest);
      if (!Object.prototype.hasOwnProperty.call(methods, method)) throw new PaymeError(PAYME_ERR.methodNotFound, method);
      return { jsonrpc: '2.0', id, result: await methods[method](params) };
    } catch (e) {
      const err = e instanceof PaymeError ? e : new PaymeError(PAYME_ERR.internal); // never leak internals
      if (!(e instanceof PaymeError)) console.error('payme handler error', e);
      return { jsonrpc: '2.0', id, error: err.toJSON() };
    }
  };
}

// ── Click SHOP-API ─────────────────────────────────────────────────────────

const CLICK_ERR = { success: 0, sign: -1, amount: -2, action: -3, alreadyPaid: -4, orderNotFound: -5, txNotFound: -6, update: -7, badRequest: -8, cancelled: -9 };
const CLICK_REQUIRED = ['click_trans_id', 'service_id', 'click_paydoc_id', 'merchant_trans_id', 'amount', 'action', 'error', 'error_note', 'sign_time', 'sign_string'];

/**
 * @param {object} o
 * @param {object} o.store  { findOrder(merchantTransId), findPrepare(id), prepare(order, req) -> id, complete(order, prepare, req) -> id, cancel(order, prepare, req) }
 */
function createClickHandler({ serviceId, secretKey, store }) {
  if (!secretKey) throw new Error('CLICK_SECRET_KEY is required');
  serviceId = Number(serviceId);

  return async function handle(bodyText) {
    const text = String(bodyText || '').trim();
    let f = {};
    try { f = text.startsWith('{') ? JSON.parse(text) : Object.fromEntries(new URLSearchParams(text)); } catch { f = {}; }
    for (const k of Object.keys(f)) if (f[k] !== null && f[k] !== undefined) f[k] = String(f[k]);
    const action = f.action;
    const reply = (error, note, ids = {}) => ({
      click_trans_id: Number(f.click_trans_id) || f.click_trans_id || null,
      merchant_trans_id: f.merchant_trans_id ?? null,
      ...(action === '1' ? { merchant_confirm_id: ids.confirm ?? null } : { merchant_prepare_id: ids.prepare ?? null }),
      error, error_note: note,
    });

    if (CLICK_REQUIRED.some((k) => f[k] === undefined) || (action === '1' && f.merchant_prepare_id === undefined)) return reply(CLICK_ERR.badRequest, 'Error in request from click');
    const expected = crypto.createHash('md5').update([f.click_trans_id, f.service_id, secretKey, f.merchant_trans_id, action === '1' ? f.merchant_prepare_id : '', f.amount, action, f.sign_time].join('')).digest('hex');
    if (!safeEqual(expected, f.sign_string.toLowerCase())) return reply(CLICK_ERR.sign, 'SIGN CHECK FAILED!');
    if (action !== '0' && action !== '1') return reply(CLICK_ERR.action, 'Action not found');
    const nums = ['click_trans_id', 'service_id', 'click_paydoc_id'].map((k) => (/^\d+$/.test(f[k]) ? Number(f[k]) : null));
    const clickError = /^-?\d+$/.test(f.error) ? Number(f.error) : null;
    const prepareId = action === '1' ? (/^\d+$/.test(f.merchant_prepare_id) ? Number(f.merchant_prepare_id) : null) : null;
    if (nums.includes(null) || clickError === null || (action === '1' && prepareId === null) || nums[1] !== serviceId) return reply(CLICK_ERR.badRequest, 'Error in request from click');
    const amount = parseSomToTiyin(f.amount);
    if (amount === null) return reply(CLICK_ERR.amount, 'Incorrect parameter amount');
    const req = { clickTransId: nums[0], clickPaydocId: nums[2], merchantTransId: f.merchant_trans_id, amountTiyin: amount, action: Number(action), error: clickError, prepareId };

    try {
      const order = await store.findOrder(req.merchantTransId);
      if (!order) return reply(CLICK_ERR.orderNotFound, 'User does not exist');
      let prepare = null;
      if (req.action === 1) {
        prepare = await store.findPrepare(prepareId);
        if (!prepare || prepare.orderId !== order.id) return reply(CLICK_ERR.txNotFound, 'Transaction does not exist', { confirm: prepareId });
      }
      if (order.status === 'paid') return reply(CLICK_ERR.alreadyPaid, 'Already paid', { prepare: prepareId, confirm: prepareId });
      if (order.status === 'cancelled') return reply(CLICK_ERR.cancelled, 'Transaction cancelled', { prepare: prepareId, confirm: prepareId });
      if (req.amountTiyin !== order.amountTiyin) return reply(CLICK_ERR.amount, 'Incorrect parameter amount');
      if (req.action === 0) return reply(CLICK_ERR.success, 'Success', { prepare: await store.prepare(order, req) });
      if (req.error < 0) { await store.cancel(order, prepare, req); return reply(CLICK_ERR.cancelled, 'Transaction cancelled', { confirm: prepare.id }); }
      return reply(CLICK_ERR.success, 'Success', { confirm: await store.complete(order, prepare, req) });
    } catch (e) {
      console.error('click handler error', e);
      return reply(CLICK_ERR.update, 'Failed to update user');
    }
  };
}

module.exports = {
  formatSom, parseSomToTiyin, paymeCheckoutUrl, clickCheckoutUrl,
  createPaymeHandler, createClickHandler, PAYME_STATE, PAYME_ERR, CLICK_ERR,
};
