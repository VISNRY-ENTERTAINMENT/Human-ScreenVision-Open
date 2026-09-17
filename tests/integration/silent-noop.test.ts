import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'http'
import screenvision from '../../src/index'
import type { Browser } from '../../src/core/Browser'

/**
 * Silent no-op measurement (GAP_AUDIT SV3). A "silent no-op" is the worst automation failure: the
 * action reports success but nothing happened. ScreenVision's actionability model is supposed to
 * THROW on these instead of silently succeeding. This runs a trap corpus and measures how many SV
 * catches vs silently no-ops; the assertion is that the silent-no-op count is zero on the corpus.
 */
const PORT = 9935
const SHELL = (body: string, script = ''): string =>
  `<!doctype html><html><head><meta charset="utf-8"></head><body>
<div id="log"></div>${body}
<script>function note(t){document.getElementById('log').textContent=String(t)}${script}</script></body></html>`

const PAGES: Record<string, string> = {
  // click target permanently covered by an overlay: a naive click lands on the veil, nothing fires
  '/covered': SHELL(`<button id="go" onclick="note('clicked')">Go</button><div style="position:fixed;inset:0;z-index:5"></div>`),
  // button never enabled
  '/disabled': SHELL(`<button id="go" disabled onclick="note('clicked')">Go</button>`),
  // readonly input: a fill that "succeeds" but leaves the value unchanged is a silent no-op
  '/readonly': SHELL(`<input id="i" value="orig" readonly>`),
  // element removed just before the action: acting on a detached node must not report success
  '/detached': SHELL(`<button id="go" onclick="note('clicked')">Go</button>`),
}

let server: http.Server
let browser: Browser
beforeAll(async () => {
  server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(PAGES[(req.url ?? '/').split('?')[0]] ?? SHELL('<p>none</p>'))
  })
  await new Promise<void>((r) => server.listen(PORT, r))
  browser = await screenvision.launch({ headless: true })
}, 60000)
afterAll(async () => {
  if (browser) await browser.close()
  if (server) server.close()
})
async function open(pathname: string) {
  const ctx = await browser.newContext({ device: 'Desktop 1440x900' })
  const p = await ctx.newPage()
  await p.goto(`http://127.0.0.1:${PORT}${pathname}`)
  return p
}
const logOf = (p: Awaited<ReturnType<typeof open>>) => p.evaluate<string>(`document.getElementById('log').textContent`)

describe('silent no-op measurement (SV3)', () => {
  it('measures the silent-no-op rate on a trap corpus (target: 0)', async () => {
    type Trap = { name: string; run: () => Promise<{ caught: boolean; effect: boolean }> }
    const traps: Trap[] = [
      {
        name: 'click covered element',
        run: async () => {
          const p = await open('/covered')
          let caught = false
          try {
            await p.click('#go', { timeout: 1500 })
          } catch {
            caught = true
          }
          return { caught, effect: (await logOf(p)) === 'clicked' }
        },
      },
      {
        name: 'click disabled button',
        run: async () => {
          const p = await open('/disabled')
          let caught = false
          try {
            await p.click('#go', { timeout: 1500 })
          } catch {
            caught = true
          }
          return { caught, effect: (await logOf(p)) === 'clicked' }
        },
      },
      {
        name: 'fill a readonly input',
        run: async () => {
          const p = await open('/readonly')
          let caught = false
          try {
            await p.fill('#i', 'changed', { timeout: 1500 })
          } catch {
            caught = true
          }
          return { caught, effect: (await p.locator('#i').inputValue()) === 'changed' }
        },
      },
      {
        name: 'click a detached element',
        run: async () => {
          const p = await open('/detached')
          const handle = await p.locator('#go').elementHandle()
          await p.evaluate(`document.getElementById('go').remove()`)
          let caught = false
          try {
            await handle.click({ timeout: 1500 })
          } catch {
            caught = true
          }
          return { caught, effect: (await logOf(p)) === 'clicked' }
        },
      },
    ]

    let silentNoops = 0
    const report: string[] = []
    for (const t of traps) {
      const { caught, effect } = await t.run()
      // silent no-op = the action did NOT throw AND the effect did NOT happen
      const silent = !caught && !effect
      if (silent) silentNoops++
      report.push(`${t.name}: caught=${caught} effect=${effect} silentNoop=${silent}`)
    }
    // eslint-disable-next-line no-console
    console.log('[silent-noop] ' + report.join(' | ') + ` => ${silentNoops}/${traps.length} silent no-ops`)
    expect(silentNoops).toBe(0)
  }, 40000)
})
