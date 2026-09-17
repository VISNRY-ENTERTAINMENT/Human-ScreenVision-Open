/* Workspace settings — a settings screen that behaves like a real one.
 *
 * The patterns here are chosen because each is a place naive automation goes wrong:
 * a dirty-state guard that only enables Save once something actually changed; a checkbox
 * whose dependant is disabled until it is on; validation that blocks saving without saying so
 * anywhere near the button; tab panels that are present in the DOM but hidden; and a
 * destructive action behind a typed confirmation.
 */
(function () {
  'use strict';
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  var saved = null;
  var status = $('#status');

  function snapshot() {
    return JSON.stringify({
      name: $('#ws-name').value,
      tz: $('#tz').value,
      view: ($$('input[name="view"]').filter(function (r) { return r.checked; })[0] || {}).value,
      compact: $('#compact').checked,
      email: $('#n-email').checked,
      digest: $('#n-digest').checked,
      address: $('#n-address').value
    });
  }

  function validate() {
    var problems = [];
    var name = $('#ws-name').value.trim();
    var nameBad = name.length < 3;
    $('#err-ws-name').hidden = !nameBad;
    if (nameBad) problems.push('name');

    var addr = $('#n-address').value.trim();
    var addrBad = addr.length > 0 && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr);
    $('#err-n-address').hidden = !addrBad;
    if (addrBad) problems.push('address');
    return problems;
  }

  function refresh() {
    var dirty = snapshot() !== saved;
    var problems = validate();
    // Save is enabled only when something changed AND nothing is invalid. A plan that fills a
    // field and presses Save without noticing the error gets nothing, silently.
    $('#save').disabled = !dirty || problems.length > 0;
    $('#discard').disabled = !dirty;
    $('#dirty-flag').hidden = !dirty;

    // the dependant checkbox: off and disabled whenever its parent is off
    var email = $('#n-email');
    var digest = $('#n-digest');
    digest.disabled = !email.checked;
    if (!email.checked && digest.checked) digest.checked = false;
    $('#digest-hint').hidden = email.checked;
  }

  $$('input, select').forEach(function (el) {
    el.addEventListener('input', refresh);
    el.addEventListener('change', refresh);
  });

  $('#save').addEventListener('click', function () {
    if ($('#save').disabled) return;
    saved = snapshot();
    status.textContent = 'Saved ' + JSON.parse(saved).name + '.';
    refresh();
  });

  $('#discard').addEventListener('click', function () {
    var s = JSON.parse(saved);
    $('#ws-name').value = s.name;
    $('#tz').value = s.tz;
    $$('input[name="view"]').forEach(function (r) { r.checked = r.value === s.view; });
    $('#compact').checked = s.compact;
    $('#n-email').checked = s.email;
    $('#n-digest').checked = s.digest;
    $('#n-address').value = s.address;
    status.textContent = 'Discarded changes.';
    refresh();
  });

  /* tabs: panels exist in the DOM whether or not they are showing */
  $$('.tab').forEach(function (tab) {
    tab.addEventListener('click', function () {
      $$('.tab').forEach(function (t) {
        t.classList.toggle('tab--on', t === tab);
        t.setAttribute('aria-selected', String(t === tab));
      });
      $$('.panel').forEach(function (p) { p.hidden = p.id !== tab.getAttribute('data-panel'); });
      status.textContent = 'Showing ' + tab.textContent.trim() + '.';
    });
  });

  /* destructive action behind a typed confirmation */
  $('#delete-ws').addEventListener('click', function () {
    $('#confirm-backdrop').hidden = false;
    $('#confirm-word').value = '';
    $('#confirm-go').disabled = true;
  });
  $('#confirm-word').addEventListener('input', function () {
    $('#confirm-go').disabled = $('#confirm-word').value !== 'DELETE';
  });
  $('#confirm-cancel').addEventListener('click', function () {
    $('#confirm-backdrop').hidden = true;
    status.textContent = 'Deletion cancelled.';
  });
  $('#confirm-go').addEventListener('click', function () {
    if ($('#confirm-go').disabled) return;
    $('#confirm-backdrop').hidden = true;
    status.textContent = 'Workspace deleted.';
    $('#p-danger').setAttribute('data-deleted', 'yes');
  });

  saved = snapshot();
  refresh();
  status.textContent = 'Loaded.';
})();
