import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'http'
import screenvision from '../../src/index'
import type { Browser } from '../../src/core/Browser'

/**
 * New auto-retrying matchers (GAP_AUDIT #2) and Locator reads. Failure-first: each asserts a real
 * page state a no-op would get wrong, and the negative case where noted.
 */
const PORT = 9933
const SHELL = (body: string): string =>
  `<!doctype html><html><head><meta charset="utf-8"></head><body>${body}</body></html>`

const PAGES: Record<string, string> = {
  '/roles': SHELL(`<button id="b">Save</button><a id="lnk" href="/x">Home</a><input id="cb" type="checkbox">`),
  '/accname': SHELL(`<button id="b" aria-label="Close dialog">x</button><label for="e">Email</label><input id="e"><span id="lbl">Preferred Name</span><input id="both" aria-labelledby="lbl" aria-label="ignored"><article id="art">a</article>`),
  '/select': SHELL(`<select id="s" multiple><option value="a" selected>A</option><option value="b" selected>B</option><option value="c">C</option></select>`),
  '/jsprop': SHELL(`<input id="i" value="hi">`),
  '/viewport': SHELL(`<div id="on" style="width:50px;height:20px">on</div><div id="off" style="position:absolute;top:5000px">off</div>`),
  '/reads': SHELL(`<div id="d" style="text-transform:uppercase">hello</div><input id="ed"><input id="ro" readonly>`),
  '/aria': SHELL(`<nav><ul><li>One</li><li>Two</li></ul></nav>`),
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

describe('new matchers (audit gap #2)', () => {
  it('toHaveRole: explicit and implicit roles, and rejects a wrong one', async () => {
    const p = await open('/roles')
    await p.expect(p.locator('#b')).toHaveRole('button')
    await p.expect(p.locator('#lnk')).toHaveRole('link')
    await p.expect(p.locator('#cb')).toHaveRole('checkbox')
    await p.expect(p.locator('#b')).not.toHaveRole('link')
  })

  it('toHaveAccessibleName: aria-label and associated <label>', async () => {
    const p = await open('/accname')
    await p.expect(p.locator('#b')).toHaveAccessibleName('Close dialog')
    await p.expect(p.locator('#e')).toHaveAccessibleName('Email')
    // aria-labelledby must win over aria-label (WAI-ARIA precedence)
    await p.expect(p.locator('#both')).toHaveAccessibleName('Preferred Name')
  })

  it('toHaveRole agrees with getByRole for implicit roles (shared table)', async () => {
    const p = await open('/accname')
    await p.expect(p.locator('#art')).toHaveRole('article')
    // getByRole uses the same implicit-role table, so it must find the same element
    expect(await p.getByRole('article').count()).toBe(1)
  })

  it('toHaveValues: multi-select selected values', async () => {
    const p = await open('/select')
    await p.expect(p.locator('#s')).toHaveValues(['a', 'b'])
    await p.expect(p.locator('#s')).not.toHaveValues(['a', 'b', 'c'])
  })

  it('toHaveJSProperty: reads a live JS property', async () => {
    const p = await open('/jsprop')
    await p.expect(p.locator('#i')).toHaveJSProperty('value', 'hi')
  })

  it('toBeInViewport: in vs out of the viewport', async () => {
    const p = await open('/viewport')
    await p.expect(p.locator('#on')).toBeInViewport()
    await p.expect(p.locator('#off')).not.toBeInViewport()
  })

  it('toBeAttached: present vs absent', async () => {
    const p = await open('/roles')
    await p.expect(p.locator('#b')).toBeAttached()
    await p.expect(p.locator('#nope')).not.toBeAttached({ timeout: 800 })
  })

  it('toMatchAriaSnapshot: containment of expected lines', async () => {
    const p = await open('/aria')
    await p.expect(p.locator('nav')).toMatchAriaSnapshot('list')
  })
})

describe('Locator reads', () => {
  it('innerText respects rendering (uppercase), isEditable distinguishes readonly, evaluate runs', async () => {
    const p = await open('/reads')
    expect((await p.locator('#d').innerText()).trim()).toBe('HELLO')
    expect(await p.locator('#ed').isEditable()).toBe(true)
    expect(await p.locator('#ro').isEditable()).toBe(false)
    expect(await p.locator('#d').evaluate((el) => el.tagName.toLowerCase())).toBe('div')
  })
})
