import { describe, it, expect as vExpect, beforeAll, afterAll } from 'vitest'
import http from 'http'
import screenvision from '../../src/index'
import type { Browser } from '../../src/core/Browser'

/**
 * Retrying assertions.
 *
 * A one-shot check on a live page is a race, so each assertion must re-resolve and re-read
 * until the condition holds. These cover a condition that only becomes true later, one that
 * never becomes true (where the message has to say what was actually there), and the
 * negated form.
 */
const PORT = 9920

const HTML = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"></head><body>
<nav data-testid="navbar" role="navigation"><a href="/a">A</a></nav>
<span data-testid="cart-badge">0</span>
<button data-testid="submit-button" disabled>Send</button>
<input data-testid="email-input" value="">
<div data-testid="error-banner" style="display:none">Something failed</div>
<script>
 setTimeout(() => { document.querySelector('[data-testid="cart-badge"]').textContent = '3' }, 500)
 setTimeout(() => { document.querySelector('[data-testid="submit-button"]').removeAttribute('disabled') }, 600)
 setTimeout(() => { document.querySelector('[data-testid="email-input"]').value = 'a@b.c' }, 400)
</script></body></html>`

let server: http.Server
let browser: Browser

beforeAll(async () => {
  server = http.createServer((_q, res) => {
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

describe('assertions wait for the page to get there', () => {
  it('waits for text that arrives later', async () => {
    const p = await open()
    await p.expect('cart badge').toHaveText('3')
    await p.close()
  }, 60000)

  it('waits for a button to become enabled', async () => {
    const p = await open()
    await p.expect('submit button').toBeEnabled()
    await p.close()
  }, 60000)

  it('waits for an input value', async () => {
    const p = await open()
    await p.expect('email input').toHaveValue('a@b.c')
    await p.close()
  }, 60000)

  it('passes immediately for something already true', async () => {
    const p = await open()
    await p.expect('navigation bar').toBeVisible()
    await p.close()
  }, 60000)
})

describe('the failure message says what was actually there', () => {
  it('reports the real text when it never matches', async () => {
    const p = await open()
    await vExpect(p.expect('cart badge').toHaveText('99', { timeout: 1200 })).rejects.toThrow(
      /expected "cart badge".*have text containing "99".*but its text is "3"/s
    )
    await p.close()
  }, 60000)

  it('says nothing matched when the element does not exist', async () => {
    const p = await open()
    await vExpect(p.expect('checkout wizard').toBeVisible({ timeout: 1200 })).rejects.toThrow(
      /no element matched the description/
    )
    await p.close()
  }, 60000)

  it('reports the waiting time', async () => {
    const p = await open()
    await vExpect(p.expect('cart badge').toHaveText('99', { timeout: 900 })).rejects.toThrow(/after waiting 900ms/)
    await p.close()
  }, 60000)
})

describe('the negated form', () => {
  it('passes for a hidden element', async () => {
    const p = await open()
    await p.expect('error banner').not.toBeVisible()
    await p.close()
  }, 60000)

  it('fails when the element is in fact visible', async () => {
    const p = await open()
    await vExpect(p.expect('navigation bar').not.toBeVisible({ timeout: 900 })).rejects.toThrow(/should not|but it did/)
    await p.close()
  }, 60000)
})
