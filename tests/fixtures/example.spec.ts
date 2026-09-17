/**
 * A test file written against ScreenVision's own runner, used to prove the runner works
 * end to end rather than only that it compiles.
 *
 * It is deliberately shaped like a test file a user would write: a describe block, a
 * beforeEach that navigates, page assertions that retry, one deliberate failure and one skip.
 * It is not run by vitest; `runner-e2e.test.ts` invokes it through `runTests`.
 */
import http from 'http'
import { describe, it, beforeEach, expect } from '../../src/index'
import type { Page } from '../../src/core/Page'

const PORT = 9957

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Runner fixture</title>
<meta name="viewport" content="width=device-width, initial-scale=1"></head><body>
<main>
 <h1>Fixture</h1>
 <button id="go" onclick="document.getElementById('out').textContent='clicked'">Go</button>
 <span data-testid="badge">0</span>
 <div id="out"></div>
</main>
<script>setTimeout(() => { document.querySelector('[data-testid=badge]').textContent = '7' }, 300)</script>
</body></html>`

// a module-scope server, started once, because every test in the file needs it
let server: http.Server | null = null
if (!server) {
  server = http.createServer((_q, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(PAGE)
  })
  server.listen(PORT)
  server.unref()
}

describe('example suite', () => {
  beforeEach(async (page: Page) => {
    await page.goto(`http://127.0.0.1:${PORT}/`)
  })

  it('reads the title', async (page) => {
    expect(await page.title()).toBe('Runner fixture')
  })

  it('waits for text that arrives late', async (page) => {
    await page.expect('badge').toHaveText('7')
  })

  it('acts and confirms the effect', async (page) => {
    const result = await page.act({ do: 'click', selector: '#go' })
    expect(result.verdict).toBe('confirmed')
    expect(await page.evaluate<string>(`document.getElementById('out').textContent`)).toBe('clicked')
  })

  it('fails on purpose, to prove failures are reported', async (page) => {
    expect(await page.title()).toBe('this is not the title')
  })

  it.skip('is skipped', async () => {
    throw new Error('this must never run')
  })
})
