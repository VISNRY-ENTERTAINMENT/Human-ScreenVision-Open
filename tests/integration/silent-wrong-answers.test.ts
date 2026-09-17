import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'http'
import screenvision from '../../src/index'
import type { Browser } from '../../src/core/Browser'

/**
 * The three defects four independent auditors found by using the library.
 *
 * Every one of them is the same shape: the library did the wrong thing and reported success.
 * That is the failure mode this project exists to eliminate in other people's applications,
 * so having it in the library itself is the worst kind of bug it can have. These tests exist
 * to make sure each stays fixed.
 */
const PORT = 9962

const PAGES: Record<string, string> = {
  // a table whose rows are re-rendered, with a selector that matches every row
  '/table': `<!doctype html><html><head><meta charset="utf-8"><title>Table</title></head><body>
<main><table id="grid"><tbody id="rows">
 <tr class="row"><td>Carol</td><td>Eng</td><td>120000</td></tr>
 <tr class="row"><td>Dave</td><td>Ops</td><td>70000</td></tr>
</tbody></table>
<button id="reorder" onclick="rows.insertBefore(rows.children[1], rows.children[0])">Reorder</button>
</main></body></html>`,

  // three buttons that share every attribute except their text
  '/ambiguous': `<!doctype html><html><head><meta charset="utf-8"><title>Ambiguous</title></head><body>
<main>
 <form>
  <button name="which" value="draft" type="button" onclick="log('draft')">Submit draft</button>
  <button name="which" value="final" type="button" onclick="log('final')">Submit final</button>
  <button id="submit-expense" type="button" onclick="log('expense')">Submit expense</button>
 </form>
 <div id="out"></div>
 <script>function log(v){document.getElementById('out').textContent = v}</script>
</main></body></html>`,

  // a grid big enough that an uncapped observation would be larger than the markup
  '/big': `<!doctype html><html><head><meta charset="utf-8"><title>Big</title></head><body>
<main id="m"></main>
<script>
 const m = document.getElementById('m')
 for (let i = 0; i < 300; i++) {
   const row = document.createElement('div')
   row.innerHTML = '<span>Row ' + i + '</span><button>Edit</button><button>Delete</button>'
   m.appendChild(row)
 }
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

describe('a handle never heals onto a different element', () => {
  it('refuses when the selector now matches someone else', async () => {
    const p = await open('/table')
    const carol = await p.$('.row')
    expect(await carol!.textContent()).toContain('Carol')

    // the rows swap places: '.row' still matches, but the first one is now Dave
    await p.click('#reorder')
    await p.evaluate(`document.getElementById('rows').innerHTML = document.getElementById('rows').innerHTML`)

    // the old behaviour clicked Dave and reported success
    await expect(carol!.textContent()).rejects.toThrow(/was replaced by a different element/)
    await p.close()
  }, 60000)

  it('still heals when the same element comes back', async () => {
    const p = await open('/table')
    const grid = await p.$('#grid')
    await p.evaluate(`document.body.innerHTML = document.body.innerHTML`)
    expect(await grid!.textContent()).toContain('Carol')
    await p.close()
  }, 60000)
})

describe('a ref addresses exactly one element', () => {
  it('gives every affordance a selector that matches it alone', async () => {
    const p = await open('/ambiguous')
    const view = await p.observe()
    const selectors = view.affordances.map((a) => a.selector)
    expect(new Set(selectors).size).toBe(selectors.length)
    for (const selector of selectors) {
      const count = await p.evaluate<number>(`document.querySelectorAll(${JSON.stringify(selector)}).length`)
      expect(count, `selector ${selector} should match exactly one element`).toBe(1)
    }
    await p.close()
  }, 60000)

  it('acts on the button the caller chose, not a namesake', async () => {
    const p = await open('/ambiguous')
    const view = await p.observe()
    const final = view.affordances.find((a) => a.name === 'Submit final')!
    const result = await p.act({ do: 'click', ref: final.ref })
    expect(result.verdict).toBe('confirmed')
    // the old behaviour clicked "Submit draft" and reported confirmed
    expect(await p.evaluate<string>(`document.getElementById('out').textContent`)).toBe('final')
    await p.close()
  }, 60000)

  it('acts correctly on each of three lookalike buttons in turn', async () => {
    for (const [name, expected] of [
      ['Submit draft', 'draft'],
      ['Submit final', 'final'],
      ['Submit expense', 'expense'],
    ] as const) {
      const p = await open('/ambiguous')
      const view = await p.observe()
      const target = view.affordances.find((a) => a.name === name)!
      await p.act({ do: 'click', ref: target.ref })
      expect(await p.evaluate<string>(`document.getElementById('out').textContent`)).toBe(expected)
      await p.close()
    }
  }, 120000)
})

describe('an observation stays smaller than the page it describes', () => {
  it('caps and ranks a grid with hundreds of controls, and says it did', async () => {
    const p = await open('/big')
    const view = await p.observe()
    const html = await p.content()
    expect(view.affordances.length).toBeLessThanOrEqual(60)
    expect(view.truncated).toBeGreaterThan(0)
    expect(view.notices.some((n) => /more controls are present/.test(n))).toBe(true)
    // the whole point of the call is to be cheaper than reading the markup
    expect(JSON.stringify(view).length).toBeLessThan(html.length)
    await p.close()
  }, 60000)

  it('honours a smaller cap and still keeps refs unique', async () => {
    const p = await open('/big')
    const view = await p.observe({ maxAffordances: 15 })
    expect(view.affordances).toHaveLength(15)
    const selectors = view.affordances.map((a) => a.selector)
    expect(new Set(selectors).size).toBe(15)
    await p.close()
  }, 60000)
})
