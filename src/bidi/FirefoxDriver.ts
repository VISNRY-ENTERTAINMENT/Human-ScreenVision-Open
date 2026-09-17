import { spawn, ChildProcess } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { BiDiClient } from './BiDiClient'
import { BiDiSession, BiDiCapabilities } from './BiDiSession'
import { NetworkIdleTracker } from './NetworkIdleTracker'
import { expectScriptSuccess, unwrapBiDiValue, describeNode, RemoteValue, NodeRemoteValue } from './RemoteValue'

// eslint-disable-next-line no-console
const log: (...args: unknown[]) => void = process.env.SV_DEBUG ? console.log : () => undefined

const DEFAULT_LAUNCH_TIMEOUT = 60000
const DEFAULT_BINARY_WAIT = 0

/** Where Firefox normally lands, in the order worth trying. */
export const FIREFOX_BIDI_CANDIDATE_PATHS: string[] = [
  path.join(process.env['PROGRAMFILES'] ?? 'C:\\Program Files', 'Mozilla Firefox', 'firefox.exe'),
  path.join(process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)', 'Mozilla Firefox', 'firefox.exe'),
  '/Applications/Firefox.app/Contents/MacOS/firefox',
  '/usr/bin/firefox',
  '/usr/bin/firefox-esr',
  '/usr/local/bin/firefox',
  '/snap/bin/firefox',
]

/** Options for {@link FirefoxDriver.launch}. */
export interface FirefoxLaunchOptions {
  /** Run without a visible window. Defaults to true. */
  headless?: boolean
  /** Explicit path to `firefox`, short-circuiting the candidate search. */
  executablePath?: string
  /** How long to wait for the BiDi banner on stderr, in ms. Defaults to 60000. */
  timeout?: number
  /** Extra command-line arguments appended after ScreenVision's own. */
  args?: string[]
  /**
   * How long to poll for the Firefox binary before giving up, in ms. Defaults to 0.
   *
   * Useful on a machine where the installer is still running: without it the launch fails
   * instantly on a binary that would have existed a minute later.
   */
  waitForBinary?: number
  /** Capabilities passed to `session.new`. */
  capabilities?: BiDiCapabilities
}

/** Navigation wait conditions, spelled as the rest of ScreenVision spells them. */
export type WaitUntil = 'load' | 'domcontentloaded' | 'networkidle' | 'commit'

/** Options for {@link FirefoxDriver.goto}. */
export interface GotoOptions {
  waitUntil?: WaitUntil
  /** For `waitUntil: 'networkidle'`, how long to wait for quiet before giving up (ms). */
  timeout?: number
}

/**
 * A reference to a DOM node in the page.
 *
 * BiDi node references come in two flavours and both are needed. `sharedId` names the node
 * within its browsing context and is what `input.performActions` accepts as a pointer
 * origin; `handle` is a realm-scoped strong reference and is what `script.callFunction`
 * accepts as an argument. Neither substitutes for the other.
 */
export interface BiDiElementHandle {
  /** Context-scoped node id, used as an input action origin. */
  sharedId: string
  /** Realm-scoped object handle, used as a script argument. Absent if ownership was not taken. */
  handle?: string
  /** The selector that produced this handle, quoted in errors. */
  selector: string
  /** Short description such as `input#email`, for error messages. */
  description: string
}

/**
 * Map ScreenVision's wait vocabulary onto BiDi's.
 *
 * BiDi offers three readiness states for `browsingContext.navigate`. `networkidle` has no
 * direct equivalent, so navigation waits for `complete` and `goto` then waits for the network
 * to fall quiet using BiDi's network events (see `gotoNetworkIdle`) — no longer a degradation
 * to bare `complete`, which let a background-polling page through too early.
 * @param waitUntil - ScreenVision wait condition
 * @returns The BiDi `wait` value used for the navigate call itself
 */
function toBiDiWait(waitUntil: WaitUntil | undefined): 'none' | 'interactive' | 'complete' {
  switch (waitUntil) {
    case 'commit':
      return 'none'
    case 'domcontentloaded':
      return 'interactive'
    case 'networkidle':
    case 'load':
    case undefined:
      return 'complete'
  }
}

