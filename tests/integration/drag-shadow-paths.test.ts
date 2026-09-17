import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'http'
import screenvision from '../../src/index'
import type { Browser } from '../../src/core/Browser'

/**
 * The last two defects from the second audit, written as failing tests first.
 *
 * `dragTo` was wrong three ways: it re-resolved its target by selector and dropped on the
 * wrong column, its "did anything change" guard compared `innerHTML.length` so a successful
 * reorder threw while a no-op on a ticking page passed, and a locator-derived target crashed.
 *
 * Shadow piercing was inconsistent inside one object: `page.$` pierced while `waitForSelector`,
 * `click` and `fill` did not, so the semantic layer could find elements the imperative API
 * could not touch.
 */
const PORT = 9971

const PAGES: Record<string, string> = {
  // two identical drop columns: dropping on the second must not land on the first
  '/board': `<!doctype html><html><head><meta charset="utf-8"><title>Board</title>
<style>.col{display:inline-block;width:180px;min-height:140px;border:1px solid #333;vertical-align:top}
 .card{padding:8px;background:#eee;margin:4px}</style></head><body>
<main>
 <div class="col" id="c1"><div class="card" id="card" draggable="true">card</div></div>
 <div class="col" id="c2"></div>
 <div id="log">none</div>
 <script>
  for (const col of document.querySelectorAll('.col')) {
    col.addEventListener('dragover', (e) => e.preventDefault())
    col.addEventListener('drop', (e) => {
      e.preventDefault()
      col.appendChild(document.getElementById('card'))
      document.getElementById('log').textContent = 'dropped on ' + col.id
    })
  }
 </script>
</main></body></html>`,

  // a page that mutates constantly, so a length-based change check is meaningless
  '/ticking': `<!doctype html><html><head><meta charset="utf-8"><title>Ticking</title>
<style>.col{display:inline-block;width:180px;min-height:140px;border:1px solid #333}</style></head><body>
<main>
 <div class="col" id="src"><div id="card" draggable="true">card</div></div>
 <div class="col" id="dst">nothing listens here</div>
 <div id="clock">0</div>
 <script>let n = 0; setInterval(() => { document.getElementById('clock').textContent = String(++n) }, 50)</script>
</main></body></html>`,

  // one control in the light DOM, one inside a component, same page
  '/mixed': `<!doctype html><html><head><meta charset="utf-8"><title>Mixed</title></head><body>
<main>
 <my-panel></my-panel>
 <div id="out">none</div>
</main>
<script>
 class MyPanel extends HTMLElement {
   connectedCallback() {
     const root = this.attachShadow({ mode: 'open' })
     root.innerHTML = '<input id="deep-input"><button id="deep-btn">Deep</button>'
     root.getElementById('deep-btn').addEventListener('click', () => {
       document.getElementById('out').textContent = 'deep clicked ' + root.getElementById('deep-input').value
     })
   }
 }
 customElements.define('my-panel', MyPanel)
</script></body></html>`,
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

describe('dragTo drops where it was told', () => {
  it('drops on the second column, not the first', async () => {
    const p = await open('/board')
    const card = await p.$('#card')
    const second = await p.$('#c2')
    await card!.dragTo(second!)
    expect(await p.evaluate<string>(`document.getElementById('log').textContent`)).toBe('dropped on c2')
    await p.close()
  }, 60000)

  it('works when the target came from a locator', async () => {
    const p = await open('/board')
    const card = await p.locator('#card').elementHandle()
    const second = await p.locator('#c2').elementHandle()
    await card.dragTo(second)
    expect(await p.evaluate<string>(`document.getElementById('log').textContent`)).toBe('dropped on c2')
    await p.close()
  }, 60000)

  it('still reports a drop that nothing handled, even while the page ticks', async () => {
    const p = await open('/ticking')
    const card = await p.$('#card')
    const dst = await p.$('#dst')
    // the page mutates every 50ms, so a length-based check would call this a success
    await expect(card!.dragTo(dst!)).rejects.toThrow(/did not move|nothing on the page changed/)
    await p.close()
  }, 60000)
})

describe('every resolution path sees into a component', () => {
  it('waitForSelector reaches a shadow element', async () => {
    const p = await open('/mixed')
    const handle = await p.waitForSelector('#deep-btn', { timeout: 5000 })
    expect(await handle.textContent()).toBe('Deep')
    await p.close()
  }, 60000)

  it('page.click and page.fill reach shadow elements', async () => {
    const p = await open('/mixed')
    await p.fill('#deep-input', 'hello')
    await p.click('#deep-btn')
    expect(await p.evaluate<string>(`document.getElementById('out').textContent`)).toBe('deep clicked hello')
    await p.close()
  }, 60000)

  it('a locator reaches a shadow element too', async () => {
    const p = await open('/mixed')
    await p.locator('#deep-input').fill('via locator')
    await p.locator('#deep-btn').click()
    expect(await p.evaluate<string>(`document.getElementById('out').textContent`)).toBe('deep clicked via locator')
    await p.close()
  }, 60000)
})
