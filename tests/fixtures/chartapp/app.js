/* Sales report — a chart that draws into a canvas.
 *
 * The point of this fixture is that the DOM tells you almost nothing about whether it worked.
 * The canvas element is present, correctly sized and unchanged whether the chart drew or not,
 * so "generated the report" and "clicked the button and nothing happened" are indistinguishable
 * to observe(), ariaSnapshot() and any assertion over structure. Only the pixels differ.
 *
 * The Antarctica region deliberately has no data: the caption updates, the button reports
 * success, and the canvas stays blank. That is the real-world shape of a silent failure.
 */
(function () {
  'use strict';
  var $ = function (s) { return document.querySelector(s); };
  var DATA = { north: [4, 9, 6, 12, 8, 14, 11], south: [7, 5, 9, 4, 10, 6, 8], empty: [] };

  function clearCanvas() {
    var c = $('#sales-chart'), ctx = c.getContext('2d');
    ctx.clearRect(0, 0, c.width, c.height);
  }

  function draw(series) {
    var c = $('#sales-chart'), ctx = c.getContext('2d');
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    if (!series.length) return;            // no data: nothing is drawn, and nothing says so
    ctx.strokeStyle = '#333'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(40, 16); ctx.lineTo(40, 210); ctx.lineTo(400, 210); ctx.stroke();
    var max = Math.max.apply(null, series) || 1;
    ctx.fillStyle = '#2a5bd7';
    series.forEach(function (v, i) {
      var w = 34, x = 52 + i * 48, h = Math.round((v / max) * 170);
      ctx.fillRect(x, 210 - h, w, h);
    });
  }

  $('#region').addEventListener('change', function () {
    $('#generate').disabled = !$('#region').value;
  });

  $('#generate').addEventListener('click', function () {
    if ($('#generate').disabled) return;
    var r = $('#region').value;
    draw(DATA[r] || []);
    $('#chart-caption').textContent = 'Weekly sales for ' + r + '.';
    $('#log').textContent = 'generated ' + r;
  });

  $('#clear').addEventListener('click', function () {
    clearCanvas();
    $('#chart-caption').textContent = 'No chart yet.';
    $('#log').textContent = 'cleared';
  });
})();
