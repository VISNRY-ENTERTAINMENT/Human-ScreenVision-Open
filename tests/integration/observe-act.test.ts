import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'http'
import screenvision from '../../src/index'
import type { Browser } from '../../src/core/Browser'

/**
 * The agent API: observe what is on screen, act, and get proof of what the action did.
 *
 * The case that motivates all of it is the inert control. An agent clicks a button, the click
 * lands, nothing happens, and ordinary automation reports success because the click was
 * dispatched. The agent then proceeds on a false belief. `act` reports that directly as
 * `no-effect`, which is the single most valuable thing this API does.
 */
const PORT = 9945

const PAGES: Record<string, string> = {
  '/app': `<!doctype html><html><head><meta charset="utf-8"><title>Account</title>
<meta name="viewport" content="width=device-width, initial-scale=1"></head><body>
<nav role="navigation" aria-label="main"><a href="/app">Home</a><a href="/other">Settings</a></nav>
<main>
 <h1>Your account</h1>
 <p>Update the details below.</p>
 <label for="email">Email address</label>
 <input id="email" type="text">
 <input id="terms" type="checkbox"> <label for="terms">Accept terms</label>
 <select id="plan"><option value="free">Free</option><option value="pro">Pro</option></select>
 <button id="save" onclick="save()">Save changes</button>
 <button id="inert">Does nothing</button>
 <button id="broken" onclick="window.nope.boom()">Broken handler</button>
 <button id="opens" onclick="document.getElementById('dlg').style.display='block'">Open panel</button>
 <div id="dlg" role="dialog" aria-label="panel" style="display:none"><p>Panel is open</p>
   <button id="closes" onclick="document.getElementById('dlg').style.display='none'">Close</button></div>
 <div id="status"></div>
</main>
<footer>footer text</footer>
<script>
 function save() {
   document.getElementById('status').textContent = 'Saved successfully'
   fetch('/api/save', { method: 'POST' })
 }
</script></body></html>`,
  '/other': `<!doctype html><html><head><meta charset="utf-8"><title>Settings</title></head><body>
<main><h1>Settings page</h1></main></body></html>`,
}

let server: http.Server
let browser: Browser

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const route = (req.url ?? '/app').split('?')[0]
    if (route.startsWith('/api/')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
      return
    }
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(PAGES[route] ?? PAGES['/app'])
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
  await p.goto(`http://127.0.0.1:${PORT}/app`)
  return p
}

describe('observe', () => {
  it('lists every available action with a stable ref', async () => {
    const p = await open()
    const view = await p.observe()
    const names = view.affordances.map((a) => a.name)
    expect(names).toContain('Save changes')
    expect(names).toContain('Does nothing')
    expect(view.affordances.every((a) => /^e\d+$/.test(a.ref))).toBe(true)
    await p.close()
  }, 60000)

  it('gives each control its role and state', async () => {
    const p = await open()
    const view = await p.observe()
    const save = view.affordances.find((a) => a.name === 'Save changes')!
    expect(save.role).toBe('button')
    expect(save.state.enabled).toBe(true)
    expect(save.state.visible).toBe(true)
    const terms = view.affordances.find((a) => a.role === 'checkbox')!
    expect(terms.state.checked).toBe(false)
    const email = view.affordances.find((a) => a.role === 'textbox')!
    expect(email.name).toBe('Email address')
    await p.close()
  }, 60000)

  it('reports the landmark regions', async () => {
    const p = await open()
    const view = await p.observe()
    const roles = view.regions.map((r) => r.role)
    expect(roles).toContain('navigation')
    expect(roles).toContain('main')
    expect(roles).toContain('contentinfo')
    await p.close()
  }, 60000)

  it('warns about conditions an agent would otherwise hit blind', async () => {
    const p = await open()
    await p.click('#opens')
    const view = await p.observe()
    expect(view.notices.some((n) => /modal/.test(n))).toBe(true)
    await p.close()
  }, 60000)

  it('costs far less than the raw HTML on a realistically sized page', async () => {
    const p = await open()
    // real applications ship tens of thousands of characters of markup; the observation
    // should scale with how much you can DO on the page, not with how big the page is
    await p.evaluate(`(() => {
      const wrap = document.createElement('div')
      for (let i = 0; i < 300; i++) {
        const row = document.createElement('div')
        row.className = 'row-' + i + ' grid gap-4 items-center border-b px-6 py-3 hover:bg-slate-50'
        row.setAttribute('data-row-index', String(i))
        row.innerHTML = '<span class="text-sm font-medium text-slate-700">Item ' + i +
          '</span><span class="text-xs text-slate-400">description text for row ' + i + '</span>'
        wrap.appendChild(row)
      }
      document.body.appendChild(wrap)
    })()`)
    const view = await p.observe()
    const html = await p.content()
    const observationSize = JSON.stringify(view).length
    expect(html.length).toBeGreaterThan(40000)
    expect(observationSize).toBeLessThan(html.length / 10)
    await p.close()
  }, 60000)
})

