import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'http'
import screenvision from '../../src/index'
import type { Browser } from '../../src/core/Browser'

/**
 * Two ways of seeing what the page actually did, rather than what it appeared to do.
 *
 * Coverage answers "did my click reach the handler at all" — a click that lands, changes
 * nothing, and enters no function is a different failure from one that runs the handler and
 * the handler does nothing, and the two need different responses.
 *
 * WebSocket frames answer the same question for a socket-driven page, which is invisible to
 * request interception: without them an agent cannot tell "the server has not replied yet"
 * from "the reply arrived and the page ignored it".
 */
const PORT = 9962

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Live</title></head><body>
<main>
 <button id="works" onclick="handled()">Works</button>
 <button id="dead">Dead</button>
 <div id="out">none</div>
 <div id="ws">none</div>
 <script src="/app.js"></script>
</main></body></html>`

const APP_JS = `
function handled() { document.getElementById('out').textContent = 'handled' }
function neverCalled() { return 'this function is never entered' }
window.openSocket = () => new Promise((resolve) => {
  const s = new WebSocket('ws://127.0.0.1:${PORT + 1}')
  window.__sock = s
  s.onopen = () => { s.send('hello from page'); resolve('open') }
  s.onmessage = (e) => { document.getElementById('ws').textContent = e.data }
})
`

let server: http.Server
let wsServer: http.Server
let browser: Browser

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if ((req.url ?? '').startsWith('/app.js')) {
      res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' })
      res.end(APP_JS)
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(PAGE)
  })
  await new Promise<void>((r) => server.listen(PORT, r))

  // a minimal RFC6455 echo endpoint, so the test does not need a websocket dependency
  const { createHash } = await import('crypto')
  wsServer = http.createServer()
  wsServer.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'] as string
    const accept = createHash('sha1')
      .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64')
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    )
    // the browser drops the socket when the page closes; without this Node raises an
    // unhandled ECONNRESET that surfaces as a suite-level error
    socket.on('error', () => undefined)
    socket.on('data', () => {
      // reply with a single unmasked text frame
      const body = Buffer.from('pong from server')
      socket.write(Buffer.concat([Buffer.from([0x81, body.length]), body]))
    })
  })
  await new Promise<void>((r) => wsServer.listen(PORT + 1, r))

  browser = await screenvision.launch({ headless: true })
}, 60000)

afterAll(async () => {
  if (browser) await browser.close()
  if (server) server.close()
  if (wsServer) wsServer.close()
})

async function open() {
  const ctx = await browser.newContext({ device: 'Desktop 1440x900' })
  const p = await ctx.newPage()
  await p.goto(`http://127.0.0.1:${PORT}/`)
  return p
}

describe('coverage shows which code actually ran', () => {
  it('distinguishes a handler that was entered from one that was not', async () => {
    // coverage must start BEFORE the script is compiled: V8 gives per-function counts only
    // for code compiled after it began, so starting late silently degrades to one coarse
    // range per script
    const ctx = await browser.newContext({ device: 'Desktop 1440x900' })
    const p = await ctx.newPage()
    await p.startJSCoverage()
    await p.goto(`http://127.0.0.1:${PORT}/`)
    await p.click('#works')
    await p.click('#dead')
    const coverage = await p.stopJSCoverage()

    const app = coverage.find((c) => c.url.includes('/app.js'))
    expect(app, 'the application script should appear in coverage').toBeDefined()

    // the executed byte ranges, as text: what the page actually ran
    const executed = app!.ranges.filter((r) => r.count > 0)
    expect(executed.length).toBeGreaterThan(0)
    const source = APP_JS
    const ranText = executed.map((r) => source.slice(r.start, r.end)).join('\n')
    expect(ranText).toMatch(/handled/)
    // neverCalled is present in the file but was never entered
    const neverRan = app!.ranges.filter((r) => r.count === 0).map((r) => source.slice(r.start, r.end))
    expect(neverRan.join('\n')).toMatch(/never entered/)
    await p.close()
  }, 60000)

  it('reports nothing rather than throwing when no script ran', async () => {
    const p = await open()
    await p.startJSCoverage()
    const coverage = await p.stopJSCoverage()
    expect(Array.isArray(coverage)).toBe(true)
    await p.close()
  }, 60000)

  it('degrades to coarse ranges, not an error, when started after the page loaded', async () => {
    // the documented trap, asserted so it stays a known limitation rather than a surprise
    const p = await open()
    await p.startJSCoverage()
    await p.click('#works')
    const app = (await p.stopJSCoverage()).find((c) => c.url.includes('/app.js'))
    if (app) expect(app.ranges.filter((r) => r.count === 0).length).toBe(0)
    await p.close()
  }, 60000)
})

describe('websocket frames are observable in both directions', () => {
  it('sees what the page sent and what the server replied', async () => {
    const p = await open()
    const frames: Array<{ direction: string; payload: string }> = []
    const stop = p.onWebSocketFrame((f) => frames.push({ direction: f.direction, payload: f.payload }))

    await p.evaluate<string>(`window.openSocket()`)
    await p.waitForFunction(`document.getElementById('ws').textContent !== 'none'`, { timeout: 8000 })

    expect(frames.some((f) => f.direction === 'sent' && f.payload.includes('hello from page'))).toBe(
      true
    )
    expect(
      frames.some((f) => f.direction === 'received' && f.payload.includes('pong from server'))
    ).toBe(true)
    stop()
    await p.close()
  }, 60000)

  it('stops reporting once the watcher is removed', async () => {
    const p = await open()
    const frames: string[] = []
    const stop = p.onWebSocketFrame((f) => frames.push(f.payload))
    stop()
    await p.evaluate<string>(`window.openSocket()`)
    await p.waitForFunction(`document.getElementById('ws').textContent !== 'none'`, { timeout: 8000 })
    // a watcher that keeps firing after it is removed leaks into whatever runs next
    expect(frames.length).toBe(0)
    await p.close()
  }, 60000)
})