/**
 * Unicode private-use code points WebDriver assigns to non-printing keys.
 *
 * BiDi key actions carry a literal code point rather than CDP's `key`/`code`/`keyCode`
 * triple, and these are the values the spec reserves for keys that have no character.
 */
const KEY = {
  DELETE: '\uE017',
  CONTROL: '\uE009',
} as const

/** Escape a string for embedding in a generated JavaScript expression. */
function jsString(value: string): string {
  return JSON.stringify(value)
}

/**
 * Wait for a file to appear on disk.
 * @param candidates - Paths to check, in order
 * @param timeoutMs - How long to keep looking
 * @returns The first path that exists, or null if none appeared in time
 */
async function waitForBinary(candidates: string[], timeoutMs: number): Promise<string | null> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    for (const candidate of candidates) {
      try {
        if (fs.statSync(candidate).isFile()) return candidate
      } catch {
        /* not there yet */
      }
    }
    if (Date.now() >= deadline) return null
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
}

/**
 * Drives Firefox over WebDriver BiDi.
 *
 * This is the second engine: Firefox dropped its CDP endpoint and WebKit never had one, so
 * BiDi is the only standards-track way to reach either. The surface here is deliberately
 * narrow — enough to navigate, read, and interact — and is meant to sit behind the same
 * `Page` abstraction the CDP path uses rather than to be a `Page` itself.
 */
export class FirefoxDriver {
  private constructor(
    private readonly proc: ChildProcess | null,
    private readonly client: BiDiClient,
    private readonly session: BiDiSession,
    private readonly context: string,
    private readonly profileDir: string | null
  ) {}

  /** The BiDi client, for callers that need to send commands this surface does not cover. */
  get bidi(): BiDiClient {
    return this.client
  }

  /** The BiDi session, for subscribing to events. */
  get bidiSession(): BiDiSession {
    return this.session
  }

  /** The browsing context this driver operates on. */
  get contextId(): string {
    return this.context
  }

  /**
   * Locate the Firefox binary, optionally waiting for an installer to finish.
   * @param executablePath - Explicit path that short-circuits the search
   * @param waitMs - How long to poll for the binary before giving up
   * @returns Absolute path to an existing Firefox executable
   * @throws Error naming every path that was tried
   */
  static async findExecutable(executablePath?: string, waitMs: number = DEFAULT_BINARY_WAIT): Promise<string> {
    const candidates = executablePath ? [executablePath] : FIREFOX_BIDI_CANDIDATE_PATHS
    const envPath = process.env['SCREENVISION_FIREFOX_PATH']
    if (!executablePath && envPath) candidates.unshift(envPath)
    const found = await waitForBinary(candidates, waitMs)
    if (found) return found
    throw new Error(
      `FirefoxDriver.findExecutable: no Firefox binary found after waiting ${waitMs}ms. Tried: ` +
        `${candidates.join(', ')}. Install Firefox or set SCREENVISION_FIREFOX_PATH.`
    )
  }

