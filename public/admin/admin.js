/* Admin dashboard. Plain JS; every value from the server is escaped before it reaches the DOM. */
(function () {
  'use strict';

  var $ = function (s, el) { return (el || document).querySelector(s); };
  var $$ = function (s, el) { return Array.prototype.slice.call((el || document).querySelectorAll(s)); };
  var main = $('#main');

  // ---------- safe HTML templating ----------
  var ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return ESC[c]; }); }
  function Safe(s) { this.s = s; }
  Safe.prototype.toString = function () { return this.s; };
  function raw(s) { return new Safe(String(s)); }
  function out(v) {
    if (v instanceof Safe) return v.s;
    if (Array.isArray(v)) return v.map(out).join('');
    if (v === false || v === null || v === undefined) return '';
    return esc(v);
  }
  function h(strings) {
    var res = strings[0];
    for (var i = 1; i < arguments.length; i++) res += out(arguments[i]) + strings[i];
    return new Safe(res);
  }
  function setHtml(node, safe) { node.innerHTML = safe.s; }

  // ---------- formatting ----------
  var currency = 'EUR';
  var tz = 'Africa/Casablanca';
  function money(v, cur) {
    try {
      return new Intl.NumberFormat('en-GB', { style: 'currency', currency: cur || currency }).format(Number(v));
    } catch (e) {
      return Number(v).toFixed(2) + ' ' + (cur || currency);
    }
  }
  function moneyTick(v, step) {
    try {
      return new Intl.NumberFormat('en-GB', {
        style: 'currency',
        currency: currency,
        notation: v >= 10000 ? 'compact' : 'standard',
        maximumFractionDigits: step < 1 ? 2 : 0,
      }).format(v);
    } catch (e) {
      return String(v);
    }
  }
  function fmtDate(ymd, opts) {
    var o = opts || { day: 'numeric', month: 'short', year: 'numeric' };
    var f = { timeZone: 'UTC' };
    Object.keys(o).forEach(function (k) { f[k] = o[k]; });
    return new Intl.DateTimeFormat('en-GB', f).format(new Date(ymd + 'T12:00:00Z'));
  }
  function fmtDateTime(iso) {
    if (!iso) return '';
    try {
      return new Intl.DateTimeFormat('en-GB', { timeZone: tz, day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
    } catch (e) {
      return new Date(iso).toLocaleString();
    }
  }
  function plural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }
  function todayYmd() {
    try {
      var p = {};
      new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date()).forEach(function (x) { p[x.type] = x.value; });
      return p.year + '-' + p.month + '-' + p.day;
    } catch (e) {
      return new Date().toISOString().slice(0, 10);
    }
  }
  function addMonths(ym, n) {
    var p = ym.split('-').map(Number);
    return new Date(Date.UTC(p[0], p[1] - 1 + n, 1)).toISOString().slice(0, 7);
  }

  var STATUS = {
    pending: ['Awaiting payment', 'blue'],
    payment_pending: ['Payment pending', 'wait'],
    paid: ['Paid', 'ok'],
    fulfilled: ['Completed', 'ok'],
    needs_attention: ['Needs attention', 'bad'],
    expired: ['Expired', ''],
    cancelled: ['Cancelled', ''],
    failed: ['Declined', 'bad'],
    refunded: ['Refunded', 'blue'],
    reversed: ['Reversed', 'bad'],
  };
  function badge(s) {
    var st = STATUS[s] || [s, ''];
    return h`<span class="badge ${st[1]}">${st[0]}</span>`;
  }
  function modeBadge(mode) {
    if (!mode || mode === 'live') return '';
    return h` <span class="badge" title="Not a real sale">${mode === 'mock' ? 'Demo' : 'Test'}</span>`;
  }
  function emailBadge(s) {
    if (s === 'sent') return h`<span class="badge ok">Sent</span>`;
    if (s === 'failed') return h`<span class="badge bad">Failed</span>`;
    if (s === 'queued') return h`<span class="badge wait">Sending</span>`;
    return h`<span class="muted">–</span>`;
  }

  // ---------- api ----------
  function api(path, opts) {
    opts = opts || {};
    var init = { method: opts.method || (opts.body !== undefined ? 'POST' : 'GET'), headers: {}, credentials: 'same-origin' };
    if (opts.body !== undefined) {
      if (opts.rawBody) {
        init.body = opts.body;
        Object.keys(opts.headers || {}).forEach(function (k) { init.headers[k] = opts.headers[k]; });
      } else {
        init.headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(opts.body);
      }
    }
    return fetch(path, init).then(function (res) {
      if (res.status === 401 && !opts.noAuthRedirect) {
        showLogin();
        var e401 = new Error('Please log in again.');
        e401.status = 401;
        throw e401;
      }
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) {
          var err = new Error(data.error || 'Request failed (' + res.status + ')');
          err.status = res.status;
          err.data = data;
          throw err;
        }
        return data;
      });
    });
  }

  var toastTimer;
  function toast(msg, isError) {
    var t = $('#toast');
    t.textContent = msg;
    t.classList.toggle('is-error', !!isError);
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, isError ? 7000 : 4000);
  }

  function busy(btn, on, label) {
    if (!btn) return;
    if (on) {
      btn.dataset.label = btn.textContent;
      btn.textContent = label || 'Working…';
      btn.disabled = true;
    } else {
      btn.textContent = btn.dataset.label || btn.textContent;
      btn.disabled = false;
    }
  }

  // ---------- auth ----------
  function showLogin(message) {
    $('#app').hidden = true;
    $('#login').hidden = false;
    if (message) $('#login-err').textContent = message;
    setTimeout(function () { $('#login-pw').focus(); }, 30);
  }

  function startApp() {
    $('#login').hidden = true;
    $('#app').hidden = false;
    api('/api/admin/system').then(function (s) {
      tz = s.timezone || tz;
      $('#brand').textContent = 'Bookings';
    }).catch(function () {});
    api('/api/admin/settings').then(function (s) {
      currency = s.settings.currency;
      $('#brand').textContent = s.settings.siteName;
      document.title = 'Dashboard – ' + s.settings.siteName;
    }).catch(function () {});
    route();
  }

  $('#login-form').addEventListener('submit', function (e) {
    e.preventDefault();
    $('#login-err').textContent = '';
    var btn = $('#login-form button');
    busy(btn, true, 'Logging in…');
    api('/api/admin/login', { body: { password: $('#login-pw').value }, noAuthRedirect: true })
      .then(function () {
        $('#login-pw').value = '';
        startApp();
      })
      .catch(function (err) { $('#login-err').textContent = err.message; })
      .then(function () { busy(btn, false); });
  });

  $('#logout').addEventListener('click', function () {
    api('/api/admin/logout', { body: {} }).catch(function () {}).then(function () { showLogin(); });
  });

  // ---------- router ----------
  function parseHash() {
    var hsh = location.hash.replace(/^#/, '') || 'overview';
    var qi = hsh.indexOf('?');
    var pathPart = qi >= 0 ? hsh.slice(0, qi) : hsh;
    var query = {};
    new URLSearchParams(qi >= 0 ? hsh.slice(qi + 1) : '').forEach(function (v, k) { query[k] = v; });
    var parts = pathPart.split('/');
    return { name: parts[0], arg: parts[1] ? decodeURIComponent(parts[1]) : null, query: query };
  }

  var VIEWS = {
    overview: viewOverview,
    orders: viewOrders,
    stock: viewStock,
    calendar: viewCalendar,
    paypal: viewPayPal,
    email: viewEmail,
    templates: viewTemplates,
    activity: viewActivity,
    settings: viewSettings,
  };

  function route() {
    var r = parseHash();
    $$('.side a[data-nav]').forEach(function (a) {
      if (a.getAttribute('data-nav') === r.name) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
    var view = r.name === 'orders' && r.arg ? viewOrder : VIEWS[r.name] || viewOverview;
    main.innerHTML = '<p class="muted">Loading…</p>';
    Promise.resolve()
      .then(function () { return view(r); })
      .catch(function (e) {
        if (e.status === 401) return;
        setHtml(main, h`<div class="panel"><h2>Something went wrong</h2><p>${e.message}</p></div>`);
      });
  }

  window.addEventListener('hashchange', route);

  main.addEventListener('click', function (e) {
    var tr = e.target.closest('tr.clickable');
    if (tr && !e.target.closest('a, button')) location.hash = tr.getAttribute('data-href');
  });

  // ---------- shared pieces ----------
  function ordersTable(orders) {
    if (!orders.length) return h`<p class="empty">No orders to show.</p>`;
    return h`<div class="table-wrap"><table class="orders-table">
<thead><tr><th>Order</th><th class="hide-sm">Created</th><th>Visit</th><th>Customer</th><th class="num">Tickets</th><th class="num">Total</th><th>Status</th><th class="hide-sm">Email</th></tr></thead>
<tbody>${orders.map(function (o) {
      return h`<tr class="clickable" data-href="#orders/${o.id}">
<td><a class="mono-id" href="#orders/${o.id}">${o.id}</a></td>
<td class="hide-sm nowrap">${fmtDateTime(o.createdAt)}</td>
<td class="nowrap">${fmtDate(o.visitDate)}</td>
<td><div class="cust">${o.name}<span>${o.email}</span></div></td>
<td class="num">${o.totalQty}</td>
<td class="num">${money(o.total, o.currency)}${o.refundedTotal ? h`<br><span class="muted">refunded ${money(o.refundedTotal, o.currency)}</span>` : ''}</td>
<td>${badge(o.status)}${modeBadge(o.mode)}</td>
<td class="hide-sm">${emailBadge(o.emailStatus)}</td></tr>`;
    })}</tbody></table></div>`;
  }

  function tile(label, value, sub) {
    return h`<div class="tile"><p class="tile-label">${label}</p><p class="tile-value">${value}</p>${sub ? h`<p class="tile-sub">${sub}</p>` : ''}</div>`;
  }

  // ---------- overview ----------
  function viewOverview() {
    return api('/api/admin/overview').then(function (d) {
      currency = d.currency;
      var k = d.kpis;
      setHtml(main, h`
<div class="page-head"><div><h1>Overview</h1><p class="sub">${fmtDate(d.today, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</p></div></div>
${d.alerts.length ? h`<div class="alerts">${d.alerts.map(function (a) {
        return h`<div class="alert ${a.level}"><span>${a.text}</span>${a.link ? h`<a href="#${a.link}">View</a>` : ''}</div>`;
      })}</div>` : ''}
<div class="tiles">
${tile('Sales today', money(k.revenueToday), plural(k.ticketsToday, 'ticket') + ' in ' + plural(k.ordersToday, 'order'))}
${tile('Sales this month', money(k.revenueMonth), plural(k.ordersMonth, 'order') + ', average ' + money(k.avgOrder))}
${tile('Tickets sold this month', String(k.ticketsMonth), '')}
${tile('All-time sales', money(k.revenueAll), plural(k.ticketsAll, 'ticket'))}
</div>
<section class="panel">
  <div class="panel-head"><h2>Daily sales, last 30 days</h2><p class="panel-note">After refunds, by payment date</p></div>
  <div class="chart" id="chart"></div>
  <button type="button" class="btn btn-secondary btn-sm table-toggle" id="tbl-toggle" aria-expanded="false" aria-controls="chart-table">Show as table</button>
  <div id="chart-table" hidden></div>
</section>
<div class="grid-2">
  <section class="panel"><h2>Visits in the next 7 days</h2>
    <table><tbody>${d.upcoming.map(function (u) {
        return h`<tr><td>${fmtDate(u.date, { weekday: 'short', day: 'numeric', month: 'short' })}</td><td class="num">${plural(u.tickets, 'ticket')}</td></tr>`;
      })}</tbody></table>
  </section>
  <section class="panel"><div class="panel-head"><h2>Ticket stock</h2><a href="#stock">Manage stock</a></div>
    <table><tbody>${d.stock.map(function (t) {
        var low = t.availableNow === 0 ? 'bad' : t.availableNow <= 20 ? 'wait' : 'ok';
        return h`<tr><td>${t.name}</td><td class="num"><span class="badge ${low}">${t.availableNow} left</span></td></tr>`;
      })}</tbody></table>
  </section>
</div>
<section class="panel" style="margin-top:18px"><div class="panel-head"><h2>Latest orders</h2><a href="#orders">All orders</a></div>${ordersTable(d.recent)}</section>`);
      drawChart($('#chart'), d.daily);
      var lastW = $('#chart').clientWidth;
      window.onresize = function () {
        var c = $('#chart');
        if (c && Math.abs(c.clientWidth - lastW) > 40) { lastW = c.clientWidth; drawChart(c, d.daily); }
      };
      var tbl = $('#chart-table');
      setHtml(tbl, h`<div class="table-wrap"><table><thead><tr><th>Date</th><th class="num">Sales</th><th class="num">Tickets</th><th class="num">Orders</th></tr></thead><tbody>${d.daily.slice().reverse().map(function (x) {
        return h`<tr><td>${fmtDate(x.date, { weekday: 'short', day: 'numeric', month: 'short' })}</td><td class="num">${money(x.revenue)}</td><td class="num">${x.tickets}</td><td class="num">${x.orders}</td></tr>`;
      })}</tbody></table></div>`);
      $('#tbl-toggle').addEventListener('click', function () {
        tbl.hidden = !tbl.hidden;
        this.setAttribute('aria-expanded', String(!tbl.hidden));
        this.textContent = tbl.hidden ? 'Show as table' : 'Hide table';
      });
    });
  }

  function niceStep(v) {
    if (v <= 0) return 0;
    var exp = Math.pow(10, Math.floor(Math.log10(v)));
    var f = v / exp;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * exp;
  }

  function drawChart(box, daily) {
    var W = Math.max(300, Math.round(box.clientWidth || 760)), H = 230, L = 58, R = 8, T = 12, B = 30;
    var labelEvery = W < 520 ? 7 : 5;
    var iw = W - L - R, ih = H - T - B;
    var vals = daily.map(function (d) { return Number(d.revenue); });
    var max = Math.max.apply(null, vals.concat([0]));
    var step = niceStep(max / 4) || 25;
    var top = step * 4;
    var slot = iw / daily.length;
    var bw = Math.min(24, slot - 2);
    var y = function (v) { return T + ih - (v / top) * ih; };
    var parts = [];
    for (var i = 0; i <= 4; i++) {
      var v = step * i;
      var yy = Math.round(y(v)) + 0.5;
      parts.push('<line class="gridline" x1="' + L + '" x2="' + (W - R) + '" y1="' + yy + '" y2="' + yy + '"/>');
      parts.push('<text class="axis-text" x="' + (L - 8) + '" y="' + (yy + 4) + '" text-anchor="end">' + esc(moneyTick(v, step)) + '</text>');
    }
    daily.forEach(function (d, idx) {
      var x = L + idx * slot + (slot - bw) / 2;
      var val = Number(d.revenue);
      var bh = (val / top) * ih;
      var label = fmtDate(d.date, { weekday: 'short', day: 'numeric', month: 'short' }) + ': ' + money(val) + ', ' + plural(d.tickets, 'ticket');
      var path = '';
      if (bh > 0) {
        var r = Math.min(4, bh, bw / 2);
        var by = T + ih - bh;
        path = 'M' + x + ',' + (T + ih) + 'V' + (by + r) + 'Q' + x + ',' + by + ' ' + (x + r) + ',' + by + 'H' + (x + bw - r) + 'Q' + (x + bw) + ',' + by + ' ' + (x + bw) + ',' + (by + r) + 'V' + (T + ih) + 'Z';
      }
      parts.push('<g class="col"><rect class="hit" tabindex="0" role="img" aria-label="' + esc(label) + '" data-i="' + idx + '" x="' + (L + idx * slot) + '" y="' + T + '" width="' + slot + '" height="' + ih + '"/>' +
        (path ? '<path class="bar" style="pointer-events:none" d="' + path + '"/>' : '') + '</g>');
      if ((idx % labelEvery === 0 && daily.length - 1 - idx >= labelEvery / 2) || idx === daily.length - 1) {
        parts.push('<text class="axis-text" x="' + (L + idx * slot + slot / 2) + '" y="' + (H - 8) + '" text-anchor="middle">' + esc(fmtDate(d.date, { day: 'numeric', month: 'short' })) + '</text>');
      }
    });
    box.innerHTML = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="group" aria-label="Daily sales for the last 30 days">' + parts.join('') + '</svg>' +
      (max === 0 ? '<p class="muted" style="text-align:center;margin:-120px 0 100px;position:relative">No sales in the last 30 days yet.</p>' : '');
    var tip = document.createElement('div');
    tip.className = 'tooltip';
    tip.hidden = true;
    box.appendChild(tip);
    var svg = box.querySelector('svg');
    function show(e) {
      var i = Number(e.target.getAttribute('data-i'));
      var d = daily[i];
      var scale = svg.getBoundingClientRect().width / W;
      var val = Number(d.revenue);
      tip.textContent = '';
      var strong = document.createElement('strong');
      strong.textContent = money(val);
      var span = document.createElement('span');
      span.textContent = fmtDate(d.date, { weekday: 'short', day: 'numeric', month: 'short' }) + ', ' + plural(d.tickets, 'ticket');
      tip.appendChild(strong);
      tip.appendChild(span);
      tip.hidden = false;
      var half = tip.offsetWidth / 2;
      var cx = (L + i * slot + slot / 2) * scale;
      tip.style.left = Math.max(half, Math.min(box.clientWidth - half, cx)) + 'px';
      tip.style.top = Math.min(y(val), T + ih - 2) * scale + 'px';
    }
    function hide() { tip.hidden = true; }
    $$('.hit', box).forEach(function (r) {
      r.addEventListener('pointerenter', show);
      r.addEventListener('focus', show);
      r.addEventListener('pointerleave', hide);
      r.addEventListener('blur', hide);
    });
  }

  // ---------- orders ----------
  var FILTERS = [
    ['paid', 'Paid orders'],
    ['attention', 'Needs attention'],
    ['emailfailed', 'Email failed'],
    ['pending', 'Awaiting payment'],
    ['refunded', 'Refunded'],
    ['abandoned', 'Abandoned checkouts'],
    ['all', 'All orders'],
  ];

  function viewOrders(r) {
    var q = { status: 'paid', q: '', dateField: 'created', from: '', to: '', page: '1' };
    Object.keys(r.query).forEach(function (k) { q[k] = r.query[k]; });
    setHtml(main, h`
<div class="page-head"><div><h1>Orders</h1><p class="sub" id="orders-sub">&nbsp;</p></div>
<div class="head-actions"><a class="btn btn-secondary" id="csv" href="#">Export CSV</a></div></div>
<form class="filters" id="filters">
  <label class="f grow"><span>Search</span><input name="q" type="search" placeholder="Name, email, order or PayPal ID" value="${q.q}"></label>
  <label class="f"><span>Show</span><select name="status">${FILTERS.map(function (f) { return h`<option value="${f[0]}">${f[1]}</option>`; })}</select></label>
  <label class="f"><span>Dates by</span><select name="dateField"><option value="created">Purchase date</option><option value="visit">Visit date</option></select></label>
  <label class="f"><span>From</span><input type="date" name="from" value="${q.from}"></label>
  <label class="f"><span>To</span><input type="date" name="to" value="${q.to}"></label>
  <button class="btn btn-primary" type="submit">Apply</button>
</form>
<section class="panel" id="orders-panel"><p class="muted">Loading…</p></section>`);
    var form = $('#filters');
    form.status.value = q.status;
    form.dateField.value = q.dateField;
    function submit() {
      var p = new URLSearchParams();
      new FormData(form).forEach(function (v, k) { if (v && !(k === 'status' && v === 'paid') && !(k === 'dateField' && v === 'created')) p.set(k, v); });
      location.hash = 'orders' + (p.toString() ? '?' + p.toString() : '');
    }
    form.addEventListener('submit', function (e) { e.preventDefault(); submit(); });
    form.status.addEventListener('change', submit);
    var params = new URLSearchParams();
    Object.keys(q).forEach(function (k) { if (q[k]) params.set(k, q[k]); });
    $('#csv').href = '/api/admin/orders.csv?' + params.toString();
    return api('/api/admin/orders?' + params.toString()).then(function (data) {
      currency = data.currency;
      $('#orders-sub').textContent = plural(data.total, 'order') + ', ' + plural(data.tickets, 'ticket') + ', ' + money(data.revenue) + ' in sales';
      var pages = Math.max(1, Math.ceil(data.total / data.pageSize));
      var link = function (p) {
        var pp = new URLSearchParams(params);
        pp.set('page', String(p));
        return '#orders?' + pp.toString();
      };
      setHtml($('#orders-panel'), h`${ordersTable(data.orders)}
${pages > 1 ? h`<div class="actions" style="margin-top:14px;align-items:center">
${data.page > 1 ? h`<a class="btn btn-secondary btn-sm" href="${link(data.page - 1)}">Previous</a>` : ''}
<span class="muted">Page ${data.page} of ${pages}</span>
${data.page < pages ? h`<a class="btn btn-secondary btn-sm" href="${link(data.page + 1)}">Next</a>` : ''}</div>` : ''}`);
    });
  }

  function viewOrder(r) {
    return api('/api/admin/orders/' + encodeURIComponent(r.arg)).then(renderOrder);
  }

  function renderOrder(o) {
    currency = o.currency;
    var paidGroup = ['paid', 'fulfilled', 'needs_attention'].indexOf(o.status) >= 0 && o.paidAt;
    var ppBase = o.paypal.mode === 'live' ? 'https://www.paypal.com' : o.paypal.mode === 'sandbox' ? 'https://www.sandbox.paypal.com' : null;
    var email = o.email || {};
    var emailText = email.status === 'sent'
      ? 'Sent to ' + email.to + ' on ' + fmtDateTime(email.sentAt)
      : email.status === 'failed'
        ? 'Failed (' + (email.lastError || 'unknown error') + ')' + (email.nextAttemptAt ? '. Next automatic try ' + fmtDateTime(email.nextAttemptAt) : '')
        : email.status === 'queued' ? 'Sending…' : 'Not sent';

    setHtml(main, h`
<a class="back" href="#orders">Back to orders</a>
${o.paypalUnavailable ? h`<div class="alert warn" style="margin-bottom:16px"><span>PayPal can't confirm this payment: the keys it was made with are gone or no longer accepted, or PayPal has no record of it. Look the order up in your PayPal account, then choose below what happened.</span></div>` : ''}
<div class="page-head">
  <div><h1>${o.id}</h1><p class="sub">${badge(o.status)}${modeBadge(o.paypal.mode)} ${o.customer.name}, created ${fmtDateTime(o.createdAt)}</p></div>
  <div class="head-actions">
    ${['paid', 'needs_attention'].indexOf(o.status) >= 0 ? h`<button class="btn btn-primary" data-act="retry">Retry delivery</button>` : ''}
    ${o.status === 'pending' && !o.paypal.captureAttemptedAt ? h`<button class="btn btn-danger" data-act="cancel">Cancel order</button>` : ''}
    ${o.paypalUnavailable ? h`<button class="btn btn-primary" data-act="confirm-paid">Payment received: send tickets</button>` : ''}
    ${o.paypalUnavailable && (o.status === 'pending' || o.status === 'payment_pending') ? h`<button class="btn btn-danger" data-act="release">No payment: release tickets</button>` : ''}
    ${paidGroup ? h`<button class="btn btn-secondary" data-act="refunded">Mark as refunded</button>` : ''}
    ${ppBase && o.paypal.captureId ? h`<a class="btn btn-secondary" href="${ppBase + '/activity/payment/' + encodeURIComponent(o.paypal.captureId)}" target="_blank" rel="noopener">View in PayPal</a>` : ''}
  </div>
</div>
${o.attention ? h`<div class="attention">${o.attention}</div>` : ''}
<div class="grid-2">
  <section class="panel"><h2>Visit</h2><dl class="kv">
    <dt>Date</dt><dd>${fmtDate(o.visitDate, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</dd>
    <dt>Tickets</dt><dd>${o.items.map(function (i) { return i.qty + ' × ' + i.name + ' at ' + money(i.unitPrice); }).join(', ')}</dd>
    <dt>Total</dt><dd>${money(o.total)}${o.refundedTotal ? h` <span class="muted">(refunded ${money(o.refundedTotal)})</span>` : ''}</dd>
  </dl></section>
  <section class="panel"><h2>Customer</h2><dl class="kv">
    <dt>Name</dt><dd>${o.customer.name}</dd>
    <dt>Email</dt><dd><a href="mailto:${o.customer.email}">${o.customer.email}</a></dd>
    <dt>Phone</dt><dd>${o.customer.phone || '–'}</dd>
  </dl></section>
  <section class="panel"><h2>Payment</h2><dl class="kv">
    <dt>Status</dt><dd>${o.paidAt ? 'Paid ' + fmtDateTime(o.paidAt) : 'Not paid'}</dd>
    <dt>PayPal mode</dt><dd>${o.paypal.mode}</dd>
    <dt>PayPal order</dt><dd>${o.paypal.orderId || '–'}</dd>
    <dt>Capture ID</dt><dd>${o.paypal.captureId || '–'}</dd>
    <dt>Paid by</dt><dd>${[o.paypal.payerName, o.paypal.payerEmail].filter(Boolean).join(', ') || '–'}</dd>
  </dl></section>
  <section class="panel"><h2>Tickets and email</h2>
    ${o.tickets.length ? h`<ul class="files">${o.tickets.map(function (t, i) {
      return h`<li><span>${t.name}<br><small>From stock file ${t.original}</small></span><a class="btn btn-secondary btn-sm" href="/api/admin/orders/${o.id}/tickets/${i + 1}?view=1" target="_blank" rel="noopener">Open</a></li>`;
    })}</ul>` : h`<p class="muted">${o.reservation && o.reservation.count ? plural(o.reservation.count, 'ticket') + ' reserved until ' + fmtDateTime(o.reservation.expiresAt) + '.' : 'No tickets issued.'}</p>`}
    <dl class="kv" style="margin-top:12px"><dt>Email</dt><dd>${emailText}</dd></dl>
    ${o.status === 'fulfilled' ? h`<form class="inline-form" id="resend-form">
      <input class="input" type="email" name="email" placeholder="${o.customer.email}" aria-label="Send to another address (optional)">
      <button class="btn btn-primary btn-sm" type="submit">Resend tickets</button></form>
      <p class="muted" style="margin-top:6px">Leave the address empty to resend to the customer.</p>
      ${o.downloadUrl ? h`<p style="margin:10px 0 0"><button type="button" class="btn btn-secondary btn-sm" id="copy-link">Copy customer download link</button></p>` : ''}` : ''}
  </section>
</div>
<section class="panel" style="margin-top:18px"><h2>Activity</h2>
  <ul class="timeline">${(o.log || []).slice().reverse().map(function (l) { return h`<li><time>${fmtDateTime(l.at)}</time><span>${l.msg}</span></li>`; })}</ul>
  <form class="inline-form" id="note-form"><input class="input" name="text" maxlength="500" placeholder="Add an internal note (only visible here)" aria-label="Internal note"><button class="btn btn-secondary btn-sm" type="submit">Add note</button></form>
</section>`);

    function act(path, btn, body, okMsg) {
      busy(btn, true);
      return api('/api/admin/orders/' + o.id + '/' + path, { body: body || {} })
        .then(function (updated) { toast(okMsg); renderOrder(updated); })
        .catch(function (e) { toast(e.message, true); busy(btn, false); });
    }
    $$('[data-act]', main).forEach(function (b) {
      b.addEventListener('click', function () {
        var a = b.getAttribute('data-act');
        if (a === 'retry') act('retry', b, {}, 'Delivery retried.');
        if (a === 'cancel' && window.confirm('Cancel this unpaid order and put its tickets back in stock?')) act('cancel', b, {}, 'Order cancelled.');
        if (a === 'release' && window.confirm('Only continue if your PayPal account shows NO payment for this order. Release its tickets back to stock?')) {
          act('cancel', b, { confirmNotPaid: true }, 'Order cancelled and tickets released.');
        }
        if (a === 'confirm-paid' && window.confirm('Only continue if your PayPal account shows a completed payment of ' + money(o.total, o.currency) + ' for this order. Send the tickets to ' + o.customer.email + '?')) {
          act('confirm-paid', b, { confirmPaid: true }, 'Payment confirmed. Tickets are being sent.');
        }
        if (a === 'refunded' && window.confirm('Refund the payment in PayPal first. Mark this order as refunded now?')) act('refunded', b, {}, 'Marked as refunded.');
      });
    });
    var rf = $('#resend-form');
    if (rf) rf.addEventListener('submit', function (e) {
      e.preventDefault();
      act('resend', rf.querySelector('button'), { email: rf.email.value.trim() }, 'Tickets sent.');
    });
    var nf = $('#note-form');
    nf.addEventListener('submit', function (e) {
      e.preventDefault();
      if (!nf.text.value.trim()) return;
      act('note', nf.querySelector('button'), { text: nf.text.value }, 'Note added.');
    });
    var cl = $('#copy-link');
    if (cl) cl.addEventListener('click', function () {
      (navigator.clipboard ? navigator.clipboard.writeText(o.downloadUrl) : Promise.reject())
        .then(function () { toast('Download link copied.'); })
        .catch(function () { window.prompt('Copy this link:', o.downloadUrl); });
    });
  }

  // ---------- stock ----------
  // Which ticket folder the stock page shows: 'real' or 'test' (set from the server's answer).
  var stockFolder = '';
  function folderQuery(sep) { return stockFolder ? sep + 'folder=' + stockFolder : ''; }

  function folderNote(s) {
    if (s.folder === 'test') {
      return 'Only for test payments (PayPal Sandbox and simulated). Put sample tickets here, never real ones: test buyers receive whatever is in this folder.' +
        (s.mode === 'live' ? ' Test payments are off right now.' : '');
    }
    if (s.mode !== 'live') return 'Your real tickets. They are sold once you switch to live payments; test payments never take them.';
    return 'Your real tickets, sold to customers who pay with PayPal.';
  }

  function viewStock(r) {
    var wanted = r && (r.query.folder === 'test' || r.query.folder === 'real') ? r.query.folder : '';
    return api('/api/admin/stock' + (wanted ? '?folder=' + wanted : '')).then(function (s) {
      stockFolder = s.folder;
      setHtml(main, h`
<div class="page-head"><div><h1>Ticket stock</h1><p class="sub">Each file is one ticket. Customers get the next files in name order, and sold files move to the sold folder.</p></div>
<div class="head-actions"><button class="btn btn-secondary" id="dupes">Check for duplicates</button></div></div>
<nav class="seg" aria-label="Ticket folder">
  <a href="#stock?folder=real" ${s.folder === 'real' ? raw('aria-current="page"') : ''}>Real tickets${s.activeFolder === 'real' ? h` <span class="seg-tag">in use</span>` : ''}</a>
  <a href="#stock?folder=test" ${s.folder === 'test' ? raw('aria-current="page"') : ''}>Test tickets${s.activeFolder === 'test' ? h` <span class="seg-tag">in use</span>` : ''}</a>
</nav>
<p class="folder-note ${s.folder === 'test' ? 'is-test' : ''}">${folderNote(s)}</p>
<div class="stock-grid" id="stock-grid"></div>
<section class="panel">
  <h2>Add ${s.folder === 'test' ? 'test' : 'real'} tickets</h2>
  <div class="filters">
    <label class="f"><span>Ticket type</span><select id="up-type">${s.types.map(function (t) { return h`<option value="${t.id}">${t.name}</option>`; })}</select></label>
    <label class="f"><span>Valid on</span><select id="up-mode"><option value="">Any day</option><option value="date">One specific date</option></select></label>
    <label class="f" id="up-date-wrap" hidden><span>Date</span><input type="date" id="up-date"></label>
  </div>
  <div class="dropzone" id="drop" tabindex="0" role="button" aria-label="Choose ticket files to upload"><strong>Drop ticket files here</strong> or click to choose them.<br>PDF, PNG, JPG or Apple Wallet (.pkpass), up to 20 MB each.</div>
  <input type="file" id="file-input" multiple accept=".pdf,.png,.jpg,.jpeg,.gif,.webp,.pkpass" hidden>
  <ul class="upload-log" id="up-log"></ul>
  <p class="muted" style="margin-top:12px">You can also copy files into the folders on the server: <span class="code">${s.dir}/stock/TYPE/</span> for any day, or <span class="code">${s.dir}/stock/TYPE/YYYY-MM-DD/</span> for one date. Date-specific tickets are used first for that date.</p>
</section>
<section class="panel" id="dupe-panel" hidden></section>
<section class="panel" id="files-panel" hidden></section>`);
      renderStockGrid(s);
      bindUpload();
      $('#dupes').addEventListener('click', function () { checkDupes(false, this); });
    });
  }

  function renderStockGrid(s) {
    var grid = $('#stock-grid');
    if (!grid) return;
    setHtml(grid, h`${s.types.map(function (t) {
      var future = t.dated.filter(function (d) { return !d.past; }).reduce(function (a, d) { return a + d.count; }, 0);
      var low = t.availableNow <= s.lowStockThreshold;
      return h`<div class="stock-card">
<h3><span>${t.name}</span>${t.active ? '' : h`<span class="badge">Not on sale</span>`}</h3>
<p class="stock-count ${low ? 'low' : ''}">${t.availableNow}</p>
<p class="muted">available: ${t.open} for any day${future ? h`, ${future} for specific dates` : ''}</p>
<p class="muted">${t.sold} sold so far</p>
${t.dated.length ? h`<ul class="dated">${t.dated.map(function (d) {
        return h`<li class="${d.past ? 'past' : ''}"><span>${fmtDate(d.date)}${d.past ? ' (past)' : ''}</span><span>${d.count}</span></li>`;
      })}</ul>` : ''}
<p style="margin-top:12px"><button type="button" class="btn btn-secondary btn-sm" data-files="${t.id}">View files</button></p>
</div>`;
    })}`);
    $$('[data-files]', grid).forEach(function (b) {
      b.addEventListener('click', function () {
        var t = s.types.filter(function (x) { return x.id === b.getAttribute('data-files'); })[0];
        showFiles(t, '');
      });
    });
  }

  function refreshStock() {
    return api('/api/admin/stock' + folderQuery('?')).then(renderStockGrid);
  }

  function showFiles(t, date) {
    var panel = $('#files-panel');
    panel.hidden = false;
    var q = '/api/admin/stock/files?type=' + encodeURIComponent(t.id) + (date ? '&date=' + date : '') + folderQuery('&');
    api(q).then(function (res) {
      setHtml(panel, h`<div class="panel-head"><h2>${t.name} files</h2>
<label class="f"><span class="sr-only">Folder</span><select id="files-folder"><option value="">Any day</option>${t.dated.map(function (d) { return h`<option value="${d.date}">${fmtDate(d.date)}</option>`; })}</select></label></div>
<p class="muted">${res.total === 0 ? 'This folder is empty.' : plural(res.total, 'file') + (res.total > res.files.length ? ', showing the first ' + res.files.length : '') + '. These are sent next, top first.'}</p>
<ul class="files">${res.files.map(function (n) {
        return h`<li><span>${n}</span><button type="button" class="btn btn-danger btn-sm" data-remove="${n}">Remove</button></li>`;
      })}</ul>`);
      var sel = $('#files-folder');
      sel.value = date;
      sel.addEventListener('change', function () { showFiles(t, sel.value); });
      $$('[data-remove]', panel).forEach(function (b) {
        b.addEventListener('click', function () {
          var name = b.getAttribute('data-remove');
          if (!window.confirm('Remove ' + name + ' from stock? It is moved to the "removed" folder, not deleted.')) return;
          busy(b, true, 'Removing…');
          api('/api/admin/stock/remove', { body: { type: t.id, date: date || null, name: name, folder: stockFolder } })
            .then(function () { toast('Removed from stock.'); refreshStock(); showFiles(t, date); })
            .catch(function (e) { toast(e.message, true); busy(b, false); });
        });
      });
      panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }).catch(function (e) { toast(e.message, true); });
  }

  function bindUpload() {
    var drop = $('#drop');
    var input = $('#file-input');
    var mode = $('#up-mode');
    mode.addEventListener('change', function () { $('#up-date-wrap').hidden = mode.value !== 'date'; });
    drop.addEventListener('click', function () { input.click(); });
    drop.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
    drop.addEventListener('dragover', function (e) { e.preventDefault(); drop.classList.add('is-over'); });
    drop.addEventListener('dragleave', function () { drop.classList.remove('is-over'); });
    drop.addEventListener('drop', function (e) {
      e.preventDefault();
      drop.classList.remove('is-over');
      upload(Array.prototype.slice.call(e.dataTransfer.files || []));
    });
    input.addEventListener('change', function () {
      upload(Array.prototype.slice.call(input.files || []));
      input.value = '';
    });
  }

  function upload(files) {
    if (!files.length) return;
    var type = $('#up-type').value;
    var date = $('#up-mode').value === 'date' ? $('#up-date').value : '';
    if ($('#up-mode').value === 'date' && !date) {
      toast('Pick the date these tickets are valid for.', true);
      return;
    }
    var log = $('#up-log');
    var ok = 0, dup = 0, bad = 0;
    var line = function (cls, text) {
      var li = document.createElement('li');
      li.className = cls;
      li.textContent = text;
      log.insertBefore(li, log.firstChild);
    };
    var chain = Promise.resolve();
    files.forEach(function (f) {
      chain = chain.then(function () {
        return fetch('/api/admin/stock/upload?type=' + encodeURIComponent(type) + (date ? '&date=' + date : '') + folderQuery('&'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(f.name) },
          body: f,
          credentials: 'same-origin',
        }).then(function (res) {
          return res.json().catch(function () { return {}; }).then(function (d) {
            if (res.status === 401) { showLogin(); throw new Error('Please log in again.'); }
            if (res.ok) { ok++; line('ok', 'Added ' + d.name); }
            else if (d.duplicate) { dup++; line('dup', d.error); }
            else { bad++; line('bad', d.error || f.name + ': upload failed'); }
          });
        }).catch(function (e) { bad++; line('bad', f.name + ': ' + e.message); });
      });
    });
    chain.then(function () {
      toast(plural(ok, 'ticket') + ' added' + (dup ? ', ' + dup + ' duplicate' + (dup === 1 ? '' : 's') + ' skipped' : '') + (bad ? ', ' + bad + ' failed' : '') + '.', bad > 0);
      refreshStock();
    });
  }

  function checkDupes(fix, btn) {
    busy(btn, true, fix ? 'Moving…' : 'Checking…');
    api('/api/admin/stock/duplicates', { body: { fix: fix, folder: stockFolder } }).then(function (r) {
      var panel = $('#dupe-panel');
      panel.hidden = false;
      var count = r.duplicates.reduce(function (a, d) { return a + d.duplicates.length; }, 0) + r.alreadySold.length;
      if (!count) {
        setHtml(panel, h`<h2>Duplicate check</h2><p>${fix ? 'Duplicates were moved to the "removed/duplicates" folder.' : 'No duplicate tickets found in stock.'}</p>`);
      } else {
        setHtml(panel, h`<h2>Duplicate check</h2>
<p>${plural(count, 'file')} would sell a ticket that is already in stock or already sold.</p>
<ul class="files">${r.duplicates.map(function (d) { return d.duplicates.map(function (x) { return h`<li><span>${x}<br><small>same as ${d.keep}</small></span></li>`; }); })}
${r.alreadySold.map(function (x) { return h`<li><span>${x.file}<br><small>already sold in order ${x.soldIn}</small></span></li>`; })}</ul>
<p style="margin-top:12px"><button class="btn btn-primary" id="fix-dupes">Move duplicates out of stock</button></p>`);
        $('#fix-dupes').addEventListener('click', function () { checkDupes(true, this); });
      }
      if (fix) refreshStock();
      panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }).catch(function (e) { toast(e.message, true); }).then(function () { busy(btn, false); });
  }

  // ---------- calendar ----------
  var WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  function viewCalendar(r) {
    var month = /^\d{4}-\d{2}$/.test(r.query.month || '') ? r.query.month : todayYmd().slice(0, 7);
    return api('/api/admin/calendar?month=' + month).then(function (d) {
      setHtml(main, h`
<div class="page-head"><div><h1>Calendar</h1><p class="sub">Click a day to close or reopen it for online sales. Bookings already made are not affected.</p></div></div>
<section class="panel">
  <div class="acal-head">
    <a class="btn btn-secondary btn-sm" href="#calendar?month=${addMonths(month, -1)}" aria-label="Previous month">Previous</a>
    <h2>${fmtDate(month + '-01', { month: 'long', year: 'numeric' })}</h2>
    <a class="btn btn-secondary btn-sm" href="#calendar?month=${addMonths(month, 1)}" aria-label="Next month">Next</a>
  </div>
  <div class="acal" id="acal"></div>
</section>
<section class="panel">
  <h2>Weekly closing days</h2>
  <p class="muted" style="margin-top:-6px">Tick the days the palace is closed every week.</p>
  <div class="weekdays" id="weekdays">${[1, 2, 3, 4, 5, 6, 0].map(function (i) {
        return h`<label><input type="checkbox" value="${i}" ${d.closedWeekdays.indexOf(i) >= 0 ? raw('checked') : ''}> ${WEEKDAYS[i]}</label>`;
      })}</div>
  <p style="margin-top:14px"><button class="btn btn-primary" id="save-weekdays">Save weekly closing days</button></p>
</section>`);
      renderMonth(d);
      $('#save-weekdays').addEventListener('click', function () {
        var btn = this;
        var days = $$('#weekdays input:checked').map(function (c) { return Number(c.value); });
        busy(btn, true, 'Saving…');
        api('/api/admin/settings', { method: 'PUT', body: { closedWeekdays: days } })
          .then(function () { toast('Weekly closing days saved.'); return api('/api/admin/calendar?month=' + month).then(renderMonth); })
          .catch(function (e) { toast(e.message, true); })
          .then(function () { busy(btn, false); });
      });
    });
  }

  function renderMonth(d) {
    var box = $('#acal');
    var first = new Date(d.month + '-01T12:00:00Z').getUTCDay();
    var offset = (first + 6) % 7;
    var cells = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'].map(function (w) { return h`<div class="wd" aria-hidden="true">${w}</div>`; });
    for (var i = 0; i < offset; i++) cells.push(h`<div></div>`);
    d.days.forEach(function (day) {
      var closed = day.closedDate || day.closedWeekday;
      var cls = 'aday' + (closed ? ' is-closed' : '') + (day.past ? ' is-past' : '') + (day.date === d.today ? ' is-today' : '');
      var status = closed ? (day.closedWeekday ? 'Closed weekly' : 'Closed') : day.past ? '' : day.available + ' in stock';
      var label = fmtDate(day.date, { weekday: 'long', day: 'numeric', month: 'long' }) + ', ' + plural(day.booked, 'ticket') + ' booked' + (status ? ', ' + status : '');
      cells.push(h`<button type="button" class="${cls}" data-date="${day.date}" ${day.past ? raw('disabled') : ''} aria-label="${label}">
<span class="n">${Number(day.date.slice(8))}</span>
<span class="b">${day.booked ? day.booked + ' booked' : ''}</span>
<span class="s">${status}</span></button>`);
    });
    setHtml(box, h`${cells}`);
    $$('.aday', box).forEach(function (b) {
      b.addEventListener('click', function () {
        var day = d.days.filter(function (x) { return x.date === b.getAttribute('data-date'); })[0];
        if (day.closedWeekday && !day.closedDate) {
          toast('This day is closed every week. Change it under Weekly closing days.', true);
          return;
        }
        b.disabled = true;
        api('/api/admin/calendar/toggle', { body: { date: day.date } })
          .then(function (nd) {
            renderMonth(nd);
            toast(day.closedDate ? 'Reopened ' + fmtDate(day.date) + '.' : 'Closed ' + fmtDate(day.date) + ' for online sales.');
          })
          .catch(function (e) { toast(e.message, true); b.disabled = false; });
      });
    });
  }

  // ---------- settings ----------
  function slugify(s) {
    return String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 31);
  }

  function viewSettings() {
    return Promise.all([api('/api/admin/settings'), api('/api/admin/system')]).then(function (res) {
      var s = res[0].settings, currencies = res[0].currencies, sys = res[1];
      var savedIds = s.ticketTypes.map(function (t) { return t.id; });
      setHtml(main, h`
<div class="page-head"><div><h1>Settings</h1><p class="sub">Changes apply to the booking page straight away.</p></div></div>
<form id="settings-form" novalidate>
<section class="panel">
  <div class="panel-head"><h2>Ticket types and prices</h2><p class="panel-note">Prices in ${s.currency}. Each type sells from its own stock folder.</p></div>
  <div class="table-wrap"><table class="types-table"><thead><tr><th>Name</th><th>Description</th><th>Price</th><th>Stock folder</th><th>On sale</th><th></th></tr></thead><tbody id="types-body"></tbody></table></div>
  <p style="margin-top:10px"><button type="button" class="btn btn-secondary btn-sm" id="add-type">Add ticket type</button></p>
</section>
<section class="panel"><h2>Sales rules</h2><div class="form-grid">
  <label class="f"><span>Currency</span><select name="currency">${currencies.map(function (c) { return h`<option value="${c}">${c}</option>`; })}</select><p class="hint">PayPal does not support Moroccan dirham (MAD).</p></label>
  <label class="f"><span>Most tickets in one order</span><input name="maxTicketsPerOrder" type="number" min="1" max="50" value="${s.maxTicketsPerOrder}"></label>
  <label class="f"><span>Sell tickets up to this many days ahead</span><input name="bookingWindowDays" type="number" min="1" max="730" value="${s.bookingWindowDays}"></label>
  <label class="f"><span>Stop same-day sales at</span><input name="sameDayCutoff" type="time" value="${s.sameDayCutoff}"><p class="hint">Venue time (${sys.timezone}). Leave empty to sell until midnight.</p></label>
  <label class="f"><span>Hold tickets during checkout (minutes)</span><input name="holdMinutes" type="number" min="5" max="60" value="${s.holdMinutes}"></label>
  <label class="f"><span>Warn me when stock falls to</span><input name="lowStockThreshold" type="number" min="0" value="${s.lowStockThreshold}"></label>
  <label class="f"><span>Show "Few left" when stock falls to</span><input name="fewLeftThreshold" type="number" min="0" value="${s.fewLeftThreshold}"><p class="hint">Yellow label on the booking calendar. Set 0 to hide it.</p></label>
</div></section>
<section class="panel"><h2>Booking page and email text</h2><div class="form-grid">
  <label class="f"><span>Site name</span><input name="siteName" maxlength="80" value="${s.siteName}"></label>
  <label class="f"><span>Opening hours</span><input name="openingHours" maxlength="120" value="${s.openingHours}"></label>
  <label class="f wide"><span>Tagline under the site name</span><input name="tagline" maxlength="200" value="${s.tagline}"></label>
  <label class="f wide"><span>Notice banner (optional, e.g. a holiday closure)</span><input name="notice" maxlength="300" value="${s.notice}"></label>
  <label class="f wide"><span>Instructions in the ticket email</span><textarea name="ticketInstructions" maxlength="1000">${s.ticketInstructions}</textarea></label>
  <label class="f"><span>Address</span><input name="address" maxlength="200" value="${s.address}"></label>
  <label class="f"><span>Support email shown to customers</span><input name="supportEmail" type="email" value="${s.supportEmail}"></label>
  <label class="f wide"><span>Terms and conditions link (optional, adds a checkbox at checkout)</span><input name="termsUrl" type="url" placeholder="https://" value="${s.termsUrl}"></label>
  <label class="check-row wide"><input type="checkbox" name="notifyAdminOnSale" ${s.notifyAdminOnSale ? raw('checked') : ''}> Email me about every sale ${sys.adminEmail ? h`(${sys.adminEmail})` : h`<span class="muted">(set ADMIN_EMAIL in ${sys.settingsPlace || 'the .env file'} first)</span>`}</label>
</div></section>
<div class="savebar"><span class="msg" id="save-msg"></span><button class="btn btn-primary" type="submit" id="save-btn">Save settings</button></div>
</form>
<section class="panel"><h2>Connection status</h2><dl class="kv">
  <dt>Payments</dt><dd>${sys.paymentsEnabled ? h`PayPal <strong>${sys.mode}</strong>` : h`<span class="badge bad">Off</span> ${sys.paymentsDisabledReason}`} <a href="#paypal">PayPal page</a></dd>
  <dt>PayPal webhook</dt><dd>${sys.mode === 'mock' ? 'Not used with simulated payments' : sys.webhookConfigured ? h`<span class="badge ok">Connected</span>` : h`<span class="badge wait">Not set up</span>`}<br><span class="code">${sys.webhookUrl}</span></dd>
  <dt>Email sending</dt><dd>${sys.smtpConfigured ? sys.smtpHost : h`<span class="badge wait">Not set up</span> emails are saved to the outbox folder`}</dd>
  <dt>Emails come from</dt><dd>${sys.mailFrom}</dd>
  <dt>Alerts go to</dt><dd>${sys.adminEmail || 'not set (ADMIN_EMAIL)'}</dd>
  <dt>Public address</dt><dd>${sys.baseUrl}</dd>
  <dt>Venue time now</dt><dd>${sys.venueTime} (${sys.timezone}) <span class="muted">If this is wrong, update Node.js or set TIMEZONE in ${sys.settingsPlace || 'the .env file'}.</span></dd>
  <dt>Ticket folder</dt><dd><span class="code">${sys.ticketsDir}</span></dd>
  <dt>Version</dt><dd>${sys.version}, Node ${sys.node}</dd>
</dl>
<form class="inline-form" id="test-email"><input class="input" type="email" name="to" placeholder="you@example.com" value="${sys.adminEmail}" aria-label="Send a test email to"><button class="btn btn-secondary btn-sm" type="submit">Send test email</button></form>
</section>`);

      var form = $('#settings-form');
      form.currency.value = s.currency;
      var body = $('#types-body');
      function typeRow(t, isNew) {
        var tr = document.createElement('tr');
        setHtml(tr, h`<td><input class="input" data-k="name" maxlength="60" value="${t.name}" aria-label="Name"></td>
<td><input class="input" data-k="description" maxlength="140" value="${t.description}" aria-label="Description"></td>
<td class="price"><input class="input" data-k="price" inputmode="decimal" value="${t.price}" aria-label="Price"></td>
<td class="folder"><input class="input" data-k="id" value="${t.id}" ${isNew ? '' : raw('readonly')} aria-label="Stock folder"></td>
<td><input type="checkbox" data-k="active" ${t.active ? raw('checked') : ''} aria-label="On sale"></td>
<td>${isNew ? h`<button type="button" class="btn btn-danger btn-sm" data-del>Remove</button>` : ''}</td>`);
        if (isNew) {
          var idInput = tr.querySelector('[data-k="id"]');
          var touched = false;
          idInput.addEventListener('input', function () { touched = true; });
          tr.querySelector('[data-k="name"]').addEventListener('input', function () { if (!touched) idInput.value = slugify(this.value); });
          tr.querySelector('[data-del]').addEventListener('click', function () { tr.remove(); });
        }
        body.appendChild(tr);
      }
      s.ticketTypes.forEach(function (t) { typeRow(t, false); });
      $('#add-type').addEventListener('click', function () {
        typeRow({ id: '', name: '', description: '', price: '', active: true }, true);
        body.lastChild.querySelector('input').focus();
      });

      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var types = $$('tr', body).map(function (tr) {
          var g = function (k) { return tr.querySelector('[data-k="' + k + '"]'); };
          return { id: g('id').value.trim(), name: g('name').value.trim(), description: g('description').value.trim(), price: g('price').value.trim(), active: g('active').checked };
        });
        var payload = {
          ticketTypes: types,
          currency: form.currency.value,
          maxTicketsPerOrder: Number(form.maxTicketsPerOrder.value),
          bookingWindowDays: Number(form.bookingWindowDays.value),
          sameDayCutoff: form.sameDayCutoff.value,
          holdMinutes: Number(form.holdMinutes.value),
          lowStockThreshold: Number(form.lowStockThreshold.value),
          fewLeftThreshold: Number(form.fewLeftThreshold.value),
          siteName: form.siteName.value,
          openingHours: form.openingHours.value,
          tagline: form.tagline.value,
          notice: form.notice.value,
          ticketInstructions: form.ticketInstructions.value,
          address: form.address.value,
          supportEmail: form.supportEmail.value,
          termsUrl: form.termsUrl.value,
          notifyAdminOnSale: form.notifyAdminOnSale.checked,
        };
        var btn = $('#save-btn');
        busy(btn, true, 'Saving…');
        $('#save-msg').textContent = '';
        api('/api/admin/settings', { method: 'PUT', body: payload })
          .then(function (r) {
            currency = r.settings.currency;
            $('#brand').textContent = r.settings.siteName;
            var added = r.settings.ticketTypes.filter(function (t) { return savedIds.indexOf(t.id) < 0; });
            toast('Settings saved.' + (added.length ? ' Add tickets for ' + added.map(function (t) { return t.name; }).join(', ') + ' in Ticket stock.' : ''));
            viewSettings();
          })
          .catch(function (err) {
            $('#save-msg').textContent = err.message;
            toast(err.message, true);
            busy(btn, false);
          });
      });

      $('#test-email').addEventListener('submit', function (e) {
        e.preventDefault();
        var f = this;
        var btn = f.querySelector('button');
        busy(btn, true, 'Sending…');
        api('/api/admin/test-email', { body: { to: f.to.value.trim() } })
          .then(function (r) { toast(r.outbox ? 'Email saved to the outbox folder (SMTP not set up).' : 'Test email sent. Check the inbox.'); })
          .catch(function (err) { toast(err.message, true); })
          .then(function () { busy(btn, false); });
      });
    });
  }

  // ---------- PayPal ----------
  var MODE_INFO = {
    sandbox: {
      head: 'Test payments are on',
      tag: 'Test',
      cls: 'is-test',
      text: 'Only PayPal Sandbox test accounts can pay, so no real money moves. Tickets come from the test folder, never from your real tickets.',
      done: 'Test payments are on.',
    },
    live: {
      head: 'Live payments are on',
      tag: 'Live',
      cls: 'is-live',
      text: 'Customers pay real money with PayPal or a card and receive tickets from your real ticket folder.',
      done: 'Live payments are on. Customers now pay for real.',
    },
    mock: {
      head: 'Simulated payments are on',
      tag: 'Demo',
      cls: 'is-demo',
      text: 'No PayPal at all: the pay button completes at once and tickets come from the test folder. This only works on your own computer.',
      done: 'Simulated payments are on.',
    },
  };
  var MODE_LABEL = { sandbox: 'Sandbox', live: 'Live' };

  function folderName(dir) {
    return String(dir || '').split(/[\\/]/).filter(Boolean).pop() || dir;
  }

  function webhookState(w) {
    if (w.state === 'on') return h`<span class="badge ok">On</span>`;
    var badgeHtml =
      w.state === 'error' ? h`<span class="badge bad">Problem</span>` :
      w.state === 'moved' ? h`<span class="badge wait">Old address</span>` :
      w.state === 'needs-https' ? h`<span class="badge wait">Waiting</span>` :
      h`<span class="badge">Off</span>`;
    return h`${badgeHtml}${w.message ? h`<span class="pp-why">${w.message}</span>` : ''}`;
  }

  function modePanel(p) {
    var info = MODE_INFO[p.mode] || MODE_INFO.sandbox;
    var acct = p.mode === 'mock' ? p.modes.sandbox : p.modes[p.mode];
    var options = [];
    if (p.mode !== 'live') {
      options.push({
        mode: 'live',
        label: 'Switch to live payments',
        primary: true,
        why: !p.modes.live.connected ? 'Connect your Live keys first.' : !p.publicHttps ? "Live payments need the app's public https address." : '',
      });
    }
    if (p.mode !== 'sandbox') options.push({ mode: 'sandbox', label: 'Switch to test payments', why: p.modes.sandbox.connected ? '' : 'Connect your Sandbox keys first.' });
    if (p.mockAllowed && p.mode !== 'mock') options.push({ mode: 'mock', label: 'Use simulated payments', why: '' });
    var why = options.filter(function (o) { return o.why; }).map(function (o) { return o.why; });
    return h`<section class="panel pp-mode ${p.enabled ? info.cls : 'is-off'}">
<div class="pp-mode-head"><h2>${p.enabled ? info.head : 'Payments are off'}</h2><span class="badge ${p.mode === 'live' ? 'ok' : p.mode === 'mock' ? 'blue' : 'wait'}">${info.tag}</span></div>
<p>${p.enabled ? info.text : p.mode === 'mock' ? p.disabledReason : 'Connect your ' + MODE_LABEL[p.mode] + ' keys below to start taking payments.'}</p>
<dl class="kv">
  <dt>Tickets come from</dt><dd>${folderName(acct.ticketsDir)} folder, ${plural(acct.tickets || 0, 'ticket')} in stock</dd>
  ${p.mode !== 'mock' ? h`<dt>Payment updates</dt><dd>${webhookState(acct.webhook)}</dd>` : ''}
</dl>
${options.length ? h`<div class="actions">${options.map(function (o) {
      return h`<button type="button" class="btn ${o.primary ? 'btn-primary' : 'btn-secondary'}" data-pp-mode="${o.mode}" ${o.why ? raw('disabled') : ''}>${o.label}</button>`;
    })}</div>` : ''}
${why.length ? h`<p class="pp-why">${why.join(' ')}</p>` : ''}
</section>`;
  }

  function accountPanel(mode, a, p) {
    var label = MODE_LABEL[mode];
    var inUse = p.mode === mode;
    var details = a.connected
      ? h`<dl class="kv">
  <dt>Client ID</dt><dd><span class="code">${a.clientId}</span></dd>
  <dt>Keys from</dt><dd>${a.source === 'env' ? 'the server settings (PAYPAL_CLIENT_ID)' : h`this page${a.connectedAt ? h`, ${fmtDateTime(a.connectedAt)}` : ''}`}</dd>
  <dt>Payment updates</dt><dd>${webhookState(a.webhook)}</dd>
  <dt>Ticket folder</dt><dd>${folderName(a.ticketsDir)}, ${plural(a.tickets || 0, 'ticket')} in stock</dd>
</dl>
${a.keptForOpenOrders ? h`<p class="pp-why">Keys you replaced are kept until the orders made with them are finished, then forgotten.</p>` : ''}
<div class="actions">
  <button type="button" class="btn btn-secondary btn-sm" data-pp-check="${mode}">Check connection</button>
  <button type="button" class="btn btn-secondary btn-sm" data-pp-replace="${mode}">${a.source === 'env' ? 'Use other keys' : 'Replace keys'}</button>
  ${a.source === 'dashboard' && !inUse ? h`<button type="button" class="btn btn-danger btn-sm" data-pp-remove="${mode}">Remove</button>` : ''}
</div>`
      : h`<p class="panel-note">${mode === 'live'
          ? 'Connect the Live keys of the same PayPal app once a test purchase works.'
          : 'Start here. Sandbox keys let you make test purchases with PayPal test accounts.'}</p>`;
    return h`<section class="panel pp-account">
<div class="panel-head"><h2>${mode === 'live' ? 'Live account' : 'Test account (Sandbox)'}</h2>${a.connected ? h`<span class="badge ok">Connected</span>` : h`<span class="badge">Not connected</span>`}</div>
${details}
<form class="pp-form" data-pp-form="${mode}" autocomplete="off" ${a.connected ? raw('hidden') : ''}>
  <label class="f"><span>Client ID</span><input name="clientId" required maxlength="200" spellcheck="false" autocapitalize="off" autocomplete="off"></label>
  <label class="f"><span>Secret</span><input name="clientSecret" type="password" required maxlength="200" spellcheck="false" autocomplete="new-password"></label>
  <p class="hint">On developer.paypal.com open Apps &amp; Credentials, choose the <strong>${label}</strong> tab and click your app. Its Client ID and Secret are at the top.</p>
  <div class="actions"><button class="btn btn-primary btn-sm" type="submit">Connect ${label} keys</button>${a.connected ? h`<button type="button" class="btn btn-secondary btn-sm" data-pp-cancel="${mode}">Cancel</button>` : ''}</div>
</form>
</section>`;
  }

  function viewPayPal() {
    return api('/api/admin/paypal').then(renderPayPal);
  }

  function renderPayPal(p) {
    setHtml(main, h`
<div class="page-head"><div><h1>PayPal</h1><p class="sub">Connect your PayPal business account and choose between test and real payments.</p></div></div>
${modePanel(p)}
<div class="grid-2 pp-accounts">${accountPanel('sandbox', p.modes.sandbox, p)}${accountPanel('live', p.modes.live, p)}</div>
${p.mode !== 'live' ? h`<section class="panel"><h2>Going live</h2><ol class="pp-steps">
  <li>On developer.paypal.com, log in with your PayPal business account, create an app under Apps &amp; Credentials and connect its Sandbox keys here.</li>
  <li>Book a ticket on the booking page and pay with a Sandbox personal account (Testing Tools, then Sandbox Accounts). Check that the ticket email arrives.</li>
  <li>Connect the Live keys of the same app.</li>
  <li>Click Switch to live payments.</li>
</ol></section>` : ''}`);

    function act(url, body, btn, workingLabel, message) {
      busy(btn, true, workingLabel);
      return api(url, { body: body })
        .then(function (r) {
          renderPayPal(r);
          toast(message(r));
        })
        .catch(function (err) {
          toast(err.message, true);
          busy(btn, false);
        });
    }
    function updatesNote(w) {
      return w.state === 'on' ? ' Payment updates are on.' : w.message ? ' ' + w.message : '';
    }

    $$('[data-pp-form]').forEach(function (f) {
      f.addEventListener('submit', function (e) {
        e.preventDefault();
        var mode = f.getAttribute('data-pp-form');
        act('/api/admin/paypal/connect', { mode: mode, clientId: f.clientId.value.trim(), clientSecret: f.clientSecret.value.trim() }, f.querySelector('[type=submit]'), 'Checking with PayPal…', function (r) {
          return MODE_LABEL[mode] + ' keys connected.' + updatesNote(r.modes[mode].webhook);
        });
      });
    });
    $$('[data-pp-replace]').forEach(function (b) {
      b.addEventListener('click', function () {
        var f = $('[data-pp-form="' + b.getAttribute('data-pp-replace') + '"]');
        f.hidden = false;
        f.clientId.focus();
      });
    });
    $$('[data-pp-cancel]').forEach(function (b) {
      b.addEventListener('click', function () {
        var f = $('[data-pp-form="' + b.getAttribute('data-pp-cancel') + '"]');
        f.reset();
        f.hidden = true;
      });
    });
    $$('[data-pp-check]').forEach(function (b) {
      b.addEventListener('click', function () {
        var mode = b.getAttribute('data-pp-check');
        act('/api/admin/paypal/check', { mode: mode }, b, 'Checking…', function (r) {
          return 'PayPal accepts the ' + MODE_LABEL[mode] + ' keys.' + updatesNote(r.modes[mode].webhook);
        });
      });
    });
    $$('[data-pp-remove]').forEach(function (b) {
      b.addEventListener('click', function () {
        var mode = b.getAttribute('data-pp-remove');
        if (!window.confirm('Remove the ' + MODE_LABEL[mode] + ' keys from the dashboard?')) return;
        act('/api/admin/paypal/disconnect', { mode: mode }, b, 'Removing…', function () { return MODE_LABEL[mode] + ' keys removed.'; });
      });
    });
    $$('[data-pp-mode]').forEach(function (b) {
      b.addEventListener('click', function () {
        var mode = b.getAttribute('data-pp-mode');
        var question = {
          live: 'Switch to live payments? Customers will pay real money and receive tickets from your real ticket folder (' + plural(p.modes.live.tickets || 0, 'ticket') + ' in stock).',
          sandbox: 'Switch to test payments? The booking page will only accept PayPal Sandbox test accounts, and tickets will come from the test folder.',
          mock: 'Use simulated payments? The pay button completes without PayPal and customers get sample tickets.',
        }[mode];
        if (!window.confirm(question)) return;
        act('/api/admin/paypal/mode', { mode: mode }, b, 'Switching…', function () { return MODE_INFO[mode].done; });
      });
    });
  }

  // ---------- email (SMTP) ----------
  function emailFields(m) {
    var s = m.smtp;
    return {
      host: s.host,
      port: String(s.port),
      secure: s.secure,
      user: s.user,
      hasPassword: s.hasPassword,
      from: m.from,
      replyTo: m.replyTo,
    };
  }

  function readEmailForm(form) {
    return {
      smtp: {
        host: form.host.value.trim(),
        port: Number(form.port.value) || undefined,
        secure: form.secure.checked,
        user: form.user.value.trim(),
        password: form.password.value,
        removePassword: form.removePassword.checked,
        from: form.from.value.trim(),
        replyTo: form.replyTo.value.trim(),
      },
    };
  }

  function viewEmail() {
    return api('/api/admin/smtp').then(function (m) {
      var f = emailFields(m);
      setHtml(main, h`
<div class="page-head"><div><h1>Email (SMTP)</h1><p class="sub">How the app sends ticket emails and owner alerts.</p></div></div>
${m.configured
        ? h`<div class="alert ok"><span>Email is set up${m.source === 'dashboard' ? '' : ' from the server configuration'}: ${m.smtp.host || m.env.host}:${m.smtp.host ? m.smtp.port : m.env.port}</span></div>`
        : h`<div class="alert warn"><span>Email is not set up yet, so messages are saved in <span class="code">${m.outboxDir}</span> instead. Fill in your mail server below.</span></div>`}
<form id="smtp-form" novalidate>
<section class="panel">
  <div class="panel-head"><h2>Mail server</h2><p class="panel-note">${m.source === 'dashboard' ? 'Saved here' : 'Currently using the server\u2019s own settings'}</p></div>
  <div class="form-grid">
    <label class="f wide"><span>SMTP host</span><input name="host" maxlength="200" spellcheck="false" autocapitalize="off" value="${f.host}" placeholder="${m.env.host || 'smtp.example.com'}"><p class="hint">Leave empty to use the server configuration${m.env.host ? h` (${m.env.host})` : ''}.</p></label>
    <label class="f"><span>Port</span><input name="port" type="number" min="1" max="65535" value="${f.port}"></label>
    <div class="f"><span>Encryption</span><label class="check-row"><input type="checkbox" name="secure" ${f.secure ? raw('checked') : ''}> Use SSL/TLS (port 465)</label><p class="hint">Leave unticked for STARTTLS (usually port 587).</p></div>
    <label class="f"><span>Username</span><input name="user" maxlength="200" spellcheck="false" autocapitalize="off" autocomplete="off" value="${f.user}" placeholder="${m.env.user || 'you@example.com'}"></label>
    <label class="f"><span>Password</span><input name="password" type="password" maxlength="200" spellcheck="false" autocomplete="new-password" placeholder="${f.hasPassword ? 'Saved – leave empty to keep it' : ''}"></label>
  </div>
  <label class="check-row" style="margin-top:10px"><input type="checkbox" name="removePassword"> Forget the saved password</label>
</section>
<section class="panel">
  <h2>Sender</h2>
  <div class="form-grid">
    <label class="f wide"><span>Emails come from</span><input name="from" maxlength="200" value="${f.from}" placeholder="${m.env.from || 'Tickets <tickets@example.com>'}"></label>
    <label class="f wide"><span>Reply-to (optional)</span><input name="replyTo" maxlength="200" value="${f.replyTo}" placeholder="${m.env.replyTo || ''}"></label>
  </div>
  <p class="muted">Owner alerts are sent to <strong>${m.adminEmail || 'nobody (set ADMIN_EMAIL on the server)'}</strong>.</p>
</section>
<div class="savebar"><span class="msg" id="smtp-msg"></span>
  <button class="btn btn-secondary" type="button" id="smtp-test">Test connection</button>
  <button class="btn btn-primary" type="submit" id="smtp-save">Save email settings</button>
</div>
</form>
<section class="panel">
  <h2>Send a test email</h2>
  <form class="inline-form" id="test-email"><input class="input" type="email" name="to" placeholder="you@example.com" value="${m.adminEmail}" aria-label="Send a test email to"><button class="btn btn-secondary btn-sm" type="submit">Send test email</button></form>
</section>`);

      var form = $('#smtp-form');
      function save(btn, msgEl, okMsg) {
        busy(btn, true, 'Saving...');
        msgEl.textContent = '';
        return api('/api/admin/smtp', { method: 'PUT', body: readEmailForm(form) })
          .then(function () { toast(okMsg); viewEmail(); })
          .catch(function (err) { msgEl.textContent = err.message; toast(err.message, true); busy(btn, false); });
      }
      form.addEventListener('submit', function (e) { e.preventDefault(); save($('#smtp-save'), $('#smtp-msg'), 'Email settings saved.'); });
      $('#smtp-test').addEventListener('click', function () {
        var btn = this;
        busy(btn, true, 'Checking...');
        api('/api/admin/smtp/test', { body: readEmailForm(form) })
          .then(function (r) { toast('Connected to ' + r.host + ':' + r.port + (r.auth ? ' and logged in.' : '.')); })
          .catch(function (err) { toast(err.message, true); })
          .then(function () { busy(btn, false); });
      });
      $('#test-email').addEventListener('submit', function (e) {
        e.preventDefault();
        var b = this.querySelector('button');
        busy(b, true, 'Sending...');
        api('/api/admin/test-email', { body: { to: this.to.value.trim() } })
          .then(function (r) { toast(r.outbox ? 'Saved to the outbox folder (SMTP not set up).' : 'Test email sent. Check the inbox.'); })
          .catch(function (err) { toast(err.message, true); })
          .then(function () { busy(b, false); });
      });
    });
  }

  // ---------- email templates ----------
  var TEMPLATE_ORDER = ['ticket', 'adminSale', 'adminAlert', 'testEmail'];

  function viewTemplates() {
    return api('/api/admin/smtp').then(function (m) {
      setHtml(main, h`
<div class="page-head"><div><h1>Email templates</h1><p class="sub">Change the wording of the emails. The placeholders listed under each heading are filled in automatically.</p></div></div>
<form id="templates-form">
${TEMPLATE_ORDER.map(function (id) {
        var t = m.templates[id];
        var ph = (m.placeholders[id] || []).map(function (p) { return '<span class="code">' + esc(p) + '</span>'; }).join(' ');
        return h`<section class="panel">
  <div class="panel-head"><h2>${m.labels[id] || id}</h2><p class="panel-note">Placeholders: ${raw(ph)}</p></div>
  <div class="form-grid">
    <label class="f wide"><span>Subject</span><input name="${id}.subject" maxlength="160" value="${t.subject}"></label>
    <label class="f wide"><span>Heading</span><input name="${id}.heading" maxlength="160" value="${t.heading}"></label>
    <label class="f wide"><span>Introduction</span><textarea name="${id}.intro" maxlength="1200" rows="2">${t.intro}</textarea></label>
    <label class="f wide"><span>Footer</span><input name="${id}.footer" maxlength="400" value="${t.footer}"></label>
  </div>
</section>`;
      })}
<div class="savebar"><span class="msg" id="tpl-msg"></span><button class="btn btn-primary" type="submit" id="tpl-save">Save templates</button></div>
</form>`);

      var form = $('#templates-form');
      function val(name) { return $('[name="' + name + '"]', form).value; }
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var payload = {};
        TEMPLATE_ORDER.forEach(function (id) {
          payload[id] = {
            subject: val(id + '.subject'),
            heading: val(id + '.heading'),
            intro: val(id + '.intro'),
            footer: val(id + '.footer'),
          };
        });
        var btn = $('#tpl-save');
        busy(btn, true, 'Saving...');
        $('#tpl-msg').textContent = '';
        api('/api/admin/templates', { method: 'PUT', body: { templates: payload } })
          .then(function () { toast('Email templates saved.'); viewTemplates(); })
          .catch(function (err) { $('#tpl-msg').textContent = err.message; toast(err.message, true); busy(btn, false); });
      });
    });
  }

  // ---------- activity log ----------
  var ACTIVITY_TYPES = { all: 'Everything', auth: 'Logins', order: 'Orders', email: 'Email', alert: 'Alerts', paypal: 'PayPal', settings: 'Settings', stock: 'Stock', calendar: 'Calendar', error: 'Errors', info: 'Other' };

  function viewActivity(r) {
    var q = { type: 'all', q: '', page: '1' };
    Object.keys(r.query).forEach(function (k) { q[k] = r.query[k]; });
    var params = new URLSearchParams();
    if (q.type && q.type !== 'all') params.set('type', q.type);
    if (q.q) params.set('q', q.q);
    params.set('page', q.page);
    return api('/api/admin/activity?' + params.toString()).then(function (d) {
      var link = function (p) {
        var pp = new URLSearchParams(params);
        pp.set('page', String(p));
        return '#activity?' + pp.toString();
      };
      var typeOptions = ['all'].concat(d.types.filter(function (t) { return t !== 'all'; }));
      setHtml(main, h`
<div class="page-head"><div><h1>Activity log</h1><p class="sub">Logins, payments, emails, stock changes and settings — newest first.</p></div></div>
<form class="filters" id="act-filters">
  <label class="f grow"><span>Search</span><input type="search" name="q" value="${q.q}" placeholder="Text, order number, email..."></label>
  <label class="f"><span>Show</span><select name="type">${typeOptions.map(function (t) { return h`<option value="${t}">${ACTIVITY_TYPES[t] || t}</option>`; })}</select></label>
  <button class="btn btn-primary" type="submit">Apply</button>
</form>
<section class="panel">
  <div class="panel-head"><h2>${plural(d.total, 'entry')}</h2>${d.pages > 1 ? h`<p class="panel-note">Page ${d.page} of ${d.pages}</p>` : ''}</div>
  ${d.events.length ? h`<ul class="timeline">${d.events.map(function (e) {
        return h`<li><time>${fmtDateTime(e.at)}</time><span>${e.msg}${e.orderId ? h` <a class="mono-id" href="#orders/${e.orderId}">${e.orderId}</a>` : ''} <span class="badge">${ACTIVITY_TYPES[e.type] || e.type}</span>${e.actor ? h` <span class="muted">${e.actor}</span>` : ''}</span></li>`;
      })}</ul>` : h`<p class="empty">Nothing logged yet.</p>`}
  ${d.pages > 1 ? h`<div class="actions" style="margin-top:14px;align-items:center">
    ${d.page > 1 ? h`<a class="btn btn-secondary btn-sm" href="${link(d.page - 1)}">Previous</a>` : ''}
    <span class="muted">Page ${d.page} of ${d.pages}</span>
    ${d.page < d.pages ? h`<a class="btn btn-secondary btn-sm" href="${link(d.page + 1)}">Next</a>` : ''}</div>` : ''}
</section>`);
      var form = $('#act-filters');
      form.type.value = q.type;
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var p = new URLSearchParams();
        new FormData(form).forEach(function (v, k) { if (v && !(k === 'type' && v === 'all')) p.set(k, v); });
        location.hash = 'activity' + (p.toString() ? '?' + p.toString() : '');
      });
    });
  }

  // ---------- boot ----------
  api('/api/admin/me', { noAuthRedirect: true })
    .then(function (me) {
      if (!me.enabled) {
        showLogin('The dashboard is turned off. Set ADMIN_PASSWORD in ' + (me.settingsPlace || 'the .env file') + ' and restart the app.');
        $('#login-form button').disabled = true;
        return;
      }
      if (me.loggedIn) startApp();
      else showLogin();
    })
    .catch(function () { showLogin('Could not reach the server. Reload to try again.'); });
})();
