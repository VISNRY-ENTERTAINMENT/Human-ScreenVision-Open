import { describe, it, expect as vExpect, beforeAll, afterAll } from 'vitest'
import http from 'http'
import screenvision from '../../src/index'
import type { Browser } from '../../src/core/Browser'

/**
 * The wider assertion set, and assertions on locators.
 *
 * An audit found 18 of Playwright's matchers missing, and `expect()` accepted only a semantic
 * description, so the locator API could not be asserted on at all. Both are covered here,
 * including the two matchers that pass an argument into the page — a serialised function
 * loses its closure, so a matcher that captures its expected value reads `undefined` and
 * quietly always fails.
 */
const PORT = 9967

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Matchers</title>
<meta name="viewport" content="width=device-width, initial-scale=1"></head><body>
<main>
 <h1 class="title primary">Matchers</h1>
 <button id="on">Enabled</button>
 <button id="off" disabled>Disabled</button>
 <input id="editable" value="text">
 <input id="locked" value="fixed" readonly>
 <div id="empty"></div>
 <div id="full">has content</div>
 <div id="hidden" style="display:none">secret</div>
 <ul><li>alpha</li><li>beta</li><li>gamma</li></ul>
 <a id="next" href="/second">Next page</a>
</main></body></html>`

const SECOND = `<!doctype html><html><head><meta charset="utf-8"><title>Second page</title></head>
<body><main><h1>Second</h1></main></body></html>`

let server: http.Server
let browser: Browser

beforeAll(async () => {
  server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end((req.url ?? '').includes('second') ? SECOND : PAGE)
  })
  await new Promise<void>((r) => server.listen(PORT, r))
  browser = await screenvision.launch({ headless: true })
}, 60000)

afterAll(async () => {
  if (browser) await browser.close()
  if (server) server.close()
})

async function open() {
  const ctx = await browser.newContext({ device: 'Desktop 1440x900' })
  const p = await ctx.newPage()
  await p.goto(`http://127.0.0.1:${PORT}/`)
  return p
}

describe('state matchers', () => {
  it('checks hidden, disabled and editable', async () => {
    const p = await open()
    await p.expect(p.locator('#hidden')).toBeHidden()
    await p.expect(p.locator('#off')).toBeDisabled()
    await p.expect(p.locator('#editable')).toBeEditable()
    await p.expect(p.locator('#locked')).not.toBeEditable()
    await p.close()
  }, 60000)

  it('checks empty and focused', async () => {
    const p = await open()
    await p.expect(p.locator('#empty')).toBeEmpty()
    await p.expect(p.locator('#full')).not.toBeEmpty()
    await p.locator('#editable').click()
    await p.expect(p.locator('#editable')).toBeFocused()
    await p.close()
  }, 60000)
})

describe('content matchers', () => {
  it('distinguishes exact text from containment', async () => {
    const p = await open()
    await p.expect(p.locator('#full')).toHaveText('has')
    await p.expect(p.locator('#full')).toHaveExactText('has content')
    await p.expect(p.locator('#full')).not.toHaveExactText('has')
    await p.close()
  }, 60000)

  it('checks a class, which needs the value passed into the page', async () => {
    const p = await open()
    await p.expect(p.locator('h1')).toHaveClass('primary')
    await p.expect(p.locator('h1')).not.toHaveClass('secondary')
    await p.close()
  }, 60000)

  it('checks a computed style', async () => {
    const p = await open()
    await p.expect(p.locator('#hidden')).toHaveCSS('display', 'none')
    await p.close()
  }, 60000)

  it('reports the actual value when a style assertion fails', async () => {
    const p = await open()
    await vExpect(p.expect(p.locator('#full')).toHaveCSS('display', 'none', { timeout: 900 })).rejects.toThrow(
      /display is "block"/
    )
    await p.close()
  }, 60000)
})

describe('counting matches', () => {
  it('asserts how many elements a locator matches', async () => {
    const p = await open()
    await p.expect(p.getByRole('listitem')).toHaveCount(3)
    await p.expect(p.getByRole('listitem')).not.toHaveCount(2)
    await p.close()
  }, 60000)

  it('reports the real count when it is wrong', async () => {
    const p = await open()
    await vExpect(p.expect(p.getByRole('listitem')).toHaveCount(7, { timeout: 900 })).rejects.toThrow(
      /match 7 elements after waiting 900ms, but it matched 3/
    )
    await p.close()
  }, 60000)

  it('refuses toHaveCount on a plain description', async () => {
    const p = await open()
    await vExpect(p.expect('some description').toHaveCount(1)).rejects.toThrow(/needs a locator/)
    await p.close()
  }, 60000)
})

describe('page-level assertions', () => {
  it('waits for the url and the title after a navigation', async () => {
    const p = await open()
    await p.locator('#next').click()
    await p.expectURL('/second')
    await p.expectTitle(/Second/)
    await p.close()
  }, 60000)

  it('reports where it ended up when the url never matches', async () => {
    const p = await open()
    await vExpect(p.expectURL('/nowhere', { timeout: 900 })).rejects.toThrow(/but it is http/)
    await p.close()
  }, 60000)
})
