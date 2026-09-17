import { CDPSession } from './CDPSession'
import { Viewport, NavigateOptions, BoundingBox, ClickOptions, FillOptions, Cookie } from '../core/types'
import { deepQueryExpression } from '../intelligence/domTraversal'

export interface DOMNode {
  tag: string
  id?: string
  classes: string[]
  role?: string
  ariaLabel?: string
  ariaDescribedBy?: string
  href?: string
  src?: string
  type?: string
  name?: string
  placeholder?: string
  value?: string
  children: DOMNode[]
  bbox?: BoundingBox
}

export type RequestPausedHandler = (params: Record<string, unknown>) => void | Promise<void>

const DEFAULT_TIMEOUT = 30000
const POLL_INTERVAL = 100
const NETWORK_IDLE_WINDOW = 500

/** A value as the protocol describes it, before any attempt to serialise it. */
export interface RemoteObject {
  type: string
  subtype?: string
  value?: unknown
  objectId?: string
  description?: string
  className?: string
  unserializableValue?: string
}

interface EvaluateResponse {
  result: RemoteObject
  exceptionDetails?: { text?: string; exception?: { description?: string } }
}

interface KeyDefinition {
  key: string
  code: string
  keyCode: number
  text?: string
}

const KEY_DEFINITIONS: Record<string, KeyDefinition> = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  Shift: { key: 'Shift', code: 'ShiftLeft', keyCode: 16 },
  Control: { key: 'Control', code: 'ControlLeft', keyCode: 17 },
  Alt: { key: 'Alt', code: 'AltLeft', keyCode: 18 },
  Meta: { key: 'Meta', code: 'MetaLeft', keyCode: 91 },
}

/**
 * Resolve a key name (Playwright-style: `Enter`, `a`, `Shift+Tab`) to a CDP key definition.
 * @param key - Key name
 * @returns Key definition with `key`, `code`, `keyCode` and optional `text`
 */
/** Errors that mean the browser is gone: retrying can never succeed. */
const CONNECTION_LOST = /connection is not open|connection closed|websocket is not open|socket hang up|target closed|browser has been closed/i

/** A promise whose pending timers and listeners can be released when it loses a race. */
export type CancellablePromise<T> = Promise<T> & { cancel: () => void }

/**
 * Turn a CDP remote object into a value, or refuse loudly.
 *
 * `returnByValue` cannot serialise a DOM node or a function, and it reports NaN and
 * Infinity as an absent value with a description. Returning `result.value` blindly
 * therefore hands back `{}` or `undefined` for cases that are really programmer errors,
 * which is the classic source of "the check passed but the value was empty".
 * @param remote - The `result` object from Runtime.evaluate or Runtime.callFunctionOn
 * @param source - Expression or function source, quoted in the error
 * @returns The deserialised value
 * @throws Error when the value cannot cross the protocol boundary
 */
export function unwrapRemoteValue<T>(remote: RemoteObject, source: string): T {
  const where = source.slice(0, 200)
  if (remote.type === 'number' && remote.value === undefined) {
    // NaN, Infinity and -Infinity have no JSON form and travel as text
    const text = remote.unserializableValue ?? remote.description
    if (text !== undefined) return Number(text) as T
  }
  if (remote.type === 'function') {
    throw new Error(`evaluate returned a function, which cannot be serialised — return a plain value instead: ${where}`)
  }
  if (remote.type === 'object' && remote.subtype === 'node') {
    throw new Error(
      `evaluate returned a DOM node, which cannot be serialised (${remote.description ?? 'no description'}) — ` +
        `return a plain value such as its id, text or a boolean instead: ${where}`
    )
  }
  if (remote.type === 'object' && remote.value === undefined && remote.subtype !== 'null') {
    const kind = remote.subtype ?? remote.className ?? 'object'
    throw new Error(
      `evaluate returned a non-serialisable ${kind} (${remote.description ?? 'no description'}) — ` +
        `return a plain value such as its id or text instead: ${where}`
    )
  }
  return remote.value as T
}

/**
 * Physical `code` and legacy `keyCode` for punctuation on a US layout.
 *
 * Pages bind shortcuts to these ("/" to focus search, "-" in a date field) and read
 * `event.code` or `event.keyCode`; without the table both arrive as "" and 0, so the
 * handler never fires and the test looks like a page bug.
 */
const PUNCTUATION_KEYS: Record<string, [string, number]> = {
  ' ': ['Space', 32],
  '-': ['Minus', 189],
  '=': ['Equal', 187],
  '[': ['BracketLeft', 219],
  ']': ['BracketRight', 221],
  '\\': ['Backslash', 220],
  ';': ['Semicolon', 186],
  "'": ['Quote', 222],
  ',': ['Comma', 188],
  '.': ['Period', 190],
  '/': ['Slash', 191],
  '`': ['Backquote', 192],
}

export function keyDefinition(key: string): KeyDefinition {
  const known = KEY_DEFINITIONS[key]
  if (known) return known
  if (key.length === 1) {
    const punctuation = PUNCTUATION_KEYS[key]
    if (punctuation) return { key, code: punctuation[0], keyCode: punctuation[1], text: key }
    const upper = key.toUpperCase()
    const isLetter = /[A-Z]/.test(upper)
    const isDigit = /[0-9]/.test(key)
    return {
      key,
      code: isLetter ? `Key${upper}` : isDigit ? `Digit${key}` : '',
      keyCode: isLetter || isDigit ? upper.charCodeAt(0) : 0,
      text: key,
    }
  }
  return { key, code: key, keyCode: 0 }
}

/** Snapshot of the conditions that decide whether an element can be clicked. */
interface ActionabilityState {
  connected: boolean
  visible: boolean
  enabled: boolean
  hitTarget: boolean
  offCanvas: boolean
  /** On the page but scrolled out of the viewport, so no hit test can reach it. */
  outsideViewport: boolean
  hiddenBy: string | null
  hitBy: string | null
  x: number
  y: number
  width: number
  height: number
  clickX: number
  clickY: number
}

/**
 * Maps high-level ScreenVision operations onto CDP commands for a single page session.
 */
export class ProtocolMapper {
  private documentNodeId: number | null = null
  private inflightRequests: Set<string> = new Set()
  private lastNetworkActivity = Date.now()
  private networkTrackingEnabled = false
  private routeHandlers: Array<{ pattern: RegExp; source: string; handler: RequestPausedHandler }> = []
  private fetchEnabled = false
  /** Session listeners this mapper registered, released by {@link dispose}. */
  private ownListeners: Array<[string, (params: Record<string, unknown>) => void]> = []

  /**
   * @param session - CDP session for the page this mapper controls
   */
  constructor(private session: CDPSession) {
    this.listen('DOM.documentUpdated', () => {
      this.documentNodeId = null
    })
  }

  /**
   * Subscribe to a session event, remembering it so {@link dispose} can undo it.
   * @param event - CDP event name
   * @param listener - Handler
   */
  private listen(event: string, listener: (params: Record<string, unknown>) => void): void {
    this.ownListeners.push([event, listener])
    this.session.on(event, listener)
  }

  /**
   * Release every session listener this mapper registered.
   *
   * Called from `Page.close()`. Without it each closed page left its listeners behind,
   * and each closure pinned the page, this mapper and its inflight-request set.
   */
  dispose(): void {
    for (const [event, listener] of this.ownListeners) this.session.off(event, listener)
    this.ownListeners = []
    this.routeHandlers = []
  }

  /** The underlying CDP session (used by Page for events). */
  get cdpSession(): CDPSession {
    return this.session
  }

  // ── Navigation ──────────────────────────────────────────────────────────────

  /**
   * Navigate the page (CDP `Page.navigate`) and wait for the requested lifecycle state.
   * @param url - Absolute URL (or `about:blank`)
   * @param options - waitUntil (`load` default), timeout, referer
   * @returns Resolves when the wait condition is met
   * @throws Error on navigation failure or timeout
   */
  /**
   * Navigate a single frame, leaving the rest of the page untouched.
   *
   * `Page.navigate` takes a frameId; without one it replaces the top-level document. Waiting
   * on `Page.frameStoppedLoading` for this specific frame matters because a busy page fires
   * that event for other frames too, and taking the first one would return while this frame
   * is still blank.
   * @param frameId - CDP frame id to navigate
   * @param url - Absolute URL
   * @param timeout - How long to wait for the frame to stop loading
   */
  async navigateFrame(frameId: string, url: string, timeout: number): Promise<void> {
    const started = Date.now()
    const stopped = this.waitForEvent(
      'Page.frameStoppedLoading',
      timeout,
      (params) => (params.frameId as string | undefined) === frameId
    )
    stopped.catch(() => undefined)
    try {
      const result = await this.session.send('Page.navigate', { url, frameId })
      if (typeof result.errorText === 'string' && result.errorText) throw new Error(result.errorText)
    } catch (err) {
      stopped.cancel()
      throw new Error(`frame navigate(${url}) failed: ${(err as Error).message}`)
    }
    // the frame's nodes are gone; anything cached about the document is stale
    this.documentNodeId = null
    try {
      await stopped
    } catch {
      throw new Error(
        `frame navigate(${url}) did not finish loading within ${timeout}ms (waited ${Date.now() - started}ms)`
      )
    }
  }

