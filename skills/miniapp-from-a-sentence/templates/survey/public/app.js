(function () {
  var el = tma.el, app = document.getElementById('app');
  var survey = null, answers = {}, step = -1;

  function renderIntro() {
    step = -1;
    tma.backButton(null);
    app.replaceChildren(el('h1', { text: survey.title }), el('p', { class: 'sub', text: survey.intro }),
      el('div', { class: 'section' }, survey.questions.map(function (q, i) {
        return el('div', { class: 'row' }, [el('span', { class: 'meta', text: String(i + 1) }), el('div', { class: 'grow', text: q.text })]);
      })));
    tma.mainButton('Start', function () { go(0); });
  }

  function go(i) { step = i; tma.haptic(); renderQuestion(); }

  function renderQuestion() {
    var q = survey.questions[step], last = step === survey.questions.length - 1;
    tma.backButton(function () { step === 0 ? renderIntro() : go(step - 1); });
    var err = el('div', { class: 'error', role: 'alert' });
    var body;
    if (q.type === 'choice') {
      body = el('div', { class: 'chips', role: 'group', 'aria-label': q.text }, q.options.map(function (o) {
        return el('button', { class: 'chip', 'aria-pressed': String(answers[q.id] === o), on: { click: function () { answers[q.id] = o; renderQuestion(); } } }, [o]);
      }));
    } else {
      var input = q.type === 'phone'
        ? el('input', { id: 'answer', type: 'tel', inputmode: 'tel', autocomplete: 'tel', placeholder: '+998 90 123 45 67', value: answers[q.id] || '' })
        : el('textarea', { id: 'answer', maxlength: String(q.max || 500), placeholder: q.optional ? 'Optional' : '' });
      if (q.type !== 'phone') input.value = answers[q.id] || '';
      input.addEventListener('input', function () { answers[q.id] = input.value; });
      body = el('label', { class: 'field', for: 'answer' }, [el('span', { text: q.optional ? 'Optional' : 'Required' }), input]);
    }
    app.replaceChildren(el('p', { class: 'sub', text: 'Question ' + (step + 1) + ' of ' + survey.questions.length }),
      el('h1', { text: q.text }), el('div', { class: 'section' }, [body]), err);

    var ok = q.type !== 'choice' || answers[q.id];
    tma.mainButton(ok ? (last ? 'Send' : 'Next') : null, function () {
      if (q.type === 'phone' && !/^\+?\d{7,15}$/.test(String(answers[q.id] || '').replace(/[^\d+]/g, ''))) { err.textContent = 'Enter a valid phone number'; return; }
      if (q.type === 'text' && !q.optional && !String(answers[q.id] || '').trim()) { err.textContent = 'Please answer this question'; return; }
      if (!last) return go(step + 1);
      tma.tg.MainButton.showProgress().disable();
      tma.api('/api/answer', { answers: answers })
        .then(function (r) { tma.haptic('success'); renderDone(r.thanks); })
        .catch(function (e) { err.textContent = e.message; tma.haptic('error'); })
        .finally(function () { tma.tg.MainButton.hideProgress().enable(); });
    });
  }

  function renderDone(text) {
    tma.backButton(null);
    app.replaceChildren(el('div', { class: 'done' }, [el('div', { class: 'big', 'aria-hidden': 'true', text: '✓' }), el('h2', { text: 'Sent' }), el('p', { text: text })]));
    tma.mainButton('Close', function () { tma.tg.close(); });
  }

  tma.api('/api/survey').then(function (s) { survey = s; s.alreadyAnswered ? renderDone(s.thanks) : renderIntro(); })
    .catch(function (e) { app.replaceChildren(el('p', { class: 'empty', text: 'Could not load: ' + e.message })); });
})();
