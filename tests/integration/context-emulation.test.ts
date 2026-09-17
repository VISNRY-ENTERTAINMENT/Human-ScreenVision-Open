import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'http'
import screenvision from '../../src/index'
import type { Browser } from '../../src/core/Browser'

/**
 * Permissions, geolocation and the offline branch.
 *
 * These are the states an agent driving a real application actually meets: a permission
 * prompt it cannot click, a location it has to pretend to be at, and a network that drops.
 * The prompt case matters most — a modal is unanswerable in an automated run, so the grant
 * has to be possible at the moment the decision is made rather than only at context creation.
 */
const PORT = 9964

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Where</title></head><body>
<main>
 <button id="locate">Locate me</button>
 <div id="out">none</div>
 <div id="net">unknown</div>
 <script>
  document.getElementById('locate').addEventListener('click', () => {
    navigator.geolocation.getCurrentPosition(
      (pos) => { document.getElementById('out').textContent = pos.coords.latitude.toFixed(3) + ',' + pos.coords.longitude.toFixed(3) },
      (err) => { document.getElementById('out').textContent = 'error ' + err.code }
    )
  })
  window.probe = async (url) => {
    try { const r = await fetch(url, { cache: 'no-store' }); return 'ok ' + r.status }
    catch (e) { return 'failed' }
  }
 </script>
</main></body></html>`

let server: http.Server
let browser: Browser

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if ((req.url ?? '').startsWith('/ping')) {
      res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' })
      res.end('pong')
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
})

describe('geolocation can be set after the context exists', () => {
  it('reports the position that was set, once permission is granted', async () => {
    const ctx = await browser.newContext({ device: 'Desktop 1440x900' })
    const p = await ctx.newPage()
    await p.goto(`http://127.0.0.1:${PORT}/`)

    await ctx.grantPermissions(['geolocation'], { origin: `http://127.0.0.1:${PORT}` })
    await ctx.setGeolocation({ latitude: 51.507, longitude: -0.128 })

    await p.click('#locate')
    await p.waitForFunction(`document.getElementById('out').textContent !== 'none'`, { timeout: 5000 })
    expect(await p.locator('#out').textContent()).toBe('51.507,-0.128')
    await ctx.close()
  }, 60000)

  it('applies to a page opened after the location was set', async () => {
    const ctx = await browser.newContext({ device: 'Desktop 1440x900' })
    await ctx.grantPermissions(['geolocation'], { origin: `http://127.0.0.1:${PORT}` })
    await ctx.setGeolocation({ latitude: 40.713, longitude: -74.006 })

    // opened afterwards: emulation that silently stops applying to the next tab is worse
    // than emulation that never worked, because it fails only sometimes
    const later = await ctx.newPage()
    await later.goto(`http://127.0.0.1:${PORT}/`)
    await later.click('#locate')
    await later.waitForFunction(`document.getElementById('out').textContent !== 'none'`, { timeout: 5000 })
    expect(await later.locator('#out').textContent()).toBe('40.713,-74.006')
    await ctx.close()
  }, 60000)

  it('refuses coordinates that are not on the globe', async () => {
    const ctx = await browser.newContext({ device: 'Desktop 1440x900' })
    await expect(ctx.setGeolocation({ latitude: 145, longitude: 0 })).rejects.toThrow(/within ±90/)
    await ctx.close()
  }, 60000)

  it('clears the override when set to null', async () => {
    const ctx = await browser.newContext({ device: 'Desktop 1440x900' })
    const p = await ctx.newPage()
    await p.goto(`http://127.0.0.1:${PORT}/`)
    await ctx.grantPermissions(['geolocation'], { origin: `http://127.0.0.1:${PORT}` })
    await ctx.setGeolocation({ latitude: 10, longitude: 10 })
    await ctx.setGeolocation(null)
    await p.click('#locate')
    // Headless Chrome has no location provider, so with the override gone the callback may
    // never fire at all. Either outcome is correct; continuing to report 10,10 is not.
    await p
      .waitForFunction(`document.getElementById('out').textContent !== 'none'`, { timeout: 4000 })
      .catch(() => undefined)
    expect(await p.locator('#out').textContent()).not.toBe('10.000,10.000')
    await ctx.close()
  }, 60000)
})

describe('permissions gate the API rather than being assumed', () => {
  it('reports a permission error when geolocation was never granted', async () => {
    const ctx = await browser.newContext({ device: 'Desktop 1440x900' })
    const p = await ctx.newPage()
    await p.goto(`http://127.0.0.1:${PORT}/`)
    await ctx.setGeolocation({ latitude: 51.5, longitude: -0.1 })
    await p.click('#locate')
    // PERMISSION_DENIED (error 1) is the loud failure. On some headless builds (e.g. Chromium on
    // Linux) the geolocation callback never fires at all and 'out' stays 'none' -- the same tolerance
    // the granted-but-no-fix test above already documents. Both are correct; the ONLY wrong outcome
    // is silently returning a plausible-looking position when permission was denied.
    await p.waitForFunction(`document.getElementById('out').textContent !== 'none'`, { timeout: 8000 }).catch(() => undefined)
    const out = await p.locator('#out').textContent()
    expect(out === 'error 1' || out === 'none').toBe(true)
    expect(out).not.toMatch(/^-?\d+\.\d+,-?\d+\.\d+$/)
    await ctx.close()
  }, 60000)

  it('clearPermissions revokes a grant', async () => {
    const ctx = await browser.newContext({ device: 'Desktop 1440x900' })
    const p = await ctx.newPage()
    await p.goto(`http://127.0.0.1:${PORT}/`)
    await ctx.grantPermissions(['geolocation'], { origin: `http://127.0.0.1:${PORT}` })
    await ctx.clearPermissions()
    await ctx.setGeolocation({ latitude: 51.5, longitude: -0.1 })
    await p.click('#locate')
    // After a revoke, same rule: 'error 1' or a callback that never fires ('none') are both correct;
    // a returned position would mean the revoke did nothing.
    await p.waitForFunction(`document.getElementById('out').textContent !== 'none'`, { timeout: 8000 }).catch(() => undefined)
    const out = await p.locator('#out').textContent()
    expect(out === 'error 1' || out === 'none').toBe(true)
    expect(out).not.toMatch(/^-?\d+\.\d+,-?\d+\.\d+$/)
    await ctx.close()
  }, 60000)
})

describe('the offline branch', () => {
  it('fails requests while offline and recovers afterwards', async () => {
    const ctx = await browser.newContext({ device: 'Desktop 1440x900' })
    const p = await ctx.newPage()
    await p.goto(`http://127.0.0.1:${PORT}/`)

    expect(await p.evaluate<string>(`window.probe('/ping?a')`)).toMatch(/^ok /)

    await ctx.setOffline(true)
    expect(await p.evaluate<boolean>(`navigator.onLine`)).toBe(false)
    expect(await p.evaluate<string>(`window.probe('/ping?b')`)).toBe('failed')

    await ctx.setOffline(false)
    expect(await p.evaluate<string>(`window.probe('/ping?c')`)).toMatch(/^ok /)
    await ctx.close()
  }, 60000)

  it('applies to a page opened while the context is offline', async () => {
    const ctx = await browser.newContext({ device: 'Desktop 1440x900' })
    await ctx.setOffline(true)
    const later = await ctx.newPage()
    expect(await later.evaluate<boolean>(`navigator.onLine`)).toBe(false)
    await ctx.close()
  }, 60000)
})
