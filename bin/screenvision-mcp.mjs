#!/usr/bin/env node
/**
 * ScreenVision MCP server — the way an AI agent uses ScreenVision, mirroring how Playwright MCP
 * exposes Playwright. Speaks the Model Context Protocol over stdio (newline-delimited JSON-RPC 2.0)
 * with ZERO third-party dependencies: just the ScreenVision library and the Node standard library.
 *
 * Point any MCP client at it, e.g. Claude Desktop / Claude Code config:
 *   { "mcpServers": { "screenvision": { "command": "node", "args": ["bin/screenvision-mcp.mjs"] } } }
 * (run `npm run build` first; this loads the compiled library from ../dist).
 *
 * The tools deliberately lead with ScreenVision's semantic layer:
 *   browser_snapshot  -> observe(): a compact, ref-addressable model of what is on screen
 *   browser_act       -> act():     an action that PROVES it did something (no-effect is reported)
 * plus navigate / click / fill / type / screenshot / get_text / close. An agent snapshots, reads a
 * `ref`, and acts by ref -- it never invents a CSS selector.
 *
 * Env: SCREENVISION_MCP_HEADLESS=0 to run headed; SCREENVISION_CHROMIUM_PATH to choose the browser.
 */
import { createInterface } from 'node:readline'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
// pathToFileURL, not a raw path: dynamic import() needs a file:// URL, and a Windows path (c:\...)
// is rejected by the ESM loader otherwise.
const { ScreenVision } = await import(pathToFileURL(join(HERE, '..', 'dist', 'index.js')).href)

const PROTOCOL_VERSION = '2024-11-05'
const SERVER_INFO = { name: 'screenvision', version: '0.1.0' }

// ---- lazy browser/session state -------------------------------------------------
let sv = null
let browser = null
let context = null
let page = null

async function ensurePage() {
  if (page) return page
  sv = new ScreenVision()
  const headless = process.env.SCREENVISION_MCP_HEADLESS !== '0'
  browser = await sv.launch({ headless })
  context = await browser.newContext({ device: 'Desktop 1440x900' })
  page = await context.newPage()
  return page
}

async function closeAll() {
  try {
    if (browser) await browser.close()
  } catch {
    /* ignore */
  }
  sv = browser = context = page = null
}