  /**
   * Launch Firefox, connect over BiDi, start a session and open a browsing context.
   * @param options - Launch options
   * @returns A driver bound to a fresh tab
   * @throws Error if the binary is missing, Firefox exits early, or no BiDi banner appears
   */
  static async launch(options: FirefoxLaunchOptions = {}): Promise<FirefoxDriver> {
    const timeout = options.timeout ?? DEFAULT_LAUNCH_TIMEOUT
    const headless = options.headless ?? true
    const executable = await FirefoxDriver.findExecutable(options.executablePath, options.waitForBinary ?? DEFAULT_BINARY_WAIT)
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'screenvision-firefox-'))

    // Port 0 asks the OS for a free one, which the banner then reports back. Hard-coding a
    // port would make two concurrent test files collide on the same machine.
    const args = [
      '--remote-debugging-port=0',
      '--profile',
      profileDir,
      '--no-remote',
      ...(headless ? ['--headless'] : []),
      ...(options.args ?? []),
    ]
    log('[screenvision] launching firefox', executable, args.join(' '))

    let child: ChildProcess
    try {
      child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (err) {
      fs.rmSync(profileDir, { recursive: true, force: true })
      throw new Error(`FirefoxDriver.launch: failed to spawn "${executable}": ${(err as Error).message}`)
    }

    let wsEndpoint: string
    try {
      wsEndpoint = await FirefoxDriver.readBiDiEndpoint(child, executable, timeout)
    } catch (err) {
      try {
        child.kill()
      } catch {
        /* already gone */
      }
      fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
      throw err
    }

    const client = new BiDiClient(wsEndpoint)
    const session = new BiDiSession(client)
    try {
      await client.connect()
      await session.create({ browserName: 'firefox', acceptInsecureCerts: true, ...options.capabilities })
      // Use a window, not a tab: headless Firefox (155, Linux) never answers
      // browsingContext.create {type:"tab"} -- no result, no error, the launch hangs forever.
      // {type:"window"} responds immediately and serves this single-context driver identically.
      const context = await session.createContext('window')
      return new FirefoxDriver(child, client, session, context, profileDir)
    } catch (err) {
      await client.close().catch(() => undefined)
      try {
        child.kill()
      } catch {
        /* already gone */
      }
      fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
      throw new Error(`FirefoxDriver.launch: BiDi handshake failed against ${wsEndpoint}: ${(err as Error).message}`)
    }
  }

  /**
   * Attach to a BiDi endpoint that is already listening, without launching anything.
   *
   * Firefox started with a fixed `--remote-debugging-port` outlives any one test run, and
   * reusing it skips a multi-second cold start. It is also the seam that lets the driver's
   * own protocol conversation be exercised against a stub endpoint, which is the only way to
   * cover this surface on a machine with no Firefox on it.
   * @param wsEndpoint - `ws://` BiDi endpoint
   * @param options - Capabilities for `session.new`
   * @returns A driver bound to a fresh browsing context; {@link FirefoxDriver.close} will not
   *   kill the browser, because this driver did not start it
   * @throws Error if the endpoint refuses the connection or the session handshake
   */
  static async attach(
    wsEndpoint: string,
    options: { capabilities?: BiDiCapabilities } = {}
  ): Promise<FirefoxDriver> {
    const client = new BiDiClient(wsEndpoint)
    const session = new BiDiSession(client)
    try {
      await client.connect()
      await session.create({ browserName: 'firefox', acceptInsecureCerts: true, ...options.capabilities })
      // Window, not tab: headless Firefox never answers browsingContext.create {type:"tab"} (hangs).
      const context = await session.createContext('window')
      return new FirefoxDriver(null, client, session, context, null)
    } catch (err) {
      await client.close().catch(() => undefined)
      throw new Error(`FirefoxDriver.attach: BiDi handshake failed against ${wsEndpoint}: ${(err as Error).message}`)
    }
  }

  /**
   * Read the `WebDriver BiDi listening on ws://…` banner out of Firefox's stderr.
   *
   * The banner is the only place the port is published when launching with port 0, and it is
   * written to stderr rather than stdout — the same trick the CDP launcher uses for
   * Chromium's `DevTools listening on` line.
   * @param child - The freshly spawned process
   * @param executable - Path, quoted in the timeout error
   * @param timeout - How long to wait for the banner, in ms
   * @returns The `ws://` endpoint
   * @throws Error with the tail of stderr on timeout or early exit
   */
  private static readBiDiEndpoint(child: ChildProcess, executable: string, timeout: number): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      let settled = false
      let buf = ''
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        reject(
          new Error(
            `FirefoxDriver.launch: no "WebDriver BiDi listening on" banner after ${timeout}ms ` +
              `(executable=${executable}). stderr: ${buf.slice(-800)}`
          )
        )
      }, timeout)

      const onData = (chunk: Buffer): void => {
        buf += chunk.toString()
        const match = /WebDriver BiDi listening on (ws:\/\/\S+)/.exec(buf)
        if (match && !settled) {
          settled = true
          clearTimeout(timer)
          // Firefox advertises the origin, not the WebSocket path. Opening a socket against
          // the bare origin gets an HTTP 200 and no upgrade, which surfaces as the opaque
          // "Unexpected server response: 200"; the BiDi endpoint is /session beneath it.
          const advertised = match[1].replace(/\/+$/, '')
          resolve(advertised.endsWith('/session') ? advertised : `${advertised}/session`)
        }
      }
      child.stderr?.on('data', onData)
      child.stdout?.on('data', onData)
      child.once('error', (err) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(new Error(`FirefoxDriver.launch: process error: ${err.message}`))
      })
      child.once('exit', (code) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(new Error(`FirefoxDriver.launch: Firefox exited early with code ${code}. stderr: ${buf.slice(-800)}`))
      })
    })
  }

  /**
   * Navigate the context to a URL.
   * @param url - Absolute URL to load
   * @param options - `waitUntil` readiness condition; defaults to `load`
   * @returns The URL actually landed on, after any redirect
   * @throws Error if navigation fails or the wait condition is never met
   */
  async goto(url: string, options: GotoOptions = {}): Promise<string> {
    if (options.waitUntil === 'networkidle') {
      return this.gotoNetworkIdle(url, options)
    }
    const result = await this.client.send('browsingContext.navigate', {
      context: this.context,
      url,
      wait: toBiDiWait(options.waitUntil),
    })
    const landed = result['url']
    return typeof landed === 'string' ? landed : url
  }

  /**
   * Navigate and then wait for the network to fall quiet, the way Chromium's `networkidle` does.
   *
   * BiDi has no network-idle readiness state, but it does emit network lifecycle events. This
   * subscribes to them, counts in-flight requests through a {@link NetworkIdleTracker}, navigates
   * waiting only for `complete`, and then resolves once the in-flight count has held at zero for
   * the quiet window. Subscription and listeners are always torn down, including on timeout, so
   * a slow page cannot leave a dangling counter behind.
   * @param url - Absolute URL to load
   * @param options - `timeout` bounds the idle wait; defaults to 30s
   * @returns The URL actually landed on
   */
  private async gotoNetworkIdle(url: string, options: GotoOptions): Promise<string> {
    const tracker = new NetworkIdleTracker({ idleMs: 500, timeoutMs: options.timeout ?? 30_000 })
    const idOf = (p: Record<string, unknown>): string | undefined => {
      const req = p['request'] as { request?: unknown } | undefined
      return req && typeof req.request === 'string' ? req.request : undefined
    }
    const onStart = (p: Record<string, unknown>): void => {
      const id = idOf(p)
      if (id) tracker.requestStarted(id)
    }
    const onEnd = (p: Record<string, unknown>): void => {
      const id = idOf(p)
      if (id) tracker.requestFinished(id)
    }
    const events = ['network.beforeRequestSent', 'network.responseCompleted', 'network.fetchError']
    await this.session.subscribe(events, [this.context])
    this.client.on('network.beforeRequestSent', onStart)
    this.client.on('network.responseCompleted', onEnd)
    this.client.on('network.fetchError', onEnd)
    try {
      const result = await this.client.send('browsingContext.navigate', {
        context: this.context,
        url,
        wait: 'complete',
      })
      await tracker.whenIdle()
      const landed = result['url']
      return typeof landed === 'string' ? landed : url
    } finally {
      tracker.dispose()
      this.client.off('network.beforeRequestSent', onStart)
      this.client.off('network.responseCompleted', onEnd)
      this.client.off('network.fetchError', onEnd)
      await this.session.unsubscribe(events).catch(() => undefined)
    }
  }

  /**
   * Evaluate a JavaScript expression in the page and return its value.
   *
   * `awaitPromise` is on, so an expression yielding a promise resolves before returning.
   * Values that cannot survive the wire — nodes, functions, windows — are refused by name,
   * as they are on the CDP path.
   * @param expression - JavaScript expression (not a function body)
   * @returns The deserialised value
   * @throws Error if the page throws, or the result is not serialisable
   */
  async evaluate<T>(expression: string): Promise<T> {
    const raw = await this.client.send('script.evaluate', {
      expression,
      target: { context: this.context },
      awaitPromise: true,
      // The default depth of 1 silently truncates any nested object into a contentless
      // stub, which would surface as a mysteriously empty result rather than an error.
      serializationOptions: { maxObjectDepth: 20, maxDomDepth: 0 },
    })
    const value = expectScriptSuccess(raw, expression)
    return unwrapBiDiValue<T>(value, expression)
  }

  /**
   * Find the first element matching a CSS selector.
   * @param selector - CSS selector
   * @returns A handle, or null when nothing matches
   * @throws Error if the selector is invalid (the page's own `SyntaxError` is surfaced)
   */
  async querySelector(selector: string): Promise<BiDiElementHandle | null> {
    const expression = `document.querySelector(${jsString(selector)})`
    const raw = await this.client.send('script.evaluate', {
      expression,
      target: { context: this.context },
      awaitPromise: false,
      // Without root ownership the reply carries a sharedId but no handle, and the node is
      // not pinned, so a later callFunction against it fails with "no such handle".
      resultOwnership: 'root',
      serializationOptions: { maxDomDepth: 0 },
    })
    const value = expectScriptSuccess(raw, expression)
    if (value.type === 'null' || value.type === 'undefined') return null
    if (value.type !== 'node') {
      throw new Error(
        `querySelector(${selector}): expected a node but the page returned a ${value.type} — ` +
          `is the selector shadowed by a page-defined document.querySelector?`
      )
    }
    const node = value as NodeRemoteValue
    if (!node.sharedId) {
      throw new Error(`querySelector(${selector}): node came back without a sharedId, so it cannot be interacted with`)
    }
    return {
      sharedId: node.sharedId,
      handle: node.handle,
      selector,
      description: describeNode(node),
    }
  }

  /**
   * Click the first element matching a selector, with a real pointer sequence.
   *
   * The element is named as the pointer *origin*, which makes the remote end scroll it into
   * view and compute its centre itself — there is no need to read a bounding box first, and
   * no window in which the page could reflow between measuring and clicking.
   * @param selector - CSS selector
   * @returns Resolves once the pointer sequence has been dispatched
   * @throws Error if no element matches
   */
  async click(selector: string): Promise<void> {
    const element = await this.requireElement(selector, 'click')
    await this.client.send('input.performActions', {
      context: this.context,
      actions: [
        {
          type: 'pointer',
          id: 'sv-mouse',
          parameters: { pointerType: 'mouse' },
          actions: [
            { type: 'pointerMove', x: 0, y: 0, origin: { type: 'element', element: { sharedId: element.sharedId } } },
            { type: 'pointerDown', button: 0 },
            { type: 'pointerUp', button: 0 },
          ],
        },
      ],
    })
  }

  /**
   * Focus a field and replace its contents by typing.
   *
   * BiDi has no "set value" primitive, so this clicks to focus, selects any existing text
   * with Control+A and types over it. Typing rather than assigning `value` is the point:
   * frameworks that listen for `keydown`/`input` see the events they expect, which a direct
   * property assignment would not produce.
   * @param selector - CSS selector for an input, textarea or contenteditable
   * @param value - Text to type; an empty string clears the field
   * @returns Resolves once every keystroke has been dispatched
   * @throws Error if no element matches
   */
  async fill(selector: string, value: string): Promise<void> {
    await this.click(selector)
    const keyActions: Array<Record<string, unknown>> = [
      { type: 'keyDown', value: KEY.CONTROL },
      { type: 'keyDown', value: 'a' },
      { type: 'keyUp', value: 'a' },
      { type: 'keyUp', value: KEY.CONTROL },
    ]
    if (value.length === 0) {
      keyActions.push({ type: 'keyDown', value: KEY.DELETE }, { type: 'keyUp', value: KEY.DELETE })
    } else {
      // Array.from, not a plain index loop: a code point outside the BMP is two UTF-16 units
      // and sending them separately types two replacement characters.
      for (const char of Array.from(value)) {
        keyActions.push({ type: 'keyDown', value: char }, { type: 'keyUp', value: char })
      }
    }
    await this.client.send('input.performActions', {
      context: this.context,
      actions: [{ type: 'key', id: 'sv-keyboard', actions: keyActions }],
    })
  }

  /**
   * Read an element's `textContent`.
   * @param selector - CSS selector
   * @returns The text, or null when nothing matches
   */
  async textContent(selector: string): Promise<string | null> {
    return this.evaluate<string | null>(
      `(() => { const el = document.querySelector(${jsString(selector)}); return el ? el.textContent : null })()`
    )
  }

  /**
   * The document title.
   * @returns `document.title`
   */
  async title(): Promise<string> {
    return this.evaluate<string>('document.title')
  }

  /**
   * The context's current URL.
   *
   * Read from `browsingContext.getTree` rather than `location.href` so it still answers for
   * a page whose script has been blocked or whose document failed to parse.
   * @returns The current URL
   * @throws Error if the context has disappeared
   */
  async url(): Promise<string> {
    const result = await this.client.send('browsingContext.getTree', { root: this.context })
    const contexts = result['contexts']
    const first = Array.isArray(contexts) ? (contexts[0] as { url?: unknown } | undefined) : undefined
    if (!first || typeof first.url !== 'string') {
      throw new Error(`FirefoxDriver.url: browsingContext.getTree returned no url for context ${this.context}`)
    }
    return first.url
  }

  /**
   * Capture a PNG screenshot of the viewport.
   * @returns The decoded PNG bytes
   * @throws Error if the remote end returns no image data
   */
  async screenshot(): Promise<Buffer> {
    const result = await this.client.send('browsingContext.captureScreenshot', { context: this.context })
    const data = result['data']
    if (typeof data !== 'string') {
      throw new Error(
        `FirefoxDriver.screenshot: browsingContext.captureScreenshot returned no data for context ${this.context}`
      )
    }
    return Buffer.from(data, 'base64')
  }

  /**
   * Close the context, end the session, and shut Firefox down.
   *
   * Every stage is best-effort and ordered so that a failure early on still reaches the
   * process kill: an orphaned headless Firefox holds its profile directory open and would
   * leak tens of megabytes per run.
   * @returns Resolves once the process has exited or been killed
   */
  async close(): Promise<void> {
    await this.session.dispose().catch(() => undefined)
    await this.client.close().catch(() => undefined)
    await this.killProcess()
    this.removeProfile()
  }

  /**
   * Resolve a selector to a handle or fail with a message naming the caller.
   * @param selector - CSS selector
   * @param action - Name of the calling operation, quoted in the error
   * @returns The element handle
   * @throws Error if no element matches
   */
  private async requireElement(selector: string, action: string): Promise<BiDiElementHandle> {
    const element = await this.querySelector(selector)
    if (!element) {
      throw new Error(`FirefoxDriver.${action}: no element matches selector ${JSON.stringify(selector)}`)
    }
    return element
  }

  /** Terminate Firefox, escalating to SIGKILL after a grace period. */
  private killProcess(): Promise<void> {
    const proc = this.proc
    // An attached driver did not start the browser, so it has no business stopping it.
    if (!proc) return Promise.resolve()
    if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve()
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          proc.kill('SIGKILL')
        } catch {
          /* already gone */
        }
        resolve()
      }, 5000)
      proc.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
      try {
        proc.kill()
      } catch {
        clearTimeout(timer)
        resolve()
      }
    })
  }

  /**
   * Delete the temporary profile.
   *
   * On Windows the browser's children keep handles open for a beat after the parent exits,
   * so a single immediate delete reliably fails; retry on a widening interval and give up
   * quietly rather than failing a close() that otherwise succeeded.
   */
  private removeProfile(): void {
    const dir = this.profileDir
    if (!dir) return
    let delay = 250
    const attempt = (): void => {
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 })
        if (!fs.existsSync(dir)) return
      } catch {
        /* still locked */
      }
      delay = Math.min(delay * 2, 4000)
      if (Date.now() < deadline) setTimeout(attempt, delay).unref()
    }
    const deadline = Date.now() + 30000
    attempt()
  }
}

export type { RemoteValue, NodeRemoteValue }
