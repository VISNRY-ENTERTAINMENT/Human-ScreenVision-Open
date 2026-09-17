import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'http'
import screenvision from '../../src/index'
import type { Browser } from '../../src/core/Browser'

/**
 * The exact cases an AI agent failed on when it drove this library through realistic tasks.
 *
 * Each of these was a case where the library reported success it had not earned, or could
 * not answer a question the agent had to answer to finish its task. They are kept as a suite
 * because this class of bug is invisible to ordinary testing: everything passes, and the
 * caller is simply told the wrong thing.
 */
const PORT = 9947

const PAGES: Record<string, string> = {
  // markup with ordinary ids that say nothing about what the controls do
  '/login': `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"></head><body>
<main>
 <h2>Welcome back</h2>
 <div id="f-name" class="field"><label for="user">Username</label><input id="user"></div>
 <div id="f-pass" class="field"><label for="pw">Password</label><input id="pw" type="password"></div>
 <button id="submit">Sign in</button>
 <button id="export">Export CSV</button>
 <button id="archive">Archive selected</button>
</main></body></html>`,

  // a plain table, the thing the agent could not name at all
  '/grid': `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"></head><body>
<main><table id="grid">
 <thead><tr><th>ID</th><th>Service</th><th>Status</th></tr></thead>
 <tbody>
  <tr><td>D-1</td><td>search</td><td>failed</td></tr>
  <tr><td>D-2</td><td>api</td><td>ok</td></tr>
 </tbody></table></main></body></html>`,

  // a page whose viewport meta is present but hostile
  '/fixed-width': `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=1200">
<style>.buy{width:564px}#buy{position:absolute;left:2000px}</style></head><body>
<nav role="navigation"><a href="/a">Features</a></nav>
<main><h1>Product</h1><div class="buy"><button id="buy">Add to cart</button></div></main>
</body></html>`,
}

let server: http.Server
let browser: Browser

beforeAll(async () => {
  server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(PAGES[(req.url ?? '/login').split('?')[0]] ?? PAGES['/login'])
  })
  await new Promise<void>((r) => server.listen(PORT, r))
  browser = await screenvision.launch({ headless: true })
}, 60000)

afterAll(async () => {
  if (browser) await browser.close()
  if (server) server.close()
})

async function open(route: string, device = 'Desktop 1440x900') {
  const ctx = await browser.newContext({ device })
  const p = await ctx.newPage()
  await p.goto(`http://127.0.0.1:${PORT}${route}`)
  return p
}

describe('find matches what a control says, not just what it is called', () => {
  it('finds a button by its visible text when the id says nothing', async () => {
    const p = await open('/login')
    const el = await p.find('sign in button')
    expect(await el.getAttribute('id')).toBe('submit')
    await p.close()
  }, 60000)

  it('prefers the label over an id that happens to contain the word', async () => {
    const p = await open('/login')
    const candidates = await p.findCandidates('Export CSV')
    expect(candidates[0].name).toBe('Export CSV')
    expect(candidates[0].why).toMatch(/name/)
    await p.close()
  }, 60000)

  it('shows the runners-up instead of silently picking one', async () => {
    const p = await open('/login')
    const candidates = await p.findCandidates('button')
    const names = candidates.map((c) => c.name)
    expect(names).toContain('Sign in')
    expect(names).toContain('Export CSV')
    expect(names).toContain('Archive selected')
    await p.close()
  }, 60000)

  it('finds a plain table and its rows', async () => {
    const p = await open('/grid')
    const table = await p.find('table')
    expect(await table.getAttribute('id')).toBe('grid')
    const rows = await p.findCandidates('row', { limit: 20 })
    expect(rows.filter((r) => r.role === 'row').length).toBeGreaterThanOrEqual(3)
    await p.close()
  }, 60000)

  it('does not hand back a div when asked for a button', async () => {
    const p = await open('/login')
    const candidates = await p.findCandidates('sign in button')
    expect(candidates[0].role).toBe('button')
    await p.close()
  }, 60000)
})

