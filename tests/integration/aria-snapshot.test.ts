import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'http'
import screenvision from '../../src/index'
import type { Browser } from '../../src/core/Browser'

/**
 * The accessibility tree as text: the representation an agent should be reading.
 *
 * What matters here is not that a snapshot is produced, but that it is *faithful* and
 * *actionable* — every line has to name something `getByRole` can then find, presentational
 * markup has to disappear, and state that changes whether an action will work (disabled,
 * checked, inert) has to be visible. A snapshot that flatters the page is worse than none,
 * because it makes the model confident.
 */
const PORT = 9966

const PAGES: Record<string, string> = {
  '/app': `<!doctype html><html><head><meta charset="utf-8"><title>App</title></head><body>
<header><h1>Invoices</h1></header>
<nav aria-label="Main"><a href="/a">Home</a><a href="/b">Reports</a></nav>
<main>
  <div class="wrapper"><div class="row"><div class="cell">
    <label for="q">Search</label><input id="q" value="draft">
  </div></div></div>
  <fieldset>
    <legend>Filters</legend>
    <input type="checkbox" id="paid" checked><label for="paid">Paid</label>
    <button disabled>Archive</button>
    <button>Apply</button>
  </fieldset>
  <ul><li>First</li><li>Second</li></ul>
  <img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="">
  <img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="Company logo">
  <div aria-hidden="true"><button>Invisible to AT</button></div>
  <button style="pointer-events:none">Looks clickable</button>
</main>
<footer><p>Contact us</p></footer>
</body></html>`,

  '/component': `<!doctype html><html><head><meta charset="utf-8"><title>Component</title></head><body>
<main>
  <section aria-label="Billing"><h2>Billing</h2><button>Save billing</button></section>
  <section aria-label="Shipping"><h2>Shipping</h2><button>Save shipping</button></section>
</main></body></html>`,
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

async function open(route: string) {
  const ctx = await browser.newContext({ device: 'Desktop 1440x900' })
  const p = await ctx.newPage()
  await p.goto(`http://127.0.0.1:${PORT}${route}`)
  return p
}

describe('ariaSnapshot describes the page the way a screen reader would', () => {
  it('names landmarks, headings with level, and controls', async () => {
    const p = await open('/app')
    const snap = await p.ariaSnapshot()
    expect(snap).toMatch(/- banner:/)
    expect(snap).toMatch(/- heading "Invoices" \[level=1\]/)
    expect(snap).toMatch(/- navigation "Main":/)
    expect(snap).toMatch(/- main:/)
    expect(snap).toMatch(/- contentinfo:/)
    expect(snap).toMatch(/- link "Home"/)
    await p.close()
  }, 60000)

  it('collapses presentational wrappers instead of spending a line on each', async () => {
    const p = await open('/app')
    const snap = await p.ariaSnapshot()
    // three nested layout divs sit between main and the search box
    expect(snap).not.toMatch(/generic/)
    expect(snap).toMatch(/- textbox "Search"/)
    await p.close()
  }, 60000)

  it('reports state that decides whether an action will do anything', async () => {
    const p = await open('/app')
    const snap = await p.ariaSnapshot()
    expect(snap).toMatch(/- button "Archive" \[disabled\]/)
    expect(snap).toMatch(/- checkbox[^\n]*\[checked\]/)
    expect(snap).toMatch(/- textbox "Search" \[value="draft"\]/)
    await p.close()
  }, 60000)

  it('marks a control that is present but cannot be interacted with', async () => {
    const p = await open('/app')
    const snap = await p.ariaSnapshot()
    // the difference between "not there" and "there but inert" is the one an agent
    // most often gets wrong: it clicks, sees nothing, and blames the page
    expect(snap).toMatch(/- button "Looks clickable" \[no-pointer-events\]/)
    await p.close()
  }, 60000)

  it('omits what is hidden from assistive technology, and can be asked to include it', async () => {
    const p = await open('/app')
    expect(await p.ariaSnapshot()).not.toMatch(/Invisible to AT/)
    expect(await p.ariaSnapshot({ includeHidden: true })).toMatch(/Invisible to AT/)
    await p.close()
  }, 60000)

  it('drops a decorative image and keeps a described one', async () => {
    const p = await open('/app')
    const snap = await p.ariaSnapshot()
    expect(snap).toMatch(/- img "Company logo"/)
    expect((snap.match(/- img/g) ?? []).length).toBe(1)
    await p.close()
  }, 60000)

  it('nests lists as a reader would hear them, keeping the item text', async () => {
    const p = await open('/app')
    const snap = await p.ariaSnapshot()
    expect(snap).toMatch(/- list:\n\s+- listitem/)
    // a leaf role that takes no name from its content still has to report that content;
    // printing a bare "- listitem" loses everything the item said
    expect(snap).toMatch(/- listitem: First/)
    expect(snap).toMatch(/- listitem: Second/)
    expect(snap).toMatch(/- paragraph: Contact us/)
    await p.close()
  }, 60000)

  it('announces a label once, through the control it names', async () => {
    const p = await open('/app')
    const snap = await p.ariaSnapshot()
    // "Search" is the textbox's accessible name; emitting the <label> as its own line makes
    // every labelled field appear twice and invites the model to act on the label
    expect((snap.match(/Search/g) ?? []).length).toBe(1)
    expect((snap.match(/Paid/g) ?? []).length).toBe(1)
    await p.close()
  }, 60000)
})

describe('a snapshot names things that can then be acted on', () => {
  it('every role/name pair in the snapshot resolves with getByRole', async () => {
    const p = await open('/app')
    const snap = await p.ariaSnapshot()
    const pairs = [...snap.matchAll(/- (button|link|textbox|checkbox) "([^"]+)"/g)]
    expect(pairs.length).toBeGreaterThan(3)
    for (const [, role, name] of pairs) {
      const count = await p.getByRole(role, { name }).count()
      expect(count, `${role} "${name}" from the snapshot should be findable`).toBeGreaterThan(0)
    }
    await p.close()
  }, 60000)
})

describe('a locator snapshots only its own subtree', () => {
  it('returns the component, not the page', async () => {
    const p = await open('/component')
    const snap = await p.locator('section[aria-label="Billing"]').ariaSnapshot()
    expect(snap).toMatch(/Save billing/)
    expect(snap).not.toMatch(/Save shipping/)
    await p.close()
  }, 60000)

  it('refuses an ambiguous locator rather than snapshotting an arbitrary one', async () => {
    const p = await open('/component')
    await expect(p.locator('section').ariaSnapshot()).rejects.toThrow(/matched 2 elements/)
    await p.close()
  }, 60000)
})
