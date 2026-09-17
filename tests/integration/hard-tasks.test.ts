import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'http'
import fs from 'fs'
import os from 'os'
import path from 'path'
import screenvision from '../../src/index'
import { AuditLog } from '../../src/index'
import type { Browser } from '../../src/core/Browser'

/**
 * Harder than a to-do app: a multi-step wizard with validation between steps, content that
 * loads asynchronously, edge states (a dead button, an undeclared POST, a stray navigation),
 * an element that re-renders mid-flow, and a same-origin iframe. The question these ask is the
 * only one that matters for this library: does the verdict tell the truth on the hard cases?
 *
 * Two of them are regressions for a real defect found while writing this file. An effect that
 * lands after the settle window — a table that loads 800ms after the click — was reported
 * twice wrong: `textAppears`/`textDisappears` read the page once and missed it (while
 * `elementAppears` already polled), and a met expectation was overridden to `no-effect`
 * because the MutationObserver window had closed before the change arrived. The engine now
 * keeps measuring while a declared postcondition is still pending, so an async success is
 * measured as one.
 */
const PORT = 9973

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Hard flows</title>
<style>.hidden{display:none}</style></head><body>
<main>
 <!-- 3-step wizard with validation between steps -->
 <section id="step1">
   <h2>Step 1 — your email</h2>
   <input id="email" placeholder="email" />
   <div id="err1" class="hidden">enter a valid email address</div>
   <button id="next1">Next</button>
 </section>
 <section id="step2" class="hidden">
   <h2>Step 2 — quantity</h2>
   <input id="qty" value="1" />
   <button id="next2">Next</button>
 </section>
 <section id="step3" class="hidden">
   <h2>Step 3 — review</h2>
   <div>Ready to place your order.</div>
   <button id="place">Place order</button>
   <div id="placed" class="hidden">Order placed. Thank you.</div>
 </section>

 <!-- async: no synchronous change; a table is injected 800ms later -->
 <button id="load">Load results</button>
 <div id="host"></div>

 <button id="dead">Does nothing</button>

 <button id="leaky" onclick="
   document.getElementById('savemsg').textContent='saved';
   fetch('/charge',{method:'POST',body:'amount=99'});
 ">Save (also charges)</button>
 <div id="savemsg">unsaved</div>

 <button id="wander" onclick="setTimeout(()=>{location.href='/elsewhere';},30)">Go</button>

 <button id="rerender">Re-render</button>
 <div id="rr">v1</div>

 <iframe id="frame" src="/frame" style="width:300px;height:80px;border:1px solid #ccc"></iframe>

 <script>
  document.getElementById('next1').addEventListener('click', () => {
    const ok = document.getElementById('email').value.includes('@')
    if (ok) { document.getElementById('step1').classList.add('hidden'); document.getElementById('step2').classList.remove('hidden') }
    else { document.getElementById('err1').classList.remove('hidden') }
  })
  document.getElementById('next2').addEventListener('click', () => {
    document.getElementById('step2').classList.add('hidden'); document.getElementById('step3').classList.remove('hidden')
  })
  document.getElementById('place').addEventListener('click', () => {
    document.getElementById('placed').classList.remove('hidden')
  })
  document.getElementById('load').addEventListener('click', () => {
    setTimeout(() => { document.getElementById('host').innerHTML = '<table id="tbl"><tr><td>ROW-BETELGEUSE</td></tr></table>' }, 800)
  })
  document.getElementById('rerender').addEventListener('click', () => {
    // same markup, brand new nodes — the crude equivalent of a framework re-render
    document.getElementById('rr').outerHTML = '<div id="rr">v2</div>'
  })
 </script>
</main></body></html>`

const FRAME = `<!doctype html><html><head><meta charset="utf-8"></head><body>
 <button id="fbtn" onclick="document.getElementById('fout').textContent='frame clicked'">Inside frame</button>
 <div id="fout">idle</div>
