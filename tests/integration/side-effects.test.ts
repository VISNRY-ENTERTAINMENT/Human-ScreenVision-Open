import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'http'
import screenvision from '../../src/index'
import type { Browser } from '../../src/core/Browser'

/**
 * The dangerous verdict: the action did what was asked, **and something else**.
 *
 * Every screenshot-driven agent reports this as plain success, because the next screenshot
 * shows the expected outcome and nothing in an image says "a POST also went out". The
 * literature on computer-use agents names the consequence directly — frontier models "lack
 * active concern for user safety, resulting in harmful side effects during execution" — and
 * that is an environment failure, not a model failure: an agent cannot avoid a side effect
 * nobody reports to it.
 *
 * The boundary only exists when the caller declares one. Without `expect` there is nothing
 * for an effect to fall outside of, so `undeclared` stays empty and the older verdicts are
 * unchanged.
 */
const PORT = 9958

let posts: string[] = []

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Side</title></head><body>
<main>
 <button id="clean" onclick="document.getElementById('out').textContent='saved'">Save draft</button>

 <button id="dirty" onclick="
   document.getElementById('out').textContent='saved';
   fetch('/charge', { method: 'POST', body: 'amount=4200' })
 ">Save draft (also charges)</button>

 <button id="reads" onclick="
   document.getElementById('out').textContent='saved';
   fetch('/lookup?q=1')
 ">Save draft (reads only)</button>

 <button id="declared" onclick="
   document.getElementById('out').textContent='saved';
   fetch('/expected-endpoint', { method: 'POST', body: 'x=1' })
 ">Save draft (declared post)</button>

 <button id="noisy" onclick="
   document.getElementById('out').textContent='saved';
   setTimeout(() => { null.boom }, 0)
 ">Save draft (throws)</button>

 <button id="wanders" onclick="
   document.getElementById('out').textContent='saved';
   setTimeout(() => { location.href='/elsewhere' }, 30)
 ">Save draft (navigates)</button>

 <div id="out">none</div>
</main></body></html>`

let server: http.Server
let browser: Browser

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = req.url ?? '/'
    if (req.method === 'POST') {
      posts.push(url)
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('ok')
      return
    }
    if (url.startsWith('/lookup')) {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('ok')
      return
    }
    if (url.startsWith('/elsewhere')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<!doctype html><html><body><h1 id="m">Elsewhere</h1></body></html>')
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
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
  posts = []
  const ctx = await browser.newContext({ device: 'Desktop 1440x900' })
  const p = await ctx.newPage()
  await p.goto(`http://127.0.0.1:${PORT}/`)
  return p
}

describe('an action that does what was asked and nothing else', () => {
  it('is confirmed', async () => {
    const p = await open()
    const result = await p.act({
      do: 'click',
      selector: '#clean',
      expect: { textAppears: 'saved' },
    })
    expect(result.verdict).toBe('confirmed')
    expect(result.undeclared).toEqual([])
    await p.close()
  }, 60000)

  it('is still confirmed when it only reads from the server', async () => {
    const p = await open()
    const result = await p.act({
      do: 'click',
      selector: '#reads',
      expect: { textAppears: 'saved' },
    })
    // a GET changes nothing; flagging every fetch would make this useless on a real page
    expect(result.verdict).toBe('confirmed')
    expect(result.undeclared).toEqual([])
    await p.close()
  }, 60000)
})

describe('an action that also does something undeclared', () => {
  it('reports side-effects rather than success when it posts somewhere', async () => {
    const p = await open()
    const result = await p.act({
      do: 'click',
      selector: '#dirty',
      expect: { textAppears: 'saved' },
    })
    // the expectation held: a screenshot-based agent sees "saved" and moves on
    expect(result.expectations.every((e) => e.met)).toBe(true)
    expect(result.verdict).toBe('side-effects')
    expect(result.undeclared.some((u) => u.kind === 'write-request')).toBe(true)
    expect(result.undeclared.find((u) => u.kind === 'write-request')!.detail).toMatch(
      /POST .*\/charge/
    )
    // and the summary says so in one line, without the caller parsing anything
    expect(result.summary).toMatch(/undeclared/)
    expect(result.summary).toMatch(/POST/)
    expect(posts).toContain('/charge')
    await p.close()
  }, 60000)

  it('does not flag the write the caller declared', async () => {
    const p = await open()
    const result = await p.act({
      do: 'click',
      selector: '#declared',
      expect: { textAppears: 'saved', requestMade: '/expected-endpoint' },
    })
    expect(result.verdict).toBe('confirmed')
    expect(result.undeclared).toEqual([])
    await p.close()
  }, 60000)

  it('reports an undeclared navigation alongside the failed expectation', async () => {
    const p = await open()
    const result = await p.act({
      do: 'click',
      selector: '#wanders',
      expect: { textAppears: 'saved' },
    })
    // The declaration genuinely did not hold at the end of the action -- the page navigated
    // away, taking the text with it -- so `unexpected` is the right verdict and a failed
    // declaration outranks anything extra. But the navigation is the *reason*, so it is
    // reported too: the caller needs both facts, not a verdict that hides one of them.
    expect(result.verdict).toBe('unexpected')
    expect(result.undeclared.some((u) => u.kind === 'navigation')).toBe(true)
    await p.close()
  }, 60000)

  it('reports side-effects when a navigation happens and the declaration still holds', async () => {
    const p = await open()
    const result = await p.act({
      do: 'click',
      selector: '#wanders',
      // satisfied on the page we land on, so the declaration survives the navigation
      expect: { textAppears: 'Elsewhere' },
    })
    expect(result.expectations.every((e) => e.met)).toBe(true)
    expect(result.verdict).toBe('side-effects')
    expect(result.undeclared.some((u) => u.kind === 'navigation')).toBe(true)
    await p.close()
  }, 60000)

  it('does not flag a navigation the caller declared', async () => {
    const p = await open()
    const result = await p.act({
      do: 'click',
      selector: '#wanders',
      expect: { urlContains: '/elsewhere' },
    })
    expect(result.undeclared.some((u) => u.kind === 'navigation')).toBe(false)
    await p.close()
  }, 60000)

  it('reports a console error raised during the action', async () => {
    const p = await open()
    const result = await p.act({
      do: 'click',
      selector: '#noisy',
      expect: { textAppears: 'saved' },
    })
    // "it worked, and it threw" is not success; an agent that cannot see this keeps going
    expect(result.verdict).toBe('side-effects')
    expect(result.undeclared.some((u) => u.kind === 'console-error')).toBe(true)
    await p.close()
  }, 60000)
})

describe('the boundary only exists when one is declared', () => {
  it('stays silent about side effects when nothing was expected', async () => {
    const p = await open()
    const result = await p.act({ do: 'click', selector: '#dirty' })
    // without a declaration there is nothing to be outside of, so the older behaviour holds
    expect(result.undeclared).toEqual([])
    expect(result.verdict).toBe('confirmed')
    await p.close()
  }, 60000)

  it('still reports a failed expectation as unexpected, not as a side effect', async () => {
    const p = await open()
    const result = await p.act({
      do: 'click',
      selector: '#dirty',
      expect: { textAppears: 'this never appears' },
    })
    // a declaration that did not hold outranks anything extra that happened
    expect(result.verdict).toBe('unexpected')
    await p.close()
  }, 60000)
})
