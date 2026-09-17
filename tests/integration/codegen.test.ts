import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'http'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import screenvision from '../../src/index'
import type { Browser } from '../../src/core/Browser'

/**
 * Codegen: record a flow and generate the script that reproduces it.
 *
 * The interactions are driven through the library rather than by a human hand, which is a
 * fair proxy: the recorder listens to real DOM events in the capture phase, and a synthesised
 * click produces the same event a person's click does.
 *
 * The thing actually worth testing is selector quality. A recording full of positional
 * selectors is worse than no recording, so these assert that a test id wins over an id, an
 * accessible name wins over structure, and typing collapses into one fill.
 */
const PORT = 9958

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Codegen</title>
<meta name="viewport" content="width=device-width, initial-scale=1"></head><body>
<main>
 <h1>Sign up</h1>
 <input data-testid="email-field" id="email" aria-label="email">
 <input id="nickname">
 <input type="checkbox" id="terms">
 <select id="plan"><option value="free">Free</option><option value="pro">Pro</option></select>
 <button data-testid="submit-button" id="go">Create account</button>
 <button aria-label="cancel">Cancel</button>
 <div id="out"></div>
</main></body></html>`

let server: http.Server
let browser: Browser
let tmp: string

beforeAll(async () => {
  server = http.createServer((_q, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(PAGE)
  })
  await new Promise<void>((r) => server.listen(PORT, r))
  browser = await screenvision.launch({ headless: true })
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sv-codegen-'))
}, 60000)

afterAll(async () => {
  if (browser) await browser.close()
  if (server) server.close()
  if (tmp) await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined)
})

async function open() {
  const ctx = await browser.newContext({ device: 'Desktop 1440x900' })
  const p = await ctx.newPage()
  await p.goto(`http://127.0.0.1:${PORT}/`)
  return p
}

describe('recording', () => {
  it('captures clicks, typing, checkboxes and selects', async () => {
    const p = await open()
    await p.record.start()
    await p.fill('#email', 'dana@example.com')
    await p.click('[data-testid="submit-button"]')
    await p.check('#terms')
    await p.selectOption('#plan', 'pro')
    const steps = await p.record.stop()

    const kinds = steps.map((s) => s.kind)
    expect(kinds).toContain('goto')
    expect(kinds).toContain('fill')
    expect(kinds).toContain('click')
    expect(kinds).toContain('check')
    expect(kinds).toContain('select')
    await p.close()
  }, 90000)

  it('prefers a test id over an id, and an accessible name over structure', async () => {
    const p = await open()
    await p.record.start()
    await p.click('[data-testid="submit-button"]')
    await p.click('button[aria-label="cancel"]')
    const steps = await p.record.stop()
    const clicks = steps.filter((s) => s.kind === 'click').map((s) => s.selector)
    expect(clicks).toContain('[data-testid="submit-button"]')
    expect(clicks).toContain('button[aria-label="cancel"]')
    // never a positional path when something better exists
    expect(clicks.every((s) => !s.includes('nth-of-type'))).toBe(true)
    await p.close()
  }, 90000)

  it('collapses a burst of typing into one fill with the final value', async () => {
    const p = await open()
    await p.record.start()
    await p.fill('#nickname', 'dana')
    await p.fill('#nickname', 'dana reyes')
    const steps = await p.record.stop()
    const fills = steps.filter((s) => s.kind === 'fill')
    expect(fills).toHaveLength(1)
    expect(fills[0].value).toBe('dana reyes')
    await p.close()
  }, 90000)

  it('writes a runnable test file that uses act, not bare clicks', async () => {
    const p = await open()
    await p.record.start()
    await p.fill('#email', 'dana@example.com')
    await p.click('[data-testid="submit-button"]')
    await p.record.stop()
    const out = await p.record.writeTest(path.join(tmp, 'recorded.spec.ts'), { name: 'signs up' })
    const source = await fs.readFile(out, 'utf8')

    expect(source).toContain("import { describe, it } from 'screenvision'")
    expect(source).toContain("it(\"signs up\"")
    expect(source).toContain('await page.goto(')
    // act() so a recorded flow reports a step that silently stops working
    expect(source).toContain("do: 'fill'")
    expect(source).toContain("do: 'click'")
    expect(source).toContain('[data-testid="submit-button"]')
    expect(source).not.toContain('page.click(')
    await p.close()
  }, 90000)

  it('refuses to stop when nothing was started', async () => {
    const p = await open()
    await expect(p.record.stop()).rejects.toThrow(/nothing is being recorded/)
    await p.close()
  }, 60000)
})