// ---- the tools ------------------------------------------------------------------
const TOOLS = [
  {
    name: 'browser_navigate',
    description: 'Open a URL in the browser (launches it on first use).',
    inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'The URL to open' } }, required: ['url'] },
    run: async ({ url }) => {
      const p = await ensurePage()
      await p.goto(String(url), { waitUntil: 'load' })
      return `Navigated to ${p.url()}`
    },
  },
  {
    name: 'browser_snapshot',
    description:
      'A compact, ref-addressable model of the current page: landmark regions, every available ' +
      'action with a stable ref to address it by, and any blocking conditions. Use the refs with ' +
      'browser_act/browser_click/browser_fill. Prefer this over a raw DOM dump.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    run: async () => {
      const p = await ensurePage()
      const o = await p.observe()
      const regions = (o.regions ?? []).map((r) => r.name).join(', ') || '(none)'
      const conditions = (o.conditions ?? []).length ? '\nConditions: ' + o.conditions.map((c) => (typeof c === 'string' ? c : c.summary ?? JSON.stringify(c))).join('; ') : ''
      const acts = (o.affordances ?? [])
        .map((a) => `  ${a.ref}  ${a.role}  ${JSON.stringify(a.name)}${a.href ? '  -> ' + a.href : ''}`)
        .join('\n')
      return `URL: ${p.url()}\nRegions: ${regions}${conditions}\nActions:\n${acts || '  (none)'}`
    },
  },
  {
    name: 'browser_act',
    description:
      'Perform an action and get a verdict that says whether it actually did anything (a click that ' +
      'hit a dead button is reported as no-effect, not silently "done"). do is one of click, fill, ' +
      'check, uncheck, select, press, hover. Address the target with a ref from browser_snapshot.',
    inputSchema: {
      type: 'object',
      properties: {
        do: { type: 'string', enum: ['click', 'fill', 'check', 'uncheck', 'select', 'press', 'hover'] },
        ref: { type: 'string', description: 'A ref from the latest browser_snapshot' },
        text: { type: 'string', description: 'Text for fill, option for select, or key for press' },
      },
      required: ['do', 'ref'],
    },
    run: async (args) => {
      const p = await ensurePage()
      const req = { do: args.do, ref: String(args.ref) }
      if (args.text !== undefined) req.text = String(args.text)
      const r = await p.act(req)
      return `${r.ok ? 'OK' : 'NO-EFFECT/FAILED'}: ${r.summary}`
    },
  },
  {
    name: 'browser_click',
    description: 'Click the element with the given ref (from browser_snapshot). Reports no-effect if nothing happened.',
    inputSchema: { type: 'object', properties: { ref: { type: 'string' } }, required: ['ref'] },
    run: async ({ ref }) => {
      const p = await ensurePage()
      const r = await p.act({ do: 'click', ref: String(ref) })
      return `${r.ok ? 'OK' : 'NO-EFFECT/FAILED'}: ${r.summary}`
    },
  },
  {
    name: 'browser_fill',
    description: 'Fill the input with the given ref (from browser_snapshot) with text; the value is read back to confirm.',
    inputSchema: { type: 'object', properties: { ref: { type: 'string' }, text: { type: 'string' } }, required: ['ref', 'text'] },
    run: async ({ ref, text }) => {
      const p = await ensurePage()
      const r = await p.act({ do: 'fill', ref: String(ref), text: String(text) })
      return `${r.ok ? 'OK' : 'FAILED'}: ${r.summary}`
    },
  },
  {
    name: 'browser_get_text',
    description: 'The readable text of the current page.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    run: async () => {
      const p = await ensurePage()
      const o = await p.observe()
      return o.text || '(no text)'
    },
  },
  {
    name: 'browser_screenshot',
    description: 'A PNG screenshot of the current page, returned as an image.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    run: async () => {
      const p = await ensurePage()
      const buf = await p.screenshot({ type: 'png' })
      return { image: buf.toString('base64') }
    },
  },
  {
    name: 'browser_close',
    description: 'Close the browser and release resources.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    run: async () => {
      await closeAll()
      return 'Browser closed.'
    },
  },
]
const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]))

// ---- JSON-RPC over stdio --------------------------------------------------------
function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n')
}
function reply(id, result) {
  send({ jsonrpc: '2.0', id, result })
}
function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

async function handle(msg) {
  const { id, method, params } = msg
  if (method === 'initialize') {
    return reply(id, { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: SERVER_INFO })
  }
  if (method === 'notifications/initialized' || method === 'initialized') return // notification, no reply
  if (method === 'ping') return reply(id, {})
  if (method === 'tools/list') {
    return reply(id, { tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) })
  }
  if (method === 'tools/call') {
    const tool = TOOL_BY_NAME.get(params?.name)
    if (!tool) return replyError(id, -32602, `Unknown tool: ${params?.name}`)
    try {
      const out = await tool.run(params.arguments ?? {})
      if (out && typeof out === 'object' && out.image) {
        return reply(id, { content: [{ type: 'image', data: out.image, mimeType: 'image/png' }] })
      }
      return reply(id, { content: [{ type: 'text', text: String(out) }] })
    } catch (err) {
      // MCP convention: tool errors come back as an isError result, not a protocol error.
      return reply(id, { content: [{ type: 'text', text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true })
    }
  }
  if (id !== undefined) replyError(id, -32601, `Method not found: ${method}`)
}

const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const s = line.trim()
  if (!s) return
  let msg
  try {
    msg = JSON.parse(s)
  } catch {
    return // ignore non-JSON lines
  }
  handle(msg).catch((err) => {
    if (msg && msg.id !== undefined) replyError(msg.id, -32603, `Internal error: ${err instanceof Error ? err.message : String(err)}`)
  })
})
rl.on('close', () => {
  closeAll().finally(() => process.exit(0))
})
process.on('SIGINT', () => closeAll().finally(() => process.exit(0)))
process.on('SIGTERM', () => closeAll().finally(() => process.exit(0)))
