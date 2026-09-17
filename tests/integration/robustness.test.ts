import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'http'
import fs from 'fs'
import os from 'os'
import screenvision from '../../src/index'
import { keyDefinition } from '../../src/cdp/ProtocolMapper'
import type { Browser } from '../../src/core/Browser'

/**
 * Regression tests for the correctness audit.
 *
 * Each of these was a confirmed, reproduced defect: a verification that passed without
 * checking anything, errors that named an internal step instead of the caller's operation,
 * values that crossed the protocol as `{}` or `undefined`, punctuation keys that arrived
 * with no code, listeners that were never released, and a route handler that could suspend
 * a request forever.
 */
const PORT = 9919

const HTML = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"></head><body>
<nav data-testid="navbar" role="navigation"><a href="/a">A</a></nav>
<input id="field"><div id="keys"></div>
<script>
 document.getElementById('field').addEventListener('keydown', (e) => {
   document.getElementById('keys').textContent = e.key + '|' + e.code + '|' + e.keyCode
 })
</script></body></html>`

let server: http.Server
let browser: Browser

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if ((req.url ?? '').startsWith('/data')) {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('origin-data')
      return
    }
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(HTML)
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

describe('verify refuses to assert nothing', () => {
  it('rejects an unknown option instead of passing', async () => {
    const p = await open()
    // `elements` is not an option; the plausible typo for `contains`
    await expect(
      p.verify({ elements: ['navigation bar'] } as unknown as Parameters<typeof p.verify>[0])
    ).rejects.toThrow(/unknown option elements/)
    await p.close()
  }, 60000)

  it('rejects an empty option object', async () => {
    const p = await open()
    await expect(p.verify({})).rejects.toThrow(/nothing to check/)
    await p.close()
  }, 60000)

  it('still verifies normally when a real check is present', async () => {
    const p = await open()
    const r = await p.verify({ contains: ['navigation bar'] })
    expect(r.pass).toBe(true)
    await p.close()
  }, 60000)
})

describe('errors name the operation the caller made', () => {
  it('a failed click says click, and quotes the selector', async () => {
    const p = await open()
    await expect(p.click('#does-not-exist', { timeout: 700 })).rejects.toThrow(/^click\("#does-not-exist"\) failed:/)
    await p.close()
  }, 60000)

  it('a failed fill says fill', async () => {
    const p = await open()
    await expect(p.fill('#does-not-exist', 'x', { timeout: 700 })).rejects.toThrow(/^fill\("#does-not-exist"\) failed:/)
    await p.close()
  }, 60000)
})

describe('values that cannot cross the protocol are refused, not faked', () => {
  it('returns NaN as NaN rather than undefined', async () => {
    const p = await open()
    expect(await p.evaluate<number>('0/0')).toBeNaN()
    expect(await p.evaluate<number>('1/0')).toBe(Infinity)
    await p.close()
  }, 60000)

  it('refuses a DOM node instead of returning an empty object', async () => {
    const p = await open()
    await expect(p.evaluate('document.body')).rejects.toThrow(/cannot be serialised/)
    await p.close()
  }, 60000)

  it('refuses a function instead of returning an empty object', async () => {
    const p = await open()
    await expect(p.evaluate('(function(){})')).rejects.toThrow(/returned a function/)
    await p.close()
  }, 60000)

  it('still returns ordinary values, including null', async () => {
    const p = await open()
    expect(await p.evaluate<number>('1 + 1')).toBe(2)
    expect(await p.evaluate<null>('null')).toBeNull()
    expect(await p.evaluate<string[]>('["a","b"]')).toEqual(['a', 'b'])
    await p.close()
  }, 60000)
})

describe('punctuation keys carry a code and keyCode', () => {
  it('maps punctuation the way a real keyboard does', () => {
    expect(keyDefinition('.')).toMatchObject({ code: 'Period', keyCode: 190 })
    expect(keyDefinition('/')).toMatchObject({ code: 'Slash', keyCode: 191 })
    expect(keyDefinition('-')).toMatchObject({ code: 'Minus', keyCode: 189 })
    expect(keyDefinition('a')).toMatchObject({ code: 'KeyA' })
  })

  it('the page sees the code for a punctuation key', async () => {
    const p = await open()
    await p.focus('#field')
    await p.keyboard.press('/')
    expect(await p.evaluate<string>(`document.getElementById('keys').textContent`)).toBe('/|Slash|191')
    await p.close()
  }, 60000)
})

describe('resources are released', () => {
  it('closing a page removes the session listeners it registered', async () => {
    const ctx = await browser.newContext({ device: 'Desktop 1440x900' })
    const count = (): number => browser.listenerCount()
    const before = count()
    for (let i = 0; i < 5; i++) {
      const p = await ctx.newPage()
      await p.goto(`http://127.0.0.1:${PORT}/`)
      await p.close()
    }
    // a small residue is fine; unbounded growth per page is the defect
    expect(count() - before).toBeLessThan(5)
  }, 90000)

  it('leaves no temporary profile directory behind', async () => {
    const profileDirs = (): Set<string> =>
      new Set(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('screenvision-profile-')))
    // other test files launch their own browsers in parallel, so count only the directory
    // this launch creates rather than the total
    const before = profileDirs()
    const b = await screenvision.launch({ headless: true })
    const mine = [...profileDirs()].filter((n) => !before.has(n))
    const c = await b.newContext({ device: 'Desktop 1440x900' })
    const p = await c.newPage()
    await p.goto(`http://127.0.0.1:${PORT}/`)
    await b.close()
    // cleanup deliberately retries while the browser's children release their handles, so
    // poll for the directory to go rather than assuming a fixed delay is enough
    const remaining = (): string[] => {
      const now = profileDirs()
      return mine.filter((n) => now.has(n))
    }
    const deadline = Date.now() + 20000
    while (remaining().length > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 500))
    }
    expect(remaining()).toEqual([])
  }, 90000)
})

describe('routing never suspends a request forever', () => {
  it('a handler that answers nothing still lets the request through', async () => {
    const ctx = await browser.newContext({ device: 'Desktop 1440x900' })
    const p = await ctx.newPage()
    let seen = 0
    // the common mistake: an early return without fulfill/continue/abort
    await p.route('**/data*', async () => {
      seen++
    })
    await p.goto(`http://127.0.0.1:${PORT}/`)
    const body = await p.evaluate<string>(`fetch('/data').then(r => r.text())`)
    expect(seen).toBeGreaterThan(0)
    expect(body).toBe('origin-data')
    await p.close()
  }, 60000)

  it('a handler that fulfils still wins', async () => {
    const ctx = await browser.newContext({ device: 'Desktop 1440x900' })
    const p = await ctx.newPage()
    await p.route('**/data*', async (route) => {
      await route.fulfill({ status: 200, contentType: 'text/plain', body: 'stubbed' })
    })
    await p.goto(`http://127.0.0.1:${PORT}/`)
    expect(await p.evaluate<string>(`fetch('/data').then(r => r.text())`)).toBe('stubbed')
    await p.close()
  }, 60000)
})
