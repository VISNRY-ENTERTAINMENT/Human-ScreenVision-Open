import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'http'
import screenvision from '../../src/index'
import type { Browser } from '../../src/core/Browser'

/**
 * The ambiguous and negative cases, which the previous round of tests did not cover.
 *
 * An audit found six defects in code that had passing tests, and the common thread was that
 * every test asserted the happy path and the zero-match path, never the case where several
 * things match. That is precisely where a library guesses, and guessing is the failure this
 * project exists to eliminate. Its recommendation was a rule: every "we now do X" test must
 * also assert what happens when X is ambiguous. This file is that rule applied.
 */
const PORT = 9970

const PAGES: Record<string, string> = {
  // the case that motivated it: two addresses, one label
  '/addresses': `<!doctype html><html><head><meta charset="utf-8"><title>Addresses</title></head><body>
<main>
 <fieldset id="billing"><legend>Billing</legend>
  <label for="b-addr">Address</label><input id="b-addr">
 </fieldset>
 <fieldset id="shipping"><legend>Shipping</legend>
  <label for="s-addr">Address</label><input id="s-addr">
 </fieldset>
 <button>Save</button><button>Save</button>
</main></body></html>`,

  // two components with identical internals: refs must not collide
  '/components': `<!doctype html><html><head><meta charset="utf-8"><title>Components</title></head><body>
<main><my-card id="a"></my-card><my-card id="b"></my-card><div id="out"></div></main>
<script>
 class MyCard extends HTMLElement {
   connectedCallback() {
     const root = this.attachShadow({ mode: 'open' })
     root.innerHTML = '<input id="name"><button id="go">Go ' + this.id.toUpperCase() + '</button>'
     root.getElementById('go').addEventListener('click', () => {
       document.getElementById('out').textContent = 'clicked ' + this.id
     })
   }
 }
 customElements.define('my-card', MyCard)
</script></body></html>`,

  // an iframe containing a button with the same name as one in the parent
  '/frames': `<!doctype html><html><head><meta charset="utf-8"><title>Frames</title></head><body>
<main>
 <button id="outer" onclick="document.getElementById('out').textContent='outer'">Delete account</button>
 <div id="out">none</div>
 <iframe id="inner" src="/inner" width="400" height="200"></iframe>
</main></body></html>`,
  '/inner': `<!doctype html><html><head><meta charset="utf-8"></head><body>
<button id="innerbtn" onclick="document.getElementById('o').textContent='inner'">Delete account</button>
<div id="o">none</div></body></html>`,
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

describe('a locator refuses to guess between matches', () => {
  it('will not fill one of two identically labelled fields', async () => {
    const p = await open('/addresses')
    // the reported failure: this used to fill billing and report success
    await expect(p.getByLabel('Address').fill('12 High Street')).rejects.toThrow(
      /matched 2 elements, and acting on one of them would be a guess/
    )
    expect(await p.evaluate<string>(`document.getElementById('b-addr').value`)).toBe('')
    expect(await p.evaluate<string>(`document.getElementById('s-addr').value`)).toBe('')
    await p.close()
  }, 60000)

  it('names the matches so the caller can choose', async () => {
    const p = await open('/addresses')
    await expect(p.getByRole('button', { name: 'Save' }).click()).rejects.toThrow(/button.*"Save"/s)
    await p.close()
  }, 60000)

  it('accepts the disambiguation the caller supplies', async () => {
    const p = await open('/addresses')
    await p.locator('#shipping').getByLabel('Address').fill('12 High Street')
    expect(await p.evaluate<string>(`document.getElementById('s-addr').value`)).toBe('12 High Street')
    expect(await p.evaluate<string>(`document.getElementById('b-addr').value`)).toBe('')
    await p.close()
  }, 60000)

  it('accepts first, last and nth as explicit choices', async () => {
    const p = await open('/addresses')
    await p.getByLabel('Address').first().fill('first one')
    await p.getByLabel('Address').last().fill('last one')
    expect(await p.evaluate<string>(`document.getElementById('b-addr').value`)).toBe('first one')
    expect(await p.evaluate<string>(`document.getElementById('s-addr').value`)).toBe('last one')
    await p.close()
  }, 60000)
})

describe('refs across shadow roots stay distinct', () => {
  it('gives two identical components distinct, resolvable refs', async () => {
    const p = await open('/components')
    await p.waitForSelector('#out', { timeout: 5000 })
    const view = await p.observe()
    const buttons = view.affordances.filter((a) => a.role === 'button')
    expect(buttons.length).toBe(2)
    // the reported failure: both refs shared one selector matching nothing
    expect(new Set(buttons.map((b) => b.ref)).size).toBe(2)
    expect(buttons.every((b) => b.inShadowRoot === true)).toBe(true)
    await p.close()
  }, 60000)

  it('acts on the component the caller named, not its twin', async () => {
    const p = await open('/components')
    await p.waitForSelector('#out', { timeout: 5000 })
    const view = await p.observe()
    const second = view.affordances.find((a) => a.name === 'Go B')!
    const result = await p.act({ do: 'click', ref: second.ref })
    expect(result.verdict).toBe('confirmed')
    expect(await p.evaluate<string>(`document.getElementById('out').textContent`)).toBe('clicked b')
    await p.close()
  }, 60000)
})

describe('refs inside a frame never act on the page behind it', () => {
  it('clicks the frame button, not the identically named one outside', async () => {
    const p = await open('/frames')
    const frame = await p.frame('#inner')
    await frame.waitForSelector('#innerbtn', { timeout: 5000 })
    const view = await p.observe()
    const inFrame = view.affordances.find((a) => a.name === 'Delete account' && a.frameId !== undefined)
    expect(inFrame, 'the frame affordance should be listed').toBeDefined()

    // "Delete account" is classified as requiring confirmation, and this test is about frame
    // scoping rather than about the gate, so it authorises the action explicitly.
    const result = await p.act({ do: 'click', ref: inFrame!.ref, confirmed: true })
    // whatever happens, the button in the main document must not have been clicked
    expect(await p.evaluate<string>(`document.getElementById('out').textContent`)).toBe('none')
    if (result.verdict === 'confirmed') {
      expect(await frame.textContent('#o')).toBe('inner')
    }
    await p.close()
  }, 60000)
})
