import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { WebSocketServer, WebSocket } from 'ws'
import { CDPClient } from '../../src/cdp/CDPClient'
import { globToRegExp } from '../../src/cdp/ProtocolMapper'

// A tiny fake CDP server: echoes params for `Echo.ping`, errors for `Bad.method`,
// and emits an event when asked.
let server: WebSocketServer
let port: number

beforeAll(async () => {
  server = new WebSocketServer({ port: 0 })
  await new Promise<void>((resolve) => server.once('listening', resolve))
  port = (server.address() as { port: number }).port
  server.on('connection', (socket: WebSocket) => {
    socket.on('message', (raw) => {
      const msg = JSON.parse(raw.toString()) as { id: number; method: string; params?: Record<string, unknown>; sessionId?: string }
      if (msg.method === 'Echo.ping') {
        socket.send(JSON.stringify({ id: msg.id, result: { echoed: msg.params, sessionId: msg.sessionId ?? null } }))
      } else if (msg.method === 'Bad.method') {
        socket.send(JSON.stringify({ id: msg.id, error: { code: -32601, message: 'method not found' } }))
      } else if (msg.method === 'Emit.event') {
        socket.send(JSON.stringify({ method: 'Test.fired', params: { n: 1 }, sessionId: msg.sessionId }))
        socket.send(JSON.stringify({ id: msg.id, result: {} }))
      }
    })
  })
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

describe('CDPClient', () => {
  it('connects, sends commands and receives results', async () => {
    const client = new CDPClient(`ws://127.0.0.1:${port}`)
    await client.connect()
    const result = await client.send('Echo.ping', { a: 1 }, 'S1')
    expect(result).toEqual({ echoed: { a: 1 }, sessionId: 'S1' })
    await client.close()
  })

  it('rejects on protocol errors with method name in message', async () => {
    const client = new CDPClient(`ws://127.0.0.1:${port}`)
    await client.connect()
    await expect(client.send('Bad.method')).rejects.toThrow(/Bad\.method.*method not found/)
    await client.close()
  })

  it('routes events to global and session-scoped listeners', async () => {
    const client = new CDPClient(`ws://127.0.0.1:${port}`)
    await client.connect()
    const global: unknown[] = []
    const scoped: unknown[] = []
    const other: unknown[] = []
    client.on('Test.fired', (p) => global.push(p))
    client.on('Test.fired', (p) => scoped.push(p), 'S9')
    client.on('Test.fired', (p) => other.push(p), 'OTHER')
    await client.send('Emit.event', {}, 'S9')
    expect(global).toEqual([{ n: 1 }])
    expect(scoped).toEqual([{ n: 1 }])
    expect(other).toEqual([])
    await client.close()
  })

  it('fails fast when the endpoint is unreachable', async () => {
    const client = new CDPClient('ws://127.0.0.1:1')
    await expect(client.connect()).rejects.toThrow(/failed to connect/)
  })
})

describe('globToRegExp', () => {
  it('supports **, * and ?', () => {
    expect(globToRegExp('**/api/**').test('https://x.test/api/users')).toBe(true)
    expect(globToRegExp('https://x.test/*.png').test('https://x.test/a.png')).toBe(true)
    expect(globToRegExp('https://x.test/*.png').test('https://x.test/dir/a.png')).toBe(false)
    expect(globToRegExp('https://x.test/?.png').test('https://x.test/a.png')).toBe(true)
  })
})