describe('act proves what happened', () => {
  it('confirms an action that changed the page', async () => {
    const p = await open()
    const r = await p.act({ do: 'click', selector: '#save' })
    expect(r.verdict).toBe('confirmed')
    expect(r.ok).toBe(true)
    expect(JSON.stringify(r.effects.mutations)).toContain('Saved successfully')
    expect(r.effects.requests.some((u) => u.includes('/api/save'))).toBe(true)
    await p.close()
  }, 60000)

  it('reports an inert control as no-effect instead of success', async () => {
    const p = await open()
    const r = await p.act({ do: 'click', selector: '#inert' })
    expect(r.verdict).toBe('no-effect')
    expect(r.ok).toBe(false)
    expect(r.summary).toMatch(/nothing changed: no navigation, no DOM mutation and no network request/)
    await p.close()
  }, 60000)

  it('surfaces the console error when a handler throws', async () => {
    const p = await open()
    const r = await p.act({ do: 'click', selector: '#broken' })
    expect(r.verdict).toBe('no-effect')
    expect(r.effects.consoleErrors.length).toBeGreaterThan(0)
    expect(r.summary).toMatch(/console reported/)
    await p.close()
  }, 60000)

  it('acts by ref from an observation, with no selector invented', async () => {
    const p = await open()
    const view = await p.observe()
    const save = view.affordances.find((a) => a.name === 'Save changes')!
    const r = await p.act({ do: 'click', ref: save.ref })
    expect(r.verdict).toBe('confirmed')
    expect(r.target.ref).toBe(save.ref)
    await p.close()
  }, 60000)

  it('lists the available refs when given one that does not exist', async () => {
    const p = await open()
    await p.observe()
    await expect(p.act({ do: 'click', ref: 'e999' })).rejects.toThrow(/Available: e1=/)
    await p.close()
  }, 60000)

  it('detects new controls appearing', async () => {
    const p = await open()
    const r = await p.act({ do: 'click', selector: '#opens' })
    expect(r.verdict).toBe('confirmed')
    expect(r.effects.mutations.attributeChanges.some((c) => c.attribute === 'style')).toBe(true)
    await p.close()
  }, 60000)

  it('confirms a fill by reading the value back, not by watching the DOM', async () => {
    const p = await open()
    const r = await p.act({ do: 'fill', selector: '#email', value: 'a@b.c' })
    expect(r.verdict).toBe('confirmed')
    expect(r.effects.valueSet).toEqual({ expected: 'a@b.c', actual: 'a@b.c', matched: true })
    await p.close()
  }, 60000)

  it('catches a field that silently rejects what was typed', async () => {
    const p = await open()
    // a field that rewrites its own value, the way an input mask or formatter does
    await p.evaluate(
      `document.getElementById('email').addEventListener('input', function () { this.value = 'REWRITTEN' })`
    )
    const r = await p.act({ do: 'fill', selector: '#email', value: 'a@b.c' })
    expect(r.verdict).toBe('unexpected')
    expect(r.effects.valueSet?.matched).toBe(false)
    expect(r.summary).toMatch(/did not take the value/)
    await p.close()
  }, 60000)

  it('confirms a checkbox by its state', async () => {
    const p = await open()
    const r = await p.act({ do: 'check', selector: '#terms' })
    expect(r.verdict).toBe('confirmed')
    expect(r.effects.valueSet?.actual).toBe('true')
    await p.close()
  }, 60000)

  it('diagnoses a button that has no handler at all', async () => {
    const p = await open()
    const r = await p.act({ do: 'click', selector: '#inert' })
    expect(r.inert?.likely).toBe(true)
    expect(r.summary).toMatch(/no event listener/)
    await p.close()
  }, 60000)
})

describe('act checks stated expectations', () => {
  it('confirms when every expectation holds', async () => {
    const p = await open()
    const r = await p.act({
      do: 'click',
      selector: '#save',
      expect: { textAppears: 'Saved successfully', requestMade: '/api/save' },
    })
    expect(r.verdict).toBe('confirmed')
    expect(r.expectations.every((e) => e.met)).toBe(true)
    await p.close()
  }, 60000)

  it('reports unexpected when the page changed but not as promised', async () => {
    const p = await open()
    const r = await p.act({
      do: 'click',
      selector: '#save',
      expect: { urlContains: '/thank-you' },
    })
    expect(r.verdict).toBe('unexpected')
    expect(r.ok).toBe(false)
    expect(r.summary).toMatch(/did not hold/)
    await p.close()
  }, 60000)

  it('says no requests were made at all when that is the reason', async () => {
    const p = await open()
    const r = await p.act({ do: 'click', selector: '#inert', expect: { requestMade: '/api/save' } })
    const req = r.expectations.find((e) => /request/.test(e.expectation))!
    expect(req.met).toBe(false)
    expect(req.detail).toMatch(/no requests were made at all/)
    await p.close()
  }, 60000)

  it('confirms a navigation expectation', async () => {
    const p = await open()
    const view = await p.observe()
    const link = view.affordances.find((a) => a.role === 'link' && a.name === 'Settings')!
    const r = await p.act({
      do: 'click',
      ref: link.ref,
      expect: { urlContains: '/other', textAppears: 'Settings page' },
    })
    expect(r.verdict).toBe('confirmed')
    expect(r.effects.urlChanged?.to).toContain('/other')
    await p.close()
  }, 60000)

  it('keeps an ordered log of every action with its verdict', async () => {
    const p = await open()
    await p.act({ do: 'click', selector: '#inert' })
    await p.act({ do: 'click', selector: '#save' })
    const log = p.actions()
    expect(log).toHaveLength(2)
    expect(log[0].verdict).toBe('no-effect')
    expect(log[1].verdict).toBe('confirmed')
    await p.close()
  }, 60000)
})
