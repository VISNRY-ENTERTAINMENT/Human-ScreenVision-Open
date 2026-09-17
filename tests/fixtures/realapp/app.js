/* Acme Ops Console - a deliberately realistic SPA-ish page, no framework, no build. */
(function () {
  'use strict';

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var esc = function (s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  };

  /* ---------------- toasts (auto-dismiss) ---------------- */
  function toast(msg, kind, ms) {
    var wrap = $('#toasts');
    var el = document.createElement('div');
    el.className = 'toast' + (kind === 'error' ? ' toast--error' : '');
    el.setAttribute('data-toast', '');
    el.textContent = msg;
    wrap.appendChild(el);
    setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, ms || 2500);
  }

  /* ---------------- state ---------------- */
  var customers = [];
  var invoices = [];
  var sortKey = null;
  var sortDir = 1;

  /* ---------------- section 1: stats ---------------- */
  fetch('/api/stats').then(function (r) { return r.json(); }).then(function (data) {
    var grid = $('#stats-grid');
    grid.innerHTML = data.map(function (s) {
      return '<div class="card card--stat"><span class="card__label">' + esc(s.label) +
        '</span><span class="card__value">' + esc(s.value) + '</span></div>';
    }).join('');
    grid.setAttribute('data-state', 'ready');
  });

  /* ---------------- section 2: customer list, full re-render per keystroke ------------- */
  function renderCustomers() {
    var q = $('#cust-filter').value.trim().toLowerCase();
    var rows = customers.filter(function (c) {
      return !q || c.name.toLowerCase().indexOf(q) >= 0 || c.city.toLowerCase().indexOf(q) >= 0;
    });
    // Full innerHTML replacement: every existing <li> node is destroyed and recreated.
    $('#cust-list').innerHTML = rows.map(function (c) {
      return '<li class="lst__item" data-cust="' + esc(c.id) + '">' +
        '<div class="lst__body"><div class="lst__name">' + esc(c.name) + '</div>' +
        '<div class="lst__meta">' + esc(c.city) + ' &middot; ' + esc(c.plan) + '</div></div>' +
        '<div class="lst__ctl"><button type="button" class="btn btn--sm sv-b8e2" data-open-cust="' +
        esc(c.id) + '">View</button></div></li>';
    }).join('');
    $('#cust-count').textContent = rows.length + ' of ' + customers.length + ' customers';
  }

  fetch('/api/customers').then(function (r) { return r.json(); }).then(function (data) {
    customers = data;
    $('.list-wrap').setAttribute('data-state', 'ready');
    renderCustomers();
  });

  $('#cust-filter').addEventListener('input', renderCustomers);

  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-open-cust]');
    if (!b) return;
    var c = customers.filter(function (x) { return x.id === b.getAttribute('data-open-cust'); })[0];
    if (c) toast('Opened ' + c.name, null, 2200);
    $('#cust-count').setAttribute('data-last-opened', c ? c.id : '');
  });

  /* ---------------- section 3: invoices table ---------------- */
  function statusPill(s) {
    var mod = s === 'Paid' ? ' pill--paid' : s === 'Overdue' ? ' pill--overdue' : '';
    return '<span class="pill' + mod + '">' + esc(s) + '</span>';
  }

  function renderInvoices() {
    var rows = invoices.slice();
    if (sortKey) {
      rows.sort(function (a, b) {
        var av = a[sortKey], bv = b[sortKey];
        return (av < bv ? -1 : av > bv ? 1 : 0) * sortDir;
      });
    }
    $('#inv-body').innerHTML = rows.map(function (inv) {
      return '<tr class="tbl__row" data-inv="' + esc(inv.id) + '">' +
        '<td class="tbl__td"><span class="mono">' + esc(inv.id) + '</span></td>' +
        '<td class="tbl__td">' + esc(inv.customer) + '</td>' +
        '<td class="tbl__td">$' + esc(inv.amount.toFixed(2)) + '</td>' +
        '<td class="tbl__td" data-status>' + statusPill(inv.status) + '</td>' +
        '<td class="tbl__td"><div class="tbl__actions">' +
        '<button type="button" class="btn btn--sm" data-edit="' + esc(inv.id) + '">Edit</button>' +
        '<button type="button" class="btn btn--sm sv-3d91" data-paid="' + esc(inv.id) + '">Mark paid</button>' +
        '<button type="button" class="btn btn--sm btn--danger" data-del="' + esc(inv.id) + '">Delete</button>' +
        '</div></td></tr>';
    }).join('');
  }

  fetch('/api/invoices').then(function (r) { return r.json(); }).then(function (data) {
    invoices = data;
    renderInvoices();
  });

  document.querySelectorAll('.th-sort').forEach(function (b) {
    b.addEventListener('click', function () {
      var k = b.getAttribute('data-sort');
      if (sortKey === k) sortDir = -sortDir; else { sortKey = k; sortDir = 1; }
      renderInvoices();
    });
  });

  document.addEventListener('click', function (e) {
    var t = e.target.closest && e.target.closest('[data-edit],[data-del],[data-paid]');
    if (!t) return;
    if (t.hasAttribute('data-edit')) return openModal(t.getAttribute('data-edit'));
    if (t.hasAttribute('data-del')) {
      var id = t.getAttribute('data-del');
      $('#inv-log').textContent = 'Deleted ' + id;
      invoices = invoices.filter(function (x) { return x.id !== id; });
      renderInvoices();
      toast('Invoice ' + id + ' deleted', null, 2000);
      return;
    }
    // OPTIMISTIC UI: flip to Paid immediately, then a simulated request fails and reverts.
    var pid = t.getAttribute('data-paid');
    var inv = invoices.filter(function (x) { return x.id === pid; })[0];
    if (!inv) return;
    var prev = inv.status;
    inv.status = 'Paid';
    renderInvoices();
    $('#inv-log').textContent = 'Marking ' + pid + ' as paid...';
    fetch('/api/pay?id=' + encodeURIComponent(pid)).then(function (r) { return r.json(); })
      .then(function (res) {
        if (res.ok) {
          $('#inv-log').textContent = 'Paid ' + pid;
          toast('Invoice ' + pid + ' marked paid', null, 2000);
        } else {
          inv.status = prev;
          renderInvoices();
          $('#inv-log').textContent = 'Payment failed for ' + pid + ' - reverted to ' + prev;
          toast('Could not mark ' + pid + ' as paid', 'error', 3000);
        }
      });
  });

  /* ---------------- modal with focus trap ---------------- */
  var lastFocus = null;
  function focusables(root) {
    return Array.prototype.slice.call(
      root.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')
    ).filter(function (el) { return !el.disabled && el.offsetParent !== null; });
  }
  function openModal(id) {
    var inv = invoices.filter(function (x) { return x.id === id; })[0];
    lastFocus = document.activeElement;
    $('#modal-backdrop').hidden = false;
    $('#dlg-subject').textContent = inv ? inv.id + ' - ' + inv.customer : '-';
    $('#edit-modal').setAttribute('data-inv', id);
    $('#dlg-amount').value = inv ? inv.amount.toFixed(2) : '';
    setTimeout(function () { $('#dlg-amount').focus(); }, 0);
  }
  function closeModal() {
    $('#modal-backdrop').hidden = true;
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }
  $('#dlg-close').addEventListener('click', closeModal);
  $('#dlg-cancel').addEventListener('click', closeModal);
  $('#dlg-save').addEventListener('click', function () {
    var id = $('#edit-modal').getAttribute('data-inv');
    var inv = invoices.filter(function (x) { return x.id === id; })[0];
    var v = parseFloat($('#dlg-amount').value);
    if (inv && !isNaN(v)) { inv.amount = v; renderInvoices(); }
    $('#inv-log').textContent = 'Updated ' + id + ' to $' + (isNaN(v) ? '?' : v.toFixed(2));
    closeModal();
    toast('Invoice ' + id + ' updated', null, 2000);
  });
  // backdrop swallows clicks aimed at the page behind it, and does not close
  $('#modal-backdrop').addEventListener('click', function (e) {
    if (e.target === $('#modal-backdrop')) e.stopPropagation();
  });
  document.addEventListener('keydown', function (e) {
    if ($('#modal-backdrop').hidden) return;
    if (e.key === 'Escape') return closeModal();
    if (e.key !== 'Tab') return;
    var f = focusables($('#edit-modal'));
    if (!f.length) return;
    var first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });

  /* ---------------- section 4: form validation + inert submit ---------------- */
  var RULES = {
    name: function (v) { return v.trim() ? null : 'Customer name is required'; },
    email: function (v) {
      if (!v.trim()) return 'Email is required';
      return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.trim()) ? null : 'Enter a valid email address';
    },
    amount: function (v) {
      if (!v.trim()) return 'Amount is required';
      return /^\d+(\.\d{1,2})?$/.test(v.trim()) && parseFloat(v) > 0 ? null : 'Amount must be a positive number';
    }
  };
  function showErr(name, msg) {
    var p = document.querySelector('[data-err-for="' + name + '"]');
    var input = document.querySelector('#inv-form [name="' + name + '"]');
    if (msg) { p.textContent = msg; p.hidden = false; input.classList.add('is-invalid'); input.setAttribute('aria-invalid', 'true'); }
    else { p.textContent = ''; p.hidden = true; input.classList.remove('is-invalid'); input.removeAttribute('aria-invalid'); }
  }
  ['name', 'email', 'amount'].forEach(function (n) {
    var input = document.querySelector('#inv-form [name="' + n + '"]');
    input.addEventListener('blur', function () { showErr(n, RULES[n](input.value)); });
    input.addEventListener('input', function () { if (!input.classList.contains('is-invalid')) return; showErr(n, RULES[n](input.value)); });
  });
  $('#f-terms').addEventListener('change', function () {
    var btn = $('#inv-submit');
    if ($('#f-terms').checked) {
      btn.disabled = false; btn.classList.remove('is-inert');
      $('#submit-hint').textContent = 'Ready to submit.';
    } else {
      btn.disabled = true; btn.classList.add('is-inert');
      $('#submit-hint').textContent = 'Confirm the billing details to continue.';
    }
  });
  $('#inv-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var bad = 0;
    ['name', 'email', 'amount'].forEach(function (n) {
      var input = document.querySelector('#inv-form [name="' + n + '"]');
      var msg = RULES[n](input.value);
      if (msg) bad++;
      showErr(n, msg);
    });
    if (bad) { $('#submit-hint').textContent = bad + ' field(s) need attention.'; return; }
    var due = $('#f-due').value || '(none)';
    $('#submit-hint').textContent = 'Created invoice for ' + $('#f-name').value + ' due ' + due;
    toast('Invoice created', null, 2500);
  });

  /* ---------------- section 6: drag reorder ---------------- */
  var dragged = null;
  var queue = $('#queue');
  function syncOrder() {
    $('#queue-order').textContent = Array.prototype.map.call(
      queue.querySelectorAll('.dnd__item'), function (li) { return li.getAttribute('data-key'); }).join(',');
  }
  queue.addEventListener('dragstart', function (e) {
    dragged = e.target.closest('.dnd__item');
    if (dragged) { dragged.classList.add('is-dragging'); try { e.dataTransfer.setData('text/plain', dragged.getAttribute('data-key')); } catch (x) {} }
  });
  queue.addEventListener('dragover', function (e) { e.preventDefault(); });
  queue.addEventListener('drop', function (e) {
    e.preventDefault();
    var over = e.target.closest('.dnd__item');
    if (!dragged || !over || over === dragged) return;
    var items = Array.prototype.slice.call(queue.querySelectorAll('.dnd__item'));
    if (items.indexOf(dragged) < items.indexOf(over)) over.after(dragged); else over.before(dragged);
    syncOrder();
  });
  queue.addEventListener('dragend', function () {
    if (dragged) dragged.classList.remove('is-dragging');
    dragged = null;
    syncOrder();
  });

  /* ---------------- section 7: lazy load on scroll ---------------- */
  var loaded = false;
  var io = new IntersectionObserver(function (entries) {
    if (loaded || !entries.some(function (en) { return en.isIntersecting; })) return;
    loaded = true;
    var slot = $('#activity-slot');
    slot.setAttribute('data-state', 'loading');
    slot.innerHTML = '<div class="sk sk--line sk--md"></div><div class="sk sk--line sk--md"></div>';
    fetch('/api/activity').then(function (r) { return r.json(); }).then(function (items) {
      slot.innerHTML = '<ul class="lst">' + items.map(function (it) {
        return '<li class="lst__item"><div class="lst__body">' + esc(it.text) +
          '</div><span class="lst__meta">' + esc(it.when) + '</span></li>';
      }).join('') + '</ul>';
      slot.setAttribute('data-state', 'ready');
    });
  }, { rootMargin: '0px' });
  io.observe($('#lazy-sentinel'));

  /* ---------------- misc header ---------------- */
  $('[data-action="new-invoice"]').addEventListener('click', function () {
    $('#f-name').focus();
    toast('Fill in the new invoice form', null, 2000);
  });
  $('#theme-toggle').addEventListener('click', function () {
    document.body.classList.toggle('theme-dark');
  });

  /* ---------------- payment iframe bridge ---------------- */
  window.addEventListener('message', function (e) {
    if (e.data && e.data.type === 'card-saved') {
      $('#pay-result').textContent = 'Card ending ' + e.data.last4 + ' saved.';
    }
  });
})();

