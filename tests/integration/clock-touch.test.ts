import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'http'
import screenvision from '../../src/index'
import type { Browser } from '../../src/core/Browser'

/**
 * Controlling time.
 *
 * Anything that waits is otherwise tested by actually waiting, which makes a suite slow and
 * flaky at once. The important part is that the clock is installed before the page's own
 * scripts run: an application that captures `Date.now` or `setInterval` at module scope keeps
 * the real ones if you install afterwards, and the test silently measures nothing.
 */
const PORT = 9966

const TOUCH_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Touch</title>
<meta name="viewport" content="width=device-width, initial-scale=1"></head><body>
<main>
 <button id="target" style="width:200px;height:60px">Tap me</button>
 <div id="log">none</div>
 <div id="swipe">no swipe</div>
</main>
<script>
 const t = document.getElementById('target')
 // binds touch only: a synthesised mouse click must not satisfy this
 t.addEventListener('touchstart', () => { document.getElementById('log').textContent = 'touched' })
 t.addEventListener('click', () => {
   const el = document.getElementById('log')
   if (el.textContent === 'none') el.textContent = 'clicked-only'
 })
 let startY = null
 document.addEventListener('touchstart', (e) => { startY = e.touches[0].clientY })
 document.addEventListener('touchend', () => { startY = null })
 document.addEventListener('touchmove', (e) => {
   if (startY !== null && startY - e.touches[0].clientY > 80) {
     document.getElementById('swipe').textContent = 'swiped up'
   }
 })
</script></body></html>`

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Clock</title>
<meta name="viewport" content="width=device-width, initial-scale=1"></head><body>
<main>
 <div id="started"></div>
 <div id="ticks">0</div>
 <div id="status">active</div>
 <div id="debounced">idle</div>
 <button id="poke" onclick="poke()">Poke</button>
</main>
<script>
 // captured at module scope, exactly as a real application does
 const startedAt = Date.now()
 document.getElementById('started').textContent = String(startedAt)

 let ticks = 0
 setInterval(() => { document.getElementById('ticks').textContent = String(++ticks) }, 1000)

 setTimeout(() => { document.getElementById('status').textContent = 'session expired' }, 30 * 60 * 1000)

 let debounce
 function poke() {
   clearTimeout(debounce)
   debounce = setTimeout(() => { document.getElementById('debounced').textContent = 'settled' }, 500)
 }
</script></body></html>`

let server: http.Server
let browser: Browser

beforeAll(async () => {
  server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end((req.url ?? '').includes('touch') ? TOUCH_PAGE : PAGE)
  })
  await new Promise<void>((r) => server.listen(PORT, r))
  browser = await screenvision.launch({ headless: true })
}, 60000)

afterAll(async () => {
  if (browser) await browser.close()
  if (server) server.close()
})

async function openWithClock(time?: string) {
  const ctx = await browser.newContext({ device: 'Desktop 1440x900' })
  const p = await ctx.newPage()
  await p.clock.install(time ? { time } : undefined)
  await p.goto(`http://127.0.0.1:${PORT}/`)
  return p
}

describe('the clock is in place before the page reads it', () => {
  it('fixes the time the page captures at module scope', async () => {
    const p = await openWithClock('2026-01-01T09:00:00Z')
    const started = await p.evaluate<string>(`document.getElementById('started').textContent`)
    expect(Number(started)).toBe(Date.parse('2026-01-01T09:00:00Z'))
    await p.close()
  }, 60000)

  it('reports the page time back', async () => {
    const p = await openWithClock('2026-01-01T09:00:00Z')
    expect(await p.clock.now()).toBe(Date.parse('2026-01-01T09:00:00Z'))
    await p.close()
  }, 60000)
})

