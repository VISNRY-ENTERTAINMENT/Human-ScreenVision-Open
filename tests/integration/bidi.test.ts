import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { WebSocketServer, WebSocket } from 'ws'
import type { AddressInfo } from 'net'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type http from 'http'
import { BiDiClient } from '../../src/bidi/BiDiClient'
import { BiDiSession } from '../../src/bidi/BiDiSession'
import { FirefoxDriver, FIREFOX_BIDI_CANDIDATE_PATHS } from '../../src/bidi/FirefoxDriver'
import { unwrapBiDiValue, type RemoteValue } from '../../src/bidi/RemoteValue'
import { startFixtureServer, stopFixtureServer } from './fixture-server'

/** A command as the mock server saw it. */
interface SeenCommand {
  id: number
  method: string
  params: Record<string, unknown>
}

/** What a mock handler may return: a result object, or a BiDi error to send back. */
type MockReply = Record<string, unknown> | { __error: string; __message: string }

/**
 * A stand-in WebDriver BiDi endpoint.
 *
 * Firefox is a heavy and, on a fresh machine, absent dependency, but almost everything worth
 * getting wrong here is in the protocol conversation rather than in the browser: id
 * correlation, error shape, subscription gating, RemoteValue deserialisation, the exact
 * action sequences click and fill emit. A stub endpoint pins all of that down deterministically.
 */
class MockBiDiServer {
  private readonly wss: WebSocketServer
  private sockets: WebSocket[] = []
  readonly seen: SeenCommand[] = []
  readonly handlers: Map<string, (params: Record<string, unknown>) => MockReply> = new Map()
  private readonly delays: Map<string, (params: Record<string, unknown>) => number> = new Map()

  private constructor(wss: WebSocketServer) {
    this.wss = wss
    this.wss.on('connection', (socket: WebSocket) => {
      this.sockets.push(socket)
      socket.on('message', (raw) => this.onMessage(socket, raw.toString()))
    })
  }

  /**
   * Start a mock server on an ephemeral port.
   * @returns The running server
   */
  static async start(): Promise<MockBiDiServer> {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await new Promise<void>((resolve) => wss.once('listening', () => resolve()))
    return new MockBiDiServer(wss)
  }

  /** The `ws://` endpoint clients should connect to. */
  get url(): string {
    const address = this.wss.address() as AddressInfo
    return `ws://127.0.0.1:${address.port}/session`
  }

  /**
   * Register a handler for a method, replacing any previous one.
   * @param method - BiDi method name
   * @param handler - Produces the `result` object, or a `__error` marker to fail the command
   */
  on(method: string, handler: (params: Record<string, unknown>) => MockReply): void {
    this.handlers.set(method, handler)
  }

  /**
   * Hold a method's reply back, so responses can be made to arrive out of order.
   * @param method - BiDi method name
   * @param ms - Given the command params, how long to wait before replying
   */
  delay(method: string, ms: (params: Record<string, unknown>) => number): void {
    this.delays.set(method, ms)
  }

  /**
   * Push an unsolicited event to every connected client.
   * @param method - Event name
   * @param params - Event params
   */
  emit(method: string, params: Record<string, unknown>): void {
    const payload = JSON.stringify({ type: 'event', method, params })
    for (const socket of this.sockets) socket.send(payload)
  }

  /**
   * Every command seen for a method.
   * @param method - BiDi method name
   * @returns Matching commands, in arrival order
   */
  commands(method: string): SeenCommand[] {
    return this.seen.filter((c) => c.method === method)
  }

  /**
   * The most recent command for a method.
   * @param method - BiDi method name
   * @returns The command
   * @throws Error if the method was never called
   */
  lastCommand(method: string): SeenCommand {
    const all = this.commands(method)
    const last = all[all.length - 1]
    if (!last) throw new Error(`mock: ${method} was never called (saw: ${this.seen.map((c) => c.method).join(', ')})`)
    return last
  }

