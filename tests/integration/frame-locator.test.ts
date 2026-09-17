import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'http'
import screenvision from '../../src/index'
import type { Browser } from '../../src/core/Browser'

/**
 * Frames were a second-class citizen: `Frame` had `click`, `fill`, `textContent` and
 * `waitForSelector`, but no locators. That is not a missing convenience — the strictness
 * guarantee lives in `Locator`, so an agent working inside a frame silently lost the one
 * protection this library exists to provide. `frame.click('button')` on two buttons picks the
 * first and reports success; `frame.getByRole('button').click()` must refuse.
 *
 * Following the round-2 audit rule: every "we now do X" case is paired with the ambiguous one.
 */
const PORT = 9969

const PAGES: Record<string, string> = {
  '/host': `<!doctype html><html><head><meta charset="utf-8"><title>Host</title></head><body>
<main>
 <button id="outer-save" onclick="document.getElementById('outlog').textContent='OUTER SAVE'">Save</button>
 <label for="outer-addr">Address</label><input id="outer-addr">
 <div id="outlog">none</div>
 <iframe id="shop" src="/shop" width="500" height="400"></iframe>
 <iframe id="other" src="/other" width="500" height="400"></iframe>
</main></body></html>`,

  // inside the frame: a namesake of the parent's button, plus a genuinely ambiguous pair
  '/shop': `<!doctype html><html><head><meta charset="utf-8"><title>Shop</title></head><body>
<main>
 <button id="inner-save" onclick="document.getElementById('inlog').textContent='INNER SAVE'">Save</button>
 <fieldset id="billing"><legend>Billing</legend>
   <label for="b-addr">Address</label><input id="b-addr">
 </fieldset>
 <fieldset id="shipping"><legend>Shipping</legend>
   <label for="s-addr">Address</label><input id="s-addr">
 </fieldset>
 <div id="inlog">none</div>
 <div id="later"></div>
 <script>
   setTimeout(() => { document.getElementById('later').innerHTML = '<button id="late">Late Button</button>' }, 300)
 </script>
</main></body></html>`,

  '/other': `<!doctype html><html><head><meta charset="utf-8"><title>Other</title></head><body>
<button id="other-save" onclick="document.getElementById('olog').textContent='OTHER SAVE'">Save</button>
<div id="olog">none</div></body></html>`,

  '/elsewhere': `<!doctype html><html><head><meta charset="utf-8"><title>Elsewhere</title></head><body>
<main><h1 id="marker">Elsewhere</h1></main></body></html>`,
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

async function openHost() {
  const ctx = await browser.newContext({ device: 'Desktop 1440x900' })
  const p = await ctx.newPage()
  await p.goto(`http://127.0.0.1:${PORT}/host`)
  return p
}

describe('a frame hosts locators', () => {
  it('acts on the frame button, never the identically named one outside', async () => {
    const p = await openHost()
    const frame = await p.frame('#shop')
    await frame.getByRole('button', { name: 'Save' }).click()
    expect(await frame.textContent('#inlog')).toBe('INNER SAVE')
    // the parent's namesake must be untouched
    expect(await p.evaluate<string>(`document.getElementById('outlog').textContent`)).toBe('none')
    await p.close()
  }, 60000)

  it('refuses an ambiguous locator inside the frame instead of picking one', async () => {
    const p = await openHost()
    const frame = await p.frame('#shop')
    await expect(frame.getByLabel('Address').fill('12 High Street')).rejects.toThrow(
      /matched 2 elements, and acting on one of them would be a guess/
    )
    expect(await frame.evaluate<string>(`document.getElementById('b-addr').value`)).toBe('')
    expect(await frame.evaluate<string>(`document.getElementById('s-addr').value`)).toBe('')
    await p.close()
  }, 60000)

  it('accepts a scoped disambiguation inside the frame', async () => {
    const p = await openHost()
    const frame = await p.frame('#shop')
    await frame.locator('#shipping').getByLabel('Address').fill('12 High Street')
    expect(await frame.evaluate<string>(`document.getElementById('s-addr').value`)).toBe('12 High Street')
    expect(await frame.evaluate<string>(`document.getElementById('b-addr').value`)).toBe('')
    await p.close()
  }, 60000)

  it('re-resolves lazily, so an element that arrives later is found', async () => {
    const p = await openHost()
    const frame = await p.frame('#shop')
    // created 300ms after load: a handle taken now would be null, a locator must wait
    await frame.getByRole('button', { name: 'Late Button' }).click({ timeout: 5000 })
    await p.close()
  }, 60000)

  it('counts only what is inside its own frame', async () => {
    const p = await openHost()
    const shop = await p.frame('#shop')
    const other = await p.frame('#other')
    expect(await shop.getByRole('button', { name: 'Save' }).count()).toBe(1)
    expect(await other.getByRole('button', { name: 'Save' }).count()).toBe(1)
    // and the page sees its own, not the frames'
    expect(await p.getByRole('button', { name: 'Save' }).count()).toBe(1)
    await p.close()
  }, 60000)
})

describe('frame.goto navigates only that frame', () => {
  it('replaces the frame document and leaves the parent alone', async () => {
    const p = await openHost()
    const frame = await p.frame('#shop')
    await frame.goto(`http://127.0.0.1:${PORT}/elsewhere`)
    expect(await frame.textContent('#marker')).toBe('Elsewhere')
    // the host page must still be the host page
    expect(await p.evaluate<string>(`document.title`)).toBe('Host')
    expect(await p.evaluate<string>(`document.getElementById('outlog').textContent`)).toBe('none')
    await p.close()
  }, 60000)
})

describe('page.frameLocator reaches into a frame without resolving it first', () => {
  it('clicks the button inside the named frame', async () => {
    const p = await openHost()
    await p.frameLocator('#shop').getByRole('button', { name: 'Save' }).click()
    const frame = await p.frame('#shop')
    expect(await frame.textContent('#inlog')).toBe('INNER SAVE')
    expect(await p.evaluate<string>(`document.getElementById('outlog').textContent`)).toBe('none')
    await p.close()
  }, 60000)

  it('is strict inside the frame too', async () => {
    const p = await openHost()
    await expect(p.frameLocator('#shop').getByLabel('Address').fill('x')).rejects.toThrow(
      /matched 2 elements/
    )
    await p.close()
  }, 60000)

  it('names the frame when the frame itself cannot be found', async () => {
    const p = await openHost()
    await expect(p.frameLocator('#nosuchframe').getByRole('button').click()).rejects.toThrow(
      /#nosuchframe/
    )
    await p.close()
  }, 60000)
})

/**
 * Every coordinate-based action, inside a frame.
 *
 * Clicks were fixed by routing them through the host; hover, tap and dragTo compute their own
 * points and were still delivering them to the top-level document, so inside a same-origin
 * frame they landed at the same coordinates in the parent — on nothing, or on whatever
 * happened to be there. The frame in these fixtures is deliberately pushed down the page by a
 * tall spacer, so an un-offset point cannot accidentally be right.
 */
const COORD_PAGES: Record<string, string> = {
  '/coordhost': `<!doctype html><html><head><meta charset="utf-8"><title>CoordHost</title></head><body>
<main>
 <div style="height:260px;background:#eee">spacer — the frame starts well down the page</div>
 <button id="decoy" style="width:300px;height:120px"
   onmouseover="document.getElementById('dlog').textContent='DECOY HOVERED'"
   onclick="document.getElementById('dlog').textContent='DECOY CLICKED'">Decoy in the parent</button>
 <div id="dlog">none</div>
 <iframe id="widget" src="/widget" width="520" height="420" style="border:1px solid #333"></iframe>
</main></body></html>`,

  '/widget': `<!doctype html><html><head><meta charset="utf-8"><title>Widget</title>
<style>#pad{height:40px} .col{display:inline-block;width:190px;min-height:120px;border:1px solid #666;vertical-align:top}
 #card{padding:10px;background:#ddd;margin:6px}</style></head><body>
<main>
 <div id="pad"></div>
 <button id="hovertarget" style="width:220px;height:70px"
   onmouseover="document.getElementById('wlog').textContent='HOVERED'">Hover me</button>
 <button id="taptarget" style="width:220px;height:70px"
   ontouchstart="document.getElementById('wlog').textContent='TAPPED'">Tap me</button>
 <div class="col" id="c1"><div id="card" draggable="true">card</div></div>
 <div class="col" id="c2"></div>
 <div id="wlog">none</div>
 <script>
  for (const col of document.querySelectorAll('.col')) {
    col.addEventListener('dragover', (e) => e.preventDefault())
    col.addEventListener('drop', (e) => {
      e.preventDefault()
      col.appendChild(document.getElementById('card'))
      document.getElementById('wlog').textContent = 'dropped on ' + col.id
    })
  }
 </script>
</main></body></html>`,
}

describe('coordinate actions respect the frame offset', () => {
  let coordServer: http.Server
  const CPORT = 9968

  beforeAll(async () => {
    coordServer = http.createServer((req, res) => {
      const body = COORD_PAGES[(req.url ?? '/').split('?')[0]]
      res.writeHead(body ? 200 : 404, { 'content-type': 'text/html' })
      res.end(body ?? '<h1>404</h1>')
    })
    await new Promise<void>((r) => coordServer.listen(CPORT, r))
  }, 30000)

  afterAll(() => {
    if (coordServer) coordServer.close()
  })

  async function openCoord() {
    const ctx = await browser.newContext({ device: 'Desktop 1440x900' })
    const p = await ctx.newPage()
    await p.goto(`http://127.0.0.1:${CPORT}/coordhost`)
    return p
  }

  it('hovers the element in the frame, not the parent at those coordinates', async () => {
    const p = await openCoord()
    const frame = await p.frame('#widget')
    await frame.getByRole('button', { name: 'Hover me' }).hover()
    expect(await frame.textContent('#wlog')).toBe('HOVERED')
    expect(await p.evaluate<string>(`document.getElementById('dlog').textContent`)).toBe('none')
    await p.close()
  }, 60000)

  it('hovers correctly from a handle taken via frame.$ as well', async () => {
    const p = await openCoord()
    const frame = await p.frame('#widget')
    const handle = await frame.$('#hovertarget')
    await handle!.hover()
    expect(await frame.textContent('#wlog')).toBe('HOVERED')
    expect(await p.evaluate<string>(`document.getElementById('dlog').textContent`)).toBe('none')
    await p.close()
  }, 60000)

  it('taps the element in the frame', async () => {
    const p = await openCoord()
    const frame = await p.frame('#widget')
    const handle = await frame.$('#taptarget')
    await handle!.tap()
    expect(await frame.textContent('#wlog')).toBe('TAPPED')
    await p.close()
  }, 60000)

  it('drags to the correct column inside the frame', async () => {
    const p = await openCoord()
    const frame = await p.frame('#widget')
    const card = await frame.$('#card')
    const second = await frame.$('#c2')
    await card!.dragTo(second!)
    expect(await frame.textContent('#wlog')).toBe('dropped on c2')
    await p.close()
  }, 60000)

  it('clicks through frameLocator without touching the decoy', async () => {
    const p = await openCoord()
    await p.frameLocator('#widget').getByRole('button', { name: 'Hover me' }).click()
    expect(await p.evaluate<string>(`document.getElementById('dlog').textContent`)).toBe('none')
    await p.close()
  }, 60000)
})
