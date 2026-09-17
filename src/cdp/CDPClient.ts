import WebSocket from 'ws'

// eslint-disable-next-line no-console
const log: (...args: unknown[]) => void = process.env.SV_DEBUG ? console.log : () => undefined

export interface CDPCommand {
  id: number
  method: string
  params?: Record<string, unknown>
  sessionId?: string
}

export interface CDPResponse {
  id: number
  result?: Record<string, unknown>
  error?: { code: number; message: string; data?: string }
  sessionId?: string
}

export interface CDPEvent {
  method: string
  params: Record<string, unknown>
  sessionId?: string
}

export type CDPEventListener = (params: Record<string, unknown>) => void

interface PendingEntry {
  resolve: (value: Record<string, unknown>) => void
  reject: (reason: Error) => void
  method: string
}

const CONNECT_TIMEOUT = 10000

/**
 * WebSocket connection to a Chrome DevTools Protocol endpoint.
 * Routes command responses to their callers and events to registered listeners.
 */
export class CDPClient {
  private ws: WebSocket | null = null
  private nextId = 1
  private pending: Map<number, PendingEntry> = new Map()
  private listeners: Map<string, Set<CDPEventListener>> = new Map()

  /**
   * Total number of registered event listeners across all sessions.
   *
   * Exposed so leaks are observable: this count must not grow without bound as pages are
   * opened and closed.
   * @returns Listener count
   */
  listenerCount(): number {
    let total = 0
    for (const set of this.listeners.values()) total += set.size
    return total
  }
  private closed = false

  /**
   * @param wsEndpoint - `ws://` DevTools endpoint (from the browser's stderr)
   */
  constructor(private readonly wsEndpoint: string) {}

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
        reject(new Error(`CDPClient.connect: timeout connecting to ${this.wsEndpoint} after ${CONNECT_TIMEOUT}ms`))
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
          this.failAllPending(new Error(`CDP connection error: ${err.message}`))
          return
        }
        settled = true
        clearTimeout(timer)
        reject(new Error(`CDPClient.connect: failed to connect to ${this.wsEndpoint}: ${err.message}`))
      })
      ws.on('message', (data: WebSocket.RawData) => this.onMessage(data))
      // released only now: unref'ing an open socket would let Node exit while a command
      // was still in flight, which silently truncates the caller's work
      ;(ws as unknown as { _socket?: { unref?: () => void } })._socket?.unref?.()
      ws.once('close', () => {
        this.closed = true
        this.failAllPending(new Error('CDP connection closed'))
      })
    })
  }

  /**
   * Send a CDP command and wait for its response.
   * @param method - CDP method, e.g. `Page.navigate`
   * @param params - Method parameters
   * @param sessionId - Target session to address (omit for browser-level commands)
   * @returns The `result` object of the CDP response
   * @throws Error if the protocol returns an error or the connection is closed
   */
  async send(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string
  ): Promise<Record<string, unknown>> {
    if (!this.ws || this.closed) {
      throw new Error(`CDPClient.send(${method}): connection is not open`)
    }
    const id = this.nextId++
    const command: CDPCommand = { id, method }
    if (params) command.params = params
    if (sessionId) command.sessionId = sessionId
    const payload = JSON.stringify(command)
    log('[cdp →]', payload.length > 400 ? payload.slice(0, 400) + '…' : payload)

    return new Promise<Record<string, unknown>>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method })
      this.ws!.send(payload, (err) => {
        if (err) {
          this.pending.delete(id)
          reject(new Error(`CDPClient.send(${method}): socket write failed: ${err.message}`))
        }
      })
    })
  }

  /**
   * Register a listener for a CDP event.
   * @param event - Event method name, e.g. `Page.loadEventFired`
   * @param listener - Callback receiving the event params
   * @param sessionId - Restrict to a specific session (key becomes `sessionId:event`)
   */
  on(event: string, listener: CDPEventListener, sessionId?: string): void {
    const key = sessionId ? `${sessionId}:${event}` : event
    let set = this.listeners.get(key)
    if (!set) {
      set = new Set()
      this.listeners.set(key, set)
    }
    set.add(listener)
  }

  /**
   * Remove a previously registered event listener.
   * @param event - Event method name
   * @param listener - The exact callback passed to {@link on}
   * @param sessionId - Session the listener was registered for
   */
  off(event: string, listener: CDPEventListener, sessionId?: string): void {
    const key = sessionId ? `${sessionId}:${event}` : event
    const set = this.listeners.get(key)
    if (!set) return
    set.delete(listener)
    if (set.size === 0) this.listeners.delete(key)
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
    this.failAllPending(new Error('CDPClient.close: connection closed by client'))
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

  /** Whether the socket is open. */
  isConnected(): boolean {
    return this.ws !== null && !this.closed
  }

  private onMessage(data: WebSocket.RawData): void {
    let message: CDPResponse & Partial<CDPEvent>
    try {
      message = JSON.parse(data.toString()) as CDPResponse & Partial<CDPEvent>
    } catch (err) {
      log('[cdp] failed to parse message', (err as Error).message)
      return
    }
    if (typeof message.id === 'number') {
      const entry = this.pending.get(message.id)
      if (!entry) return
      this.pending.delete(message.id)
      if (message.error) {
        const detail = message.error.data ? ` (${message.error.data})` : ''
        entry.reject(
          new Error(`CDP ${entry.method} failed: ${message.error.message}${detail} [code ${message.error.code}]`)
        )
      } else {
        entry.resolve(message.result ?? {})
      }
      return
    }
    if (typeof message.method === 'string') {
      const params = message.params ?? {}
      log('[cdp ←]', message.sessionId ?? '-', message.method)
      this.emit(message.method, params)
      if (message.sessionId) this.emit(`${message.sessionId}:${message.method}`, params)
    }
  }

  private emit(key: string, params: Record<string, unknown>): void {
    const set = this.listeners.get(key)
    if (!set) return
    for (const listener of Array.from(set)) {
      try {
        listener(params)
      } catch (err) {
        log('[cdp] listener error for', key, (err as Error).message)
      }
    }
  }

  private failAllPending(err: Error): void {
    for (const [, entry] of this.pending) entry.reject(err)
    this.pending.clear()
  }
}