  /** Install the handlers a FirefoxDriver needs to reach a usable state. */
  installDefaults(): void {
    this.on('session.new', () => ({ sessionId: 'mock-session-1', capabilities: { browserName: 'firefox' } }))
    this.on('session.subscribe', () => ({}))
    this.on('session.unsubscribe', () => ({}))
    this.on('session.end', () => ({}))
    this.on('browsingContext.create', () => ({ context: 'ctx-1' }))
    this.on('browsingContext.close', () => ({}))
    this.on('browsingContext.getTree', () => ({ contexts: [{ context: 'ctx-1', url: 'about:blank', children: [] }] }))
    this.on('browsingContext.navigate', (p) => ({ navigation: 'nav-1', url: String(p['url']) }))
    this.on('input.performActions', () => ({}))
  }

  /** Shut the server and every client socket. */
  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.terminate()
    this.sockets = []
    await new Promise<void>((resolve) => this.wss.close(() => resolve()))
  }

  private onMessage(socket: WebSocket, raw: string): void {
    const command = JSON.parse(raw) as SeenCommand
    this.seen.push(command)
    const handler = this.handlers.get(command.method)
    if (!handler) {
      socket.send(
        JSON.stringify({
          type: 'error',
          id: command.id,
          error: 'unknown command',
          message: `mock has no handler for ${command.method}`,
        })
      )
      return
    }
    const params = command.params ?? {}
    const reply = handler(params)
    const payload =
      '__error' in reply
        ? JSON.stringify({ type: 'error', id: command.id, error: reply.__error, message: reply.__message })
        : JSON.stringify({ type: 'success', id: command.id, result: reply })
    const wait = this.delays.get(command.method)?.(params) ?? 0
    if (wait > 0) setTimeout(() => socket.send(payload), wait)
    else socket.send(payload)
  }
}

/** A `script.evaluate` success reply wrapping a RemoteValue. */
function scriptSuccess(result: RemoteValue): Record<string, unknown> {
  return { type: 'success', realm: 'realm-1', result }
}

