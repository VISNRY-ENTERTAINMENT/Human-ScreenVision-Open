import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'http'
import screenvision from '../../src/index'
import type { Browser } from '../../src/core/Browser'

/**
 * Pages the site opens for itself.
 *
 * An auditor found that `pages()` returned only what `newPage()` had created, so a
 * `target="_blank"` link or a `window.open` was invisible and an agent waiting on one hung
 * until its timeout. That rules out most authentication and payment flows, which is why this
 * was the top-ranked blocker.
 */
const PORT = 9963

const PAGES: Record<string, string> = {
  '/opener': `<!doctype html><html><head><meta charset="utf-8"><title>Opener</title></head><body>
<main>
 <a id="blank" href="/second" target="_blank">Open in a new tab</a>
 <button id="scripted" onclick="window.open('/second?scripted=1', '_blank')">Open by script</button>
</main></body></html>`,
  '/second': `<!doctype html><html><head><meta charset="utf-8"><title>Second</title></head><body>
<main><h1>Second page</h1><div id="code">A1B2C3</div></main></body></html>`,
}

let server: http.Server
let browser: Browser

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const body = PAGES[(req.url ?? '/').split('?')[0]]
    res.writeHead(body ? 200 : 404, { 'content-type': 'text/html' })
    res.end(body ?? '<h1>404</h1>')
  })
  await new Promise<void>((r) => server.listen(PORT, r))
  browser = await screenvision.launch({ headless: true })
}, 60000)

afterAll(async () => {
  if (browser) await browser.close()
  if (server) server.close()
})

describe('pages the site opens', () => {
  it('waits for a target=_blank tab and can drive it', async () => {
    const ctx = await browser.newContext({ device: 'Desktop 1440x900' })
    const page = await ctx.newPage()
    await page.goto(`http://127.0.0.1:${PORT}/opener`)

    const [popup] = await Promise.all([ctx.waitForPage({ timeout: 15000 }), page.click('#blank')])
    await popup.waitForSelector('#code', { timeout: 10000 })
    expect(await popup.title()).toBe('Second')
    // the reason this matters: reading something out of the second tab
    expect(await popup.evaluate<string>(`document.getElementById('code').textContent`)).toBe('A1B2C3')
    await ctx.close()
  }, 90000)

  it('waits for a window.open popup', async () => {
    const ctx = await browser.newContext({ device: 'Desktop 1440x900' })
    const page = await ctx.newPage()
    await page.goto(`http://127.0.0.1:${PORT}/opener`)
    const [popup] = await Promise.all([ctx.waitForPage({ timeout: 15000 }), page.click('#scripted')])
    await popup.waitForSelector('#code', { timeout: 10000 })
    expect(popup.url()).toContain('scripted=1')
    await ctx.close()
  }, 90000)

  it('lists the opened tab in pages() even without waiting for it', async () => {
    const ctx = await browser.newContext({ device: 'Desktop 1440x900' })
    const page = await ctx.newPage()
    await page.goto(`http://127.0.0.1:${PORT}/opener`)
    const before = (await ctx.pages()).length
    await page.click('#blank')
    await page.waitForTimeout(1200)
    const after = await ctx.pages()
    expect(after.length).toBe(before + 1)
    await ctx.close()
  }, 90000)

  it('says plainly when no page opens', async () => {
    const ctx = await browser.newContext({ device: 'Desktop 1440x900' })
    const page = await ctx.newPage()
    await page.goto(`http://127.0.0.1:${PORT}/opener`)
    await expect(ctx.waitForPage({ timeout: 1200 })).rejects.toThrow(/opened no new page/)
    await ctx.close()
  }, 60000)

  it('keeps one context’s tabs out of another’s', async () => {
    const a = await browser.newContext({ device: 'Desktop 1440x900' })
    const b = await browser.newContext({ device: 'Desktop 1440x900' })
    const pageA = await a.newPage()
    await pageA.goto(`http://127.0.0.1:${PORT}/opener`)
    await pageA.click('#blank')
    await pageA.waitForTimeout(1200)
    expect((await a.pages()).length).toBe(2)
    expect((await b.pages()).length).toBe(0)
    await a.close()
    await b.close()
  }, 90000)
})
