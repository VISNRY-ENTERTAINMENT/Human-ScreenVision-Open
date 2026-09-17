import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'http'
import screenvision from '../../src/index'
import type { Browser } from '../../src/core/Browser'

/**
 * Clicking waits for the element to be genuinely clickable, and says why when it never is.
 *
 * A bounding box existing is not the same as a click landing: the classic silent failure is
 * a click that lands on a modal backdrop that is still fading out, or on a button that has
 * moved since its box was measured. These cover visible, stable, enabled and receives-events,
 * plus the quality of the message when the wait times out.
 */
const PORT = 9916

const SHELL = (body: string, script = ''): string =>
  `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"></head><body>
<div id="log"></div>${body}
<script>
 function note(t) { document.getElementById('log').textContent = t }
 ${script}
</script></body></html>`

const PAGES: Record<string, string> = {
  // the button only becomes clickable once the overlay is removed, 400ms in
  '/late-overlay': SHELL(
    `<button id="go" onclick="note('clicked')">Go</button>
     <div id="veil" style="position:fixed;inset:0;background:rgba(0,0,0,.2);z-index:5"></div>`,
    `setTimeout(() => document.getElementById('veil').remove(), 400)`
  ),
  // the overlay never goes away: the wait must fail and name the blocker
  '/permanent-overlay': SHELL(
    `<button id="go" onclick="note('clicked')">Go</button>
     <div id="veil" style="position:fixed;inset:0;z-index:5"></div>`
  ),
  // the button is disabled for 400ms
  '/late-enable': SHELL(
    `<button id="go" disabled onclick="note('clicked')">Go</button>`,
    `setTimeout(() => document.getElementById('go').removeAttribute('disabled'), 400)`
  ),
  '/never-enabled': SHELL(`<button id="go" disabled onclick="note('clicked')">Go</button>`),
  // the button slides into place: clicking mid-animation would land on empty space
  '/animating': SHELL(
    `<button id="go" style="position:absolute;left:0;transition:left .4s" onclick="note('clicked')">Go</button>`,
    `requestAnimationFrame(() => { document.getElementById('go').style.left = '300px' })`
  ),
  '/hidden': SHELL(`<button id="go" style="display:none" onclick="note('clicked')">Go</button>`),
  '/zero-size': SHELL(
    `<button id="go" style="width:0;height:0;padding:0;border:0;overflow:hidden" onclick="note('clicked')">Go</button>`
  ),
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

async function log(p: Awaited<ReturnType<typeof open>>): Promise<string> {
  return p.evaluate<string>(`document.getElementById('log').textContent`)
}

describe('click waits for actionability', () => {
  it('waits out an overlay that is removed later, then clicks', async () => {
    const p = await open('/late-overlay')
    await p.click('#go', { timeout: 5000 })
    expect(await log(p)).toBe('clicked')
    await p.close()
  }, 60000)

  it('waits for a button to be enabled', async () => {
    const p = await open('/late-enable')
    await p.click('#go', { timeout: 5000 })
    expect(await log(p)).toBe('clicked')
    await p.close()
  }, 60000)

  it('waits for a moving button to settle before clicking it', async () => {
    const p = await open('/animating')
    await p.click('#go', { timeout: 5000 })
    expect(await log(p)).toBe('clicked')
    await p.close()
  }, 60000)
})

describe('the failure message names the cause', () => {
  it('names the element covering the target', async () => {
    const p = await open('/permanent-overlay')
    await expect(p.click('#go', { timeout: 1000 })).rejects.toThrow(/#veil is on top of it at the click point/)
    await p.close()
  }, 60000)

  it('reports a disabled button as disabled, not as invisible', async () => {
    const p = await open('/never-enabled')
    await expect(p.click('#go', { timeout: 1000 })).rejects.toThrow(/it is disabled/)
    await p.close()
  }, 60000)

  it('reports display:none as hidden', async () => {
    const p = await open('/hidden')
    await expect(p.click('#go', { timeout: 1000 })).rejects.toThrow(/display:none/)
    await p.close()
  }, 60000)

  it('reports a zero-size element with its measurements', async () => {
    const p = await open('/zero-size')
    await expect(p.click('#go', { timeout: 1000 })).rejects.toThrow(/it has no size \(0x0\)/)
    await p.close()
  }, 60000)

  it('suggests force as the escape hatch, and force actually clicks', async () => {
    const p = await open('/permanent-overlay')
    await expect(p.click('#go', { timeout: 1000 })).rejects.toThrow(/force: true/)
    await p.click('#go', { force: true })
    expect(await log(p)).toBe('clicked')
    await p.close()
  }, 60000)
})