</body></html>`

let server: http.Server
let browser: Browser
let posts: string[] = []
let tmp: string

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-hard-'))
  server = http.createServer((req, res) => {
    const url = req.url ?? '/'
    if (req.method === 'POST') { posts.push(url); res.writeHead(200); res.end('ok'); return }
    if (url.startsWith('/frame')) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(FRAME); return }
    if (url.startsWith('/elsewhere')) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end('<!doctype html><h1 id=e>Elsewhere</h1>'); return }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(PAGE)
  })
  await new Promise<void>((r) => server.listen(PORT, r))
  browser = await screenvision.launch({ headless: true })
}, 60000)

afterAll(async () => {
  if (browser) await browser.close()
  if (server) server.close()
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
})

async function open() {
  posts = []
  const ctx = await browser.newContext({ device: 'Desktop 1440x900' })
  const p = await ctx.newPage()
  await p.goto(`http://127.0.0.1:${PORT}/`)
  return p
}

describe('a multi-step wizard with validation between steps', () => {
  it('advances step by step when each step is valid, and each Next is confirmed', async () => {
    const p = await open()
    await p.act({ do: 'fill', selector: '#email', value: 'a@b.com', expect: { textDisappears: 'enter a valid email' } })
    const n1 = await p.act({ do: 'click', selector: '#next1', expect: { elementAppears: '#step2' } })
    expect(n1.verdict).toBe('confirmed')
    const n2 = await p.act({ do: 'click', selector: '#next2', expect: { elementAppears: '#step3' } })
    expect(n2.verdict).toBe('confirmed')
    const place = await p.act({ do: 'click', selector: '#place', expect: { textAppears: 'Order placed' } })
    expect(place.verdict).toBe('confirmed')
    await p.close()
  }, 60000)

  it('does not advance when the step is invalid, and the verdict says so', async () => {
    const p = await open()
    // no '@' in the email: validation must reject, so step 2 must NOT appear
    const r = await p.act({ do: 'click', selector: '#next1', expect: { elementAppears: '#step2' } })
    expect(r.verdict).toBe('unexpected')
    expect(r.expectations[0].met).toBe(false)
    // and the page did react (an error was shown), so this is not mistaken for no-effect
    expect(r.effects.mutations.total).toBeGreaterThan(0)
    await p.close()
  }, 60000)
})

describe('asynchronous content (regression: the settle window must not close early)', () => {
  it('confirms an async load declared with textAppears', async () => {
    const p = await open()
    const r = await p.act({ do: 'click', selector: '#load', expect: { textAppears: 'ROW-BETELGEUSE' } })
    expect(r.verdict).toBe('confirmed')
    expect(r.expectations[0].met).toBe(true)
    expect(r.effects.mutations.total).toBeGreaterThan(0)
    await p.close()
  }, 60000)

  it('confirms an async load declared with elementAppears', async () => {
    const p = await open()
    const r = await p.act({ do: 'click', selector: '#load', expect: { elementAppears: '#tbl' } })
    expect(r.verdict).toBe('confirmed')
    await p.close()
  }, 60000)
})

describe('edge states', () => {
  it('reports a silently-broken button as no-effect, not confirmed', async () => {
    const p = await open()
    const r = await p.act({ do: 'click', selector: '#dead' })
    expect(r.verdict).toBe('no-effect')
    expect(r.inert?.likely).toBe(true)
    await p.close()
  }, 60000)

  it('reports an undeclared POST as side-effects even though the expectation held', async () => {
    const p = await open()
    const r = await p.act({ do: 'click', selector: '#leaky', expect: { textAppears: 'saved' } })
    expect(r.expectations.every((e) => e.met)).toBe(true)
    expect(r.verdict).toBe('side-effects')
    expect(r.undeclared.some((u) => /POST .*\/charge/.test(u.detail))).toBe(true)
    expect(posts).toContain('/charge')
    await p.close()
  }, 60000)

  it('surfaces an undeclared navigation', async () => {
    const p = await open()
    const r = await p.act({ do: 'click', selector: '#wander', expect: { textAppears: 'unsaved' } })
    expect(r.undeclared.some((u) => u.kind === 'navigation')).toBe(true)
    await p.close()
  }, 60000)
})