  async navigate(url: string, options?: NavigateOptions): Promise<void> {
    const waitUntil = options?.waitUntil ?? 'load'
    const timeout = options?.timeout ?? DEFAULT_TIMEOUT
    const started = Date.now()
    this.ensureNetworkTracking()

    const loadPromise = this.waitForEvent(
      waitUntil === 'domcontentloaded' ? 'Page.domContentEventFired' : 'Page.loadEventFired',
      timeout
    )
    loadPromise.catch(() => undefined)

    try {
      const params: Record<string, unknown> = { url }
      if (options?.referer) params.referrer = options.referer
      const result = await this.session.send('Page.navigate', params)
      if (typeof result.errorText === 'string' && result.errorText) {
        throw new Error(result.errorText)
      }
    } catch (err) {
      throw new Error(`navigate(${url}) failed: ${(err as Error).message}`)
    }
    this.documentNodeId = null
    if (waitUntil === 'commit') {
      loadPromise.cancel()
      return
    }

    const remaining = Math.max(0, timeout - (Date.now() - started))
    const readyTarget = waitUntil === 'domcontentloaded' ? ['interactive', 'complete'] : ['complete']
    try {
      await Promise.race([
        loadPromise,
        this.pollUntil(
          async () => {
            const state = await this.evaluate<string>('document.readyState')
            return readyTarget.includes(state)
          },
          remaining,
          `navigate(${url}): page did not reach ${waitUntil}`
        ),
      ])
    } catch (err) {
      throw new Error(`navigate(${url}) failed waiting for ${waitUntil}: ${(err as Error).message}`)
    } finally {
      loadPromise.cancel()
    }
    if (waitUntil === 'networkidle') {
      await this.waitForNetworkIdle(Math.max(0, timeout - (Date.now() - started)))
    }
  }

  /**
   * Reload the page (CDP `Page.reload`) and wait for load.
   * @param options - waitUntil and timeout
   * @returns Resolves after the reload completes
   */
  async reload(options?: { waitUntil?: string; timeout?: number }): Promise<void> {
    const timeout = options?.timeout ?? DEFAULT_TIMEOUT
    const loadPromise = this.waitForEvent('Page.loadEventFired', timeout)
    loadPromise.catch(() => undefined)
    try {
      await this.session.send('Page.reload', {})
      this.documentNodeId = null
      if (options?.waitUntil === 'commit') return
      await loadPromise
    } catch (err) {
      throw new Error(`reload failed: ${(err as Error).message}`)
    } finally {
      loadPromise.cancel()
    }
  }

  /**
   * Navigate back in history (`window.history.back()`).
   * @returns Resolves after the history navigation has been issued and the document settled
   */
  async goBack(): Promise<void> {
    await this.historyNavigate('window.history.back()')
  }

  /**
   * Navigate forward in history (`window.history.forward()`).
   * @returns Resolves after the history navigation has been issued and the document settled
   */
  async goForward(): Promise<void> {
    await this.historyNavigate('window.history.forward()')
  }

  private async historyNavigate(expression: string): Promise<void> {
    const loadPromise = this.waitForEvent('Page.loadEventFired', 5000)
    loadPromise.catch(() => undefined)
    let settleTimer: NodeJS.Timeout | undefined
    try {
      await this.evaluate<void>(expression)
      this.documentNodeId = null
      await Promise.race([
        loadPromise,
        new Promise<void>((r) => {
          settleTimer = setTimeout(r, 1000)
        }),
      ])
    } catch (err) {
      throw new Error(`${expression} failed: ${(err as Error).message}`)
    } finally {
      loadPromise.cancel()
      if (settleTimer) clearTimeout(settleTimer)
    }
  }

  /**
   * Current document title (`document.title`).
   * @returns Title string
   */
  async title(): Promise<string> {
    return this.evaluate<string>('document.title')
  }

  /**
   * Current location (`window.location.href`).
   * @returns URL string
   */
  async url(): Promise<string> {
    return this.evaluate<string>('window.location.href')
  }

  // ── Viewport ────────────────────────────────────────────────────────────────

  /**
   * Apply viewport emulation (CDP `Emulation.setDeviceMetricsOverride`).
   * @param viewport - Width/height in CSS pixels
   * @param deviceScaleFactor - Device pixel ratio (default 1)
   * @param mobile - Emulate mobile layout (default false)
   */
  async setViewport(viewport: Viewport, deviceScaleFactor = 1, mobile = false): Promise<void> {
    try {
      await this.session.send('Emulation.setDeviceMetricsOverride', {
        width: viewport.width,
        height: viewport.height,
        deviceScaleFactor,
        mobile,
      })
    } catch (err) {
      throw new Error(`setViewport(${viewport.width}x${viewport.height}) failed: ${(err as Error).message}`)
    }
  }

  /**
   * Override the user agent (CDP `Emulation.setUserAgentOverride`).
   * @param userAgent - UA string
   */
  async setUserAgent(userAgent: string): Promise<void> {
    try {
      await this.session.send('Emulation.setUserAgentOverride', { userAgent })
    } catch (err) {
      throw new Error(`setUserAgent failed: ${(err as Error).message}`)
    }
  }

  /**
   * Toggle touch emulation (CDP `Emulation.setTouchEmulationEnabled`).
   * @param enabled - Whether touch events are emulated
   */
  async setTouchEnabled(enabled: boolean): Promise<void> {
    try {
      await this.session.send('Emulation.setTouchEmulationEnabled', { enabled, maxTouchPoints: enabled ? 5 : 1 })
    } catch (err) {
      throw new Error(`setTouchEnabled(${enabled}) failed: ${(err as Error).message}`)
    }
  }

  // ── DOM Querying ─────────────────────────────────────────────────────────────

  private async getDocumentNodeId(): Promise<number> {
    if (this.documentNodeId !== null) return this.documentNodeId
    const result = await this.session.send('DOM.getDocument', { depth: 0 })
    const root = result.root as { nodeId?: number } | undefined
    if (!root || typeof root.nodeId !== 'number') {
      throw new Error('DOM.getDocument returned no root node')
    }
    this.documentNodeId = root.nodeId
    return root.nodeId
  }

  /**
   * Query the first matching element (CDP `DOM.querySelector`).
   * @param selector - CSS selector
   * @returns nodeId or null when nothing matches
   */
  async querySelector(selector: string): Promise<number | null> {
    try {
      const nodeId = await this.getDocumentNodeId()
      const result = await this.session.send('DOM.querySelector', { nodeId, selector })
      const found = result.nodeId
      if (typeof found === 'number' && found > 0) return found
      // The protocol's query cannot cross a shadow boundary, so a control inside a component
      // is invisible to it. Every other resolution path funnels through here, which is why
      // the fallback belongs here rather than in each caller: without it `page.$` could find
      // an element that `click` and `fill` then could not touch.
      return this.nodeIdForExpression(deepQueryExpression(selector)).catch(() => null)
    } catch (err) {
      const message = (err as Error).message
      if (/Could not find node|not find node with given id/i.test(message)) {
        this.documentNodeId = null
        return this.querySelector(selector)
      }
      throw new Error(`querySelector("${selector}") failed: ${message}`)
    }
  }

  /**
   * Query all matching elements (CDP `DOM.querySelectorAll`).
   * @param selector - CSS selector
   * @returns Array of nodeIds (possibly empty)
   */
  async querySelectorAll(selector: string): Promise<number[]> {
    try {
      const nodeId = await this.getDocumentNodeId()
      const result = await this.session.send('DOM.querySelectorAll', { nodeId, selector })
      const ids = result.nodeIds
      return Array.isArray(ids) ? (ids as number[]) : []
    } catch (err) {
      const message = (err as Error).message
      if (/Could not find node|not find node with given id/i.test(message)) {
        this.documentNodeId = null
        return this.querySelectorAll(selector)
      }
      throw new Error(`querySelectorAll("${selector}") failed: ${message}`)
    }
  }

  /**
   * Query within a parent element (CDP `DOM.querySelector` on `parentNodeId`).
   * @param parentNodeId - Scope node
   * @param selector - CSS selector
   * @returns nodeId or null
   */
  async querySelectorWithin(parentNodeId: number, selector: string): Promise<number | null> {
    try {
      const result = await this.session.send('DOM.querySelector', { nodeId: parentNodeId, selector })
      const found = result.nodeId
      return typeof found === 'number' && found > 0 ? found : null
    } catch (err) {
      throw new Error(`querySelectorWithin(${parentNodeId}, "${selector}") failed: ${(err as Error).message}`)
    }
  }

  /**
   * Query all within a parent element (CDP `DOM.querySelectorAll` on `parentNodeId`).
   * @param parentNodeId - Scope node
   * @param selector - CSS selector
   * @returns Array of nodeIds
   */
  async querySelectorAllWithin(parentNodeId: number, selector: string): Promise<number[]> {
    try {
      const result = await this.session.send('DOM.querySelectorAll', { nodeId: parentNodeId, selector })
      const ids = result.nodeIds
      return Array.isArray(ids) ? (ids as number[]) : []
    } catch (err) {
      throw new Error(`querySelectorAllWithin(${parentNodeId}, "${selector}") failed: ${(err as Error).message}`)
    }
  }

