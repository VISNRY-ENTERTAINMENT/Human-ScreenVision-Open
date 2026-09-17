import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'http'
import screenvision from '../../src/index'
import type { Browser } from '../../src/core/Browser'

/**
 * Closed shadow DOM (GAP_AUDIT SV5) — the one differentiator raw Playwright cannot do. A closed
 * shadow root hides its content from `host.shadowRoot` and therefore from any query. With piercing
 * enabled before navigation, the closed root is forced open and its content becomes queryable.
 * Failure-first: the same content is unreachable WITHOUT piercing, proving the feature does the work.
 */
const PORT = 9934
const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<div id="host"></div>
<script>
  const r = document.getElementById('host').attachShadow({ mode: 'closed' });
  r.innerHTML = '<button id="inner">Inner</button>';
</script></body></html>`

let server: http.Server
let browser: Browser
beforeAll(async () => {
  server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(PAGE)
  })
  await new Promise<void>((r) => server.listen(PORT, r))
  browser = await screenvision.launch({ headless: true })
}, 60000)
afterAll(async () => {
  if (browser) await browser.close()
  if (server) server.close()
})

describe('closed shadow DOM piercing (SV5)', () => {
  it('closed root content is UNREACHABLE without piercing', async () => {
    const ctx = await browser.newContext({ device: 'Desktop 1440x900' })
    const p = await ctx.newPage()
    await p.goto(`http://127.0.0.1:${PORT}/`)
    // host.shadowRoot is null for a closed root, so the content cannot be counted
    expect(await p.locator('#inner').count()).toBe(0)
  })

  it('closed root content IS reachable after pierceClosedShadowRoots (before goto)', async () => {
    const ctx = await browser.newContext({ device: 'Desktop 1440x900' })
    const p = await ctx.newPage()
    await p.pierceClosedShadowRoots()
    await p.goto(`http://127.0.0.1:${PORT}/`)
    expect(await p.locator('#inner').count()).toBe(1)
    expect((await p.locator('#inner').innerText()).trim()).toBe('Inner')
  })
})
