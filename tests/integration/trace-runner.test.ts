import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'http'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import zlib from 'zlib'
import screenvision from '../../src/index'

import { Runner, writeJUnitReport } from '../../src/runner/Runner'
import type { Browser } from '../../src/core/Browser'

/**
 * Read the trace payload back out of the viewer.
 * @param html - The written report
 * @returns The decoded payload
 */
function inflate(html: string): {
  entries: Array<Record<string, unknown>>
  shots: string[]
  snapshots: string[]
  network: Array<Record<string, unknown>>
} {
  const match = /type="application\/gzip-base64">([\s\S]*?)<\/script>/.exec(html)
  if (!match) throw new Error('no payload found in the trace')
  return JSON.parse(zlib.gunzipSync(Buffer.from(match[1].trim(), 'base64')).toString('utf8'))
}

/**
 * Tracing and the parallel runner.
 *
 * These close the two things a conventional automation library offers that this one did not:
 * a record of what happened that you can read after a CI failure, and a way to run many
 * browser jobs at once without them interfering. The trace is the differentiated one, because
 * each step carries the verdict for its action rather than only the fact that it was
 * dispatched.
 */
const PORT = 9948

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Trace demo</title>
<meta name="viewport" content="width=device-width, initial-scale=1"></head><body>
<main>
 <h1>Demo</h1>
 <button id="works" onclick="document.getElementById('out').textContent='done'">Works</button>
 <button id="dead">Dead</button>
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
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sv-trace-'))
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

describe('trace', () => {
  it('writes one self-contained HTML file with a step per action', async () => {
    const p = await open()
    await p.trace.start({ title: 'demo run' })
    await p.act({ do: 'click', selector: '#works' })
    await p.act({ do: 'click', selector: '#dead' })
    const out = await p.trace.stop(path.join(tmp, 'demo.html'))
    const html = await fs.readFile(out, 'utf8')

    const payload = inflate(html)
    expect(html).toContain('demo run')
    expect(payload.entries.map((e: { label: string }) => e.label).join(' ')).toContain('click #works')
    // the differentiated part: the verdict is in the report, not just the action
    const verdicts = payload.entries.map((e: { verdict?: string }) => e.verdict).filter(Boolean)
    expect(verdicts).toContain('confirmed')
    expect(verdicts).toContain('no-effect')
    // self-contained: no external assets of any kind
    expect(html).not.toMatch(/<script src=|<link rel="stylesheet"/)
    expect(payload.shots.length).toBeGreaterThan(0)
    await p.close()
  }, 90000)

  it('counts the actions that did not confirm', async () => {
    const p = await open()
    await p.trace.start()
    await p.act({ do: 'click', selector: '#dead' })
    const out = await p.trace.stop(path.join(tmp, 'failing.html'))
    const payload = inflate(await fs.readFile(out, 'utf8'))
    const notConfirmed = payload.entries.filter(
      (e: { verdict?: string }) => e.verdict && e.verdict !== 'confirmed'
    )
    expect(notConfirmed).toHaveLength(1)
    await p.close()
  }, 90000)

  it('records notes and navigations, and can skip screenshots', async () => {
    const p = await open()
    await p.trace.start({ screenshots: false })
    await p.trace.note('about to reload')
    await p.goto(`http://127.0.0.1:${PORT}/?second`)
    const entries = (await p.trace.stop(path.join(tmp, 'notes.html'))) && true
    expect(entries).toBe(true)
    const payload = inflate(await fs.readFile(path.join(tmp, 'notes.html'), 'utf8'))
    const labels = payload.entries.map((e: { label: string }) => e.label).join(' | ')
    expect(labels).toContain('about to reload')
    expect(labels).toContain('goto')
    expect(payload.shots).toHaveLength(0)
    await p.close()
  }, 90000)

  it('refuses to stop a trace that was never started', async () => {
    const p = await open()
    await expect(p.trace.stop(path.join(tmp, 'never.html'))).rejects.toThrow(/no trace is being recorded/)
    await p.close()
  }, 60000)
})