  /**
   * Bounding box of an element's content box (CDP `DOM.getBoxModel`), in viewport CSS pixels.
   * @param nodeId - Element nodeId
   * @returns BoundingBox or null when the element has no layout (hidden/detached)
   */
  /**
   * Top-left of a frame's content area, in this document's viewport coordinates.
   *
   * A node inside a same-origin frame reports coordinates relative to that frame, but input
   * events are dispatched against the main viewport, so a click aimed with the raw numbers
   * lands in the wrong place. This is the offset that reconciles them.
   * @param frameId - CDP frame id
   * @returns Offset, or null when the frame has no owner element in this document
   */
  async frameContentOffset(frameId: string): Promise<{ x: number; y: number } | null> {
    try {
      const owner = await this.session.send('DOM.getFrameOwner', { frameId })
      const backendNodeId = owner.backendNodeId as number | undefined
      if (backendNodeId === undefined) return null
      const box = await this.session.send('DOM.getBoxModel', { backendNodeId })
      const model = box.model as { content?: number[] } | undefined
      const quad = model?.content
      if (!quad || quad.length < 8) return null
      return { x: Math.min(quad[0], quad[2], quad[4], quad[6]), y: Math.min(quad[1], quad[3], quad[5], quad[7]) }
    } catch {
      return null
    }
  }

  /**
   * Event listener types registered on an element and its ancestors.
   *
   * This answers a question no other automation library asks before acting: can this control
   * do anything at all? A button with no click listener, no `href` and no submit behaviour
   * is inert, and knowing that before the click turns a mysterious no-op into a diagnosis.
   * @param nodeId - Element nodeId
   * @param depth - How far up the ancestor chain to look
   * @returns Listener type names, e.g. `['click', 'keydown']`
   */
  async eventListeners(nodeId: number, depth = 4): Promise<string[]> {
    // `depth` walks DESCENDANTS, not ancestors, and never reaches document or window. Relying
    // on it alone reported "no listener on it or any ancestor" for every delegated handler --
    // one listener on `document` serving a whole list, which is how most real applications are
    // written. The claim was false and confident, in the same breath as reporting that the
    // click had worked. So the chain is walked explicitly here.
    const objectIds: string[] = []
    try {
      const resolved = await this.session.send('DOM.resolveNode', { nodeId })
      const self = (resolved.object as { objectId?: string } | undefined)?.objectId
      if (!self) return []
      objectIds.push(self)

      // the element's ancestors, then the two roots every delegated handler actually uses
      const chain = await this.session.send('Runtime.callFunctionOn', {
        objectId: self,
        functionDeclaration: `function() {
          const out = []
          let n = this.parentNode
          while (n) {
            out.push(n)
            n = n.parentNode || (n.host ? n.host : null)
          }
          if (out.indexOf(document) === -1) out.push(document)
          out.push(window)
          return out
        }`,
        returnByValue: false,
      })
      const arrayId = (chain.result as { objectId?: string } | undefined)?.objectId
      if (arrayId) {
        objectIds.push(arrayId)
        const props = await this.session.send('Runtime.getProperties', {
          objectId: arrayId,
          ownProperties: true,
        })
        for (const prop of (props.result as Array<Record<string, unknown>>) ?? []) {
          if (prop.name === 'length' || !prop.enumerable) continue
          const id = (prop.value as { objectId?: string } | undefined)?.objectId
          if (id) objectIds.push(id)
        }
      }

      const types = new Set<string>()
      for (let idx = 0; idx < objectIds.length; idx++) {
        // `depth` walks DESCENDANTS. That is wanted for the element itself, whose inner span
        // may carry the listener a click actually hits -- and catastrophic for document and
        // window, whose descendants are the entire page, which made every element report
        // every listener on the page and no element could ever look inert. Ancestors and the
        // two roots are asked only about listeners bound directly to them.
        const isSelf = idx === 0
        const result = await this.session
          .send('DOMDebugger.getEventListeners', {
            objectId: objectIds[idx],
            depth: isSelf ? depth : 0,
            pierce: isSelf,
          })
          .catch(() => null)
        for (const l of ((result?.listeners as Array<{ type?: string }> | undefined) ?? [])) {
          if (l.type) types.add(l.type)
        }
      }
      return [...types]
    } catch {
      // the protocol may refuse for detached or unusual nodes; absence of an answer is not
      // evidence of absence, so callers treat [] as "unknown" rather than "inert"
      return []
    } finally {
      for (const id of objectIds) {
        void this.session.send('Runtime.releaseObject', { objectId: id }).catch(() => undefined)
      }
    }
  }


  /**
   * Attach files to a file input.
   *
   * A file chooser cannot be driven by synthesising clicks: the dialog is native and outside
   * the page. The protocol sets the input's files directly, which is the only way this works.
   * @param nodeId - The `<input type="file">` element
   * @param files - Absolute paths
   */
  /**
   * Set an input's files when all you have is a backend node id.
   *
   * `Page.fileChooserOpened` identifies the input by backendNodeId, which survives across
   * documents where a nodeId does not; converting it to a nodeId first would be an extra
   * round trip and a chance to fail.
   * @param backendNodeId - The `<input type="file">` element
   * @param files - Absolute paths
   */
  async setFileInputFilesByBackendId(backendNodeId: number, files: string[]): Promise<void> {
    try {
      await this.session.send('DOM.setFileInputFiles', { backendNodeId, files })
    } catch (err) {
      throw new Error(`setFiles(${files.join(', ')}) failed: ${(err as Error).message}`)
    }
  }

  async setFileInputFiles(nodeId: number, files: string[]): Promise<void> {
    try {
      await this.session.send('DOM.setFileInputFiles', { nodeId, files })
    } catch (err) {
      throw new Error(`setInputFiles(${files.join(', ')}) failed: ${(err as Error).message}`)
    }
  }

  /**
   * Press the mouse, move in steps, and release: a drag the page will believe.
   *
   * A single jump from source to target does not produce a drag. Applications listen for
   * intermediate `mousemove` events, and HTML5 drag and drop needs several before it starts.
   * @param from - Start point in viewport coordinates
   * @param to - End point in viewport coordinates
   * @param steps - Intermediate moves
   */
  async dragMouse(from: { x: number; y: number }, to: { x: number; y: number }, steps = 12): Promise<void> {
    await this.mouseMove(from.x, from.y)
    await this.mouseButton('mousePressed', from.x, from.y)
    for (let i = 1; i <= steps; i++) {
      await this.mouseMove(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps)
    }
    await this.mouseButton('mouseReleased', to.x, to.y)
  }

  /**
   * Resolve an affordance recorded by the observer, by its position in that observation.
   *
   * The observer keeps the actual elements it collected, so this addresses the very element
   * the caller was shown rather than re-running a selector and hoping it still matches the
   * same thing.
   * @param index - Zero-based index into the recorded affordances
   * @returns nodeId, or null when the observation is stale or the element is gone
   */
  async nodeIdForObservedRef(index: number): Promise<number | null> {
    return this.nodeIdForExpression(
      `(window.__svRefs && window.__svRefs[${index}] && window.__svRefs[${index}].isConnected) ` +
        `? window.__svRefs[${index}] : null`
    ).catch(() => null)
  }

  async getBoundingBox(nodeId: number): Promise<BoundingBox | null> {
    try {
      const result = await this.session.send('DOM.getBoxModel', { nodeId })
      const model = result.model as { border?: number[]; content?: number[] } | undefined
      const quad = model?.border ?? model?.content
      if (!quad || quad.length < 8) return null
      const xs = [quad[0], quad[2], quad[4], quad[6]]
      const ys = [quad[1], quad[3], quad[5], quad[7]]
      const x = Math.min(...xs)
      const y = Math.min(...ys)
      const width = Math.max(...xs) - x
      const height = Math.max(...ys) - y
      if (width === 0 && height === 0) return null
      return { x, y, width, height }
    } catch (err) {
      const message = (err as Error).message
      if (/Could not compute box model|no layout|not find node/i.test(message)) return null
      throw new Error(`getBoundingBox(${nodeId}) failed: ${message}`)
    }
  }

  /**
   * Resolve a nodeId to a Runtime remote object id (CDP `DOM.resolveNode`).
   * @param nodeId - Element nodeId
   * @returns objectId usable with `Runtime.callFunctionOn`
   */
  async resolveObjectId(nodeId: number): Promise<string> {
    try {
      const result = await this.session.send('DOM.resolveNode', { nodeId })
      const obj = result.object as RemoteObject | undefined
      if (!obj?.objectId) throw new Error('no objectId returned')
      return obj.objectId
    } catch (err) {
      throw new Error(`resolveObjectId(${nodeId}) failed: ${(err as Error).message}`)
    }
  }

