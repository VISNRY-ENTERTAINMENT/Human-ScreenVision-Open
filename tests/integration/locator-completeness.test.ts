import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'http'
import screenvision from '../../src/index'
import type { Browser } from '../../src/core/Browser'

/**
 * Locator action/read completeness (GAP_AUDIT_2026-09-17 #1). These methods delegate to
 * ElementHandle, but the point of a Locator is that they exist ON the locator so an agent never
 * has to resolve a handle by hand. Each assertion is failure-first: it would still pass if the
 * method silently did nothing only where noted, and is written so a no-op fails it.
 */
const PORT = 9931

const SHELL = (body: string, script = ''): string =>
  `<!doctype html><html><head><meta charset="utf-8"></head><body>
<div id="log"></div>${body}
<script>function note(t){document.getElementById('log').textContent=t}${script}</script></body></html>`

const PAGES: Record<string, string> = {
  // dblclick must fire the dblclick handler, not just click. onclick writes 'single' first;
  // ondblclick writes 'DBL' last. A single click would leave 'single' -> the assert fails.
  '/dbl': SHELL(`<button id="b" onclick="note('single')" ondblclick="note('DBL')">x</button>`),
  '/clear': SHELL(`<input id="i" value="hello">`),
  '/check': SHELL(`<input id="on" type="checkbox" checked><input id="off" type="checkbox">`),
  '/box': SHELL(`<div id="d" style="width:120px;height:40px">box</div>`),
  '/html': SHELL(`<div id="d"><b>hi</b></div>`),
}

let server: http.Server
let browser: Browser
beforeAll(async () => {
  server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(PAGES[(req.url ?? '/').split('?')[0]] ?? SHELL('<p>none</p>'))
  })
  await new Promise<void>((r) => server.listen(PORT, r))
  browser = await screenvision.launch({ headless: true })
}, 60000)
afterAll(async () => {
  if (browser) await browser.close()
  if (server) server.close()
})
async function open(pathname: string) {
  const ctx = await browser.newContext({ device: 'Desktop 1440x900' })
  const p = await ctx.newPage()
  await p.goto(`http://127.0.0.1:${PORT}${pathname}`)
  return p
}

describe('Locator completeness (audit gap #1)', () => {
  it('dblclick fires the dblclick handler, not a single click', async () => {
    const p = await open('/dbl')
    await p.locator('#b').dblclick()
    expect(await p.evaluate<string>(`document.getElementById('log').textContent`)).toBe('DBL')
  })

  it('clear empties an input that had a value', async () => {
    const p = await open('/clear')
    expect(await p.locator('#i').inputValue()).toBe('hello')
    await p.locator('#i').clear()
    expect(await p.locator('#i').inputValue()).toBe('')
  })

  it('isChecked reflects the real checkbox state', async () => {
    const p = await open('/check')
    expect(await p.locator('#on').isChecked()).toBe(true)
    expect(await p.locator('#off').isChecked()).toBe(false)
  })

  it('boundingBox returns the element geometry', async () => {
    const p = await open('/box')
    const box = await p.locator('#d').boundingBox()
    expect(box).not.toBeNull()
    expect(box!.width).toBeGreaterThan(100)
    expect(box!.height).toBeGreaterThan(30)
  })

  it('innerHTML returns the element markup', async () => {
    const p = await open('/html')
    expect(await p.locator('#d').innerHTML()).toContain('<b>hi</b>')
  })
})
