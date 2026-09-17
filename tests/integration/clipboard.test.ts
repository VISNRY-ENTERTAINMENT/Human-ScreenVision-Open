import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'http'
import screenvision from '../../src/index'
import type { Browser } from '../../src/core/Browser'

/**
 * The OS clipboard — an affordance that lives past the browser, and one the DOM cannot describe.
 *
 * A "Copy" button that silently copied nothing, or the wrong thing, leaves the page looking
 * perfectly healthy: the button is there, it has an enabled state, no error fires. The only way
 * to prove the effect is to read the clipboard, which is the silent-wrong-answer class this
 * library closes, carried one step past the browser (G5).
 */
const PORT = 9947

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Clipboard</title></head><body>
<main>
 <button id="copy">Copy the value</button>
 <button id="copy-nothing">Broken copy</button>
 <input id="paste" aria-label="paste target">
 <script>
  document.getElementById('copy').addEventListener('click', () => {
    // the classic reliable copy that real apps ship: async API with an execCommand fallback,
    // because navigator.clipboard.writeText is restricted in many contexts (headless included)
    const text = 'the exported report id: R-4417'
    const fallback = () => {
      const ta = document.createElement('textarea')
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0'
      document.body.appendChild(ta); ta.focus(); ta.select()
      document.execCommand('copy'); ta.remove()
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(fallback)
    } else fallback()
  })
  // a copy button that does nothing -- the silent failure the DOM cannot see
  document.getElementById('copy-nothing').addEventListener('click', () => {})
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

describe('reading and writing the OS clipboard', () => {
  it('reads back exactly what a Copy button placed on the clipboard', async () => {
    const ctx = await browser.newContext({ device: 'Desktop 1440x900' })
    await ctx.grantPermissions(['clipboardReadWrite'])
    const p = await ctx.newPage()
    await p.goto(`http://127.0.0.1:${PORT}/`)
    // a page's own async writeText needs the tab focused, and it resolves a beat after the click
    await p.bringToFront()
    await p.click('#copy')
    let got = ''
    for (let i = 0; i < 20 && got !== 'the exported report id: R-4417'; i++) {
      got = await p.clipboardText()
      if (got !== 'the exported report id: R-4417') await new Promise((r) => setTimeout(r, 50))
    }
    expect(got).toBe('the exported report id: R-4417')
    await p.close()
  }, 60000)

  it('proves a broken Copy button did nothing to the clipboard', async () => {
    const ctx = await browser.newContext({ device: 'Desktop 1440x900' })
    await ctx.grantPermissions(['clipboardReadWrite'])
    const p = await ctx.newPage()
    await p.goto(`http://127.0.0.1:${PORT}/`)
    await p.setClipboardText('sentinel-before')
    await p.click('#copy-nothing')
    // the DOM shows a healthy button; only the clipboard reveals it copied nothing
    expect(await p.clipboardText()).toBe('sentinel-before')
    await p.close()
  }, 60000)

  it('round-trips text written from the driver, for driving a paste', async () => {
    const ctx = await browser.newContext({ device: 'Desktop 1440x900' })
    await ctx.grantPermissions(['clipboardReadWrite'])
    const p = await ctx.newPage()
    await p.goto(`http://127.0.0.1:${PORT}/`)
    await p.setClipboardText('pasted from the driver')
    expect(await p.clipboardText()).toBe('pasted from the driver')
    await p.close()
  }, 60000)

  it('fails loudly, not silently, when clipboard-read was never granted', async () => {
    const ctx = await browser.newContext({ device: 'Desktop 1440x900' })
    const p = await ctx.newPage()
    await p.goto(`http://127.0.0.1:${PORT}/`)
    // no grantPermissions: reading must throw with a reason, never return a misleading ''
    await expect(p.clipboardText()).rejects.toThrow(/clipboard/i)
    await p.close()
  }, 60000)
})
