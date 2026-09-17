import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'http'
import screenvision from '../../src/index'
import type { Browser } from '../../src/core/Browser'

/**
 * Standalone Page methods added for Playwright parity (GAP_AUDIT_2026-09-17 #3-8):
 * dblclick, mouse.wheel, setViewportSize, pdf, emulateMedia, waitForURL. Each assertion is
 * failure-first: a no-op implementation fails it.
 */
const PORT = 9932
const SHELL = (body: string, script = ''): string =>
  `<!doctype html><html><head><meta charset="utf-8"></head><body>
<div id="log"></div>${body}
<script>function note(t){document.getElementById('log').textContent=String(t)}${script}</script></body></html>`

const PAGES: Record<string, string> = {
  '/dbl': SHELL(`<button id="b" onclick="note('single')" ondblclick="note('DBL')">x</button>`),
  '/wheel': SHELL(`<div style="height:3000px">tall</div>`, `window.addEventListener('wheel',e=>note(e.deltaY),{passive:true})`),
  '/vp': SHELL(`<p>vp</p>`),
  '/media': SHELL(`<p>m</p>`),
  '/pushes': SHELL(`<p>go</p>`, `setTimeout(()=>history.pushState({},'','/done'),150)`),
  '/pdf': SHELL(`<h1>pdf me</h1>`),
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

describe('Page methods (audit gaps #3-8)', () => {
  it('dblclick fires the dblclick handler', async () => {
    const p = await open('/dbl')
    await p.dblclick('#b')
    expect(await p.evaluate<string>(`document.getElementById('log').textContent`)).toBe('DBL')
  })

  it('mouse.wheel dispatches a real wheel event with the delta', async () => {
    const p = await open('/wheel')
    await p.mouse.move(200, 200)
    await p.mouse.wheel(0, 120)
    await new Promise((r) => setTimeout(r, 200)) // the JS wheel handler fires just after the CDP call resolves
    expect(await p.evaluate<string>(`document.getElementById('log').textContent`)).toBe('120')
  })

  it('setViewportSize resizes the viewport mid-session', async () => {
    const p = await open('/vp')
    await p.setViewportSize({ width: 500, height: 400 })
    expect(await p.evaluate<number>(`window.innerWidth`)).toBe(500)
  })

  it('emulateMedia switches the color scheme', async () => {
    const p = await open('/media')
    await p.emulateMedia({ colorScheme: 'dark' })
    expect(await p.evaluate<boolean>(`matchMedia('(prefers-color-scheme: dark)').matches`)).toBe(true)
  })

  it('waitForURL resolves once the URL matches (RegExp)', async () => {
    const p = await open('/pushes')
    await p.waitForURL(/\/done$/, { timeout: 5000 })
    expect(await p.evaluate<string>(`location.pathname`)).toBe('/done')
  })

  it('pdf returns real PDF bytes (headless)', async () => {
    const p = await open('/pdf')
    const buf = await p.pdf()
    expect(buf.length).toBeGreaterThan(500)
    expect(buf.toString('latin1', 0, 5)).toBe('%PDF-')
  })
})
