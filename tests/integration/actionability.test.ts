import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'http'
import screenvision from '../../src/index'
import type { Browser } from '../../src/core/Browser'

/**
 * Actionability and structure checks (added after the defect-corpus audit).
 * These cover the four defect classes the first corpus run missed: an element that is
 * present but collapsed, present but off-canvas, present but covered, and present but
 * structurally wrong (the "nav should have 3 links; it has 2" case from the architecture doc).
 */
const PORT = 9914

function page(body: string, style = ''): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><style>
 .navbar{display:flex;gap:16px;padding:16px}
 .hero{padding:40px}
 ${style}</style></head><body>${body}</body></html>`
}

const PAGES: Record<string, string> = {
  '/ok': page(`<nav data-testid="navbar" class="navbar" role="navigation">
      <a href="/a">A</a><a href="/b">B</a><a href="/c">C</a>
      <button aria-label="login">Login</button></nav>
    <section data-testid="hero" class="hero"><h1>Hero</h1>
      <button data-testid="hero-cta">Get Started</button></section>`),
  '/two-links': page(`<nav data-testid="navbar" class="navbar" role="navigation">
      <a href="/a">A</a><a href="/b">B</a>
      <button aria-label="login">Login</button></nav>
    <section data-testid="hero" class="hero"><h1>Hero</h1></section>`),
  '/collapsed': page(`<nav data-testid="navbar" class="navbar" role="navigation"><a href="/a">A</a></nav>
    <section data-testid="hero" class="hero" style="height:0;padding:0;overflow:hidden"><h1>Hero</h1></section>`),
  '/offcanvas': page(`<nav data-testid="navbar" class="navbar" role="navigation"><a href="/a">A</a></nav>
    <section data-testid="hero" class="hero"><h1>Hero</h1>
      <button data-testid="hero-cta" style="position:absolute;left:-9999px">Get Started</button></section>`),
  '/covered': page(`<nav data-testid="navbar" class="navbar" role="navigation"><a href="/a">A</a></nav>
    <section data-testid="hero" class="hero"><h1>Hero</h1></section>
    <div id="overlay" style="position:fixed;inset:0;z-index:99"></div>`),
}

let server: http.Server
let browser: Browser

beforeAll(async () => {
  server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(PAGES[(req.url ?? '/ok').split('?')[0]] ?? PAGES['/ok'])
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

describe('structure expectations', () => {
  it('reports the exact count when a nav link is missing', async () => {
    const p = await open('/two-links')
    const r = await p.verify({ structure: [{ element: 'navigation bar', links: 3 }] })
    expect(r.pass).toBe(false)
    expect(r.issues[0].message).toContain('should have 3 links; it has 2')
    expect(r.issues[0].expected).toBe('3 links')
    expect(r.issues[0].actual).toBe('2')
    await p.close()
  }, 60000)

  it('passes when the counts match, and checks buttons and text too', async () => {
    const p = await open('/ok')
    const r = await p.verify({
      structure: [
        { element: 'navigation bar', links: 3, buttons: 1 },
        { element: 'hero section', headings: 1, buttons: 1, text: 'Hero' },
      ],
    })
    expect(r.issues.filter((i) => i.severity === 'error')).toHaveLength(0)
    expect(r.pass).toBe(true)
    await p.close()
  }, 60000)

  it('normalizes whitespace in the text check (regression: \\s escape in a template literal)', async () => {
    const p = await open('/ok')
    const r = await p.verify({ structure: [{ element: 'hero section', text: 'Get Started' }] })
    expect(r.issues.filter((i) => i.severity === 'error')).toHaveLength(0)
    const bad = await p.verify({ structure: [{ element: 'hero section', text: 'Not Present' }] })
    // the reported actual text must still contain its letter s
    expect(bad.issues[0].actual).toContain('Started')
    await p.close()
  }, 60000)
})

describe('actionability', () => {
  it('flags an element that is present but collapsed to zero height', async () => {
    const p = await open('/collapsed')
    const r = await p.verify({ contains: ['hero section'] })
    expect(r.pass).toBe(false)
    expect(r.issues.some((i) => /not visible/.test(i.message))).toBe(true)
    await p.close()
  }, 60000)

  it('flags an element parked off the page canvas', async () => {
    const p = await open('/offcanvas')
    const r = await p.verify({ contains: ['hero cta'] })
    expect(r.pass).toBe(false)
    expect(r.issues.some((i) => /outside the page canvas/.test(i.message))).toBe(true)
    await p.close()
  }, 60000)

  it('flags an element covered by an overlay, naming the covering element', async () => {
    const p = await open('/covered')
    const r = await p.verify({ contains: ['navigation bar'] })
    expect(r.pass).toBe(false)
    const covered = r.issues.find((i) => /covered by/.test(i.message))
    expect(covered).toBeDefined()
    expect(covered!.message).toContain('#overlay')
    await p.close()
  }, 60000)

  it('does not flag a healthy page', async () => {
    const p = await open('/ok')
    const r = await p.verify({ contains: ['navigation bar', 'hero section'] })
    expect(r.issues.filter((i) => i.severity === 'error')).toHaveLength(0)
    await p.close()
  }, 60000)
})

describe('resolver precision', () => {
  it('resolves a specific phrase to the element, not its container', async () => {
    const p = await open('/ok')
    const cta = await p.find('hero cta')
    const testid = await cta.getAttribute('data-testid')
    expect(testid).toBe('hero-cta')
    await p.close()
  }, 60000)
})
