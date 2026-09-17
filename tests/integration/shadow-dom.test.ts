import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'http'
import screenvision from '../../src/index'
import type { Browser } from '../../src/core/Browser'

/**
 * Web components.
 *
 * CSS cannot cross a shadow boundary, so a page built from components looked empty: an
 * auditor found `observe()` reporting zero affordances on a page whose only control lived in
 * a shadow root. A confident report of an empty page is worse than an error, because the
 * caller has no reason to look further.
 */
const PORT = 9964

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Components</title>
<meta name="viewport" content="width=device-width, initial-scale=1"></head><body>
<main>
 <h1>Component page</h1>
 <my-form></my-form>
 <button id="plain">Plain button</button>
 <div id="out"></div>
</main>
<script>
 class MyForm extends HTMLElement {
   connectedCallback() {
     const root = this.attachShadow({ mode: 'open' })
     root.innerHTML =
       '<label for="email">Email address</label>' +
       '<input id="email" data-testid="shadow-email">' +
       '<button id="save" data-testid="shadow-save">Save profile</button>' +
       '<button id="cancel">Cancel</button>'
     root.getElementById('save').addEventListener('click', () => {
       document.getElementById('out').textContent = 'saved ' + root.getElementById('email').value
     })
   }
 }
 customElements.define('my-form', MyForm)
</script></body></html>`

let server: http.Server
let browser: Browser

beforeAll(async () => {
  server = http.createServer((_q, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(PAGE)
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
  await p.waitForSelector('#plain', { timeout: 5000 })
  return p
}

describe('queries reach into shadow roots', () => {
  it('finds an element inside a component', async () => {
    const p = await open()
    const save = await p.$('[data-testid="shadow-save"]')
    expect(save).not.toBeNull()
    expect(await save!.textContent()).toBe('Save profile')
    await p.close()
  }, 60000)

  it('finds every match across the light and shadow trees', async () => {
    const p = await open()
    const buttons = await p.$$('button')
    const names = await Promise.all(buttons.map((b) => b.textContent()))
    expect(names).toContain('Plain button')
    expect(names).toContain('Save profile')
    expect(names).toContain('Cancel')
    await p.close()
  }, 60000)
})

describe('the observation is not empty on a component page', () => {
  it('lists the controls inside the shadow root', async () => {
    const p = await open()
    const view = await p.observe()
    const names = view.affordances.map((a) => a.name)
    expect(names).toContain('Save profile')
    expect(names).toContain('Plain button')
    // the input's label lives in the shadow root too
    expect(names.some((n) => n.includes('Email'))).toBe(true)
    await p.close()
  }, 60000)

  it('ranks a shadow control as a candidate for a description', async () => {
    const p = await open()
    const candidates = await p.findCandidates('save profile button')
    expect(candidates[0].name).toBe('Save profile')
    await p.close()
  }, 60000)
})

describe('acting on a shadow control works end to end', () => {
  it('fills and clicks inside a component and confirms the effect', async () => {
    const p = await open()
    const email = await p.$('[data-testid="shadow-email"]')
    await email!.fill('dana@example.com')
    const save = await p.$('[data-testid="shadow-save"]')
    await save!.click()
    expect(await p.evaluate<string>(`document.getElementById('out').textContent`)).toBe(
      'saved dana@example.com'
    )
    await p.close()
  }, 60000)
})
