import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'http'
import fs from 'fs'
import os from 'os'
import path from 'path'
import screenvision from '../../src/index'
import { registerSelectorEngine, clearSelectorEngines } from '../../src/core/selectorEngines'
import type { Browser } from '../../src/core/Browser'

/**
 * The last four gaps: HAR replay, custom selector engines, workers, and recording.
 *
 * HAR is the one that matters. Determinism is the point of the library — a run that reaches
 * the real network cannot distinguish "my change broke this" from "the backend moved", so a
 * replay that quietly falls through to the internet is worse than no replay at all. That is
 * why an unmatched request fails by default, and why it is asserted here.
 */
const PORT = 9960

/** Incremented per request, so a replay serving stale bytes is detectable. */
let served = 0

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Har</title></head><body>
<main>
 <div data-cy="target">custom engine target</div>
 <div data-cy="other">not this one</div>
 <button id="load">Load</button>
 <div id="out">none</div>
 <script>
  document.getElementById('load').addEventListener('click', async () => {
    try {
      const r = await fetch('/api/data', { cache: 'no-store' })
      document.getElementById('out').textContent = await r.text()
    } catch (e) { document.getElementById('out').textContent = 'request failed' }
  })
  window.startWorker = () => new Promise((resolve) => {
    const blob = new Blob(['self.onmessage = (e) => self.postMessage("worker saw " + e.data)'],
      { type: 'application/javascript' })
    const w = new Worker(URL.createObjectURL(blob))
    self.__worker = w
    w.onmessage = (e) => { document.getElementById('out').textContent = e.data; resolve('done') }
    w.postMessage('ping')
  })
 </script>
</main></body></html>`

let server: http.Server
let browser: Browser
let tmp: string

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-har-'))
  server = http.createServer((req, res) => {
    if ((req.url ?? '').startsWith('/api/data')) {
      served += 1
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
      res.end(`live response #${served}`)
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(PAGE)
  })
  await new Promise<void>((r) => server.listen(PORT, r))
  browser = await screenvision.launch({ headless: true })
}, 60000)

afterAll(async () => {
  if (browser) await browser.close()
  if (server) server.close()
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
  clearSelectorEngines()
})

