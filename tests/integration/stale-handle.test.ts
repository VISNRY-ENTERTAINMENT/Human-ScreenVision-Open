import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'http'
import screenvision from '../../src/index'
import type { Browser } from '../../src/core/Browser'

/**
 * Self-healing handles. A CDP nodeId dies when the element is re-created, which on a
 * React/Vue/Svelte page happens on every render. A handle must survive that by re-resolving
 * from the selector that produced it — otherwise every "find, wait, act" sequence against a
 * live app is a coin flip.
 */
const PORT = 9915
const HTML = `<!doctype html><html><head><meta charset="utf-8"></head><body>
 <nav data-testid="navbar" role="navigation"><a href="/a">A</a>
 <button id="rerender" aria-label="rerender">Re-render</button></nav>
 <section data-testid="hero"><h1>Hero</h1></section>
 <script>
  document.getElementById('rerender').addEventListener('click', () => {
    // the crude equivalent of a framework re-render: same markup, brand new nodes
    document.body.innerHTML = document.body.innerHTML
  })
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

async function open() {
  const ctx = await browser.newContext({ device: 'Desktop 1440x900' })
  const p = await ctx.newPage()
  await p.goto(`http://127.0.0.1:${PORT}/`)
  return p
}

describe('handles survive a re-render', () => {
  it('boundingBox() works after the DOM is replaced', async () => {
    const page = await open()
    const nav = await page.find('navigation bar')
    const before = await nav.boundingBox()
    expect(before).not.toBeNull()
    await page.evaluate('document.body.innerHTML = document.body.innerHTML')
    const after = await nav.boundingBox()
    expect(after).not.toBeNull()
    expect(after!.width).toBeCloseTo(before!.width, 0)
    await page.close()
  }, 60000)

  it('isVisible() and textContent() work after the DOM is replaced', async () => {
    const page = await open()
    const hero = await page.find('hero section')
    await page.evaluate('document.body.innerHTML = document.body.innerHTML')
    expect(await hero.isVisible()).toBe(true)
    expect(await hero.textContent()).toContain('Hero')
    await page.close()
  }, 60000)

  it('the nodeId actually changes (proving it re-resolved, not cached)', async () => {
    const page = await open()
    const nav = await page.find('navigation bar')
    const idBefore = nav.nodeId
    await page.evaluate('document.body.innerHTML = document.body.innerHTML')
    await nav.boundingBox()
    expect(nav.nodeId).not.toBe(idBefore)
    await page.close()
  }, 60000)

  it('gives a clear error when the element is genuinely gone', async () => {
    const page = await open()
    const hero = await page.find('hero section')
    await page.evaluate(`document.querySelector('[data-testid="hero"]').remove()`)
    await expect(hero.boundingBox()).rejects.toThrow(/no longer exists after the page changed/)
    await page.close()
  }, 60000)

  it('verify() still passes after a re-render', async () => {
    const page = await open()
    await page.find('navigation bar')
    await page.evaluate('document.body.innerHTML = document.body.innerHTML')
    const r = await page.verify({ contains: ['navigation bar', 'hero section'] })
    expect(r.issues.filter((i) => i.severity === 'error')).toHaveLength(0)
    await page.close()
  }, 60000)
})
