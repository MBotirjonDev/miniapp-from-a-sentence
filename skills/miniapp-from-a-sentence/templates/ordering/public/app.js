(function () {
  var el = tma.el, app = document.getElementById('app');
  var catalog = null, cart = {}; // id -> qty
  var MAX = 20;

  function money(n) { return n.toLocaleString('en-US').replace(/,/g, ' ') + ' ' + catalog.currency; }
  function find(id) { for (var c of catalog.categories) for (var i of c.items) if (i.id === id) return i; }
  function count() { return Object.values(cart).reduce(function (a, b) { return a + b; }, 0); }
  // Display only. The server recalculates the total from its own prices.
  function total() { return Object.keys(cart).reduce(function (s, id) { return s + find(id).price * cart[id]; }, 0); }

  function stepper(id) {
    var q = cart[id] || 0;
    var label = find(id).name;
    if (!q) return el('button', { class: 'btn', 'aria-label': 'Add ' + label, on: { click: function () { change(id, 1); } } }, ['Add']);
    return el('div', { class: 'stepper' }, [
      el('button', { class: 'btn', 'aria-label': 'Remove one ' + label, on: { click: function () { change(id, -1); } } }, ['−']),
      el('output', { 'aria-label': label + ' quantity', text: String(q) }),
      el('button', { class: 'btn', 'aria-label': 'Add one ' + label, disabled: q >= MAX ? '' : null, on: { click: function () { change(id, 1); } } }, ['+']),
    ]);
  }

  function change(id, d) {
    var q = Math.min(MAX, Math.max(0, (cart[id] || 0) + d));
    if (q) cart[id] = q; else delete cart[id];
    tma.haptic();
    renderMenu();
  }

  function renderMenu() {
    tma.backButton(null);
    app.replaceChildren(el('h1', { text: catalog.shop }), el('p', { class: 'sub', text: catalog.tagline }));
    catalog.categories.forEach(function (c) {
      app.appendChild(el('div', { class: 'section-title', text: c.name }));
      app.appendChild(el('div', { class: 'section' }, c.items.map(function (i) {
        return el('div', { class: 'row' }, [
          el('div', { class: 'grow' }, [el('div', { class: 'title', text: i.name }), el('div', { class: 'meta', text: i.description })]),
          el('div', { class: 'price meta', text: money(i.price) }),
          stepper(i.id),
        ]);
      })));
    });
    var n = count();
    tma.mainButton(n ? 'View order · ' + money(total()) : null, renderCart);
  }

  function renderCart() {
    tma.backButton(renderMenu);
    var note = el('textarea', { id: 'note', maxlength: '300', placeholder: 'For example: no sugar, pick up at 9:30' });
    var err = el('div', { class: 'error', role: 'alert' });
    app.replaceChildren(
      el('h1', { text: 'Your order' }),
      el('div', { class: 'section' }, Object.keys(cart).map(function (id) {
        var i = find(id);
        return el('div', { class: 'row' }, [
          el('div', { class: 'grow' }, [el('div', { class: 'title', text: cart[id] + ' × ' + i.name })]),
          el('div', { class: 'price', text: money(i.price * cart[id]) }),
        ]);
      }).concat([el('div', { class: 'total' }, [el('span', { text: 'Total' }), el('span', { class: 'price', text: money(total()) })])])),
      el('div', { class: 'section' }, [el('label', { class: 'field', for: 'note' }, [el('span', { text: 'Note for the shop (optional)' }), note])]),
      err
    );
    tma.mainButton('Place order', function () {
      tma.tg.MainButton.showProgress().disable();
      tma.api('/api/order', { items: Object.keys(cart).map(function (id) { return { id: id, qty: cart[id] }; }), note: note.value })
        .then(function (r) { cart = {}; tma.haptic('success'); renderDone(r); })
        .catch(function (e) { err.textContent = e.message; tma.haptic('error'); })
        .finally(function () { tma.tg.MainButton.hideProgress().enable(); });
    });
  }

  function renderDone(r) {
    tma.backButton(null);
    app.replaceChildren(el('div', { class: 'done' }, [
      el('div', { class: 'big', 'aria-hidden': 'true', text: '✓' }),
      el('h2', { text: 'Order #' + r.orderId + ' placed' }),
      el('p', { text: 'Total ' + r.totalText + '. The shop has received your order.' }),
    ]));
    tma.mainButton('Back to menu', renderMenu);
  }

  tma.api('/api/catalog').then(function (c) { catalog = c; renderMenu(); })
    .catch(function (e) { app.replaceChildren(el('p', { class: 'empty', text: 'Could not load the menu: ' + e.message })); });
})();
