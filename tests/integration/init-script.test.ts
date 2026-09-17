import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'http'
import screenvision from '../../src/index'
import type { Browser } from '../../src/core/Browser'

/**
 * Init scripts run before the page's own code.
 *
 * The point is reaching code that runs at module scope, which `evaluate` is always too late
 * for: a page that reads a feature flag or stamps `Date.now()` on first paint cannot be
 * tested at all without this.
 */
const PORT = 9917

// reads its globals immediately, the way a bundled app does
const HTML = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<div id="flag"></div><div id="stamp"></div>
<script>
 document.getElementById('flag').textContent = window.__FEATURE__ || 'default'
 document.getElementById('stamp').textContent = String(Date.now())
</script></body></html>`

let server: http.Server
let browser: Browser

beforeAll(async () => {
  server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(HTML)
  })
  await new Promise<void>((r) => server.listen(PORT, r))
  browser = await screenvision.launch({ headless: true })
}, 60000)

afterAll(async () => {
  if (browser) await browser.close()
  if (server) server.close()
})

const URL_ = () => `http://127.0.0.1:${PORT}/`

describe('page.addInitScript', () => {
  it('sets a global the page reads at module scope', async () => {
    const ctx = await browser.newContext({ device: 'Desktop 1440x900' })
    const p = await ctx.newPage()
    await p.addInitScript(`window.__FEATURE__ = 'new-checkout'`)
    await p.goto(URL_())
    expect(await p.evaluate<string>(`document.getElementById('flag').textContent`)).toBe('new-checkout')
    await p.close()
  }, 60000)

  it('accepts a function with an argument', async () => {
    const ctx = await browser.newContext({ device: 'Desktop 1440x900' })
    const p = await ctx.newPage()
    await p.addInitScript((value) => {
      ;(window as unknown as Record<string, unknown>).__FEATURE__ = value
    }, 'from-function')
    await p.goto(URL_())
    expect(await p.evaluate<string>(`document.getElementById('flag').textContent`)).toBe('from-function')
    await p.close()
  }, 60000)

  it('can freeze the clock before the page reads it', async () => {
    const ctx = await browser.newContext({ device: 'Desktop 1440x900' })
    const p = await ctx.newPage()
    await p.addInitScript(`Date.now = () => 1700000000000`)
    await p.goto(URL_())
    expect(await p.evaluate<string>(`document.getElementById('stamp').textContent`)).toBe('1700000000000')
    await p.close()
  }, 60000)

  it('survives a navigation, and stops after removeInitScript', async () => {
    const ctx = await browser.newContext({ device: 'Desktop 1440x900' })
    const p = await ctx.newPage()
    const id = await p.addInitScript(`window.__FEATURE__ = 'sticky'`)
    await p.goto(URL_())
    await p.goto(URL_())
    expect(await p.evaluate<string>(`document.getElementById('flag').textContent`)).toBe('sticky')
    await p.removeInitScript(id)
    await p.goto(URL_())
    expect(await p.evaluate<string>(`document.getElementById('flag').textContent`)).toBe('default')
    await p.close()
  }, 60000)
})

describe('context.addInitScript', () => {
  it('applies to every page the context opens afterwards', async () => {
    const ctx = await browser.newContext({ device: 'Desktop 1440x900' })
    await ctx.addInitScript(`window.__FEATURE__ = 'context-wide'`)
    const a = await ctx.newPage()
    const b = await ctx.newPage()
    await a.goto(URL_())
    await b.goto(URL_())
    expect(await a.evaluate<string>(`document.getElementById('flag').textContent`)).toBe('context-wide')
    expect(await b.evaluate<string>(`document.getElementById('flag').textContent`)).toBe('context-wide')
    await a.close()
    await b.close()
  }, 60000)
})
