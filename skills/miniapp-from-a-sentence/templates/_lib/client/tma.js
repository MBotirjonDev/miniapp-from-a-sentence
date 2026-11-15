// Small helpers around Telegram.WebApp shared by the templates.
window.tma = (function () {
  var tg = window.Telegram && window.Telegram.WebApp;
  var ready = Promise.resolve(tg && tg.__initReady).then(function () {
    tg.ready();
    tg.expand();
    document.documentElement.dataset.scheme = tg.colorScheme || 'light';
  });

  // Every API call carries the raw initData; the server validates it. Never send a user id yourself.
  function api(path, body) {
    return ready.then(function () {
      return fetch(path, {
        method: body ? 'POST' : 'GET',
        headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': tg.initData },
        body: body ? JSON.stringify(body) : undefined,
      });
    }).then(function (r) {
      return r.json().then(function (data) {
        if (!r.ok) throw new Error(data.error || 'Request failed');
        return data;
      });
    });
  }

  var mainHandler = null;
  function mainButton(text, onClick) {
    var b = tg.MainButton;
    if (mainHandler) b.offClick(mainHandler);
    if (!text) { b.hide(); mainHandler = null; return; }
    mainHandler = onClick;
    b.setText(text).enable().show();
    b.onClick(mainHandler);
  }

  var backHandler = null;
  function backButton(onClick) {
    var b = tg.BackButton;
    if (backHandler) b.offClick(backHandler);
    backHandler = onClick || null;
    if (onClick) { b.onClick(onClick); b.show(); } else b.hide();
  }

  function haptic(kind) {
    try { kind === 'success' || kind === 'error' ? tg.HapticFeedback.notificationOccurred(kind) : tg.HapticFeedback.impactOccurred('light'); } catch (e) {}
  }

  function el(tag, attrs, children) {
    var n = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (attrs[k] === null || attrs[k] === undefined || attrs[k] === false) return;
      if (k === 'on') Object.keys(attrs.on).forEach(function (ev) { n.addEventListener(ev, attrs.on[ev]); });
      else if (k === 'text') n.textContent = attrs.text; // textContent, never innerHTML: names come from users
      else n.setAttribute(k, attrs[k]);
    });
    (children || []).forEach(function (c) { if (c) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return n;
  }

  return { tg: tg, ready: ready, api: api, mainButton: mainButton, backButton: backButton, haptic: haptic, el: el };
})();
