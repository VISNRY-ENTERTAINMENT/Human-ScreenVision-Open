import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'http'
import screenvision from '../../src/index'
import { describeCanvas } from '../../src/capture/CanvasProbe'
import type { Browser } from '../../src/core/Browser'

/**
 * The DOM's one genuine blind spot.
 *
 * A chart that silently failed to draw is a `<canvas>` with a healthy element, the right
 * dimensions and no console error. `observe()` sees an empty box, `ariaSnapshot()` sees
 * nothing, and the page reads as fine — which is a silent wrong answer, the failure class this
 * library exists to eliminate.
 *
 * These tests are mostly about the distinctions the measure has to preserve. "Blank" must not
 * be confused with "unreadable"; "drew the axes and no data" must not be confused with "drew
 * everything". A single similarity score would collapse all of those, which is why the probe
 * reports regions and a reason rather than one number.
 */
const PORT = 9944

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Charts</title></head><body>
<main>
 <canvas id="blank" width="300" height="200"></canvas>
 <canvas id="filled-uniform" width="300" height="200"></canvas>
 <canvas id="chart" width="300" height="200"></canvas>
 <canvas id="axes-only" width="300" height="200"></canvas>
 <canvas id="zero-size" width="0" height="0"></canvas>
 <canvas id="webgl" width="200" height="200"></canvas>
 <canvas id="webgl-blank" width="200" height="200"></canvas>
 <div id="not-a-canvas">text</div>
 <button id="draw">Draw the series</button>
 <script>
  const g = (id) => document.getElementById(id).getContext('2d')

  // A WebGL canvas has no 2d context, so the old probe called it unreadable -- the real blind
  // spot. It is now read by copying the composited surface with drawImage. Two scissored clears
  // make a two-colour split, which must register as content. preserveDrawingBuffer keeps the
  // copy deterministic in the test; the probe still flags the read as possibly-cleared because
  // it cannot know that flag was set.
  const gl = document.getElementById('webgl').getContext('webgl', { preserveDrawingBuffer: true })
  if (gl) {
    gl.enable(gl.SCISSOR_TEST)
    gl.scissor(0, 0, 100, 200); gl.clearColor(0.1, 0.2, 0.85, 1); gl.clear(gl.COLOR_BUFFER_BIT)
    gl.scissor(100, 0, 100, 200); gl.clearColor(0.9, 0.35, 0.1, 1); gl.clear(gl.COLOR_BUFFER_BIT)
  }
  // a WebGL canvas that never drew: must read as blank-or-unreadable, not confident-blank
  document.getElementById('webgl-blank').getContext('webgl', { preserveDrawingBuffer: true })

  // a canvas that has been filled with one colour is still "nothing was drawn": uniform means
  // no structure, and an agent looking for a chart must not be told there is one
  const u = g('filled-uniform'); u.fillStyle = '#3355aa'; u.fillRect(0, 0, 300, 200)

  function axes(ctx) {
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 300, 200)
    ctx.strokeStyle = '#333'; ctx.lineWidth = 2
    ctx.beginPath(); ctx.moveTo(30, 10); ctx.lineTo(30, 180); ctx.lineTo(290, 180); ctx.stroke()
  }
  function series(ctx) {
    ctx.strokeStyle = '#c33'; ctx.lineWidth = 3; ctx.beginPath()
    for (let i = 0; i <= 20; i++) {
      const x = 30 + i * 13, y = 100 - Math.sin(i / 2) * 60
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)
    }
    ctx.stroke()
  }
  axes(g('axes-only'))
  axes(g('chart')); series(g('chart'))

  document.getElementById('draw').addEventListener('click', () => {
    const ctx = g('blank'); axes(ctx); series(ctx)
  })
 </script>
</main></body></html>`

let server: http.Server
let browser: Browser

beforeAll(async () => {
  server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(PAGE)
  })
  await new Promise<void>((r) => server.listen(PORT, r))
  browser = await screenvision.launch({ headless: true })
}, 60000)

afterAll(async () => {
  if (browser) await browser.close()
  if (server) server.close()
})

async function open() {
  const ctx = await browser.newContext({ device: 'Desktop 1440x900' })
  const p = await ctx.newPage()
  await p.goto(`http://127.0.0.1:${PORT}/`)
  return p
}

