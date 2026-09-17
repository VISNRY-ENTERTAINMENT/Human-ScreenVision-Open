import WebSocket from 'ws'

// eslint-disable-next-line no-console
const log: (...args: unknown[]) => void = process.env.SV_DEBUG ? console.log : () => undefined

/** A command as it travels down the wire. */
export interface BiDiCommand {
  id: number
  method: string
  params: Record<string, unknown>
}

/** Successful command reply. */
export interface BiDiSuccess {
  type: 'success'
  id: number
  result: Record<string, unknown>
}

/**
 * Failed command reply.
 *
 * The shape differs from CDP: BiDi puts `error` (a string code such as `no such element`)
 * and `message` at the top level rather than nesting them in an error object, and adds an
 * optional `stacktrace`.
 */
export interface BiDiErrorReply {
  type: 'error'
  id?: number
  error: string
  message: string
  stacktrace?: string
}

/** An unsolicited event. */
export interface BiDiEvent {
  type: 'event'
  method: string
  params: Record<string, unknown>
}

export type BiDiEventListener = (params: Record<string, unknown>) => void

/**
 * Any message arriving from the remote end, before it has been told apart.
 *
 * A union of the three reply shapes would be more faithful, but every field has to be
 * inspected before the discriminant can be trusted — a malformed or truncated frame is
 * exactly the case this needs to survive — so the flat, all-optional shape is the honest one.
 */
interface InboundMessage {
  type?: 'success' | 'error' | 'event'
  id?: number
  result?: Record<string, unknown>
  error?: string
  message?: string
  stacktrace?: string
  method?: string
  params?: Record<string, unknown>
}

interface PendingEntry {
  resolve: (value: Record<string, unknown>) => void
  reject: (reason: Error) => void
  method: string
  params: Record<string, unknown>
}

const CONNECT_TIMEOUT = 10000

/**
 * Truncate a parameter object for inclusion in an error message.
 *
 * Errors quote the parameters because BiDi's own error strings are terse — `no such node`
 * says nothing about which selector or context was at fault — while an unbounded dump of,
 * say, a base64 screenshot would bury the message it is meant to clarify.
 * @param params - Command parameters
 * @returns A single-line, length-capped JSON rendering
 */
function describeParams(params: Record<string, unknown>): string {
  let text: string
  try {
    text = JSON.stringify(params)
  } catch {
    text = '[unserialisable params]'
  }
  return text.length > 300 ? `${text.slice(0, 300)}…` : text
}

/**
 * WebSocket connection to a WebDriver BiDi endpoint.
 *
 * Routes command responses to their callers by id and events to registered listeners,
 * mirroring `CDPClient` so the two transports can be reasoned about together.
 */
export class BiDiClient {
  private ws: WebSocket | null = null
  private nextId = 1
  private pending: Map<number, PendingEntry> = new Map()
  private listeners: Map<string, Set<BiDiEventListener>> = new Map()
  private closed = false

  /**
   * @param wsEndpoint - `ws://` BiDi endpoint (from the browser's stderr banner)
   */
  constructor(private readonly wsEndpoint: string) {}

  /**
   * Total number of registered event listeners.
   *
   * Exposed so leaks are observable: this count must not grow without bound as browsing
   * contexts are created and closed.
   * @returns Listener count
   */
  listenerCount(): number {
    let total = 0
    for (const set of this.listeners.values()) total += set.size
    return total
  }