describe('fill refuses a control it cannot fill', () => {
  it('throws on a div and names the input inside it', async () => {
    const p = await open('/login')
    await expect(p.fill('#f-name', 'Dana')).rejects.toThrow(/not a fillable control/)
    await expect(p.fill('#f-name', 'Dana')).rejects.toThrow(/input#user/)
    await p.close()
  }, 60000)

  it('throws on a button rather than silently doing nothing', async () => {
    const p = await open('/login')
    await expect(p.fill('#submit', 'Dana')).rejects.toThrow(/not a fillable control/)
    await p.close()
  }, 60000)

  it('still fills a real input', async () => {
    const p = await open('/login')
    await p.fill('#user', 'Dana')
    expect(await p.evaluate<string>(`document.getElementById('user').value`)).toBe('Dana')
    await p.close()
  }, 60000)
})

describe('visibility tells the truth about where an element is', () => {
  it('reports an element off the side of a phone viewport as not in the viewport', async () => {
    const p = await open('/fixed-width', 'iPhone 15')
    const buy = await p.$('#buy')
    const v = await buy!.visibility()
    expect(v.rendered).toBe(true)
    // isVisible answers "does the browser render it", which is true and useless here
    expect(await buy!.isVisible()).toBe(true)
    expect(v.inViewport).not.toBe('full')
    await p.close()
  }, 60000)

  it('names what covers an element', async () => {
    const p = await open('/login')
    await p.evaluate(`(() => {
      const d = document.createElement('div')
      d.id = 'veil'; d.style.cssText = 'position:fixed;inset:0;z-index:9'
      document.body.appendChild(d)
    })()`)
    const submit = await p.$('#submit')
    const v = await submit!.visibility()
    expect(v.occludedBy).toContain('#veil')
    await p.close()
  }, 60000)
})

describe('verify separates a failure from a check that never ran', () => {
  it('marks an unresolvable target as could-not-run, not as a failure', async () => {
    const p = await open('/login')
    const r = await p.verify({ structure: [{ element: 'quantum flux capacitor', links: 3 }] })
    expect(r.incomplete).toBe(true)
    expect(r.checks.some((c) => c.status === 'could-not-run')).toBe(true)
    expect(r.checks.some((c) => c.status === 'fail')).toBe(false)
    await p.close()
  }, 60000)

  it('marks a genuine regression as a failure', async () => {
    const p = await open('/grid')
    const r = await p.verify({ structure: [{ element: 'table', selector: 'tr', count: 99 }] })
    expect(r.incomplete).toBe(false)
    expect(r.checks.some((c) => c.status === 'fail')).toBe(true)
    await p.close()
  }, 60000)

  it('does not attach a screenshot buffer unless asked', async () => {
    const p = await open('/login')
    const r = await p.verify({ contains: ['purple elephant'], timeout: 800 })
    expect(r.screenshotBuffer).toBeUndefined()
    await p.close()
  }, 60000)
})

describe('page.on refuses an event it will never deliver', () => {
  it('throws and lists what is supported', async () => {
    const p = await open('/login')
    // 'response' used to be accepted silently and never fire; it is now genuinely delivered,
    // so this checks an event that really is unsupported
    expect(() => p.on('websocket' as never, () => undefined)).toThrow(/not a supported event/)
    expect(() => p.on('websocket' as never, () => undefined)).toThrow(/response/)
    await p.close()
  }, 60000)

  it('now actually delivers the network events it advertises', async () => {
    const p = await open('/login')
    const seen: string[] = []
    p.on('response', (r) => seen.push(String(r.status)))
    await p.goto(`http://127.0.0.1:${PORT}/grid`)
    await p.waitForTimeout(500)
    expect(seen.length).toBeGreaterThan(0)
    await p.close()
  }, 60000)
})