describe('the question the DOM cannot answer', () => {
  it('reports an untouched canvas as blank', async () => {
    const p = await open()
    const c = await p.canvasContent('#blank')
    expect(c.readable).toBe(true)
    expect(c.width).toBe(300)
    expect(c.energy).toBe(0)
    await p.close()
  }, 60000)

  it('still calls a uniformly filled canvas blank', async () => {
    const p = await open()
    // filled is not drawn: an agent looking for a chart must not be told one is there
    const c = await p.canvasContent('#filled-uniform')
    expect(c.readable).toBe(true)
    expect(c.energy).toBe(0)
    await p.close()
  }, 60000)

  it('reports a drawn chart as having content', async () => {
    const p = await open()
    const c = await p.canvasContent('#chart')
    expect(c.energy).toBeGreaterThan(0.5)
    expect(c.inkCoverage).toBeGreaterThan(0)
    await p.close()
  }, 60000)

  it('sees the canvas that the DOM says is identical', async () => {
    const p = await open()
    // blank and chart are the same element type, same size, same attributes. Nothing in the
    // DOM distinguishes them; only the pixels do.
    const blank = await p.canvasContent('#blank')
    const chart = await p.canvasContent('#chart')
    const sameInDom = await p.evaluate<boolean>(
      `(() => { const a = document.querySelector('#blank'), b = document.querySelector('#chart')
        return a.tagName === b.tagName && a.width === b.width && a.height === b.height })()`
    )
    expect(sameInDom).toBe(true)
    expect(blank.energy).toBe(0)
    expect(chart.energy).toBeGreaterThan(0.5)
    await p.close()
  }, 60000)
})

describe('it distinguishes partly drawn from fully drawn', () => {
  it('locates content by region, so axes-without-series is visible', async () => {
    const p = await open()
    const axesOnly = await p.canvasContent('#axes-only')
    const full = await p.canvasContent('#chart')
    const lit = (c: typeof full) => c.quadrants.filter((q) => q.energy > 0.5).length
    // both have ink; the chart has it spread across more of the surface
    expect(axesOnly.energy).toBeGreaterThan(0)
    expect(lit(full)).toBeGreaterThan(lit(axesOnly))
    await p.close()
  }, 60000)

  it('notices a canvas that fills in after an action', async () => {
    const p = await open()
    expect((await p.canvasContent('#blank')).energy).toBe(0)
    await p.click('#draw')
    expect((await p.canvasContent('#blank')).energy).toBeGreaterThan(0.5)
    await p.close()
  }, 60000)
})

describe('unreadable is not the same as blank', () => {
  it('says why when the selector matches nothing', async () => {
    const p = await open()
    const c = await p.canvasContent('#nope')
    expect(c.readable).toBe(false)
    expect(c.reason).toMatch(/no element matches/)
    await p.close()
  }, 60000)

  it('says why when the element is not a canvas', async () => {
    const p = await open()
    const c = await p.canvasContent('#not-a-canvas')
    expect(c.readable).toBe(false)
    expect(c.reason).toMatch(/not a canvas/)
    await p.close()
  }, 60000)

  it('says why when the canvas has no drawing surface', async () => {
    const p = await open()
    const c = await p.canvasContent('#zero-size')
    expect(c.readable).toBe(false)
    expect(c.reason).toMatch(/no drawing surface/)
    await p.close()
  }, 60000)
})

describe('beyond a 2D canvas: WebGL, the old blind spot', () => {
  it('reads a WebGL canvas the 2D probe could not, and flags the copy as best-effort', async () => {
    const p = await open()
    const c = await p.canvasContent('#webgl')
    expect(c.readable).toBe(true)
    expect(c.kind).toBe('canvas')
    expect(c.source).toBe('drawImage')
    // it drew: two colours split down the middle is real content, not an empty box
    expect(c.energy).toBeGreaterThan(0)
    // honesty: a WebGL copy can be silently cleared, so a zero here is never a confident blank
    expect(c.bufferMayBeCleared).toBe(true)
    await p.close()
  }, 60000)

  it('will not call a blank WebGL surface a confident blank', async () => {
    const p = await open()
    const c = await p.canvasContent('#webgl-blank')
    const line = describeCanvas('#webgl-blank', c, 0.5)
    // must NOT assert "is blank / nothing was drawn"; must say blank-or-unreadable
    expect(line).not.toMatch(/nothing was drawn on it/)
    expect(line).toMatch(/blank or unreadable|cleared drawing buffer/)
    await p.close()
  }, 60000)
})

describe('what it tells the caller', () => {
  it('names the element and the fact, not a bare number', async () => {
    const p = await open()
    const blank = describeCanvas('#blank', await p.canvasContent('#blank'), 0.5)
    const chart = describeCanvas('#chart', await p.canvasContent('#chart'), 0.5)
    // "visual delta 0.07" is an unearned number; this has to be actionable on its own
    expect(blank).toMatch(/#blank is blank/)
    expect(blank).toMatch(/nothing was drawn on it/)
    expect(chart).toMatch(/#chart has content/)
    expect(chart).toMatch(/regions/)
    await p.close()
  }, 60000)
})