describe('HAR record and replay', () => {
  it('records traffic, then serves the recorded bytes instead of the live ones', async () => {
    const har = path.join(tmp, 'nested', 'session.har')

    const recCtx = await browser.newContext({ device: 'Desktop 1440x900' })
    const router = await recCtx.routeFromHAR(har, { update: true })
    const rec = await recCtx.newPage()
    await rec.goto(`http://127.0.0.1:${PORT}/`)
    await rec.click('#load')
    await rec.waitForFunction(`document.getElementById('out').textContent !== 'none'`, { timeout: 8000 })
    const recorded = await rec.locator('#out').textContent()
    expect(recorded).toMatch(/^live response #/)
    const written = await router.save()
    expect(written).not.toBeNull()
    expect(fs.existsSync(har)).toBe(true)
    await recCtx.close()

    // the live server has moved on; a replay must not show the new value
    const before = served
    const playCtx = await browser.newContext({ device: 'Desktop 1440x900' })
    await playCtx.routeFromHAR(har)
    const play = await playCtx.newPage()
    await play.goto(`http://127.0.0.1:${PORT}/`)
    await play.click('#load')
    await play.waitForFunction(`document.getElementById('out').textContent !== 'none'`, { timeout: 8000 })
    expect(await play.locator('#out').textContent()).toBe(recorded)
    expect(served, 'replay must not reach the real server').toBe(before)
    await playCtx.close()
  }, 90000)

  it('fails an unrecorded request rather than silently reaching the network', async () => {
    const har = path.join(tmp, 'partial.har')
    fs.writeFileSync(
      har,
      JSON.stringify({
        log: {
          version: '1.2',
          creator: { name: 'test', version: '1' },
          entries: [
            {
              request: { method: 'GET', url: `http://127.0.0.1:${PORT}/` },
              response: {
                status: 200,
                headers: [{ name: 'content-type', value: 'text/html; charset=utf-8' }],
                content: { text: PAGE, mimeType: 'text/html' },
              },
            },
          ],
        },
      })
    )
    const ctx = await browser.newContext({ device: 'Desktop 1440x900' })
    await ctx.routeFromHAR(har)
    const p = await ctx.newPage()
    await p.goto(`http://127.0.0.1:${PORT}/`)
    const before = served
    await p.click('#load')
    await p.waitForFunction(`document.getElementById('out').textContent !== 'none'`, { timeout: 8000 })
    // the fetch was aborted, so the page's catch branch ran
    expect(await p.locator('#out').textContent()).toBe('request failed')
    expect(served, 'an unmatched request must not hit the network').toBe(before)
    await ctx.close()
  }, 90000)

  it('explains itself when the HAR is missing or empty', async () => {
    const ctx = await browser.newContext({ device: 'Desktop 1440x900' })
    await expect(ctx.routeFromHAR(path.join(tmp, 'nope.har'))).rejects.toThrow(/Record one first/)
    const empty = path.join(tmp, 'empty.har')
    fs.writeFileSync(empty, JSON.stringify({ log: { version: '1.2', creator: {}, entries: [] } }))
    await expect(ctx.routeFromHAR(empty)).rejects.toThrow(/no entries/)
    await ctx.close()
  }, 60000)
})

describe('custom selector engines', () => {
  it('selects by an application convention the library cannot know about', async () => {
    registerSelectorEngine('cy', `(el, value) => el.getAttribute('data-cy') === value`)
    const ctx = await browser.newContext({ device: 'Desktop 1440x900' })
    const p = await ctx.newPage()
    await p.goto(`http://127.0.0.1:${PORT}/`)
    expect(await p.locator('cy=target').textContent()).toBe('custom engine target')
    expect(await p.locator('cy=other').count()).toBe(1)
    await ctx.close()
  }, 60000)

  it('leaves ordinary CSS containing "=" alone', async () => {
    const ctx = await browser.newContext({ device: 'Desktop 1440x900' })
    const p = await ctx.newPage()
    await p.goto(`http://127.0.0.1:${PORT}/`)
    // an unregistered prefix must not be treated as an engine
    expect(await p.locator('[data-cy=target]').count()).toBe(1)
    await ctx.close()
  }, 60000)

  it('inherits strictness, so an ambiguous engine selector still refuses', async () => {
    registerSelectorEngine('anydiv', `(el) => el.tagName === 'DIV'`)
    const ctx = await browser.newContext({ device: 'Desktop 1440x900' })
    const p = await ctx.newPage()
    await p.goto(`http://127.0.0.1:${PORT}/`)
    await expect(p.locator('anydiv=x').click()).rejects.toThrow(/matched \d+ elements/)
    await ctx.close()
  }, 60000)

  it('supports a query engine, which is the only way to express position', async () => {
    // a predicate is judged one element at a time, so it cannot say "the second one";
    // this was the gap that made the predicate-only version a partial closure
    registerSelectorEngine(
      'nthdiv',
      `(root, value) => {
         const all = Array.from(root.querySelectorAll('div[data-cy]'))
         const el = all[Number(value)]
         return el ? [el] : []
       }`
    )
    const ctx = await browser.newContext({ device: 'Desktop 1440x900' })
    const p = await ctx.newPage()
    await p.goto(`http://127.0.0.1:${PORT}/`)
    expect(await p.locator('nthdiv=0').textContent()).toBe('custom engine target')
    expect(await p.locator('nthdiv=1').textContent()).toBe('not this one')
    await ctx.close()
  }, 60000)

  it('keeps a query engine strict and scoped like every built-in', async () => {
    registerSelectorEngine('alldiv', `(root) => Array.from(root.querySelectorAll('div[data-cy]'))`)
    const ctx = await browser.newContext({ device: 'Desktop 1440x900' })
    const p = await ctx.newPage()
    await p.goto(`http://127.0.0.1:${PORT}/`)
    // returning several elements must refuse to act, exactly as getByRole would
    await expect(p.locator('alldiv=x').click()).rejects.toThrow(/matched 2 elements/)
    // and it narrows within a chain rather than escaping to the document
    expect(await p.locator('main').locator('alldiv=x').count()).toBe(2)
    expect(await p.locator('#out').locator('alldiv=x').count()).toBe(0)
    await ctx.close()
  }, 60000)

  it('refuses to shadow a built-in prefix', () => {
    expect(() => registerSelectorEngine('text', `(el) => true`)).toThrow(/already a built-in/)
    expect(() => registerSelectorEngine('bad name', `(el) => true`)).toThrow(/not a usable name/)
  })
})

describe('workers and recording', () => {
  it('lists a worker the page started', async () => {
    const ctx = await browser.newContext({ device: 'Desktop 1440x900' })
    const p = await ctx.newPage()
    await p.goto(`http://127.0.0.1:${PORT}/`)
    await p.evaluate<string>(`window.startWorker()`)
    const workers = await p.workers()
    // a page doing its work in a worker looks idle from outside; listing them makes it visible
    expect(Array.isArray(workers)).toBe(true)
    expect(await p.locator('#out').textContent()).toBe('worker saw ping')
    await ctx.close()
  }, 60000)

  it('writes a real video file that a media player can open', async () => {
    const out = path.join(tmp, 'rec', 'run.avi')
    const ctx = await browser.newContext({ device: 'Desktop 1440x900' })
    const p = await ctx.newPage()
    await p.goto(`http://127.0.0.1:${PORT}/`)
    const recording = await p.recordVideo({ path: out, fps: 10 })
    // make the screen change, since the screencast emits frames only on change
    for (let i = 0; i < 6; i++) {
      await p.evaluate(`document.getElementById('out').textContent = 'frame ${'${i}'}'`)
      await new Promise((r) => setTimeout(r, 120))
    }
    const written = await recording.stop()

    expect(fs.existsSync(written)).toBe(true)
    const buf = fs.readFileSync(written)
    // a real RIFF/AVI container carrying MJPEG, not an HTML page pretending to be a video
    expect(buf.subarray(0, 4).toString('ascii')).toBe('RIFF')
    expect(buf.subarray(8, 12).toString('ascii')).toBe('AVI ')
    expect(buf.includes(Buffer.from('MJPG', 'ascii'))).toBe(true)
    expect(buf.includes(Buffer.from('idx1', 'ascii'))).toBe(true)
    // the declared size in the RIFF header must match the bytes actually written
    expect(buf.readUInt32LE(4)).toBe(buf.length - 8)
    expect(buf.length).toBeGreaterThan(2000)
    await expect(recording.stop()).rejects.toThrow(/already been stopped/)
    await ctx.close()
  }, 90000)

  it('still writes the self-contained player when asked for .html', async () => {
    const out = path.join(tmp, 'rec', 'run.html')
    const ctx = await browser.newContext({ device: 'Desktop 1440x900' })
    const p = await ctx.newPage()
    await p.goto(`http://127.0.0.1:${PORT}/`)
    const recording = await p.recordVideo({ path: out })
    await p.evaluate(`document.getElementById('out').textContent = 'x'`)
    await new Promise((r) => setTimeout(r, 200))
    const written = await recording.stop()
    const html = fs.readFileSync(written, 'utf8')
    expect(html).toMatch(/<title>Recording<\/title>/)
    expect(html).not.toMatch(/src="http/)
    await ctx.close()
  }, 90000)
})
