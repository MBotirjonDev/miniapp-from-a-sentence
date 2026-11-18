// Local development only. In real Telegram, WebApp.initData is filled in and this file does nothing.
// In a normal browser it creates a small Telegram.WebApp stand-in: theme colors, MainButton,
// BackButton, and initData signed by the dev server, so the real server-side check still runs.
(function () {
  var real = window.Telegram && window.Telegram.WebApp;
  if (real && real.initData) return;

  var theme = {
    bg_color: '#ffffff', text_color: '#1c1c1e', hint_color: '#8e8e93', link_color: '#2481cc',
    button_color: '#2481cc', button_text_color: '#ffffff', secondary_bg_color: '#f2f2f7',
    section_bg_color: '#ffffff', section_separator_color: '#e5e5ea', destructive_text_color: '#e53935',
  };
  var root = document.documentElement.style;
  Object.keys(theme).forEach(function (k) { root.setProperty('--tg-theme-' + k.replace(/_/g, '-'), theme[k]); });

  function makeButton(id, cls) {
    var el = document.createElement('button');
    el.id = id; el.className = cls; el.hidden = true; el.type = 'button';
    var handlers = [];
    el.addEventListener('click', function () { if (!el.disabled) handlers.forEach(function (h) { h(); }); });
    document.addEventListener('DOMContentLoaded', function () { document.body.appendChild(el); });
    var api = {
      text: '', isVisible: false, isActive: true,
      setText: function (t) { api.text = t; el.textContent = t; return api; },
      show: function () { api.isVisible = true; el.hidden = false; return api; },
      hide: function () { api.isVisible = false; el.hidden = true; return api; },
      enable: function () { api.isActive = true; el.disabled = false; return api; },
      disable: function () { api.isActive = false; el.disabled = true; return api; },
      showProgress: function () { el.classList.add('loading'); return api; },
      hideProgress: function () { el.classList.remove('loading'); return api; },
      onClick: function (h) { handlers.push(h); return api; },
      offClick: function (h) { handlers = handlers.filter(function (x) { return x !== h; }); return api; },
    };
    return api;
  }

  var initReady = fetch('/dev/init-data').then(function (r) { return r.ok ? r.json() : { initData: '' }; })
    .then(function (d) {
      var wa = window.Telegram.WebApp;
      wa.initData = d.initData || '';
      // Mirror Telegram: initDataUnsafe is the parsed, UNVERIFIED copy. Use it for display only.
      try { var u = new URLSearchParams(wa.initData).get('user'); wa.initDataUnsafe = u ? { user: JSON.parse(u) } : {}; } catch (e) {}
    })
    .catch(function () {});

  window.Telegram = window.Telegram || {};
  window.Telegram.WebApp = {
    __mock: true, __initReady: initReady,
    initData: '', initDataUnsafe: {}, colorScheme: 'light', themeParams: theme, platform: 'mock',
    ready: function () {}, expand: function () {}, close: function () { document.body.dataset.closed = '1'; },
    MainButton: makeButton('mock-main-button', 'mock-main-button'),
    BackButton: makeButton('mock-back-button', 'mock-back-button'),
    HapticFeedback: { impactOccurred: function () {}, notificationOccurred: function () {}, selectionChanged: function () {} },
    showAlert: function (m, cb) { window.alert(m); if (cb) cb(); },
    // Real Telegram opens the link in the in-app browser. The mock records it instead of leaving the page.
    openLink: function (url) { document.body.dataset.openedLink = url; },
    onEvent: function () {}, offEvent: function () {},
  };
  window.Telegram.WebApp.BackButton.setText('‹ Back');
})();