  /**
   * Open the WebSocket and wait for it to become ready.
   * @returns Resolves once the socket is open
   * @throws Error if the connection fails or takes longer than 10s
   */
  async connect(): Promise<void> {
    if (this.ws) return
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const ws = new WebSocket(this.wsEndpoint, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 })
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        ws.terminate()
        reject(new Error(`BiDiClient.connect: timeout connecting to ${this.wsEndpoint} after ${CONNECT_TIMEOUT}ms`))
      }, CONNECT_TIMEOUT)

      ws.once('open', () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.ws = ws
        resolve()
      })
      ws.once('error', (err: Error) => {
        if (settled) {
          this.failAllPending(new Error(`BiDi connection error: ${err.message}`))
          return
        }
        settled = true
        clearTimeout(timer)
        reject(new Error(`BiDiClient.connect: failed to connect to ${this.wsEndpoint}: ${err.message}`))
      })
      ws.on('message', (data: WebSocket.RawData) => this.onMessage(data))
      // released only now: unref'ing an open socket would let Node exit while a command
      // was still in flight, which silently truncates the caller's work
      ;(ws as unknown as { _socket?: { unref?: () => void } })._socket?.unref?.()
      ws.once('close', () => {
        this.closed = true
        this.failAllPending(new Error('BiDi connection closed'))
      })
    })
  }

  /**
   * Send a BiDi command and wait for its response.
   *
   * Unlike CDP there is no session id on the envelope: a BiDi connection carries exactly one
   * session, and the target is named inside `params` (usually as a `context`).
   * @param method - BiDi method, e.g. `browsingContext.navigate`
   * @param params - Method parameters; BiDi requires the key even when empty
   * @returns The `result` object of the response
   * @throws Error naming the command and its parameters if the protocol errors or the socket is shut
   */
  async send(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    if (!this.ws || this.closed) {
      throw new Error(`BiDiClient.send(${method}, ${describeParams(params)}): connection is not open`)
    }
    const id = this.nextId++
    const command: BiDiCommand = { id, method, params }
    const payload = JSON.stringify(command)
    log('[bidi →]', payload.length > 400 ? payload.slice(0, 400) + '…' : payload)

    return new Promise<Record<string, unknown>>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method, params })
      this.ws!.send(payload, (err) => {
        if (err) {
          this.pending.delete(id)
          reject(
            new Error(`BiDiClient.send(${method}, ${describeParams(params)}): socket write failed: ${err.message}`)
          )
        }
      })
    })
  }

  /**
   * Register a listener for a BiDi event.
   *
   * Registering here is only half the job: the remote end sends nothing until the event name
   * has also been passed to `session.subscribe`.
   * @param event - Event method name, e.g. `browsingContext.load`
   * @param listener - Callback receiving the event params
   */
  on(event: string, listener: BiDiEventListener): void {
    let set = this.listeners.get(event)
    if (!set) {
      set = new Set()
      this.listeners.set(event, set)
    }
    set.add(listener)
  }

  /**
   * Remove a previously registered event listener.
   * @param event - Event method name
   * @param listener - The exact callback passed to {@link BiDiClient.on}
   */
  off(event: string, listener: BiDiEventListener): void {
    const set = this.listeners.get(event)
    if (!set) return
    set.delete(listener)
    if (set.size === 0) this.listeners.delete(event)
  }

  /**
   * Close the WebSocket connection and reject all in-flight commands.
   * @returns Resolves when the socket has closed
   */
  async close(): Promise<void> {
    if (!this.ws) return
    const ws = this.ws
    this.ws = null
    this.closed = true
    this.listeners.clear()
    this.failAllPending(new Error('BiDiClient.close: connection closed by client'))
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        ws.terminate()
        resolve()
      }, 2000)
      ws.once('close', () => {
        clearTimeout(timer)
        resolve()
      })
      try {
        ws.close()
      } catch {
        clearTimeout(timer)
        resolve()
      }
    })
  }

  /**
   * Whether the socket is open.
   * @returns True while commands can still be sent
   */
  isConnected(): boolean {
    return this.ws !== null && !this.closed
  }

  private onMessage(data: WebSocket.RawData): void {
    let message: InboundMessage
    try {
      message = JSON.parse(data.toString()) as InboundMessage
    } catch (err) {
      log('[bidi] failed to parse message', (err as Error).message)
      return
    }

    if (message.type === 'event' && typeof message.method === 'string') {
      const params = message.params ?? {}
      log('[bidi ←]', message.method)
      this.emit(message.method, params)
      return
    }

    if (typeof message.id !== 'number') {
      // An error with no id is a protocol-level complaint we could not correlate anyway
      // (malformed JSON on our side, or a shutdown notice), so log it and move on.
      if (message.type === 'error') log('[bidi] untargeted error', message.error, message.message)
      return
    }

    const entry = this.pending.get(message.id)
    if (!entry) return
    this.pending.delete(message.id)

    if (message.type === 'error') {
      const trace = message.stacktrace ? `\n${message.stacktrace}` : ''
      entry.reject(
        new Error(
          `BiDi ${entry.method}(${describeParams(entry.params)}) failed: ` +
            `${message.message ?? 'no message'} [${message.error ?? 'unknown error'}]${trace}`
        )
      )
      return
    }
    entry.resolve(message.result ?? {})
  }

  private emit(key: string, params: Record<string, unknown>): void {
    const set = this.listeners.get(key)
    if (!set) return
    for (const listener of Array.from(set)) {
      try {
        listener(params)
      } catch (err) {
        log('[bidi] listener error for', key, (err as Error).message)
      }
    }
  }

  private failAllPending(err: Error): void {
    for (const [, entry] of this.pending) entry.reject(err)
    this.pending.clear()
  }
}