  /**
   * Call a function with the element as `this` (CDP `Runtime.callFunctionOn`) and return its value.
   * @param nodeId - Element nodeId
   * @param functionDeclaration - Source of a function; `this` is the element
   * @param args - JSON-serialisable arguments
   * @returns The function's return value (by value; promises awaited)
   */
  async callFunctionOn<T>(nodeId: number, functionDeclaration: string, args: unknown[] = []): Promise<T> {
    const objectId = await this.resolveObjectId(nodeId)
    try {
      const result = (await this.session.send('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration,
        arguments: args.map((value) => ({ value })),
        returnByValue: true,
        awaitPromise: true,
      })) as unknown as EvaluateResponse
      if (result.exceptionDetails) {
        throw new Error(
          result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'exception in page'
        )
      }
      return unwrapRemoteValue<T>(result.result, functionDeclaration)
    } catch (err) {
      throw new Error(`callFunctionOn(${nodeId}) failed: ${(err as Error).message}`)
    } finally {
      this.session.send('Runtime.releaseObject', { objectId }).catch(() => undefined)
    }
  }

  /**
   * Evaluate an expression that yields a DOM element and return its nodeId
   * (CDP `Runtime.evaluate` without returnByValue, then `DOM.requestNode`).
   * @param expression - JS expression returning an Element (or null)
   * @param contextId - Execution context to evaluate in; omit for the main frame
   * @returns nodeId or null when the expression yields no element
   */
  async nodeIdForExpression(expression: string, contextId?: number): Promise<number | null> {
    let objectId: string | undefined
    try {
      const result = (await this.session.send('Runtime.evaluate', {
        expression,
        returnByValue: false,
        awaitPromise: true,
        ...(contextId === undefined ? {} : { contextId }),
      })) as unknown as EvaluateResponse
      if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'exception')
      }
      objectId = result.result.objectId
      if (!objectId || result.result.subtype === 'null') return null
      await this.getDocumentNodeId()
      const node = await this.session.send('DOM.requestNode', { objectId })
      return typeof node.nodeId === 'number' && node.nodeId > 0 ? node.nodeId : null
    } catch (err) {
      throw new Error(`nodeIdForExpression failed: ${(err as Error).message}`)
    } finally {
      if (objectId) this.session.send('Runtime.releaseObject', { objectId }).catch(() => undefined)
    }
  }

  /**
   * All attributes of an element as a name→value map.
   * @param nodeId - Element nodeId
   * @returns Attribute record
   */
  async getAttributes(nodeId: number): Promise<Record<string, string>> {
    return this.callFunctionOn<Record<string, string>>(
      nodeId,
      `function() { const out = {}; for (const a of this.attributes) out[a.name] = a.value; return out }`
    )
  }

  /**
   * Outer HTML of an element (CDP `DOM.getOuterHTML`).
   * @param nodeId - Element nodeId
   * @returns HTML string
   */
  async getOuterHTML(nodeId: number): Promise<string> {
    try {
      const result = await this.session.send('DOM.getOuterHTML', { nodeId })
      return typeof result.outerHTML === 'string' ? result.outerHTML : ''
    } catch (err) {
      throw new Error(`getOuterHTML(${nodeId}) failed: ${(err as Error).message}`)
    }
  }

  /**
   * Evaluate a JavaScript expression in the page (CDP `Runtime.evaluate`).
   * @param expression - JS source; promises are awaited
   * @returns The serialised result value
   * @throws Error if the expression throws
   */
  /**
   * Register a script to run before any page script, on this and every future document.
   * @param source - JavaScript source
   * @returns Identifier that can be passed to `removeInitScript`
   */
  async addInitScript(source: string): Promise<string> {
    const result = await this.session.send('Page.addScriptToEvaluateOnNewDocument', { source })
    return String(result.identifier)
  }

  /**
   * Remove a previously registered init script.
   * @param identifier - Value returned by `addInitScript`
   */
  async removeInitScript(identifier: string): Promise<void> {
    await this.session.send('Page.removeScriptToEvaluateOnNewDocument', { identifier })
  }

  async evaluate<T>(expression: string, contextId?: number): Promise<T> {
    let result: EvaluateResponse
    try {
      // Deliberately NOT returnByValue: that flattens a DOM node to {} with no subtype, so
      // a node and a real empty object become indistinguishable. The remote object carries
      // the type, and the value is fetched below only when it can actually be serialised.
      result = (await this.session.send('Runtime.evaluate', {
        expression,
        returnByValue: false,
        awaitPromise: true,
        userGesture: true,
        ...(contextId === undefined ? {} : { contextId }),
      })) as unknown as EvaluateResponse
    } catch (err) {
      throw new Error(`evaluate failed: ${(err as Error).message} — expression: ${expression.slice(0, 200)}`)
    }
    if (result.exceptionDetails) {
      const detail =
        result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? 'unknown page exception'
      throw new Error(`evaluate threw in page: ${detail}`)
    }
    return this.materialise<T>(result.result, expression)
  }

  /**
   * Turn a remote object into a JavaScript value, refusing the ones that cannot travel.
   * @param remote - RemoteObject from Runtime.evaluate
   * @param source - Expression, quoted in any error
   * @returns The value
   * @throws Error when the result is a DOM node or a function
   */
  private async materialise<T>(remote: RemoteObject, source: string): Promise<T> {
    const objectId = remote.objectId
    const release = (): void => {
      if (objectId) void this.session.send('Runtime.releaseObject', { objectId }).catch(() => undefined)
    }
    if (remote.type !== 'object' && remote.type !== 'function') {
      release()
      return unwrapRemoteValue<T>(remote, source)
    }
    if (remote.type === 'function' || remote.subtype === 'node') {
      release()
      return unwrapRemoteValue<T>(remote, source)
    }
    if (remote.subtype === 'null' || !objectId) {
      release()
      return (remote.value ?? null) as T
    }
    try {
      const byValue = (await this.session.send('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: 'function() { return this }',
        returnByValue: true,
      })) as unknown as EvaluateResponse
      if (byValue.exceptionDetails) {
        throw new Error(byValue.exceptionDetails.exception?.description ?? byValue.exceptionDetails.text ?? 'unknown')
      }
      return byValue.result.value as T
    } catch (err) {
      throw new Error(
        `evaluate could not serialise its result (${(err as Error).message}) — ` +
          `return a plain value instead: ${source.slice(0, 200)}`
      )
    } finally {
      release()
    }
  }

  /**
   * Snapshot of the DOM tree as simplified JSON (tag, id, classes, aria, bbox, children).
   * @returns Array with the `<html>` root node
   */
  async getDOMTree(): Promise<DOMNode[]> {
    const script = `(() => {
      const walk = (el) => {
        const r = el.getBoundingClientRect()
        const node = {
          tag: el.tagName.toLowerCase(),
          classes: Array.from(el.classList),
          children: [],
          bbox: { x: r.x, y: r.y, width: r.width, height: r.height },
        }
        const attr = (n) => el.getAttribute(n)
        if (el.id) node.id = el.id
        if (attr('role')) node.role = attr('role')
        if (attr('aria-label')) node.ariaLabel = attr('aria-label')
        if (attr('aria-describedby')) node.ariaDescribedBy = attr('aria-describedby')
        if (attr('href')) node.href = attr('href')
        if (attr('src')) node.src = attr('src')
        if (attr('type')) node.type = attr('type')
        if (attr('name')) node.name = attr('name')
        if (attr('placeholder')) node.placeholder = attr('placeholder')
        if ('value' in el && typeof el.value === 'string' && el.value) node.value = el.value
        for (const child of el.children) {
          const t = child.tagName.toLowerCase()
          if (t === 'script' || t === 'style' || t === 'noscript') continue
          node.children.push(walk(child))
        }
        return node
      }
      return [walk(document.documentElement)]
    })()`
    try {
      return await this.evaluate<DOMNode[]>(script)
    } catch (err) {
      throw new Error(`getDOMTree failed: ${(err as Error).message}`)
    }
  }

  // ── Element Interaction ──────────────────────────────────────────────────────

  /**
   * Click an element: scroll into view, then dispatch mouse events at its centre.
   * @param nodeId - Element nodeId
   * @param options - button, clickCount, delay, position offset, force
   */
  async click(
    nodeId: number,
    options?: ClickOptions,
    offset?: { x: number; y: number }
  ): Promise<void> {
    const dx = offset?.x ?? 0
    const dy = offset?.y ?? 0
    try {
      await this.scrollIntoView(nodeId)
      if (options?.force) {
        const state = await this.actionabilityState(
          nodeId,
          options.position ? options.position.x : -1,
          options.position ? options.position.y : -1
        )
        // a real mouse event only reaches the element when nothing is on top of it
        if (state.visible && state.hitTarget) {
          await this.mouseClick(state.clickX + dx, state.clickY + dy, options)
        } else {
          await this.callFunctionOn<void>(nodeId, 'function() { this.click() }')
        }
        return
      }
      const point = await this.waitForActionable(nodeId, {
        timeout: options?.timeout,
        position: options?.position,
      })
      await this.mouseClick(point.x + dx, point.y + dy, options)
    } catch (err) {
      throw new Error(`click(${nodeId}) failed: ${(err as Error).message}`)
    }
  }

  /**
   * Dispatch a full mouse click at viewport coordinates.
   * @param x - Viewport x
   * @param y - Viewport y
   * @param options - button, clickCount, delay
   */
  async mouseClick(x: number, y: number, options?: ClickOptions): Promise<void> {
    const button = options?.button ?? 'left'
    const clickCount = options?.clickCount ?? 1
    await this.mouseMove(x, y)
    await this.session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount })
    if (options?.delay) await new Promise((r) => setTimeout(r, options.delay))
    await this.session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount })
  }

  /**
   * Tap at viewport coordinates: a real touch sequence, not a mouse click.
   *
   * A page that listens for `touchstart`, or that distinguishes a tap from a click to avoid
   * the 300ms delay, sees nothing from a synthesised mouse event.
   * @param x - Viewport x
   * @param y - Viewport y
   */
  async touchTap(x: number, y: number): Promise<void> {
    const point = [{ x: Math.round(x), y: Math.round(y), radiusX: 1, radiusY: 1, force: 1 }]
    try {
      await this.session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: point })
      await this.session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    } catch (err) {
      throw new Error(
        `tap(${Math.round(x)}, ${Math.round(y)}) failed: ${(err as Error).message}. ` +
          `Touch events require a context with touch enabled, such as a mobile device descriptor.`
      )
    }
  }

  /**
   * Drag a finger across the screen.
   * @param from - Start point
   * @param to - End point
   * @param steps - Intermediate moves
   */
  async touchSwipe(from: { x: number; y: number }, to: { x: number; y: number }, steps = 10): Promise<void> {
    const at = (x: number, y: number): Array<Record<string, number>> => [
      { x: Math.round(x), y: Math.round(y), radiusX: 1, radiusY: 1, force: 1 },
    ]
    await this.session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at(from.x, from.y) })
    for (let i = 1; i <= steps; i++) {
      await this.session.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: at(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps),
      })
    }
    await this.session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  }

  /**
   * Turn touch emulation on or off for this page.
   * @param enabled - Whether the page should report touch support
   * @param maxPoints - Maximum simultaneous touch points
   */
  async setTouchEmulation(enabled: boolean, maxPoints = 5): Promise<void> {
    await this.session
      .send('Emulation.setTouchEmulationEnabled', { enabled, maxTouchPoints: maxPoints })
      .catch(() => undefined)
    await this.session
      .send('Emulation.setEmitTouchEventsForMouse', { enabled: false })
      .catch(() => undefined)
  }

  /**
   * Move the mouse to viewport coordinates.
   * @param x - Viewport x
   * @param y - Viewport y
   */
  async mouseMove(x: number, y: number): Promise<void> {
    await this.session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' })
  }

  /**
   * Press or release the left mouse button at the current position.
   * @param type - `mousePressed` or `mouseReleased`
   * @param x - Viewport x
   * @param y - Viewport y
   */
  async mouseButton(type: 'mousePressed' | 'mouseReleased', x: number, y: number): Promise<void> {
    await this.session.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 })
  }

  /**
   * Fill an input/textarea/contenteditable: focus, clear, then `Input.insertText`.
   * @param nodeId - Element nodeId
   * @param value - Text to type
   * @param options - force (skip visibility check)
   */
  async fill(nodeId: number, value: string, options?: FillOptions): Promise<void> {
    try {
      if (!options?.force) {
        // click() has always scrolled first; fill() did not, so a form below the fold refused
        // every field while reporting an overlay that was not there. A control you would have
        // to scroll to reach is not a control you cannot use.
        await this.scrollIntoView(nodeId)
        await this.waitForActionable(nodeId, { timeout: options?.timeout })
      }
      // Writing to a <div> silently does nothing, which is how a form ends up empty while
      // every call reported success. Refuse, and name the control that would have worked.
      const fillable = await this.callFunctionOn<string>(
        nodeId,
        `function() {
          const tag = this.tagName.toLowerCase()
          const isField = tag === 'input' || tag === 'textarea' || tag === 'select' || this.isContentEditable
          if (isField) {
            // A readonly or disabled field accepts no input: writing to it "succeeds" while the
            // value never changes -- a silent no-op. Refuse it, like a real user could not type.
            if (this.disabled) return JSON.stringify({ tag: tag, hint: '', reason: 'disabled' })
            if (this.readOnly) return JSON.stringify({ tag: tag, hint: '', reason: 'readonly' })
            return ''
          }
          const inner = this.querySelector && this.querySelector('input, textarea, select, [contenteditable=""], [contenteditable="true"]')
          let hint = ''
          if (inner) {
            hint = inner.tagName.toLowerCase()
            if (inner.id) hint += '#' + inner.id
            else if (inner.getAttribute('name')) hint += '[name="' + inner.getAttribute('name') + '"]'
          }
          return JSON.stringify({ tag: tag, hint: hint })
        }`
      )
      if (fillable) {
        const detail = JSON.parse(fillable) as { tag: string; hint: string; reason?: string }
        if (detail.reason === 'readonly') throw new Error(`<${detail.tag}> is read-only and cannot be filled`)
        if (detail.reason === 'disabled') throw new Error(`<${detail.tag}> is disabled and cannot be filled`)
        throw new Error(
          `<${detail.tag}> is not a fillable control` +
            (detail.hint
              ? `. The nearest fillable element inside it is ${detail.hint}`
              : ' and contains no input, textarea, select or contenteditable element')
        )
      }
      await this.callFunctionOn<void>(
        nodeId,
        `function() {
          this.focus()
          if ('value' in this) {
            const proto = Object.getPrototypeOf(this)
            const desc = Object.getOwnPropertyDescriptor(proto, 'value')
            if (desc && desc.set) desc.set.call(this, ''); else this.value = ''
            this.dispatchEvent(new Event('input', { bubbles: true }))
          } else if (this.isContentEditable) {
            this.textContent = ''
          }
        }`
      )
      await this.session.send('Input.insertText', { text: value })
      await this.callFunctionOn<void>(nodeId, `function() { this.dispatchEvent(new Event('change', { bubbles: true })) }`)
    } catch (err) {
      throw new Error(`fill(${nodeId}) failed: ${(err as Error).message}`)
    }
  }

  /**
   * Press a key while an element is focused (CDP `Input.dispatchKeyEvent` down/up).
   * @param nodeId - Element to focus first
   * @param key - Key name, e.g. `Enter`, `a`, `Shift+Tab`
   */
  async press(nodeId: number, key: string): Promise<void> {
    try {
      await this.focus(nodeId)
      await this.keyPress(key)
    } catch (err) {
      throw new Error(`press(${nodeId}, ${key}) failed: ${(err as Error).message}`)
    }
  }

  /**
   * Press and release a key (with optional `Modifier+Key` combos) on the focused element.
   * @param key - Key name or combo
   */
  async keyPress(key: string): Promise<void> {
    const parts = key.split('+')
    const main = parts.pop() ?? key
    const modifiers = parts
    for (const m of modifiers) await this.keyDown(m)
    await this.keyDown(main)
    await this.keyUp(main)
    for (const m of modifiers.reverse()) await this.keyUp(m)
  }

  /**
   * Key down event.
   * @param key - Key name
   */
  async keyDown(key: string): Promise<void> {
    const def = keyDefinition(key)
    await this.session.send('Input.dispatchKeyEvent', {
      type: def.text ? 'keyDown' : 'rawKeyDown',
      key: def.key,
      code: def.code,
      windowsVirtualKeyCode: def.keyCode,
      nativeVirtualKeyCode: def.keyCode,
      text: def.text,
      unmodifiedText: def.text,
    })
  }

  /**
   * Key up event.
   * @param key - Key name
   */
  async keyUp(key: string): Promise<void> {
    const def = keyDefinition(key)
    await this.session.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: def.key,
      code: def.code,
      windowsVirtualKeyCode: def.keyCode,
      nativeVirtualKeyCode: def.keyCode,
    })
  }

  /**
   * Type text character by character via `Input.insertText`.
   * @param text - Text to type
   * @param delay - Milliseconds between characters
   */
  async typeText(text: string, delay = 0): Promise<void> {
    for (const ch of text) {
      await this.session.send('Input.insertText', { text: ch })
      if (delay) await new Promise((r) => setTimeout(r, delay))
    }
  }

  /**
   * Select options in a `<select>` element and dispatch `input`/`change`.
   * @param nodeId - Select element nodeId
   * @param values - Option values (or labels) to select
   */
  async selectOption(nodeId: number, values: string[]): Promise<void> {
    try {
      await this.callFunctionOn<void>(
        nodeId,
        `function(values) {
          if (this.tagName !== 'SELECT') throw new Error('element is not a <select>')
          const wanted = new Set(values)
          let matched = 0
          for (const opt of this.options) {
            const hit = wanted.has(opt.value) || wanted.has(opt.label) || wanted.has(opt.textContent.trim())
            opt.selected = hit
            if (hit) matched++
            if (hit && !this.multiple) break
          }
          if (matched === 0) throw new Error('no option matched ' + JSON.stringify(values))
          this.dispatchEvent(new Event('input', { bubbles: true }))
          this.dispatchEvent(new Event('change', { bubbles: true }))
        }`,
        [values]
      )
    } catch (err) {
      throw new Error(`selectOption(${nodeId}) failed: ${(err as Error).message}`)
    }
  }

  /**
   * Focus an element (CDP `DOM.focus`).
   * @param nodeId - Element nodeId
   */
  async focus(nodeId: number): Promise<void> {
    try {
      await this.session.send('DOM.focus', { nodeId })
    } catch (err) {
      throw new Error(`focus(${nodeId}) failed: ${(err as Error).message}`)
    }
  }

  /**
   * Scroll an element into view (CDP `DOM.scrollIntoViewIfNeeded`).
   * @param nodeId - Element nodeId
   */
  async scrollIntoView(nodeId: number): Promise<void> {
    try {
      await this.session.send('DOM.scrollIntoViewIfNeeded', { nodeId })
    } catch (err) {
      const message = (err as Error).message
      if (/not visible|no layout|Node does not have a layout object/i.test(message)) return
      throw new Error(`scrollIntoView(${nodeId}) failed: ${message}`)
    }
  }

  // ── Screenshots ──────────────────────────────────────────────────────────────

  /**
   * Capture a screenshot (CDP `Page.captureScreenshot`).
   * @param options - format (png default), quality, clip (page coordinates), captureBeyondViewport, omitBackground
   * @returns Decoded image bytes
   */
  async screenshot(options?: {
    format?: 'png' | 'jpeg' | 'webp'
    quality?: number
    clip?: BoundingBox
    captureBeyondViewport?: boolean
    omitBackground?: boolean
  }): Promise<Buffer> {
    const format = options?.format ?? 'png'
    const params: Record<string, unknown> = { format, fromSurface: true }
    if (format !== 'png' && typeof options?.quality === 'number') params.quality = options.quality
    if (options?.clip) {
      params.clip = {
        x: options.clip.x,
        y: options.clip.y,
        width: Math.max(1, options.clip.width),
        height: Math.max(1, options.clip.height),
        scale: 1,
      }
    }
    if (options?.captureBeyondViewport) params.captureBeyondViewport = true
    try {
      if (options?.omitBackground) {
        await this.session.send('Emulation.setDefaultBackgroundColorOverride', {
          color: { r: 0, g: 0, b: 0, a: 0 },
        })
      }
      const result = await this.session.send('Page.captureScreenshot', params)
      if (typeof result.data !== 'string') throw new Error('no image data returned')
      return Buffer.from(result.data, 'base64')
    } catch (err) {
      throw new Error(`screenshot(${format}) failed: ${(err as Error).message}`)
    } finally {
      if (options?.omitBackground) {
        this.session.send('Emulation.setDefaultBackgroundColorOverride', {}).catch(() => undefined)
      }
    }
  }

  /**
   * Layout metrics: CSS viewport size, full content size and scroll offset (CDP `Page.getLayoutMetrics`).
   * @returns viewport, contentSize and scroll position
   */
  async layoutMetrics(): Promise<{ viewport: Viewport; contentSize: Viewport; scroll: { x: number; y: number } }> {
    try {
      const result = await this.session.send('Page.getLayoutMetrics')
      const visual = (result.cssVisualViewport ?? result.visualViewport) as
        | { clientWidth: number; clientHeight: number; pageX: number; pageY: number }
        | undefined
      const content = (result.cssContentSize ?? result.contentSize) as { width: number; height: number } | undefined
      const layout = (result.cssLayoutViewport ?? result.layoutViewport) as
        | { clientWidth: number; clientHeight: number; pageX: number; pageY: number }
        | undefined
      const vp = layout ?? visual
      if (!vp || !content) throw new Error('incomplete layout metrics')
      return {
        viewport: { width: vp.clientWidth, height: vp.clientHeight },
        contentSize: { width: Math.ceil(content.width), height: Math.ceil(content.height) },
        scroll: { x: vp.pageX, y: vp.pageY },
      }
    } catch (err) {
      throw new Error(`layoutMetrics failed: ${(err as Error).message}`)
    }
  }

  // ── Network ──────────────────────────────────────────────────────────────────

  /**
   * Enable request interception for a URL pattern (CDP `Fetch.enable`) and
   * register a handler invoked with each `Fetch.requestPaused` event that matches.
   * @param pattern - Glob pattern (`**`, `*`, `?`)
   * @param handler - Receives the raw `Fetch.requestPaused` params
   */
  async setupRouting(pattern: string, handler: RequestPausedHandler): Promise<void> {
    try {
      this.routeHandlers.push({ pattern: globToRegExp(pattern), source: pattern, handler })
      if (!this.fetchEnabled) {
        this.fetchEnabled = true
        this.listen('Fetch.requestPaused', (params) => {
          void this.dispatchRequestPaused(params)
        })
      }
      await this.session.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] })
    } catch (err) {
      throw new Error(`setupRouting(${pattern}) failed: ${(err as Error).message}`)
    }
  }

  /**
   * Remove routing handlers for a pattern; disables `Fetch` when none remain.
   * @param pattern - Pattern originally passed to {@link setupRouting}
   */
  async removeRouting(pattern: string): Promise<void> {
    this.routeHandlers = this.routeHandlers.filter((r) => r.source !== pattern)
    if (this.routeHandlers.length === 0 && this.fetchEnabled) {
      this.fetchEnabled = false
      try {
        await this.session.send('Fetch.disable')
      } catch (err) {
        throw new Error(`removeRouting(${pattern}) failed: ${(err as Error).message}`)
      }
    }
  }

  private async dispatchRequestPaused(params: Record<string, unknown>): Promise<void> {
    const request = params.request as { url?: string } | undefined
    const url = request?.url ?? ''
    const requestId = params.requestId as string
    const match = this.routeHandlers.find((r) => r.pattern.test(url))
    if (!match) {
      await this.continueRequest(requestId).catch(() => undefined)
      return
    }
    try {
      await match.handler(params)
    } catch {
      /* the handler threw; the continue below un-suspends the request */
    }
    // A handler that returns without calling fulfill/continue/abort (an early return in a
    // conditional branch is the usual way) would otherwise leave this request suspended
    // until the navigation times out, which stalls the entire page. Continuing an
    // already-answered request is rejected by the protocol and safely ignored here.
    await this.continueRequest(requestId).catch(() => undefined)
  }

  /**
   * Fulfil an intercepted request (CDP `Fetch.fulfillRequest`).
   * @param requestId - From `Fetch.requestPaused`
   * @param response - responseCode, responseHeaders, body (base64)
   */
  async fulfillRequest(requestId: string, response: Record<string, unknown>): Promise<void> {
    try {
      await this.session.send('Fetch.fulfillRequest', { requestId, ...response })
    } catch (err) {
      throw new Error(`fulfillRequest(${requestId}) failed: ${(err as Error).message}`)
    }
  }

  /**
   * Continue an intercepted request (CDP `Fetch.continueRequest`).
   * @param requestId - From `Fetch.requestPaused`
   * @param overrides - url, method, headers, postData
   */
  async continueRequest(requestId: string, overrides?: Record<string, unknown>): Promise<void> {
    try {
      await this.session.send('Fetch.continueRequest', { requestId, ...(overrides ?? {}) })
    } catch (err) {
      throw new Error(`continueRequest(${requestId}) failed: ${(err as Error).message}`)
    }
  }

  /**
   * Abort an intercepted request (CDP `Fetch.failRequest`).
   * @param requestId - From `Fetch.requestPaused`
   * @param errorReason - CDP `Network.ErrorReason`, e.g. `Failed`, `Aborted`
   */
  async failRequest(requestId: string, errorReason: string): Promise<void> {
    try {
      await this.session.send('Fetch.failRequest', { requestId, errorReason })
    } catch (err) {
      throw new Error(`failRequest(${requestId}) failed: ${(err as Error).message}`)
    }
  }

  /**
   * Set a cookie (CDP `Network.setCookie`).
   * @param cookie - Cookie to set
   */
  async addCookie(cookie: Cookie): Promise<void> {
    try {
      const params: Record<string, unknown> = {
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path,
        httpOnly: cookie.httpOnly,
        secure: cookie.secure,
        sameSite: cookie.sameSite,
      }
      if (cookie.expires > 0) params.expires = cookie.expires
      const result = await this.session.send('Network.setCookie', params)
      if (result.success === false) throw new Error('browser rejected cookie')
    } catch (err) {
      throw new Error(`addCookie(${cookie.name}) failed: ${(err as Error).message}`)
    }
  }

  /**
   * All cookies visible to this session (CDP `Network.getAllCookies`).
   * @returns Cookie list
   */
  async getCookies(): Promise<Cookie[]> {
    try {
      const result = await this.session.send('Network.getAllCookies')
      const raw = (result.cookies ?? []) as Array<Record<string, unknown>>
      return raw.map(normalizeCookie)
    } catch (err) {
      throw new Error(`getCookies failed: ${(err as Error).message}`)
    }
  }

  /**
   * Clear all cookies (CDP `Network.clearBrowserCookies`).
   */
  async clearCookies(): Promise<void> {
    try {
      await this.session.send('Network.clearBrowserCookies')
    } catch (err) {
      throw new Error(`clearCookies failed: ${(err as Error).message}`)
    }
  }

  // ── JavaScript Dialogs ───────────────────────────────────────────────────────

  /**
   * Accept or dismiss the currently open JavaScript dialog (CDP `Page.handleJavaScriptDialog`).
   * @param accept - true to accept
   * @param promptText - Text for `prompt()` dialogs
   */
  async handleDialog(accept: boolean, promptText?: string): Promise<void> {
    try {
      const params: Record<string, unknown> = { accept }
      if (promptText !== undefined) params.promptText = promptText
      await this.session.send('Page.handleJavaScriptDialog', params)
    } catch (err) {
      throw new Error(`handleDialog(accept=${accept}) failed: ${(err as Error).message}`)
    }
  }

  // ── Waiting ──────────────────────────────────────────────────────────────────

  /**
   * Poll for a selector every 100ms until it reaches the requested state.
   * @param selector - CSS selector
   * @param options - state (`attached` default, `visible`, `hidden`, `detached`) and timeout
   * @returns nodeId of the matched element (0 for `detached`/`hidden` success)
   * @throws Error on timeout
   */
  async waitForSelector(selector: string, options?: { state?: string; timeout?: number }): Promise<number> {
    const state = options?.state ?? 'attached'
    const timeout = options?.timeout ?? DEFAULT_TIMEOUT
    let lastNodeId = 0
    await this.pollUntil(
      async () => {
        const nodeId = await this.querySelector(selector)
        if (state === 'attached') {
          lastNodeId = nodeId ?? 0
          return nodeId !== null
        }
        if (state === 'detached') return nodeId === null
        if (nodeId === null) return state === 'hidden'
        const visible = await this.isVisible(nodeId)
        lastNodeId = nodeId
        return state === 'visible' ? visible : !visible
      },
      timeout,
      `waitForSelector("${selector}", state=${state}) timed out after ${timeout}ms`
    )
    return lastNodeId
  }

  /**
   * Whether an element is rendered and visible (`offsetParent`/client rects + computed style).
   * @param nodeId - Element nodeId
   * @returns true when visible
   */
  /**
   * Geometry and hit-test facts for one element, used by the verifier's actionability checks.
   * @param nodeId - Target node
   * @returns rect, whether the element sits outside the scrollable canvas, and whether another
   *          element covers its centre point (`obscuredBy` is that element's description)
   */
  async elementFacts(nodeId: number): Promise<{
    width: number
    height: number
    offCanvas: boolean
    obscured: boolean
    obscuredBy: string | null
  }> {
    try {
      const raw = await this.callFunctionOn<string>(
        nodeId,
        `function() {
          const el = this
          const r = el.getBoundingClientRect()
          const doc = document.documentElement
          const sx = window.scrollX, sy = window.scrollY
          // absolute document coordinates
          const left = r.left + sx, top = r.top + sy
          const right = left + r.width, bottom = top + r.height
          const offCanvas = r.width > 0 && r.height > 0 && (right <= 0 || bottom <= 0 || left >= doc.scrollWidth || top >= doc.scrollHeight)
          let obscured = false, obscuredBy = null
          const cx = r.left + r.width / 2, cy = r.top + r.height / 2
          // On the page but not on the screen. The hit test can only ask about points inside
          // the viewport, so without this an element below the fold comes back with no hit
          // target and gets reported as "another element is on top of it" -- sending the
          // reader to look for an overlay that does not exist.
          const outsideViewport = r.width > 0 && r.height > 0 &&
            (cx < 0 || cy < 0 || cx > window.innerWidth || cy > window.innerHeight)
          if (r.width > 0 && r.height > 0 && cx >= 0 && cy >= 0 && cx <= window.innerWidth && cy <= window.innerHeight) {
            const svDeep = (x, y) => {
            let n = document.elementFromPoint(x, y)
            for (let d = 0; n && n.shadowRoot && d < 10; d++) {
              const inner = n.shadowRoot.elementFromPoint(x, y)
              if (!inner || inner === n) break
              n = inner
            }
            return n
          }
          const svRelated = (a, b) => {
            if (!a || !b) return false
            if (a === b || a.contains(b) || b.contains(a)) return true
            let h = b.getRootNode && b.getRootNode().host
            while (h) { if (h === a || a.contains(h)) return true; h = h.getRootNode && h.getRootNode().host }
            h = a.getRootNode && a.getRootNode().host
            while (h) { if (h === b || b.contains(h)) return true; h = h.getRootNode && h.getRootNode().host }
            return false
          }
            const hit = svDeep(cx, cy)
            if (hit && !svRelated(el, hit)) {
              obscured = true
              const id = hit.id ? '#' + hit.id : ''
              const cls = hit.className && typeof hit.className === 'string' && hit.className.trim()
                ? '.' + hit.className.trim().split(/\\s+/)[0] : ''
              obscuredBy = hit.tagName.toLowerCase() + id + cls
            }
          }
          return JSON.stringify({ width: r.width, height: r.height, offCanvas: offCanvas, outsideViewport: outsideViewport, obscured: obscured, obscuredBy: obscuredBy })
        }`
      )
      return JSON.parse(raw) as { width: number; height: number; offCanvas: boolean; outsideViewport: boolean; obscured: boolean; obscuredBy: string | null }
    } catch (err) {
      throw new Error(`elementFacts(nodeId=${nodeId}) failed: ${(err as Error).message}`)
    }
  }

  /**
   * Wait until an element is actually clickable, then return the point to click.
   *
   * Four conditions must hold at the same instant, which is what separates a click that
   * works from one that lands on a modal backdrop mid-animation: the element is attached
   * and visible, its box has stopped moving between two samples, it is enabled, and the
   * topmost element at the click point is the element itself or a descendant.
   * @param nodeId - Element nodeId
   * @param options - Timeout in ms and an optional position offset within the element
   * @returns Viewport coordinates to dispatch the click at
   * @throws Error naming the condition that never became true and what blocked it
   */
  async waitForActionable(
    nodeId: number,
    options?: { timeout?: number; position?: { x: number; y: number } }
  ): Promise<{ x: number; y: number }> {
    const timeout = options?.timeout ?? 5000
    const deadline = Date.now() + timeout
    const px = options?.position ? options.position.x : -1
    const py = options?.position ? options.position.y : -1
    let previous: string | null = null
    let state: ActionabilityState | null = null

    for (;;) {
      state = await this.actionabilityState(nodeId, px, py)
      const geometry = `${state.x},${state.y},${state.width},${state.height}`
      const stable = previous === geometry
      previous = geometry
      if (state.connected && state.visible && state.enabled && state.hitTarget && stable) {
        return { x: state.clickX, y: state.clickY }
      }
      if (Date.now() >= deadline) break
      await new Promise((r) => setTimeout(r, 50))
    }

    const s = state as ActionabilityState
    let reason: string
    if (!s.connected) {
      reason = 'it is no longer attached to the document'
    } else if (!s.visible) {
      // a hiding rule is the cause; the zero box it produces is only the symptom
      reason = s.hiddenBy
        ? `it is hidden (${s.hiddenBy})`
        : `it has no size (${Math.round(s.width)}x${Math.round(s.height)})`
    } else if (!s.enabled) {
      reason = 'it is disabled'
    } else if (!s.hitTarget) {
      reason = s.offCanvas
        ? 'it sits outside the page canvas, so no click can reach it'
        : s.outsideViewport
          ? 'it is scrolled out of the viewport, so nothing can be clicked there yet'
          : `${s.hitBy ?? 'another element'} is on top of it at the click point`
    } else {
      reason = 'its position kept changing, so the element is still animating or the page is still laying out'
    }
    throw new Error(
      `element did not become clickable within ${timeout}ms: ${reason}. Pass { force: true } to click it anyway.`
    )
  }

  /**
   * Single-round-trip snapshot of every condition `waitForActionable` cares about.
   * @param nodeId - Element nodeId
   * @param px - Position offset x within the element, or -1 for its centre
   * @param py - Position offset y within the element, or -1 for its centre
   * @returns The element's actionability state
   */
  private async actionabilityState(nodeId: number, px: number, py: number): Promise<ActionabilityState> {
    const raw = await this.callFunctionOn<string>(nodeId, `function(px, py) {
        const el = this
        const out = { connected: false, visible: false, enabled: false, hitTarget: false,
          offCanvas: false, hiddenBy: null, hitBy: null,
          x: 0, y: 0, width: 0, height: 0, clickX: 0, clickY: 0 }
        if (!el.isConnected) return JSON.stringify(out)
        out.connected = true
        const r = el.getBoundingClientRect()
        out.x = r.left; out.y = r.top; out.width = r.width; out.height = r.height
        const style = window.getComputedStyle(el)
        if (style.display === 'none') out.hiddenBy = 'display:none'
        else if (style.visibility === 'hidden') out.hiddenBy = 'visibility:hidden'
        else if (style.opacity === '0') out.hiddenBy = 'opacity:0'
        out.visible = !out.hiddenBy && r.width > 0 && r.height > 0
        const fieldset = el.closest ? el.closest('fieldset[disabled]') : null
        out.enabled = !el.disabled && !fieldset && style.pointerEvents !== 'none'
        const doc = document.documentElement
        const left = r.left + window.scrollX, top = r.top + window.scrollY
        out.offCanvas = r.width > 0 && r.height > 0 &&
          (left + r.width <= 0 || top + r.height <= 0 || left >= doc.scrollWidth || top >= doc.scrollHeight)
        const cx = px >= 0 ? r.left + px : r.left + r.width / 2
        const cy = py >= 0 ? r.top + py : r.top + r.height / 2
        out.clickX = cx; out.clickY = cy
        if (out.visible && cx >= 0 && cy >= 0 && cx <= window.innerWidth && cy <= window.innerHeight) {
          const svDeep = (x, y) => {
            let n = document.elementFromPoint(x, y)
            for (let d = 0; n && n.shadowRoot && d < 10; d++) {
              const inner = n.shadowRoot.elementFromPoint(x, y)
              if (!inner || inner === n) break
              n = inner
            }
            return n
          }
          const svRelated = (a, b) => {
            if (!a || !b) return false
            if (a === b || a.contains(b) || b.contains(a)) return true
            let h = b.getRootNode && b.getRootNode().host
            while (h) { if (h === a || a.contains(h)) return true; h = h.getRootNode && h.getRootNode().host }
            h = a.getRootNode && a.getRootNode().host
            while (h) { if (h === b || b.contains(h)) return true; h = h.getRootNode && h.getRootNode().host }
            return false
          }
          const hit = svDeep(cx, cy)
          if (svRelated(el, hit)) out.hitTarget = true
          else if (hit) {
            const id = hit.id ? '#' + hit.id : ''
            let cls = ''
            if (hit.className && typeof hit.className === 'string') {
              const first = hit.className.trim().split(' ')[0]
              if (first) cls = '.' + first
            }
            out.hitBy = hit.tagName.toLowerCase() + id + cls
          }
        }
        return JSON.stringify(out)
      }`, [px, py])
    return JSON.parse(raw) as ActionabilityState
  }

  /**
   * Where an element actually is, relative to the viewport and to what covers it.
   *
   * `isVisible` answers whether the browser renders an element, which is not the question an
   * agent is asking. An element parked at x=631 in a 390px viewport is rendered and entirely
   * unreachable, and answering "visible: true" for it is a lie an agent cannot detect.
   * @param nodeId - Element nodeId
   * @returns Rendering, viewport position and occlusion
   */
  async visibility(nodeId: number): Promise<{
    rendered: boolean
    inViewport: 'full' | 'partial' | 'none'
    occludedBy: string | null
    hiddenBy: string | null
    bbox: BoundingBox | null
  }> {
    try {
      const raw = await this.callFunctionOn<string>(
        nodeId,
        `function() {
          const el = this
          const out = { rendered: false, inViewport: 'none', occludedBy: null, hiddenBy: null, bbox: null }
          if (!el.isConnected) { out.hiddenBy = 'detached'; return JSON.stringify(out) }
          const style = window.getComputedStyle(el)
          if (style.display === 'none') out.hiddenBy = 'display:none'
          else if (style.visibility === 'hidden') out.hiddenBy = 'visibility:hidden'
          else if (style.opacity === '0') out.hiddenBy = 'opacity:0'
          const r = el.getBoundingClientRect()
          out.bbox = { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) }
          if (r.width <= 0 || r.height <= 0) { if (!out.hiddenBy) out.hiddenBy = 'zero size'; return JSON.stringify(out) }
          out.rendered = !out.hiddenBy
          const vw = window.innerWidth, vh = window.innerHeight
          const fully = r.left >= 0 && r.top >= 0 && r.right <= vw && r.bottom <= vh
          const partly = r.right > 0 && r.bottom > 0 && r.left < vw && r.top < vh
          out.inViewport = fully ? 'full' : partly ? 'partial' : 'none'
          if (out.rendered && out.inViewport !== 'none') {
            const cx = Math.min(Math.max(r.left + r.width / 2, 1), vw - 1)
            const cy = Math.min(Math.max(r.top + r.height / 2, 1), vh - 1)
            const svDeep = (x, y) => {
            let n = document.elementFromPoint(x, y)
            for (let d = 0; n && n.shadowRoot && d < 10; d++) {
              const inner = n.shadowRoot.elementFromPoint(x, y)
              if (!inner || inner === n) break
              n = inner
            }
            return n
          }
          const svRelated = (a, b) => {
            if (!a || !b) return false
            if (a === b || a.contains(b) || b.contains(a)) return true
            let h = b.getRootNode && b.getRootNode().host
            while (h) { if (h === a || a.contains(h)) return true; h = h.getRootNode && h.getRootNode().host }
            h = a.getRootNode && a.getRootNode().host
            while (h) { if (h === b || b.contains(h)) return true; h = h.getRootNode && h.getRootNode().host }
            return false
          }
            const hit = svDeep(cx, cy)
            if (hit && !svRelated(el, hit)) {
              const id = hit.id ? '#' + hit.id : ''
              let cls = ''
              if (hit.className && typeof hit.className === 'string') {
                const first = hit.className.trim().split(' ')[0]
                if (first) cls = '.' + first
              }
              out.occludedBy = hit.tagName.toLowerCase() + id + cls
            }
          }
          return JSON.stringify(out)
        }`
      )
      return JSON.parse(raw)
    } catch (err) {
      throw new Error(`visibility(${nodeId}) failed: ${(err as Error).message}`)
    }
  }

  async isVisible(nodeId: number): Promise<boolean> {
    try {
      return await this.callFunctionOn<boolean>(
        nodeId,
        `function() {
          const el = this
          if (!el.isConnected) return false
          const style = window.getComputedStyle(el)
          if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false
          const rect = el.getBoundingClientRect()
          if (rect.width <= 0 || rect.height <= 0) return false
          return el.offsetParent !== null || style.position === 'fixed' || el.tagName === 'BODY' || el.tagName === 'HTML'
        }`
      )
    } catch {
      return false
    }
  }

  /**
   * Poll an expression every 100ms until it is truthy.
   * @param expression - JS expression evaluated in the page
   * @param timeout - Milliseconds before failing (default 30000)
   */
  async waitForFunction(expression: string, timeout = DEFAULT_TIMEOUT): Promise<void> {
    await this.pollUntil(
      async () => Boolean(await this.evaluate<unknown>(expression)),
      timeout,
      `waitForFunction timed out after ${timeout}ms: ${expression.slice(0, 120)}`
    )
  }

  /**
   * Wait until there have been no in-flight network requests for 500ms.
   * @param timeout - Milliseconds before failing (default 30000)
   */
  async waitForNetworkIdle(timeout = DEFAULT_TIMEOUT): Promise<void> {
    this.ensureNetworkTracking()
    await this.pollUntil(
      async () => this.inflightRequests.size === 0 && Date.now() - this.lastNetworkActivity >= NETWORK_IDLE_WINDOW,
      timeout,
      `waitForNetworkIdle timed out after ${timeout}ms (${this.inflightRequests.size} requests in flight)`
    )
  }

  /**
   * Wait for a single CDP event on this session.
   * @param event - Event name
   * @param timeout - Milliseconds before rejecting
   * @returns Event params
   */
  waitForEvent(
    event: string,
    timeout = DEFAULT_TIMEOUT,
    predicate?: (params: Record<string, unknown>) => boolean
  ): CancellablePromise<Record<string, unknown>> {
    let cancel = (): void => undefined
    const promise = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.session.off(event, listener)
        reject(new Error(`waitForEvent(${event}) timed out after ${timeout}ms`))
      }, timeout)
      const listener = (params: Record<string, unknown>): void => {
        // A page fires most events for every frame it owns, so without a predicate the first
        // one wins and the caller resumes on somebody else's news.
        if (predicate !== undefined && !predicate(params)) return
        clearTimeout(timer)
        this.session.off(event, listener)
        resolve(params)
      }
      // When this promise loses a race its timer would otherwise hold the event loop open
      // for the full timeout, which is why a script that only did goto() took 30s to exit.
      cancel = (): void => {
        clearTimeout(timer)
        this.session.off(event, listener)
      }
      this.session.on(event, listener)
    })
    // a lost race is not an error, but an unobserved rejection would still be reported
    promise.catch(() => undefined)
    return Object.assign(promise, { cancel: () => cancel() })
  }

  private ensureNetworkTracking(): void {
    if (this.networkTrackingEnabled) return
    this.networkTrackingEnabled = true
    const touch = (): void => {
      this.lastNetworkActivity = Date.now()
    }
    this.listen('Network.requestWillBeSent', (p) => {
      this.inflightRequests.add(p.requestId as string)
      touch()
    })
    const done = (p: Record<string, unknown>): void => {
      this.inflightRequests.delete(p.requestId as string)
      touch()
    }
    this.listen('Network.loadingFinished', done)
    this.listen('Network.loadingFailed', done)
    this.listen('Network.requestServedFromCache', done)
  }

  private async pollUntil(check: () => Promise<boolean>, timeout: number, message: string): Promise<void> {
    const deadline = Date.now() + timeout
    let lastError: string | null = null
    for (;;) {
      try {
        if (await check()) return
      } catch (err) {
        const failure = (err as Error).message
        // a dead connection will never recover, so polling on only delays a wrong diagnosis
        if (CONNECTION_LOST.test(failure)) throw new Error(`${message}: the CDP connection closed (${failure})`)
        lastError = failure
      }
      if (Date.now() >= deadline) {
        throw new Error(lastError ? `${message} (last error: ${lastError})` : message)
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL))
    }
  }
}

/**
 * Convert a URL glob (`**`, `*`, `?`) to a RegExp.
 * @param pattern - Glob pattern
 * @returns Anchored RegExp
 */
export function globToRegExp(pattern: string): RegExp {
  let re = ''
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        re += '.*'
        i++
      } else {
        re += '[^/]*'
      }
    } else if (ch === '?') {
      re += '.'
    } else if ('.+^${}()|[]\\/'.includes(ch)) {
      re += '\\' + ch
    } else {
      re += ch
    }
  }
  return new RegExp(`^${re}$`)
}

function normalizeCookie(raw: Record<string, unknown>): Cookie {
  const sameSiteRaw = raw.sameSite
  const sameSite: Cookie['sameSite'] =
    sameSiteRaw === 'Strict' || sameSiteRaw === 'Lax' || sameSiteRaw === 'None' ? sameSiteRaw : 'Lax'
  return {
    name: String(raw.name ?? ''),
    value: String(raw.value ?? ''),
    domain: String(raw.domain ?? ''),
    path: String(raw.path ?? '/'),
    expires: typeof raw.expires === 'number' ? raw.expires : -1,
    httpOnly: Boolean(raw.httpOnly),
    secure: Boolean(raw.secure),
    sameSite,
  }
}