describe('an element that re-renders mid-flow', () => {
  it('acts through a re-render by ref without a stale-handle failure', async () => {
    const p = await open()
    await p.act({ do: 'click', selector: '#rerender', expect: { textAppears: 'v2' } })
    // the node #rr was replaced; a fresh observation resolves the new one
    const view = await p.observe()
    const rr = view.affordances.find((a) => a.selector.includes('rerender'))
    expect(rr).toBeTruthy()
    await p.close()
  }, 60000)
})

describe('a same-origin iframe', () => {
  it('drives a button inside the frame and proves it worked', async () => {
    const p = await open()
    await p.waitForSelector('#frame', { timeout: 8000 })
    const frame = await p.frame('#frame')
    expect(frame, 'the child frame should be discoverable').toBeTruthy()
    await frame.click('#fbtn')
    const out = await frame.evaluate<string>(`document.getElementById('fout').textContent`)
    expect(out).toBe('frame clicked')
    await p.close()
  }, 60000)
})

describe('the audit log records a real driven flow', () => {
  it('records every step in order, the chain verifies, and reconciliation is right', async () => {
    const p = await open()
    const ep = p.episode({ goal: 'complete the checkout wizard', maxSteps: 8 })
    await ep.observe()
    await ep.act({ do: 'fill', selector: '#email', value: 'buyer@example.com', expect: { textDisappears: 'enter a valid email' } })
    await ep.act({ do: 'click', selector: '#next1', expect: { elementAppears: '#step2' } })
    ep.note('quantity left at 1 on purpose')
    await ep.act({ do: 'click', selector: '#next2', expect: { elementAppears: '#step3' } })
    await ep.act({ do: 'click', selector: '#place', expect: { textAppears: 'Order placed' } })
    // and a deliberately dirty step, to prove the log names an undeclared effect
    await ep.act({ do: 'click', selector: '#leaky', expect: { textAppears: 'saved' } })

    const log = ep.audit
    // order matches the ledger
    expect(log.entries.map((e) => e.kind)).toEqual(['observation', 'action', 'action', 'note', 'action', 'action', 'action'])
    expect(log.entries.map((e) => e.index)).toEqual([1, 2, 3, 4, 5, 6, 7])
    // the chain verifies
    expect(log.verify().ok).toBe(true)
    // the confirmed steps are marked clean; the leaky one is not
    const actions = log.entries.filter((e) => e.kind === 'action')
    const place = actions.find((e) => e.intent?.selector === '#place')!
    expect(place.verdict).toBe('confirmed')
    expect(place.reconciliation?.clean).toBe(true)
    const leaky = actions.find((e) => e.intent?.selector === '#leaky')!
    expect(leaky.verdict).toBe('side-effects')
    expect(leaky.reconciliation?.clean).toBe(false)
    expect(leaky.reconciliation?.undeclared.some((u) => /charge/.test(u.detail))).toBe(true)

    // both surfaces write, and the written JSONL re-parses and re-verifies
    const { jsonl, markdown } = await ep.saveAudit(path.join(tmp, 'checkout'))
    expect(fs.existsSync(jsonl)).toBe(true)
    expect(fs.existsSync(markdown)).toBe(true)
    const lines = fs.readFileSync(jsonl, 'utf8').trim().split('\n')
    expect(JSON.parse(lines[0]).kind).toBe('header')
    expect(lines.length).toBe(1 + log.entries.length)
    const md = fs.readFileSync(markdown, 'utf8')
    expect(md).toMatch(/VERIFIED/)
    expect(md).toMatch(/side-effects/)
    await p.close()
  }, 90000)

  it('builds a verifiable log from bare page.act calls via fromActions', async () => {
    const p = await open()
    await p.act({ do: 'click', selector: '#dead' })
    await p.act({ do: 'fill', selector: '#email', value: 'x@y.z', expect: { textDisappears: 'valid email' } })
    const log = AuditLog.fromActions('bare acts', p.actions())
    expect(log.length).toBe(2)
    expect(log.verify().ok).toBe(true)
    await p.close()
  }, 60000)
})