describe('advancing time', () => {
  it('fires a timeout half an hour out, without waiting half an hour', async () => {
    const p = await openWithClock('2026-01-01T09:00:00Z')
    expect(await p.evaluate<string>(`document.getElementById('status').textContent`)).toBe('active')
    const started = Date.now()
    await p.clock.tick('31m')
    expect(await p.evaluate<string>(`document.getElementById('status').textContent`)).toBe('session expired')
    // the point of the exercise
    expect(Date.now() - started).toBeLessThan(5000)
    await p.close()
  }, 60000)

  it('runs an interval the number of times it really would', async () => {
    const p = await openWithClock('2026-01-01T09:00:00Z')
    await p.clock.runFor('10s', { stepMs: 500 })
    expect(await p.evaluate<string>(`document.getElementById('ticks').textContent`)).toBe('10')
    await p.close()
  }, 60000)

  it('jumps without firing what was scheduled in between', async () => {
    const p = await openWithClock('2026-01-01T09:00:00Z')
    await p.clock.setTime('2026-01-02T09:00:00Z')
    // a jump skips the intervals; the page's own counter has not moved
    expect(await p.evaluate<string>(`document.getElementById('ticks').textContent`)).toBe('0')
    expect(await p.clock.now()).toBe(Date.parse('2026-01-02T09:00:00Z'))
    await p.close()
  }, 60000)

  it('lets a debounce settle deterministically', async () => {
    const p = await openWithClock()
    await p.click('#poke')
    await p.click('#poke')
    expect(await p.evaluate<string>(`document.getElementById('debounced').textContent`)).toBe('idle')
    await p.clock.tick(600)
    expect(await p.evaluate<string>(`document.getElementById('debounced').textContent`)).toBe('settled')
    await p.close()
  }, 60000)
})

describe('the clock refuses to be used carelessly', () => {
  it('says so when it was never installed', async () => {
    const ctx = await browser.newContext({ device: 'Desktop 1440x900' })
    const p = await ctx.newPage()
    await p.goto(`http://127.0.0.1:${PORT}/`)
    await expect(p.clock.tick('1s')).rejects.toThrow(/the clock is not installed/)
    await p.close()
  }, 60000)

  it('rejects a duration it cannot parse', async () => {
    const p = await openWithClock()
    await expect(p.clock.tick('soon')).rejects.toThrow(/is not a duration/)
    await p.close()
  }, 60000)

  it('gives time back on uninstall', async () => {
    const p = await openWithClock('2026-01-01T09:00:00Z')
    await p.clock.uninstall()
    const now = await p.evaluate<number>(`Date.now()`)
    expect(now).toBeGreaterThan(Date.parse('2026-01-01T09:00:00Z'))
    await p.close()
  }, 60000)
})

describe('touch input', () => {
  it('taps, and the page sees a real touch rather than a click', async () => {
    const ctx = await browser.newContext({ device: 'iPhone 15' })
    const p = await ctx.newPage()
    await p.goto(`http://127.0.0.1:${PORT}/touch`)
    await p.getByRole('button', { name: 'Tap me' }).tap()
    expect(await p.evaluate<string>(`document.getElementById('log').textContent`)).toBe('touched')
    await ctx.close()
  }, 60000)

  it('swipes', async () => {
    const ctx = await browser.newContext({ device: 'iPhone 15' })
    const p = await ctx.newPage()
    await p.goto(`http://127.0.0.1:${PORT}/touch`)
    await p.touchscreen.swipe({ x: 180, y: 500 }, { x: 180, y: 200 })
    expect(await p.evaluate<string>(`document.getElementById('swipe').textContent`)).toBe('swiped up')
    await ctx.close()
  }, 60000)

  it('taps at coordinates', async () => {
    const ctx = await browser.newContext({ device: 'iPhone 15' })
    const p = await ctx.newPage()
    await p.goto(`http://127.0.0.1:${PORT}/touch`)
    const box = await (await p.$('#target'))!.boundingBox()
    await p.touchscreen.tap(box!.x + box!.width / 2, box!.y + box!.height / 2)
    expect(await p.evaluate<string>(`document.getElementById('log').textContent`)).toBe('touched')
    await ctx.close()
  }, 60000)
})