describe('BiDiClient', () => {
  let server: MockBiDiServer
  let client: BiDiClient

  beforeEach(async () => {
    server = await MockBiDiServer.start()
    client = new BiDiClient(server.url)
    await client.connect()
  })

  afterEach(async () => {
    await client.close()
    await server.stop()
  })

  it('correlates concurrent responses by id rather than by arrival order', async () => {
    server.on('test.slow', (p) => ({ echo: p['echo'] }))
    // Reply in reverse: a client that matched replies to callers by arrival order would hand
    // every caller somebody else's result, and would do it silently.
    const order: Record<string, number> = { a: 150, b: 80, c: 10 }
    server.delay('test.slow', (p) => order[String(p['echo'])] ?? 0)

    const [a, b, c] = await Promise.all([
      client.send('test.slow', { echo: 'a' }),
      client.send('test.slow', { echo: 'b' }),
      client.send('test.slow', { echo: 'c' }),
    ])
    expect([a['echo'], b['echo'], c['echo']]).toEqual(['a', 'b', 'c'])
    expect(server.commands('test.slow').map((x) => x.id)).toEqual([1, 2, 3])
  })

  it('rejects with an error naming the command and its parameters', async () => {
    server.on('browsingContext.navigate', () => ({
      __error: 'unknown error',
      __message: 'Address is not valid',
    }))
    await expect(client.send('browsingContext.navigate', { context: 'ctx-1', url: 'nope://x' })).rejects.toThrow(
      /BiDi browsingContext\.navigate\(.*"url":"nope:\/\/x".*\) failed: Address is not valid \[unknown error\]/
    )
  })

  it('truncates very long parameters in the error message', async () => {
    server.on('script.evaluate', () => ({ __error: 'invalid argument', __message: 'bad' }))
    const huge = 'x'.repeat(5000)
    const err = await client.send('script.evaluate', { expression: huge }).catch((e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toContain('…')
    expect((err as Error).message.length).toBeLessThan(500)
  })

  it('delivers events only to registered listeners and stops after off()', async () => {
    const seen: string[] = []
    const listener = (params: Record<string, unknown>): void => {
      seen.push(String(params['url']))
    }
    client.on('browsingContext.load', listener)
    expect(client.listenerCount()).toBe(1)

    server.emit('browsingContext.load', { context: 'ctx-1', url: 'http://a/' })
    server.emit('browsingContext.domContentLoaded', { context: 'ctx-1', url: 'http://ignored/' })
    await new Promise((r) => setTimeout(r, 50))
    expect(seen).toEqual(['http://a/'])

    client.off('browsingContext.load', listener)
    expect(client.listenerCount()).toBe(0)
    server.emit('browsingContext.load', { context: 'ctx-1', url: 'http://b/' })
    await new Promise((r) => setTimeout(r, 50))
    expect(seen).toEqual(['http://a/'])
  })

  it('survives a malformed frame without dropping the connection', async () => {
    server.on('session.status', () => ({ ready: true }))
    // A non-JSON frame must be logged and skipped, not thrown out of the message handler.
    server.emit('x', {})
    const result = await client.send('session.status', {})
    expect(result['ready']).toBe(true)
    expect(client.isConnected()).toBe(true)
  })

  it('refuses to send once closed, naming the command', async () => {
    await client.close()
    expect(client.isConnected()).toBe(false)
    await expect(client.send('script.evaluate', { expression: '1' })).rejects.toThrow(
      /BiDiClient\.send\(script\.evaluate, .*\): connection is not open/
    )
  })

  it('reports an unknown command as an error rather than hanging', async () => {
    await expect(client.send('test.never')).rejects.toThrow(/mock has no handler for test\.never/)
  })

  it('rejects in-flight commands when the socket closes underneath them', async () => {
    server.on('test.slow', () => ({ ok: true }))
    server.delay('test.slow', () => 5000)
    const inFlight = client.send('test.slow', { context: 'ctx-1' })
    // A command abandoned by a browser crash must reject, not hang until the caller's own
    // timeout — the whole point of failing all pending work on close.
    setTimeout(() => void client.close(), 50)
    await expect(inFlight).rejects.toThrow(/BiDiClient\.close: connection closed by client/)
  })

  it('fails a connection to a port nobody is listening on', async () => {
    const dead = new BiDiClient('ws://127.0.0.1:1/session')
    await expect(dead.connect()).rejects.toThrow(/BiDiClient\.connect: failed to connect/)
  })
})

describe('BiDiSession', () => {
  let server: MockBiDiServer
  let client: BiDiClient
  let session: BiDiSession

  beforeEach(async () => {
    server = await MockBiDiServer.start()
    server.installDefaults()
    client = new BiDiClient(server.url)
    await client.connect()
    session = new BiDiSession(client)
  })

  afterEach(async () => {
    await client.close()
    await server.stop()
  })

  it('sends capabilities under alwaysMatch and records the session', async () => {
    const info = await session.create({ browserName: 'firefox', acceptInsecureCerts: true })
    expect(info.sessionId).toBe('mock-session-1')
    expect(session.sessionInfo()?.capabilities).toEqual({ browserName: 'firefox' })
    expect(server.lastCommand('session.new').params).toEqual({
      capabilities: { alwaysMatch: { browserName: 'firefox', acceptInsecureCerts: true } },
    })
  })

  it('refuses a second session on the same connection', async () => {
    await session.create()
    await expect(session.create()).rejects.toThrow(/a session \(mock-session-1\) already exists/)
  })

  it('fails loudly when session.new returns no sessionId', async () => {
    server.on('session.new', () => ({ capabilities: {} }))
    await expect(session.create()).rejects.toThrow(/session\.new returned no sessionId/)
  })

  it('does not resend a global subscription that is already active', async () => {
    await session.create()
    await session.subscribe(['browsingContext.load'])
    await session.subscribe(['browsingContext.load'])
    await session.subscribe(['browsingContext.load', 'log.entryAdded'])
    expect(server.commands('session.subscribe').map((c) => c.params['events'])).toEqual([
      ['browsingContext.load'],
      ['log.entryAdded'],
    ])
  })

  it('always sends a context-scoped subscription, since it is not covered by the global set', async () => {
    await session.create()
    await session.subscribe(['browsingContext.load'])
    await session.subscribe(['browsingContext.load'], ['ctx-1'])
    const last = server.lastCommand('session.subscribe')
    expect(last.params).toEqual({ events: ['browsingContext.load'], contexts: ['ctx-1'] })
  })

  it('unsubscribes only what is currently subscribed', async () => {
    await session.create()
    await session.subscribe(['log.entryAdded'])
    await session.unsubscribe(['log.entryAdded', 'never.subscribed'])
    expect(server.lastCommand('session.unsubscribe').params['events']).toEqual(['log.entryAdded'])
  })

  it('creates and closes browsing contexts and lists the tree', async () => {
    await session.create()
    const context = await session.createContext('tab')
    expect(context).toBe('ctx-1')
    expect(server.lastCommand('browsingContext.create').params).toEqual({ type: 'tab' })
    expect(await session.contexts()).toEqual(['ctx-1'])
    await session.closeContext(context)
    expect(server.lastCommand('browsingContext.close').params).toEqual({ context: 'ctx-1' })
  })

  it('closes the contexts it owns before ending the session', async () => {
    await session.create()
    await session.createContext('tab')
    await session.dispose()
    const order = server.seen.map((c) => c.method)
    expect(order.indexOf('browsingContext.close')).toBeLessThan(order.indexOf('session.end'))
    expect(session.sessionInfo()).toBeNull()
  })

  it('still ends the session when closing a context fails', async () => {
    await session.create()
    await session.createContext('tab')
    server.on('browsingContext.close', () => ({ __error: 'no such frame', __message: 'gone' }))
    await expect(session.dispose()).resolves.toBeUndefined()
    expect(server.commands('session.end')).toHaveLength(1)
  })
})

describe('RemoteValue deserialisation', () => {
  it('unwraps primitives', () => {
    expect(unwrapBiDiValue<string>({ type: 'string', value: 'hi' }, 'src')).toBe('hi')
    expect(unwrapBiDiValue<number>({ type: 'number', value: 42 }, 'src')).toBe(42)
    expect(unwrapBiDiValue<boolean>({ type: 'boolean', value: false }, 'src')).toBe(false)
    expect(unwrapBiDiValue<null>({ type: 'null' }, 'src')).toBeNull()
    expect(unwrapBiDiValue<undefined>({ type: 'undefined' }, 'src')).toBeUndefined()
  })

  it('restores the special numbers BiDi sends as strings', () => {
    expect(unwrapBiDiValue<number>({ type: 'number', value: 'NaN' }, 'src')).toBeNaN()
    expect(unwrapBiDiValue<number>({ type: 'number', value: 'Infinity' }, 'src')).toBe(Infinity)
    expect(unwrapBiDiValue<number>({ type: 'number', value: '-Infinity' }, 'src')).toBe(-Infinity)
    expect(unwrapBiDiValue<number>({ type: 'number', value: '-0' }, 'src')).toBe(-0)
  })

  it('rebuilds nested arrays and objects from the tagged tree', () => {
    const remote: RemoteValue = {
      type: 'object',
      value: [
        ['name', { type: 'string', value: 'card' }],
        [
          'tags',
          {
            type: 'array',
            value: [
              { type: 'string', value: 'a' },
              { type: 'number', value: 2 },
            ],
          },
        ],
        ['nested', { type: 'object', value: [['deep', { type: 'boolean', value: true }]] }],
      ],
    }
    expect(unwrapBiDiValue<Record<string, unknown>>(remote, 'src')).toEqual({
      name: 'card',
      tags: ['a', 2],
      nested: { deep: true },
    })
  })

  it('rebuilds dates, regexps, bigints, maps and sets', () => {
    expect(unwrapBiDiValue<Date>({ type: 'date', value: '2026-09-10T00:00:00.000Z' }, 'src').toISOString()).toBe(
      '2026-09-10T00:00:00.000Z'
    )
    const re = unwrapBiDiValue<RegExp>({ type: 'regexp', value: { pattern: 'a+', flags: 'gi' } }, 'src')
    expect(re.source).toBe('a+')
    expect(re.flags).toBe('gi')
    expect(unwrapBiDiValue<bigint>({ type: 'bigint', value: '9007199254740993' }, 'src')).toBe(9007199254740993n)
    const set = unwrapBiDiValue<Set<number>>({ type: 'set', value: [{ type: 'number', value: 1 }] }, 'src')
    expect(Array.from(set)).toEqual([1])
    const map = unwrapBiDiValue<Map<unknown, unknown>>(
      { type: 'map', value: [[{ type: 'number', value: 7 }, { type: 'string', value: 'seven' }]] },
      'src'
    )
    expect(map.get(7)).toBe('seven')
  })

  it('refuses a DOM node, describing it', () => {
    expect(() =>
      unwrapBiDiValue(
        {
          type: 'node',
          sharedId: 'n1',
          value: { nodeType: 1, localName: 'div', attributes: { id: 'main', class: 'card wide' } },
        },
        'document.querySelector("#main")'
      )
    ).toThrow(/DOM node, which cannot be serialised \(div#main\.card\.wide\)/)
  })

  it('refuses functions, windows and promises by name', () => {
    expect(() => unwrapBiDiValue({ type: 'function' }, 'x')).toThrow(/non-serialisable function/)
    expect(() => unwrapBiDiValue({ type: 'window' }, 'x')).toThrow(/non-serialisable window/)
    expect(() => unwrapBiDiValue({ type: 'promise' }, 'x')).toThrow(/non-serialisable promise/)
    expect(() => unwrapBiDiValue({ type: 'error' }, 'x')).toThrow(/non-serialisable Error/)
  })

  it('refuses a container whose contents the depth limit stripped', () => {
    // This is the dangerous case: without the check it deserialises to {} and reads as a
    // page bug rather than a serialisation limit.
    expect(() => unwrapBiDiValue({ type: 'object' }, 'deep()')).toThrow(/contents were omitted by the remote end/)
    expect(() => unwrapBiDiValue({ type: 'array' }, 'deep()')).toThrow(/contents were omitted by the remote end/)
  })

  it('quotes the source expression so the caller can find the offending call', () => {
    expect(() => unwrapBiDiValue({ type: 'function' }, 'document.querySelector')).toThrow(/document\.querySelector/)
  })
})

describe('FirefoxDriver against a mock BiDi endpoint', () => {
  let server: MockBiDiServer
  let driver: FirefoxDriver

  beforeEach(async () => {
    server = await MockBiDiServer.start()
    server.installDefaults()
    driver = await FirefoxDriver.attach(server.url)
  })

  afterEach(async () => {
    await driver.close()
    await server.stop()
  })

  it('performs the full handshake on attach', async () => {
    expect(server.lastCommand('session.new').params).toEqual({
      capabilities: { alwaysMatch: { browserName: 'firefox', acceptInsecureCerts: true } },
    })
    expect(driver.contextId).toBe('ctx-1')
  })

  it('maps every waitUntil onto a BiDi wait, degrading networkidle to complete', async () => {
    const cases: Array<[undefined | 'load' | 'domcontentloaded' | 'networkidle' | 'commit', string]> = [
      [undefined, 'complete'],
      ['load', 'complete'],
      ['domcontentloaded', 'interactive'],
      ['commit', 'none'],
      ['networkidle', 'complete'],
    ]
    for (const [waitUntil, expected] of cases) {
      await driver.goto('http://example.test/', waitUntil ? { waitUntil } : {})
      expect(server.lastCommand('browsingContext.navigate').params['wait']).toBe(expected)
    }
  })

  it('returns the URL the navigation actually landed on', async () => {
    server.on('browsingContext.navigate', () => ({ navigation: 'n', url: 'http://example.test/redirected' }))
    expect(await driver.goto('http://example.test/')).toBe('http://example.test/redirected')
  })

  it('evaluates with awaitPromise and a raised object depth', async () => {
    server.on('script.evaluate', () => scriptSuccess({ type: 'number', value: 7 }))
    expect(await driver.evaluate<number>('3 + 4')).toBe(7)
    const params = server.lastCommand('script.evaluate').params
    expect(params['awaitPromise']).toBe(true)
    expect(params['target']).toEqual({ context: 'ctx-1' })
    expect(params['serializationOptions']).toEqual({ maxObjectDepth: 20, maxDomDepth: 0 })
  })

  it('turns a page-side throw into a host-side error carrying the page text', async () => {
    server.on('script.evaluate', () => ({
      type: 'exception',
      realm: 'r',
      exceptionDetails: { text: 'ReferenceError: nope is not defined', lineNumber: 3, columnNumber: 11 },
    }))
    await expect(driver.evaluate('nope()')).rejects.toThrow(
      /evaluate threw \(line 3:11\): ReferenceError: nope is not defined — while evaluating: nope\(\)/
    )
  })

  it('refuses an evaluate that returns a node', async () => {
    server.on('script.evaluate', () =>
      scriptSuccess({ type: 'node', sharedId: 'n1', value: { nodeType: 1, localName: 'h1' } })
    )
    await expect(driver.evaluate('document.querySelector("h1")')).rejects.toThrow(/DOM node, which cannot be serialised/)
  })

  it('querySelector asks for root ownership and returns both ids', async () => {
    server.on('script.evaluate', () =>
      scriptSuccess({
        type: 'node',
        sharedId: 'shared-9',
        handle: 'handle-9',
        value: { nodeType: 1, localName: 'input', attributes: { id: 'email' } },
      })
    )
    const element = await driver.querySelector('#email')
    expect(element).not.toBeNull()
    expect(element!.sharedId).toBe('shared-9')
    expect(element!.handle).toBe('handle-9')
    expect(element!.description).toBe('input#email')
    const params = server.lastCommand('script.evaluate').params
    expect(params['resultOwnership']).toBe('root')
    expect(params['expression']).toBe('document.querySelector("#email")')
  })

  it('querySelector returns null for no match and refuses a node with no sharedId', async () => {
    server.on('script.evaluate', () => scriptSuccess({ type: 'null' }))
    expect(await driver.querySelector('.missing')).toBeNull()

    server.on('script.evaluate', () => scriptSuccess({ type: 'node', value: { nodeType: 1, localName: 'p' } }))
    await expect(driver.querySelector('p')).rejects.toThrow(/came back without a sharedId/)
  })

  it('escapes selectors containing quotes', async () => {
    server.on('script.evaluate', () => scriptSuccess({ type: 'null' }))
    await driver.querySelector('a[href="/x"]')
    expect(server.lastCommand('script.evaluate').params['expression']).toBe(
      'document.querySelector("a[href=\\"/x\\"]")'
    )
  })

  it('click sends a pointer sequence anchored on the element itself', async () => {
    server.on('script.evaluate', () =>
      scriptSuccess({ type: 'node', sharedId: 'shared-btn', value: { nodeType: 1, localName: 'button' } })
    )
    await driver.click('button.submit')
    const actions = server.lastCommand('input.performActions').params['actions'] as Array<Record<string, unknown>>
    expect(actions).toHaveLength(1)
    expect(actions[0]['type']).toBe('pointer')
    expect(actions[0]['parameters']).toEqual({ pointerType: 'mouse' })
    expect(actions[0]['actions']).toEqual([
      { type: 'pointerMove', x: 0, y: 0, origin: { type: 'element', element: { sharedId: 'shared-btn' } } },
      { type: 'pointerDown', button: 0 },
      { type: 'pointerUp', button: 0 },
    ])
  })

  it('click names the selector when nothing matches', async () => {
    server.on('script.evaluate', () => scriptSuccess({ type: 'null' }))
    await expect(driver.click('.nope')).rejects.toThrow(/FirefoxDriver\.click: no element matches selector "\.nope"/)
  })

  it('fill focuses, selects existing text, then types one key pair per character', async () => {
    server.on('script.evaluate', () =>
      scriptSuccess({ type: 'node', sharedId: 'shared-input', value: { nodeType: 1, localName: 'input' } })
    )
    await driver.fill('#email', 'ab')
    const performs = server.commands('input.performActions')
    expect(performs).toHaveLength(2)
    const key = (performs[1].params['actions'] as Array<Record<string, unknown>>)[0]
    expect(key['type']).toBe('key')
    expect(key['actions']).toEqual([
      { type: 'keyDown', value: '\uE009' },
      { type: 'keyDown', value: 'a' },
      { type: 'keyUp', value: 'a' },
      { type: 'keyUp', value: '\uE009' },
      { type: 'keyDown', value: 'a' },
      { type: 'keyUp', value: 'a' },
      { type: 'keyDown', value: 'b' },
      { type: 'keyUp', value: 'b' },
    ])
  })

  it('fill with an empty string clears the field with Delete', async () => {
    server.on('script.evaluate', () =>
      scriptSuccess({ type: 'node', sharedId: 'shared-input', value: { nodeType: 1, localName: 'input' } })
    )
    await driver.fill('#email', '')
    const key = (server.lastCommand('input.performActions').params['actions'] as Array<Record<string, unknown>>)[0]
    const actions = key['actions'] as Array<Record<string, unknown>>
    expect(actions[actions.length - 1]).toEqual({ type: 'keyUp', value: '\uE017' })
  })

  it('fill keeps an astral character as a single keystroke', async () => {
    server.on('script.evaluate', () =>
      scriptSuccess({ type: 'node', sharedId: 'shared-input', value: { nodeType: 1, localName: 'input' } })
    )
    await driver.fill('#msg', '😀')
    const key = (server.lastCommand('input.performActions').params['actions'] as Array<Record<string, unknown>>)[0]
    const actions = key['actions'] as Array<Record<string, unknown>>
    const typed = actions.slice(4)
    expect(typed).toEqual([
      { type: 'keyDown', value: '😀' },
      { type: 'keyUp', value: '😀' },
    ])
  })

  it('reads textContent, returning null for a missing element', async () => {
    server.on('script.evaluate', () => scriptSuccess({ type: 'string', value: 'Hello' }))
    expect(await driver.textContent('h1')).toBe('Hello')
    expect(server.lastCommand('script.evaluate').params['expression']).toContain('document.querySelector("h1")')

    server.on('script.evaluate', () => scriptSuccess({ type: 'null' }))
    expect(await driver.textContent('.gone')).toBeNull()
  })

  it('reads the title through script and the url through the context tree', async () => {
    server.on('script.evaluate', () => scriptSuccess({ type: 'string', value: 'A Page' }))
    expect(await driver.title()).toBe('A Page')
    expect(server.lastCommand('script.evaluate').params['expression']).toBe('document.title')

    server.on('browsingContext.getTree', () => ({ contexts: [{ context: 'ctx-1', url: 'http://example.test/a' }] }))
    expect(await driver.url()).toBe('http://example.test/a')
    expect(server.lastCommand('browsingContext.getTree').params).toEqual({ root: 'ctx-1' })
  })

  it('fails clearly when the context tree has no url for the context', async () => {
    server.on('browsingContext.getTree', () => ({ contexts: [] }))
    await expect(driver.url()).rejects.toThrow(/returned no url for context ctx-1/)
  })

  it('decodes the screenshot from base64', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    server.on('browsingContext.captureScreenshot', () => ({ data: png.toString('base64') }))
    const shot = await driver.screenshot()
    expect(shot.subarray(0, 8).equals(png)).toBe(true)
    expect(server.lastCommand('browsingContext.captureScreenshot').params).toEqual({ context: 'ctx-1' })
  })

  it('fails clearly when the screenshot comes back without data', async () => {
    server.on('browsingContext.captureScreenshot', () => ({}))
    await expect(driver.screenshot()).rejects.toThrow(/captureScreenshot returned no data/)
  })

  it('surfaces a BiDi protocol error with the command and params attached', async () => {
    server.on('browsingContext.navigate', () => ({ __error: 'unknown error', __message: 'Address is not valid' }))
    await expect(driver.goto('http://bad.test/')).rejects.toThrow(
      /BiDi browsingContext\.navigate\(.*"context":"ctx-1".*\) failed: Address is not valid/
    )
  })
})

describe('FirefoxDriver.attach failure paths', () => {
  it('wraps a handshake failure with the endpoint', async () => {
    const server = await MockBiDiServer.start()
    server.on('session.new', () => ({ __error: 'session not created', __message: 'profile is locked' }))
    await expect(FirefoxDriver.attach(server.url)).rejects.toThrow(
      /FirefoxDriver\.attach: BiDi handshake failed against ws:\/\/127\.0\.0\.1:\d+\/session: .*profile is locked/
    )
    await server.stop()
  })

  it('close() on an attached driver ends the session without killing anything', async () => {
    const server = await MockBiDiServer.start()
    server.installDefaults()
    const driver = await FirefoxDriver.attach(server.url)
    await driver.close()
    expect(server.commands('session.end')).toHaveLength(1)
    expect(driver.bidi.isConnected()).toBe(false)
    await server.stop()
  })
})

describe('FirefoxDriver.findExecutable', () => {
  it('lists every path it tried when nothing is found', async () => {
    await expect(FirefoxDriver.findExecutable(path.join(os.tmpdir(), 'no-such-firefox.exe'), 0)).rejects.toThrow(
      /no Firefox binary found after waiting 0ms\. Tried: .*no-such-firefox\.exe/
    )
  })

  it('polls until the binary appears, for an installer that is still running', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-ff-poll-'))
    const target = path.join(dir, 'firefox.exe')
    setTimeout(() => fs.writeFileSync(target, 'stub'), 1500)
    const found = await FirefoxDriver.findExecutable(target, 10000)
    expect(found).toBe(target)
    fs.rmSync(dir, { recursive: true, force: true })
  }, 20000)
})

/**
 * End-to-end against a real Firefox.
 *
 * Skipped, loudly, when no Firefox is installed: a green suite that silently exercised
 * nothing would be worse than a visibly skipped one.
 */
const FIREFOX_PATH =
  process.env['SCREENVISION_FIREFOX_PATH'] ?? FIREFOX_BIDI_CANDIDATE_PATHS.find((p) => fs.existsSync(p))
const HAVE_FIREFOX = Boolean(FIREFOX_PATH && fs.existsSync(FIREFOX_PATH))
const PORT = 9987
const PAGE_URL = `http://127.0.0.1:${PORT}/`

const PAGE_HTML = `<!doctype html>
<html><head><title>BiDi Fixture</title></head>
<body>
  <h1 id="heading">Hello BiDi</h1>
  <input id="email" value="preset" />
  <button id="go" onclick="document.getElementById('heading').textContent = 'clicked'">Go</button>
  <div id="deep"></div>
  <script>window.__marker = { a: 1, b: { c: [1, 2, 3] } }</script>
</body></html>`

describe.skipIf(!HAVE_FIREFOX)('FirefoxDriver end-to-end (real Firefox)', () => {
  let driver: FirefoxDriver
  let server: http.Server
  let root: string

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-bidi-fixture-'))
    fs.writeFileSync(path.join(root, 'index.html'), PAGE_HTML)
    server = await startFixtureServer(root, PORT)
    driver = await FirefoxDriver.launch({ headless: true, executablePath: FIREFOX_PATH, timeout: 60000 })
  }, 120000)

  afterAll(async () => {
    if (driver) await driver.close()
    await stopFixtureServer(server)
    if (root) fs.rmSync(root, { recursive: true, force: true })
  })

  it('navigates and reads title and url', async () => {
    await driver.goto(PAGE_URL, { waitUntil: 'load' })
    expect(await driver.title()).toBe('BiDi Fixture')
    expect(await driver.url()).toBe(PAGE_URL)
  })

  it('evaluates real values, including nested objects', async () => {
    await driver.goto(PAGE_URL)
    expect(await driver.evaluate<number>('1 + 1')).toBe(2)
    expect(await driver.evaluate<string>('document.getElementById("heading").textContent')).toBe('Hello BiDi')
    expect(await driver.evaluate<Record<string, unknown>>('window.__marker')).toEqual({ a: 1, b: { c: [1, 2, 3] } })
    expect(await driver.evaluate<number>('Promise.resolve(5)')).toBe(5)
    expect(await driver.evaluate<number>('0/0')).toBeNaN()
  })

  it('refuses a non-serialisable evaluate result', async () => {
    await driver.goto(PAGE_URL)
    await expect(driver.evaluate('document.body')).rejects.toThrow(/DOM node, which cannot be serialised/)
    await expect(driver.evaluate('() => 1')).rejects.toThrow(/non-serialisable function/)
  })

  it('queries an element and reads its text', async () => {
    await driver.goto(PAGE_URL)
    const heading = await driver.querySelector('#heading')
    expect(heading).not.toBeNull()
    expect(heading!.description).toBe('h1#heading')
    expect(await driver.textContent('#heading')).toBe('Hello BiDi')
    expect(await driver.querySelector('.absent')).toBeNull()
    expect(await driver.textContent('.absent')).toBeNull()
  })

  it('clicks a button and observes the effect', async () => {
    await driver.goto(PAGE_URL)
    await driver.click('#go')
    expect(await driver.textContent('#heading')).toBe('clicked')
  })

  it('fills a field, replacing its preset value', async () => {
    await driver.goto(PAGE_URL)
    await driver.fill('#email', 'someone@example.com')
    expect(await driver.evaluate<string>('document.getElementById("email").value')).toBe('someone@example.com')
    await driver.fill('#email', '')
    expect(await driver.evaluate<string>('document.getElementById("email").value')).toBe('')
  })

  it('captures a PNG screenshot', async () => {
    await driver.goto(PAGE_URL)
    const shot = await driver.screenshot()
    expect(shot.length).toBeGreaterThan(1000)
    expect(shot.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(true)
  })
})
