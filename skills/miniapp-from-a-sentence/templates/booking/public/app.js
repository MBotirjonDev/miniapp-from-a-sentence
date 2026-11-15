(function () {
  var el = tma.el, app = document.getElementById('app');
  var cfg = null, pick = { serviceId: null, date: null, time: null };

  function money(n) { return n.toLocaleString('en-US').replace(/,/g, ' ') + ' ' + cfg.currency; }
  function dayLabel(iso) {
    var d = new Date(iso + 'T00:00:00Z');
    return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  }

  function renderServices() {
    tma.backButton(null);
    tma.mainButton(null);
    app.replaceChildren(el('h1', { text: cfg.business }), el('p', { class: 'sub', text: cfg.tagline }),
      el('div', { class: 'section-title', text: 'Service' }),
      el('div', { class: 'section' }, cfg.services.map(function (s) {
        return el('div', { class: 'row' }, [
          el('div', { class: 'grow' }, [el('div', { class: 'title', text: s.name }), el('div', { class: 'meta', text: s.minutes + ' min' })]),
          el('div', { class: 'price meta', text: money(s.price) }),
          el('button', { class: 'btn', 'aria-label': 'Choose ' + s.name, on: { click: function () { pick.serviceId = s.id; pick.date = cfg.days[0]; pick.time = null; tma.haptic(); renderTime(); } } }, ['Choose']),
        ]);
      })));
  }

  function renderTime() {
    tma.backButton(renderServices);
    var service = cfg.services.find(function (s) { return s.id === pick.serviceId; });
    var slotsBox = el('div', { class: 'chips', 'aria-label': 'Times' }, [el('span', { class: 'meta', text: 'Loading times…' })]);
    app.replaceChildren(el('h1', { text: service.name }), el('p', { class: 'sub', text: money(service.price) + ' · ' + service.minutes + ' min' }),
      el('div', { class: 'section-title', text: 'Day' }),
      el('div', { class: 'section' }, [el('div', { class: 'chips' }, cfg.days.map(function (d) {
        return el('button', { class: 'chip', 'aria-pressed': String(d === pick.date), on: { click: function () { pick.date = d; pick.time = null; renderTime(); } } }, [dayLabel(d)]);
      }))]),
      el('div', { class: 'section-title', text: 'Time' }),
      el('div', { class: 'section' }, [slotsBox]));
    tma.mainButton(null);
    tma.api('/api/slots?date=' + pick.date).then(function (r) {
      var any = r.slots.some(function (s) { return s.free; });
      slotsBox.replaceChildren.apply(slotsBox, any ? r.slots.map(function (s) {
        return el('button', { class: 'chip', disabled: s.free ? null : '', 'aria-pressed': String(s.time === pick.time), 'aria-label': s.time + (s.free ? '' : ' taken'),
          on: { click: function () { pick.time = s.time; tma.haptic(); renderTime(); } } }, [s.time]);
      }) : [el('span', { class: 'meta', text: 'No free times this day. Try another day.' })]);
      if (pick.time) tma.mainButton('Continue · ' + dayLabel(pick.date) + ', ' + pick.time, renderContact);
    });
  }

  function renderContact() {
    tma.backButton(renderTime);
    var name = el('input', { id: 'name', autocomplete: 'name', maxlength: '60', value: cfg.firstName }); // name from the server-verified initData, not initDataUnsafe
    var phone = el('input', { id: 'phone', type: 'tel', autocomplete: 'tel', inputmode: 'tel', maxlength: '20', placeholder: '+998 90 123 45 67' });
    var err = el('div', { class: 'error', role: 'alert' });
    app.replaceChildren(el('h1', { text: 'Your details' }), el('p', { class: 'sub', text: dayLabel(pick.date) + ' at ' + pick.time }),
      el('div', { class: 'section' }, [
        el('label', { class: 'field', for: 'name' }, [el('span', { text: 'Name' }), name]),
        el('label', { class: 'field', for: 'phone' }, [el('span', { text: 'Phone' }), phone]),
      ]), err);
    tma.mainButton('Book', function () {
      tma.tg.MainButton.showProgress().disable();
      tma.api('/api/book', { serviceId: pick.serviceId, date: pick.date, time: pick.time, name: name.value, phone: phone.value })
        .then(function (r) { tma.haptic('success'); renderDone(r); })
        .catch(function (e) { err.textContent = e.message; tma.haptic('error'); })
        .finally(function () { tma.tg.MainButton.hideProgress().enable(); });
    });
  }

  function renderDone(r) {
    tma.backButton(null);
    app.replaceChildren(el('div', { class: 'done' }, [
      el('div', { class: 'big', 'aria-hidden': 'true', text: '✓' }),
      el('h2', { text: 'You are booked' }),
      el('p', { text: r.service + ', ' + dayLabel(r.date) + ' at ' + r.time + '. See you then.' }),
    ]));
    tma.mainButton('Done', function () { tma.tg.close(); });
  }

  tma.api('/api/config').then(function (c) { cfg = c; renderServices(); })
    .catch(function (e) { app.replaceChildren(el('p', { class: 'empty', text: 'Could not load: ' + e.message })); });
})();
