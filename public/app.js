/* Booking page: date → tickets → details → PayPal → confirmation. No frameworks. */
(function () {
  'use strict';

  var $ = function (s, el) { return (el || document).querySelector(s); };
  var params = new URLSearchParams(location.search);
  var EMBED = params.get('embed') === '1' || window.self !== window.top;
  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var EMAIL_RE = /^[^\s@<>()[\]\\,;:"]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.[A-Za-z]{2,}$/;
  var STAR = 'M50 .5 64.5 15H85v20.5L99.5 50 85 64.5V85H64.5L50 99.5 35.5 85H15V64.5L.5 50 15 35.5V15h20.5z';

  var state = {
    cfg: null,
    month: null,
    days: {},
    loadedAt: {},
    date: null,
    qty: {},
    touched: {},
    current: null,
    ppActions: null,
    lastError: null,
    busy: false,
  };

  if (EMBED) document.documentElement.classList.add('embed');

  // ---------- helpers ----------
  function el(tag, attrs, children) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'text') n.textContent = attrs[k];
      else if (k === 'html') n.innerHTML = attrs[k];
      else if (attrs[k] !== null && attrs[k] !== undefined && attrs[k] !== false) n.setAttribute(k, attrs[k] === true ? '' : attrs[k]);
    });
    (children || []).forEach(function (c) { if (c) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return n;
  }

  function money(v) {
    try {
      return new Intl.NumberFormat('en-GB', { style: 'currency', currency: state.cfg.currency }).format(Number(v));
    } catch (e) {
      return Number(v).toFixed(2) + ' ' + state.cfg.currency;
    }
  }

  function fmt(ymd, opts) {
    var o = { timeZone: 'UTC' };
    Object.keys(opts).forEach(function (k) { o[k] = opts[k]; });
    return new Intl.DateTimeFormat('en-GB', o).format(new Date(ymd + 'T12:00:00Z'));
  }
  function longDate(ymd) { return fmt(ymd, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }); }
  function monthLabel(ym) { return fmt(ym + '-01', { month: 'long', year: 'numeric' }); }
  function addMonths(ym, n) {
    var p = ym.split('-').map(Number);
    return new Date(Date.UTC(p[0], p[1] - 1 + n, 1)).toISOString().slice(0, 7);
  }
  function cents(v) { return Math.round(Number(v) * 100); }
  function totalQty() {
    return Object.keys(state.qty).reduce(function (a, k) { return a + (state.qty[k] || 0); }, 0);
  }
  function totalCents() {
    return state.cfg.ticketTypes.reduce(function (a, t) { return a + cents(t.price) * (state.qty[t.id] || 0); }, 0);
  }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }

  function api(path, body) {
    var opts = body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {};
    return fetch(path, opts).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) {
          var err = new Error(data.error || 'Something went wrong. Please try again.');
          err.status = res.status;
          err.code = data.code;
          throw err;
        }
        return data;
      });
    }, function () {
      throw new Error('No connection. Check your internet connection and try again.');
    });
  }

  function post(msg) {
    if (!EMBED) return;
    msg.source = 'bp-booking';
    try { window.parent.postMessage(msg, '*'); } catch (e) {}
  }

  function scrollToEl(node) {
    if (!node) return;
    if (EMBED) {
      post({ type: 'scroll', top: node.getBoundingClientRect().top + window.pageYOffset });
      return;
    }
    node.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
  }

  function inView(node) {
    var r = node.getBoundingClientRect();
    return r.top >= 0 && r.top < window.innerHeight * 0.6;
  }

  // ---------- calendar ----------
  function loadMonth(ym, force) {
    state.month = ym;
    renderCalendar();
    var fresh = state.loadedAt[ym] && Date.now() - state.loadedAt[ym] < 60000;
    if (fresh && !force) return Promise.resolve();
    $('#cal-error').hidden = true;
    return api('/api/availability?month=' + ym).then(function (r) {
      Object.keys(r.days).forEach(function (d) { state.days[d] = r.days[d]; });
      state.loadedAt[ym] = Date.now();
      if (state.date && state.days[state.date] && state.days[state.date].status !== 'open') {
        state.date = null;
        showPayMsg('The date you picked is no longer available. Please choose another date.');
      }
      clampQuantities();
      if (state.month === ym) renderCalendar();
      refresh();
    }).catch(function (e) {
      $('#cal-error').textContent = 'Availability could not be loaded. ' + e.message;
      $('#cal-error').hidden = false;
    });
  }

  var REASON = {
    past: 'not available',
    beyond: 'not on sale yet',
    closed: 'closed',
    cutoff: 'online sales have closed for today',
    soldout: 'sold out',
    loading: 'loading',
  };

  function renderCalendar() {
    var ym = state.month;
    var cfg = state.cfg;
    $('#cal-month').textContent = monthLabel(ym);
    $('#prev-month').disabled = ym <= cfg.today.slice(0, 7);
    $('#next-month').disabled = ym >= cfg.lastDate.slice(0, 7);
    var grid = $('#cal-grid');
    var focused = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.date : null;
    grid.textContent = '';
    var p = ym.split('-').map(Number);
    var offset = (new Date(Date.UTC(p[0], p[1] - 1, 1)).getUTCDay() + 6) % 7;
    var count = new Date(Date.UTC(p[0], p[1], 0)).getUTCDate();
    for (var i = 0; i < offset; i++) grid.appendChild(el('span', { 'aria-hidden': 'true' }));
    for (var d = 1; d <= count; d++) {
      var ymd = ym + '-' + (d < 10 ? '0' : '') + d;
      var info = state.days[ymd] || { status: 'loading' };
      var open = info.status === 'open';
      var cls = 'day is-' + info.status + (info.few ? ' is-few' : '') + (ymd === cfg.today ? ' is-today' : '');
      var label = longDate(ymd) + ', ' + (open ? (info.few ? 'few tickets left' : 'available') : REASON[info.status] || 'not available');
      var b = el('button', { type: 'button', class: cls, 'data-date': ymd, 'aria-pressed': ymd === state.date ? 'true' : 'false', 'aria-label': label, disabled: !open, text: String(d) });
      grid.appendChild(b);
    }
    if (focused) {
      var again = grid.querySelector('[data-date="' + focused + '"]');
      if (again && !again.disabled) again.focus();
    }
  }

  function selectDate(ymd) {
    state.date = ymd;
    hidePayMsg();
    clampQuantities();
    renderCalendar();
    refresh();
    if (window.innerWidth < 900 && !inView($('#step-tickets'))) {
      setTimeout(function () { scrollToEl($('#step-tickets')); }, 80);
    }
  }

  // keyboard: arrow keys move between enabled days
  function onGridKey(e) {
    var keys = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    if (!(e.key in keys) || !e.target.dataset.date) return;
    e.preventDefault();
    var buttons = Array.prototype.slice.call($('#cal-grid').querySelectorAll('button.day'));
    var idx = buttons.indexOf(e.target);
    for (var j = idx + keys[e.key]; j >= 0 && j < buttons.length; j += keys[e.key]) {
      if (!buttons[j].disabled) { buttons[j].focus(); return; }
    }
  }

  // ---------- tickets ----------
  var MINUS = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14"/></svg>';
  var PLUS = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';

  function buildTickets() {
    var list = $('#ticket-list');
    list.textContent = '';
    state.cfg.ticketTypes.forEach(function (t) {
      state.qty[t.id] = 0;
      var minus = el('button', { type: 'button', 'data-act': 'minus', 'data-type': t.id, 'aria-label': 'Remove one ' + t.name + ' ticket', html: MINUS });
      var plus = el('button', { type: 'button', 'data-act': 'plus', 'data-type': t.id, 'aria-label': 'Add one ' + t.name + ' ticket', html: PLUS });
      var out = el('output', { id: 'q-' + t.id, 'aria-live': 'polite', 'aria-label': t.name + ' tickets', text: '0' });
      var li = el('li', { class: 'ticket', 'data-type': t.id }, [
        el('div', null, [el('p', { class: 'ticket-name', text: t.name }), t.description ? el('p', { class: 'ticket-desc', text: t.description }) : null]),
        el('p', { class: 'ticket-price', text: money(t.price) }),
        el('div', { class: 'stepper' }, [minus, out, plus]),
        el('p', { class: 'ticket-out', id: 'out-' + t.id, hidden: true }),
      ]);
      list.appendChild(li);
    });
  }

  function remainingFor(typeId) {
    var day = state.date && state.days[state.date];
    if (!day || day.status !== 'open' || !day.remaining) return 0;
    return day.remaining[typeId] || 0;
  }

  function clampQuantities() {
    if (!state.cfg) return;
    var changed = false;
    state.cfg.ticketTypes.forEach(function (t) {
      var max = state.date ? remainingFor(t.id) : 0;
      if (state.date && (state.qty[t.id] || 0) > max) {
        state.qty[t.id] = max;
        changed = true;
      }
    });
    if (changed) showPayMsg('Fewer tickets are left for this date, so your selection was adjusted.', true);
  }

  function updateTickets() {
    var maxOrder = state.cfg.maxTicketsPerOrder;
    var total = totalQty();
    $('#tickets-hint').hidden = !!state.date;
    state.cfg.ticketTypes.forEach(function (t) {
      var q = state.qty[t.id] || 0;
      var rem = remainingFor(t.id);
      var cap = Math.min(rem, maxOrder - (total - q));
      $('#q-' + t.id).textContent = String(q);
      $('[data-act="minus"][data-type="' + t.id + '"]').disabled = !state.date || q <= 0;
      $('[data-act="plus"][data-type="' + t.id + '"]').disabled = !state.date || q >= cap;
      var out = $('#out-' + t.id);
      if (state.date && rem === 0) {
        out.textContent = 'Sold out for this date';
        out.hidden = false;
      } else if (state.date && q > 0 && q >= rem && rem < maxOrder) {
        out.textContent = 'Only ' + rem + ' left for this date';
        out.hidden = false;
      } else out.hidden = true;
    });
    var maxHint = $('#max-hint');
    maxHint.hidden = total < maxOrder;
    maxHint.textContent = 'You can book up to ' + maxOrder + ' tickets per order.';
  }

  function onTicketClick(e) {
    var b = e.target.closest('button[data-act]');
    if (!b || b.disabled) return;
    var id = b.getAttribute('data-type');
    state.qty[id] = Math.max(0, (state.qty[id] || 0) + (b.getAttribute('data-act') === 'plus' ? 1 : -1));
    hidePayMsg();
    refresh();
  }

  // ---------- details / validation ----------
  function fieldErrors() {
    var errs = {};
    var name = $('#f-name').value.trim();
    var email = $('#f-email').value.trim();
    if (name.length < 2) errs.name = 'Enter your full name.';
    if (!EMAIL_RE.test(email)) errs.email = email ? 'Check your email address — it looks incomplete.' : 'Enter your email address.';
    if (state.cfg.termsUrl && !$('#f-terms').checked) errs.terms = 'Accept the terms and conditions to continue.';
    return errs;
  }

  function showFieldErrors(all) {
    var errs = fieldErrors();
    [['name', '#f-name', '#e-name'], ['email', '#f-email', '#e-email'], ['terms', '#f-terms', '#e-terms']].forEach(function (f) {
      var show = all || state.touched[f[0]];
      var msg = show ? errs[f[0]] || '' : '';
      $(f[2]).textContent = msg;
      $(f[1]).setAttribute('aria-invalid', msg ? 'true' : 'false');
      if (msg) $(f[1]).setAttribute('aria-errormessage', f[2].slice(1));
    });
    return errs;
  }

  function readiness() {
    if (state.unconfirmed) return { ok: false, step: '#step-pay', msg: 'We are still confirming your last payment. Please don\u2019t pay again.', unconfirmed: true };
    if (!state.date) return { ok: false, step: '#step-date', msg: 'Choose your visit date to continue.' };
    if (totalQty() < 1) return { ok: false, step: '#step-tickets', msg: 'Choose at least one ticket to continue.' };
    var errs = fieldErrors();
    if (Object.keys(errs).length) return { ok: false, step: '#step-details', msg: 'Fill in your details to pay.', errs: errs };
    return { ok: true };
  }

  function showMissing(r) {
    if (r.unconfirmed) {
      scrollToEl($('#step-pay'));
      return;
    }
    var hint = $('#pay-hint');
    hint.textContent = r.msg;
    hint.classList.add('is-error');
    if (r.step === '#step-details') {
      showFieldErrors(true);
      var order = [['name', '#f-name'], ['email', '#f-email'], ['terms', '#f-terms']];
      for (var i = 0; i < order.length; i++) {
        if (r.errs[order[i][0]]) { scrollToEl($('#step-details')); setTimeout(function (sel) { $(sel).focus({ preventScroll: true }); }.bind(null, order[i][1]), 350); break; }
      }
    } else scrollToEl($(r.step));
  }

  // ---------- summary / progress ----------
  function summaryLines() {
    return state.cfg.ticketTypes.filter(function (t) { return state.qty[t.id] > 0; }).map(function (t) {
      return { label: state.qty[t.id] + ' × ' + t.name, amount: money((cents(t.price) * state.qty[t.id]) / 100) };
    });
  }

  function renderSummary() {
    var lines = summaryLines();
    var dateEl = $('#sum-date');
    dateEl.textContent = state.date ? longDate(state.date) : 'Pick a date to begin.';
    dateEl.classList.toggle('is-empty', !state.date);
    var ul = $('#sum-lines');
    ul.textContent = '';
    lines.forEach(function (l) { ul.appendChild(el('li', null, [el('span', { text: l.label }), el('span', { text: l.amount })])); });
    $('#sum-total').textContent = money(totalCents() / 100);
    var sumEmail = $('#sum-email');
    var to = $('#f-email').value.trim();
    sumEmail.textContent = '';
    sumEmail.hidden = !EMAIL_RE.test(to);
    if (!sumEmail.hidden) {
      sumEmail.appendChild(el('span', { text: 'Tickets go to ' }));
      sumEmail.appendChild(el('strong', { text: to }));
    }

    var inline = $('#inline-summary');
    inline.textContent = '';
    if (state.date && lines.length) {
      inline.appendChild(el('p', { class: 'summary-date', text: longDate(state.date) }));
      var ul2 = el('ul', { class: 'summary-lines' });
      lines.forEach(function (l) { ul2.appendChild(el('li', null, [el('span', { text: l.label }), el('span', { text: l.amount })])); });
      inline.appendChild(ul2);
      inline.appendChild(el('div', { class: 'summary-total' }, [el('span', { text: 'Total' }), el('strong', { text: money(totalCents() / 100) })]));
      // With one email field, show the address once more right before paying.
      if (EMAIL_RE.test(to)) inline.appendChild(el('p', { class: 'summary-email' }, [el('span', { text: 'Tickets go to ' }), el('strong', { text: to })]));
    }

    var n = totalQty();
    $('#mb-total').textContent = money(totalCents() / 100);
    $('#mb-count').textContent = n ? plural(n, 'ticket', 'tickets') + (state.date ? ', ' + fmt(state.date, { day: 'numeric', month: 'short' }) : '') : 'No tickets selected';
  }

  function refresh() {
    updateTickets();
    renderSummary();
    var r = readiness();
    $('#step-date').classList.toggle('is-complete', !!state.date);
    $('#step-tickets').classList.toggle('is-complete', !!state.date && totalQty() > 0);
    $('#step-details').classList.toggle('is-complete', !Object.keys(fieldErrors()).length);
    var hint = $('#pay-hint');
    hint.classList.remove('is-error');
    hint.textContent = r.ok ? '' : r.msg;
    hint.hidden = r.ok || !!r.unconfirmed;
    if (state.ppActions) {
      if (r.ok) state.ppActions.enable();
      else state.ppActions.disable();
    }
    var mb = $('#mb-next');
    mb.textContent = !state.date ? 'Choose a date' : totalQty() < 1 ? 'Choose tickets' : !r.ok ? 'Your details' : 'Go to payment';
    mb.setAttribute('data-target', r.ok ? '#step-pay' : r.step);
  }

  // ---------- payment ----------
  function showPayMsg(text, info) {
    var m = $('#pay-msg');
    m.textContent = text;
    m.classList.toggle('is-info', !!info);
    m.hidden = false;
  }
  function hidePayMsg() { $('#pay-msg').hidden = true; }

  function showProcessing(on) { $('#processing').hidden = !on; }

  function orderBody() {
    return {
      date: state.date,
      items: state.cfg.ticketTypes.filter(function (t) { return state.qty[t.id] > 0; }).map(function (t) { return { typeId: t.id, qty: state.qty[t.id] }; }),
      customer: { name: $('#f-name').value.trim(), email: $('#f-email').value.trim(), phone: $('#f-phone').value.trim() },
      acceptTerms: state.cfg.termsUrl ? $('#f-terms').checked : undefined,
      // The payment mode this page loaded PayPal for; the server asks for a reload if it changed.
      mode: state.cfg.payments.mode,
    };
  }

  function cancelCurrent() {
    var c = state.current;
    state.current = null;
    if (c) api('/api/orders/' + c.orderId + '/cancel', { paypalOrderId: c.paypalOrderId }).catch(function () {});
  }

  function startCheckout() {
    if (state.unconfirmed) return Promise.reject(new Error('We are still confirming your last payment. Please don\u2019t pay again.'));
    hidePayMsg();
    if (state.current) cancelCurrent();
    return api('/api/orders', orderBody()).then(function (r) {
      state.current = r;
      return r;
    }, function (e) {
      state.lastError = e.message;
      if (e.code === 'SOLD_OUT' || e.code === 'DATE_UNAVAILABLE') loadMonth(state.month, true);
      throw e;
    });
  }

  // After the buyer approves in PayPal, confirm the payment on our server. If that request
  // fails (bad signal, server busy), retry the SAME order — never start a new one, which
  // could charge the buyer twice.
  function finishCheckout(paypalOrderId, actions) {
    showProcessing(true);
    var current = state.current;
    var pending = { orderId: current.orderId, paypalOrderId: paypalOrderId, at: Date.now() };
    var attempt = 0;
    function attemptCapture() {
      attempt++;
      return api('/api/orders/' + current.orderId + '/capture', { paypalOrderId: paypalOrderId }).then(function (r) {
        if (r.status === 'restart' && actions) {
          showProcessing(false);
          showPayMsg(r.message);
          return actions.restart();
        }
        if (r.status === 'unconfirmed') {
          showProcessing(false);
          state.current = null;
          setUnconfirmed(pending, r.message);
          return;
        }
        handleResult(r);
      }, function (e) {
        var transient = !e.status || e.status >= 500 || e.status === 429;
        if (transient && attempt < 4) {
          return new Promise(function (res) { setTimeout(res, attempt * 2000); }).then(attemptCapture);
        }
        showProcessing(false);
        if (transient) {
          state.current = null;
          setUnconfirmed(pending);
          return;
        }
        showPayMsg(e.message);
      });
    }
    return attemptCapture();
  }

  var UNCONF_KEY = 'bp-unconfirmed-payment';
  function saveUnconfirmed(u) {
    try {
      if (u) localStorage.setItem(UNCONF_KEY, JSON.stringify(u));
      else localStorage.removeItem(UNCONF_KEY);
    } catch (e) {}
  }
  function loadUnconfirmed() {
    try {
      var u = JSON.parse(localStorage.getItem(UNCONF_KEY) || 'null');
      if (u && u.orderId && u.paypalOrderId && Date.now() - u.at < 86400000) return u;
    } catch (e) {}
    return null;
  }
  function setUnconfirmed(u, message) {
    state.unconfirmed = u;
    saveUnconfirmed(u);
    $('#pay-unconfirmed-text').textContent = message || 'We couldn\u2019t confirm your payment yet. Please don\u2019t pay again: if the payment went through, your tickets will be emailed to you within a few minutes.';
    $('#pay-unconfirmed').hidden = false;
    hidePayMsg();
    refresh();
    scrollToEl($('#step-pay'));
  }
  function clearUnconfirmed() {
    state.unconfirmed = null;
    saveUnconfirmed(null);
    $('#pay-unconfirmed').hidden = true;
    refresh();
  }
  function checkUnconfirmed() {
    var u = state.unconfirmed;
    if (!u) return;
    var btn = $('#pay-check');
    btn.disabled = true;
    btn.textContent = 'Checking\u2026';
    api('/api/orders/' + u.orderId + '/capture', { paypalOrderId: u.paypalOrderId }).then(function (r) {
      if (r.status === 'unconfirmed') {
        $('#pay-unconfirmed-text').textContent = r.message;
        return;
      }
      clearUnconfirmed();
      handleResult(r);
    }, function (e) {
      if (e.status === 400 || e.status === 404) {
        clearUnconfirmed();
        return;
      }
      $('#pay-unconfirmed-text').textContent = 'We still can\u2019t reach the booking system (' + e.message + '). Please don\u2019t pay again; try this button again in a minute.';
    }).then(function () {
      btn.disabled = false;
      btn.textContent = 'Check payment status';
    });
  }

  function handleResult(r) {
    showProcessing(false);
    if (r.status === 'completed' || r.status === 'pending' || r.status === 'attention') {
      state.current = null;
      showDone(r);
      return;
    }
    state.current = null;
    showPayMsg(r.message || 'The payment could not be completed. You have not been charged.');
    loadMonth(state.month, true);
  }

  function loadPayPal() {
    var p = state.cfg.payments;
    if (!p.enabled) {
      showPayMsg(p.message || 'Online payment is temporarily unavailable.');
      return;
    }
    if (p.mode === 'mock') {
      var tb = $('#testmode');
      tb.textContent = 'Test mode: payments are simulated and nothing is charged. The tickets you receive are samples.';
      tb.hidden = false;
      $('#mock-pay').hidden = false;
      return;
    }
    if (p.mode === 'sandbox') {
      var sb = $('#testmode');
      sb.textContent = 'PayPal sandbox: pay with a PayPal sandbox test account. No real money is taken.';
      sb.hidden = false;
    }
    var s = document.createElement('script');
    s.src = 'https://www.paypal.com/sdk/js?client-id=' + encodeURIComponent(p.clientId) + '&currency=' + encodeURIComponent(state.cfg.currency) + '&intent=capture&components=buttons&commit=true';
    s.async = true;
    s.onload = renderPayPalButtons;
    s.onerror = function () {
      showPayMsg('PayPal could not be loaded. Check your internet connection, allow paypal.com in any content blocker, then reload this page.');
    };
    document.head.appendChild(s);
  }

  function renderPayPalButtons() {
    if (!window.paypal || !window.paypal.Buttons) {
      showPayMsg('PayPal could not be loaded. Please reload this page.');
      return;
    }
    window.paypal.Buttons({
      style: { layout: 'vertical', shape: 'pill', color: 'gold', label: 'pay', height: 48, tagline: false },
      onInit: function (data, actions) {
        state.ppActions = actions;
        refresh();
      },
      onClick: function (data, actions) {
        var r = readiness();
        if (!r.ok) {
          showMissing(r);
          return actions.reject();
        }
        hidePayMsg();
        return actions.resolve();
      },
      createOrder: function () {
        return startCheckout().then(function (r) { return r.paypalOrderId; });
      },
      onApprove: function (data, actions) {
        return finishCheckout(data.orderID, actions);
      },
      onCancel: function () {
        cancelCurrent();
        showPayMsg('Payment cancelled. You have not been charged — you can try again whenever you are ready.', true);
      },
      onError: function (err) {
        if (window.console) console.error(err);
        showProcessing(false);
        showPayMsg(state.lastError || 'PayPal could not complete the payment. You have not been charged. Please try again.');
        state.lastError = null;
      },
    }).render('#paypal-buttons').catch(function (err) {
      if (window.console) console.error(err);
      showPayMsg('PayPal could not be loaded. Please reload this page.');
    });
  }

  function onMockPay() {
    var r = readiness();
    if (!r.ok) return showMissing(r);
    if (state.busy) return;
    state.busy = true;
    var btn = $('#mock-pay');
    btn.disabled = true;
    startCheckout()
      .then(function (o) { return finishCheckout(o.paypalOrderId, null); })
      .catch(function (e) { showPayMsg(e.message); })
      .then(function () {
        state.busy = false;
        btn.disabled = false;
      });
  }

  // ---------- confirmation ----------
  function showDone(r) {
    var done = $('#done');
    var waiting = r.status !== 'completed';
    var star = '<svg class="done-star' + (waiting ? ' is-waiting' : '') + '" viewBox="-4 -4 108 108" aria-hidden="true"><path class="s" d="' + STAR + '"/>' +
      (waiting ? '' : '<path class="tick" d="M31 51l13 13 26-28"/>') + '</svg>';
    var title, lead;
    if (r.status === 'completed') {
      title = 'Your tickets are on their way';
      lead = ['We’ve emailed ' + plural(r.tickets, 'ticket', 'tickets') + ' to ', '. Show them at the entrance on your phone or printed.'];
    } else if (r.status === 'pending') {
      title = 'PayPal is confirming your payment';
      lead = [r.message + ' We’ll send them to ', '.'];
    } else {
      title = 'Payment received';
      lead = [r.message + ' We’ll write to ', '.'];
    }
    var facts = [['Order number', r.orderId]];
    if (r.visitDate) facts.unshift(['Visit date', longDate(r.visitDate)], ['Tickets', r.items.map(function (i) { return i.qty + ' ' + i.name; }).join(', ')], ['Total paid', money(r.total)]);

    done.innerHTML = '<div class="done-card">' + star + '<h2></h2><p class="done-lead"></p><dl class="done-facts"></dl><div class="done-actions"></div><p class="fineprint"></p></div>';
    $('h2', done).textContent = title;
    var leadEl = $('.done-lead', done);
    leadEl.appendChild(document.createTextNode(lead[0]));
    leadEl.appendChild(el('strong', { text: r.email }));
    leadEl.appendChild(document.createTextNode(lead[1]));
    var dl = $('.done-facts', done);
    facts.forEach(function (f) { dl.appendChild(el('div', null, [el('dt', { text: f[0] }), el('dd', { text: f[1] })])); });
    var actions = $('.done-actions', done);
    if (r.downloadUrl) actions.appendChild(el('a', { class: 'btn btn-primary', href: r.downloadUrl, target: '_blank', rel: 'noopener', text: 'Download tickets' }));
    var again = el('button', { type: 'button', class: 'btn btn-secondary', text: 'Book another visit' });
    again.addEventListener('click', function () { location.reload(); });
    actions.appendChild(again);
    $('.fineprint', done).textContent = r.status === 'completed'
      ? 'No email after a few minutes? Check your spam folder, or use Download tickets.'
      : state.cfg.supportEmail ? 'Questions? Write to ' + state.cfg.supportEmail + ' and quote your order number.' : 'Keep your order number for reference.';

    $('#booking').hidden = true;
    $('#mobilebar').hidden = true;
    $('#testmode').hidden = true;
    done.hidden = false;
    window.scrollTo(0, 0);
    post({ type: 'scroll', top: 0 });
    done.focus({ preventScroll: true });
  }

  // ---------- page chrome ----------
  function renderChrome() {
    var c = state.cfg;
    document.title = 'Book tickets – ' + c.siteName;
    $('#site-name').textContent = c.siteName;
    $('#tagline').textContent = c.tagline || '';
    $('#tagline').hidden = !c.tagline;
    $('#hours').textContent = c.openingHours || '';
    if (c.notice) {
      $('#notice').textContent = c.notice;
      $('#notice').hidden = false;
    }
    if (c.termsUrl) {
      $('#terms-row').hidden = false;
      $('#terms-link').href = c.termsUrl;
    }
    var foot = $('#foot');
    foot.textContent = '';
    if (c.address) foot.appendChild(el('p', { text: c.address }));
    if (c.supportEmail) foot.appendChild(el('p', null, ['Help with your booking: ', el('a', { href: 'mailto:' + c.supportEmail, text: c.supportEmail })]));
    if (c.termsUrl) foot.appendChild(el('p', null, [el('a', { href: c.termsUrl, target: '_blank', rel: 'noopener', text: 'Terms and conditions' })]));
  }

  function bind() {
    $('#prev-month').addEventListener('click', function () { loadMonth(addMonths(state.month, -1)); });
    $('#next-month').addEventListener('click', function () { loadMonth(addMonths(state.month, 1)); });
    $('#cal-grid').addEventListener('click', function (e) {
      var b = e.target.closest('button.day');
      if (b && !b.disabled) selectDate(b.dataset.date);
    });
    $('#cal-grid').addEventListener('keydown', onGridKey);
    $('#ticket-list').addEventListener('click', onTicketClick);
    [['#f-name', 'name'], ['#f-email', 'email'], ['#f-terms', 'terms']].forEach(function (f) {
      var input = $(f[0]);
      input.addEventListener('blur', function () {
        if (input.value || f[0] === '#f-terms') state.touched[f[1]] = true;
        showFieldErrors(false);
      });
      input.addEventListener('input', function () {
        if (state.touched[f[1]]) showFieldErrors(false);
        refresh();
      });
      input.addEventListener('change', function () { state.touched[f[1]] = true; showFieldErrors(false); refresh(); });
    });
    $('#details').addEventListener('submit', function (e) { e.preventDefault(); });
    $('#mock-pay').addEventListener('click', onMockPay);
    $('#pay-check').addEventListener('click', checkUnconfirmed);
    $('#mb-next').addEventListener('click', function () {
      var target = this.getAttribute('data-target') || '#step-date';
      if (target === '#step-details') {
        var r = readiness();
        if (r.errs) return showMissing(r);
      }
      scrollToEl($(target));
    });
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && state.month && state.loadedAt[state.month] && Date.now() - state.loadedAt[state.month] > 5 * 60000) loadMonth(state.month, true);
    });
    if (EMBED && window.ResizeObserver) {
      var last = 0;
      new ResizeObserver(function () {
        var h = Math.ceil(document.documentElement.scrollHeight);
        if (h !== last) { last = h; post({ type: 'height', height: h }); }
      }).observe(document.body);
    }
  }

  function init() {
    bind();
    api('/api/config').then(function (cfg) {
      state.cfg = cfg;
      renderChrome();
      buildTickets();
      var start = params.get('date');
      loadMonth((start && /^\d{4}-\d{2}-\d{2}$/.test(start) ? start : cfg.today).slice(0, 7)).then(function () {
        if (start && state.days[start] && state.days[start].status === 'open') selectDate(start);
      });
      refresh();
      loadPayPal();
      var unconfirmed = loadUnconfirmed();
      if (unconfirmed) {
        setUnconfirmed(unconfirmed, 'Checking your last payment\u2026');
        checkUnconfirmed();
      }
    }).catch(function (e) {
      $('#booking').innerHTML = '';
      $('#booking').appendChild(el('p', { class: 'pay-msg', text: 'The booking page could not load. ' + e.message + ' Please reload the page.' }));
    });
  }

  init();
})();
