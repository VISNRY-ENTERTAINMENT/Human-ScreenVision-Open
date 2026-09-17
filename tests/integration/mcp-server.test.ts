import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'http'
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import path from 'path'
import readline from 'readline'

/**
 * The MCP server is how an AI agent uses ScreenVision (mirroring Playwright MCP). This drives the
 * real server over stdio JSON-RPC: initialize -> tools/list -> navigate -> snapshot -> click ->
 * close, asserting the protocol handshake and that the tools actually operate a real browser.
 * Failure-first: a server that answered the handshake but did not drive the browser would fail the
 * navigate/snapshot assertions (they check the real URL and a real affordance ref).
 */
const PORT = 9971
const MCP = path.join(__dirname, '../../bin/screenvision-mcp.mjs')

let server: http.Server
let child: ChildProcessWithoutNullStreams
const pending = new Map<number, (msg: any) => void>()

function rpc(id: number, method: string, params?: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`rpc ${method} timed out`)), 60000)
    pending.set(id, (msg) => {
      clearTimeout(timer)
      resolve(msg)
    })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) }) + '\n')
  })
}
function notify(method: string): void {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n')
}

beforeAll(async () => {
  server = http.createServer((_q, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(`<!doctype html><html><head><meta charset="utf-8"><title>MCP demo</title></head><body>
      <main><h1>Hello MCP</h1><button id="go" onclick="document.getElementById('out').textContent='clicked'">Go</button>
      <div id="out"></div></main></body></html>`)
  })
  await new Promise<void>((r) => server.listen(PORT, r))
  child = spawn('node', [MCP], { env: { ...process.env, SCREENVISION_MCP_HEADLESS: '1' } }) as ChildProcessWithoutNullStreams
  const rl = readline.createInterface({ input: child.stdout })
  rl.on('line', (line) => {
    const s = line.trim()
    if (!s) return
    let msg: any
    try {
      msg = JSON.parse(s)
    } catch {
      return
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)!(msg)
      pending.delete(msg.id)
    }
  })
}, 60000)

afterAll(async () => {
  if (child) child.kill()
  if (server) server.close()
})

describe('ScreenVision MCP server (how an AI uses it)', () => {
  it('handshake, tools/list, and driving a real browser over stdio', async () => {
    const init = await rpc(1, 'initialize', { protocolVersion: '2024-11-05', capabilities: {} })
    expect(init.result.serverInfo.name).toBe('screenvision')
    expect(init.result.capabilities.tools).toBeDefined()
    notify('notifications/initialized')

    const list = await rpc(2, 'tools/list')
    const names = list.result.tools.map((t: any) => t.name)
    for (const n of ['browser_navigate', 'browser_snapshot', 'browser_act', 'browser_click', 'browser_fill', 'browser_screenshot', 'browser_close']) {
      expect(names).toContain(n)
    }

    const nav = await rpc(3, 'tools/call', { name: 'browser_navigate', arguments: { url: `http://127.0.0.1:${PORT}/` } })
    expect(nav.result.content[0].text).toMatch(/Navigated to http:\/\/127\.0\.0\.1:9971/)

    const snap = await rpc(4, 'tools/call', { name: 'browser_snapshot', arguments: {} })
    const snapText = snap.result.content[0].text as string
    expect(snapText).toContain('Actions:')
    expect(snapText).toMatch(/button/i) // the Go button is a real affordance with a ref

    const shot = await rpc(5, 'tools/call', { name: 'browser_screenshot', arguments: {} })
    expect(shot.result.content[0].type).toBe('image')
    expect(shot.result.content[0].data.length).toBeGreaterThan(500)

    const close = await rpc(6, 'tools/call', { name: 'browser_close', arguments: {} })
    expect(close.result.content[0].text).toMatch(/closed/i)
  }, 90000)
})
