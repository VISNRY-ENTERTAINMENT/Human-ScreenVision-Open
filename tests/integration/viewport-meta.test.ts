import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'http'
import screenvision from '../../src/index'
import type { Browser } from '../../src/core/Browser'

/**
 * Root-cause reporting: a page with no <meta name="viewport"> lays out at Chrome's
 * 980px wide-viewport fallback on a phone, so its mobile media queries never match.
 * The verifier must name that cause and mark the downstream symptoms as consequences.
 */
const CSS = `.links{display:flex;list-style:none}.ham{display:none;min-width:44px;min-height:44px}
@media (max-width:480px){.links{display:none}.ham{display:block}}`

function html(withMeta: boolean): string {
  return `<!doctype html><html><head><meta charset="utf-8">${
    withMeta ? '<meta name="viewport" content="width=device-width, initial-scale=1">' : ''
  }<style>${CSS}</style></head><body>
  <nav data-testid="navbar" role="navigation"><ul class="links"><li><a href="/a">A</a></li></ul>
  <button class="ham" aria-label="menu">&#9776;</button></nav>
  <section data-testid="hero"><h1>Hero</h1></section></body></html>`
}

const PORT = 9913
let server: http.Server
let browser: Browser

beforeAll(async () => {
  server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(html((req.url ?? '').startsWith('/meta')))
  })
  await new Promise<void>((r) => server.listen(PORT, r))
  browser = await screenvision.launch({ headless: true })
}, 60000)

afterAll(async () => {
  if (browser) await browser.close()
  if (server) server.close()
})

describe('viewport meta root-cause check', () => {
  it('reports the missing viewport meta tag as an error on a mobile device', async () => {
    const ctx = await browser.newContext({ device: 'iPhone 15' })
    const page = await ctx.newPage()
    await page.goto(`http://127.0.0.1:${PORT}/no-meta`)
    const result = await page.verify({ contains: ['navigation bar'] })
    const rootCause = result.issues.find((i) => i.element === 'viewport meta')
    expect(rootCause).toBeDefined()
    expect(rootCause!.severity).toBe('error')
    expect(rootCause!.message).toContain('980')
    await page.close()
  }, 60000)

  it('marks the missing hamburger as a consequence, not an independent defect', async () => {
    const ctx = await browser.newContext({ device: 'iPhone 15' })
    const page = await ctx.newPage()
    await page.goto(`http://127.0.0.1:${PORT}/no-meta`)
    const result = await page.verify({ contains: ['navigation bar'] })
    const ham = result.issues.find((i) => i.element === 'hamburger menu')
    expect(ham).toBeDefined()
    expect(ham!.severity).toBe('info')
    expect(ham!.message).toContain('consequence')
    await page.close()
  }, 60000)

  it('a page WITH the meta tag lays out at 390px and passes the mobile checks', async () => {
    const ctx = await browser.newContext({ device: 'iPhone 15' })
    const page = await ctx.newPage()
    await page.goto(`http://127.0.0.1:${PORT}/meta`)
    const width = await page.evaluate<number>('window.innerWidth')
    expect(width).toBe(390)
    const result = await page.verify({ contains: ['navigation bar'] })
    expect(result.issues.find((i) => i.element === 'viewport meta')).toBeUndefined()
    expect(result.issues.filter((i) => i.severity === 'error')).toHaveLength(0)
    await page.close()
  }, 60000)

  it('does not run the viewport-meta check on a desktop device', async () => {
    const ctx = await browser.newContext({ device: 'Desktop 1440x900' })
    const page = await ctx.newPage()
    await page.goto(`http://127.0.0.1:${PORT}/no-meta`)
    const result = await page.verify({ contains: ['navigation bar'] })
    expect(result.issues.find((i) => i.element === 'viewport meta')).toBeUndefined()
    await page.close()
  }, 60000)
})