/* ---------------- shadow-dom date picker web component ---------------- */
class AcmeDatePicker extends HTMLElement {
  connectedCallback() {
    if (this._built) return;
    this._built = true;
    this._value = '';
    const root = this.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        :host{display:inline-block;position:relative;font:inherit}
        .field{display:flex;gap:6px;align-items:center}
        input{font:inherit;padding:7px 9px;border:1px solid #dfe3e8;border-radius:7px;width:150px}
        .pop{position:absolute;top:100%;left:0;z-index:10;background:#fff;border:1px solid #dfe3e8;
             border-radius:8px;padding:8px;box-shadow:0 8px 24px rgba(0,0,0,.12);display:none}
        .pop[data-open]{display:block}
        .day{width:34px;height:30px;border:1px solid #eceff3;background:#fff;border-radius:6px;cursor:pointer;font:inherit}
        .days{display:grid;grid-template-columns:repeat(7,34px);gap:3px}
      </style>
      <div class="field">
        <input part="input" id="dp-input" type="text" readonly placeholder="Pick a date" aria-label="Due date">
        <button type="button" id="dp-open" aria-label="Open calendar">&#128197;</button>
      </div>
      <div class="pop" id="dp-pop" role="dialog" aria-label="Choose a due date">
        <div class="days" id="dp-days"></div>
      </div>`;
    const days = root.getElementById('dp-days');
    for (let d = 1; d <= 28; d++) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'day';
      b.textContent = String(d);
      b.setAttribute('data-day', String(d));
      b.addEventListener('click', () => {
        this._value = '2026-04-' + String(d).padStart(2, '0');
        root.getElementById('dp-input').value = this._value;
        root.getElementById('dp-pop').removeAttribute('data-open');
        this.dispatchEvent(new CustomEvent('change', { detail: this._value, bubbles: true }));
      });
      days.appendChild(b);
    }
    root.getElementById('dp-open').addEventListener('click', () => {
      const p = root.getElementById('dp-pop');
      if (p.hasAttribute('data-open')) p.removeAttribute('data-open');
      else p.setAttribute('data-open', '');
    });
  }
  get value() { return this._value || ''; }
}
customElements.define('acme-datepicker', AcmeDatePicker);