describe('parallel runner', () => {
  it('runs jobs concurrently, each isolated in its own context', async () => {
    const runner = new Runner(browser)
    const jobs = Array.from({ length: 6 }, (_, i) => ({
      name: `job-${i}`,
      run: async (page: import('../../src/core/Page').Page) => {
        await page.goto(`http://127.0.0.1:${PORT}/`)
        await page.evaluate(`document.title = 'job ${i}'`)
        return page.title()
      },
    }))
    const results = await runner.run(jobs, { workers: 3 })
    expect(results).toHaveLength(6)
    expect(results.every((r) => r.status === 'passed')).toBe(true)
    // each job saw only its own title, which proves the contexts did not share a page
    expect(results.map((r) => r.value)).toEqual(jobs.map((_, i) => `job ${i}`))
  }, 120000)

  it('reports a failing job without stopping the others', async () => {
    const runner = new Runner(browser)
    const results = await runner.run(
      [
        { name: 'ok', run: async (p) => { await p.goto(`http://127.0.0.1:${PORT}/`); return 'fine' } },
        { name: 'bad', run: async () => { throw new Error('deliberate failure') } },
        { name: 'ok2', run: async (p) => { await p.goto(`http://127.0.0.1:${PORT}/`); return 'fine' } },
      ],
      { workers: 2 }
    )
    expect(results.map((r) => r.status)).toEqual(['passed', 'failed', 'passed'])
    expect(results[1].error).toContain('deliberate failure')
  }, 120000)

  it('retries a flaky job and reports the attempt count', async () => {
    const runner = new Runner(browser)
    let calls = 0
    const results = await runner.run(
      [
        {
          name: 'flaky',
          retries: 2,
          run: async () => {
            calls++
            if (calls < 3) throw new Error('not yet')
            return 'settled'
          },
        },
      ],
      { workers: 1 }
    )
    expect(results[0].status).toBe('passed')
    expect(results[0].attempts).toBe(3)
  }, 120000)

  it('enforces a per-job timeout', async () => {
    const runner = new Runner(browser)
    const results = await runner.run(
      [{ name: 'slow', run: async () => new Promise((r) => setTimeout(r, 5000)) }],
      { workers: 1, timeoutMs: 800 }
    )
    expect(results[0].status).toBe('failed')
    expect(results[0].error).toMatch(/timed out after 800ms/)
  }, 120000)

  it('writes a trace for a failing job', async () => {
    const runner = new Runner(browser)
    const dir = path.join(tmp, 'traces')
    const results = await runner.run(
      [
        {
          name: 'fails with trace',
          run: async (p) => {
            await p.goto(`http://127.0.0.1:${PORT}/`)
            await p.act({ do: 'click', selector: '#dead' })
            throw new Error('gave up')
          },
        },
      ],
      { workers: 1, traceDir: dir, traceOnFailure: true }
    )
    expect(results[0].status).toBe('failed')
    expect(results[0].trace).toBeDefined()
    const payload = inflate(await fs.readFile(results[0].trace!, 'utf8'))
    const labels = payload.entries.map((e: { label: string }) => e.label).join(' | ')
    expect(labels).toContain('gave up')
    expect(payload.entries.some((e: { verdict?: string }) => e.verdict === 'no-effect')).toBe(true)
  }, 120000)

  it('writes a JUnit report CI can read', async () => {
    const results = [
      { name: 'a', status: 'passed' as const, attempts: 1, durationMs: 120 },
      { name: 'b <special>', status: 'failed' as const, error: 'boom & crash', attempts: 2, durationMs: 300 },
    ]
    const out = await writeJUnitReport(results, path.join(tmp, 'junit.xml'))
    const xml = await fs.readFile(out, 'utf8')
    expect(xml).toContain('tests="2" failures="1"')
    expect(xml).toContain('b &lt;special&gt;')
    expect(xml).toContain('boom &amp; crash')
  }, 60000)
})
