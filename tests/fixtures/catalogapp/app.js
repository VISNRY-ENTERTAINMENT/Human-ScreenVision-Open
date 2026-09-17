/* Parts catalog — search, filter, sort, paginate, select, basket.
 *
 * Chosen because the failure modes are compositional rather than local: filters combine,
 * paging interacts with filtering, the detail panel refers to a row that a later filter can
 * remove, and the basket persists across all of it. A plan that gets each step right
 * individually can still end up on the wrong page looking at the wrong part.
 */
(function () {
  'use strict';
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  var PAGE = 4;
  var parts = [];
  var cats = [];
  var page = 1;
  var selected = null;
  var basket = [];

  fetch('/api/parts').then(function (r) { return r.json(); }).then(function (d) {
    parts = d;
    render();
  });

  function filtered() {
    var q = $('#q').value.trim().toLowerCase();
    var stockOnly = $('#in-stock-only').checked;
    var out = parts.filter(function (p) {
      if (q && p.name.toLowerCase().indexOf(q) === -1 && p.sku.toLowerCase().indexOf(q) === -1) return false;
      if (cats.length && cats.indexOf(p.category) === -1) return false;
      if (stockOnly && p.stock <= 0) return false;
      return true;
    });
    var s = $('#sort').value;
    out.sort(function (a, b) {
      if (s === 'price-asc') return a.price - b.price;
      if (s === 'price-desc') return b.price - a.price;
      return a.name.localeCompare(b.name);
    });
    return out;
  }

  function render() {
    var rows = filtered();
    var pages = Math.max(1, Math.ceil(rows.length / PAGE));
    if (page > pages) page = pages;
    var slice = rows.slice((page - 1) * PAGE, page * PAGE);

    $('#results').innerHTML = slice.map(function (p) {
      return '<li class="card" data-sku="' + p.sku + '">' +
        '<h3 class="card__t">' + p.name + '</h3>' +
        '<p class="mono card__sku">' + p.sku + '</p>' +
        '<p class="card__price">$' + p.price.toFixed(2) + '</p>' +
        '<p class="card__stock">' + (p.stock > 0 ? p.stock + ' in stock' : 'Out of stock') + '</p>' +
        '<button type="button" class="btn btn--sm" data-view="' + p.sku + '">View</button>' +
        '</li>';
    }).join('');

    $('#result-meta').textContent = rows.length + ' of ' + parts.length + ' parts';
    $('#empty').hidden = rows.length !== 0;
    $('#pager').hidden = rows.length === 0;
    $('#page-label').textContent = 'Page ' + page + ' of ' + pages;
    $('#prev').disabled = page <= 1;
    $('#next').disabled = page >= pages;
    $$('.chip').forEach(function (c) {
      c.classList.toggle('chip--on', cats.indexOf(c.getAttribute('data-cat')) !== -1);
      c.setAttribute('aria-pressed', String(cats.indexOf(c.getAttribute('data-cat')) !== -1));
    });
    $('#cart-count').textContent = String(basket.length);
    $('#checkout').disabled = basket.length === 0;

    // the detail panel refers to a row that filtering may have removed
    if (selected && rows.filter(function (p) { return p.sku === selected; }).length === 0) {
      $('#detail').hidden = true;
      selected = null;
      $('#log').textContent = 'selection cleared by filter';
    }
  }

  $('#q').addEventListener('input', function () { page = 1; render(); });
  $('#sort').addEventListener('change', function () { page = 1; render(); });
  $('#in-stock-only').addEventListener('change', function () { page = 1; render(); });

  $('#chips').addEventListener('click', function (e) {
    var c = e.target.closest('.chip');
    if (!c) return;
    var cat = c.getAttribute('data-cat');
    var i = cats.indexOf(cat);
    if (i === -1) cats.push(cat); else cats.splice(i, 1);
    page = 1;
    render();
  });

  $('#clear-all').addEventListener('click', function () {
    $('#q').value = '';
    $('#in-stock-only').checked = false;
    cats = [];
    page = 1;
    render();
    $('#log').textContent = 'filters cleared';
  });

  $('#prev').addEventListener('click', function () { if (page > 1) { page--; render(); } });
  $('#next').addEventListener('click', function () { page++; render(); });

  // delegated: the cards are replaced on every render, so nothing can bind to them directly
  $('#results').addEventListener('click', function (e) {
    var b = e.target.closest('[data-view]');
    if (!b) return;
    var sku = b.getAttribute('data-view');
    var p = parts.filter(function (x) { return x.sku === sku; })[0];
    if (!p) return;
    selected = sku;
    $('#detail-name').textContent = p.name;
    $('#detail-sku').textContent = p.sku;
    $('#detail-price').textContent = '$' + p.price.toFixed(2);
    $('#detail-stock').textContent = p.stock > 0 ? p.stock + ' in stock' : 'Out of stock';
    $('#add-basket').disabled = p.stock <= 0;
    $('#detail').hidden = false;
    $('#log').textContent = 'viewing ' + sku;
  });

  $('#close-detail').addEventListener('click', function () {
    $('#detail').hidden = true;
    selected = null;
  });

  $('#add-basket').addEventListener('click', function () {
    if (!selected || $('#add-basket').disabled) return;
    if (basket.indexOf(selected) === -1) basket.push(selected);
    $('#log').textContent = 'added ' + selected + ' to basket';
    render();
  });

  $('#checkout').addEventListener('click', function () {
    if (!basket.length) return;
    $('#log').textContent = 'checked out ' + basket.length + ' item(s): ' + basket.join(', ');
    basket = [];
    render();
  });
})();
