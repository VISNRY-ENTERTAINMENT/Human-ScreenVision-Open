import fsSync from 'fs'
import fsp from 'fs/promises'
import nodePath from 'path'
import nodeOs from 'os'
import { CDPSession } from '../cdp/CDPSession'
import { buildMjpegAvi } from '../capture/MjpegAvi'
import { canvasProbeSource, type CanvasContent } from '../capture/CanvasProbe'
import { ProtocolMapper, globToRegExp } from '../cdp/ProtocolMapper'
import { ElementHandle } from './ElementHandle'
import { Expectation } from './Expectation'
import { Frame } from './Frame'
import { FrameLocator } from './FrameLocator'
import { FileChooser } from './FileChooser'
import { Episode } from './Episode'
import type { EpisodeOptions } from './Episode'
import { ariaSnapshotSource } from '../intelligence/ariaSnapshot'
import { Locator, cssOrEngineStep } from './Locator'
import { Clock } from './Clock'
import { compareScreenshot, describeComparison, type ScreenshotCompareOptions } from '../capture/VisualCompare'
import { PageObserver } from '../intelligence/PageObserver'
import { SemanticMatcher } from '../intelligence/SemanticMatcher'
import { deepCountExpression, deepQueryExpression, deepQueryNthExpression } from '../intelligence/domTraversal'
import { ActionEngine } from '../intelligence/ActionEngine'
import { TraceRecorder } from '../trace/TraceRecorder'
import { Recorder } from '../codegen/Recorder'
import { ElementResolver } from '../intelligence/ElementResolver'
import { VerificationEngine } from '../intelligence/VerificationEngine'
import { ScreenshotEngine } from '../capture/ScreenshotEngine'
import { TargetedCapture } from '../capture/TargetedCapture'
import { AnnotationEngine } from '../capture/AnnotationEngine'
import { VisionClient } from '../vision/VisionClient'
import { VisionResolver } from '../vision/VisionResolver'
import {
  NavigateOptions,
  WaitForSelectorOptions,
  ClickOptions,
  FillOptions,
  ScreenshotOptions,
  AnnotationSpec,
  DiptychOptions,
  EvidenceOptions,
  FindOptions,
  ResolvedElement,
  VerifyOptions,
  VerificationResult,
  ConsoleMessage,
  Dialog,
  RouteHandler,
  RouteOptions,
  Route,
  Request,
  FulfillResponse,
  ContinueOverrides,
  CodeIndexResult,
  DeviceExpectations,
  DeviceDescriptor,
  Viewport,
  Observation,
  ObserveOptions,
  ActionRequest,
  ActionResult,
  Candidate,
  TraceOptions,
  ObservedRequest,
  ObservedResponse,
  CompletedDownload,
  NetworkRequestEvent,
  NetworkResponseEvent,
  NetworkFailureEvent,
} from './types'

type PageEvent = 'console' | 'dialog' | 'load' | 'close' | 'request' | 'response' | 'requestfailed'

/** Events `page.on` actually delivers; anything else is rejected rather than ignored. */
const SUPPORTED_PAGE_EVENTS: string[] = [
  'console',
  'dialog',
  'load',
  'close',
  'request',
  'response',
  'requestfailed',
]
type AnyHandler = (...args: never[]) => void

const DEFAULT_TIMEOUT = 30000

interface RouteRegistration {
  pattern: string
  regex: RegExp
  handler: RouteHandler
  remaining: number
}

/**
 * A single browser tab. This is the main ScreenVision API surface: standard
 * Playwright-style automation plus semantic `find`/`verify`/annotated screenshots.
 */
export class Page {
  private mapper: ProtocolMapper
  private resolver: ElementResolver
  private screenshotEngine: ScreenshotEngine
  private annotationEngine: AnnotationEngine
  private verifier: VerificationEngine
  private consoleListeners: ((msg: ConsoleMessage) => void)[] = []
  private dialogListeners: ((dialog: Dialog) => void)[] = []
  private loadListeners: (() => void)[] = []
  private closeListeners: (() => void)[] = []
  private routes: RouteRegistration[] = []
  private currentUrl = 'about:blank'
  private closed = false
  private initialized = false
  private viewport: Viewport | null = null
  private mainFrameId: string | null = null

  /**
   * @param session - CDP session attached to this page's target
   * @param codeIndex - Code index built at launch (or null)
   * @param deviceExpectations - Expectations of the owning context's device (or null)
   * @param visionEndpoint - Vision API endpoint (or null: tier 3 disabled)
   * @param visionApiKey - Vision API key (or null)
   */
  constructor(
    private session: CDPSession,
    codeIndex: CodeIndexResult | null,
    private deviceExpectations: DeviceExpectations | null,
    visionEndpoint: string | null,
    visionApiKey: string | null,
    /** Owning browser context; '' for the default one. Needed for browser-scoped commands. */
    private browserContextId: string = ''
  ) {
    this.mapper = new ProtocolMapper(session)
    const visionResolver = visionEndpoint
      ? new VisionResolver(new VisionClient(visionEndpoint, visionApiKey ?? ''))
      : null
    this.resolver = new ElementResolver(codeIndex, visionResolver)
    this.annotationEngine = new AnnotationEngine()
    this.screenshotEngine = new ScreenshotEngine(new TargetedCapture(this.mapper), this.annotationEngine)
    this.verifier = new VerificationEngine(this.resolver, this.annotationEngine, deviceExpectations)
  }

  /**
   * Enable CDP domains and wire page events. Called once by BrowserContext.
   * @returns Resolves when the page is ready for commands
   */
  /** Identifiers of init scripts registered on this page. */
  private initScripts: string[] = []
  /** Lazily built trace recorder. */
  private recorder: TraceRecorder | null = null
  /** Lazily built codegen recorder. */
  private codegen: Recorder | null = null
  /** Lazily built controllable clock. */
  private controlledClock: Clock | null = null

  /** Lazily built observer and action engine. */
  private observer: PageObserver | null = null
  private actionEngine: ActionEngine | null = null
  /** The most recent observation, so act() can resolve a ref without re-observing. */
  private lastObservation: Observation | null = null
  /** Actions performed on this page, in order, each with its evidence. */
  private actionLog: ActionResult[] = []
  /** Live subscribers to network and console activity, used while an action runs. */
  private activityWatchers: Array<{
    onRequest: (url: string, method: string) => void
    onError: (text: string) => void
  }> = []

  /** Execution context id for each same-origin frame, keyed by frame id. */
  private frameContexts: Map<string, number> = new Map()
  /** Session and mapper for each cross-origin frame target, keyed by frame id. */
  private frameTargets: Map<string, { session: CDPSession; mapper: ProtocolMapper }> = new Map()

  private requestListeners: Array<(event: NetworkRequestEvent) => void> = []
  private responseListeners: Array<(event: NetworkResponseEvent) => void> = []
  private requestFailedListeners: Array<(event: NetworkFailureEvent) => void> = []
  /** Method and url of each in-flight request, so a response can report both. */
  private inflightMeta = new Map<string, { url: string; method: string }>()

  /** Session listeners this page registered, released on close. */
  private sessionListeners: Array<[string, (params: Record<string, unknown>) => void]> = []

  /**
   * Subscribe to a session event, remembering it so `close` can undo it.
   * @param event - CDP event name
   * @param listener - Handler
   */
  private listen(event: string, listener: (params: Record<string, unknown>) => void): void {
    this.sessionListeners.push([event, listener])
    this.session.on(event, listener)
  }

  async initialize(): Promise<void> {
    if (this.initialized) return
    this.initialized = true
    try {
      // These enables are independent of each other, and CDP pipelines commands on one
      // connection, so awaiting them one at a time paid a full round trip per domain for no
      // reason. Cross-origin iframes are separate browser targets: without auto-attach their
      // content is invisible to this session, which is why frames were unreachable.
      await Promise.all([
        this.session.send('Page.enable'),
        this.session.send('Runtime.enable'),
        this.session.send('DOM.enable'),
        this.session.send('Network.enable'),
        this.session.send('Page.setLifecycleEventsEnabled', { enabled: true }),
        this.session
          .send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true })
          .catch(() => undefined),
      ])
      const tree = await this.session.send('Page.getFrameTree')
      const frame = (tree.frameTree as { frame?: { id?: string; url?: string } } | undefined)?.frame
      this.mainFrameId = frame?.id ?? null
      if (frame?.url) this.currentUrl = frame.url
    } catch (err) {
      throw new Error(`Page.initialize failed: ${(err as Error).message}`)
    }

    this.listen('Network.requestWillBeSent', (params) => {
      if (this.activityWatchers.length === 0) return
      const request = params.request as { url?: string; method?: string } | undefined
      // The method is what separates reading from doing. Without it a POST that charges a
      // card and a GET that loads a font are the same event, and no amount of later analysis
      // can tell them apart.
      if (request?.url) {
        for (const w of this.activityWatchers) w.onRequest(request.url, request.method ?? 'GET')
      }
    })
    this.listen('Runtime.exceptionThrown', (params) => {
      if (this.activityWatchers.length === 0) return
      const details = params.exceptionDetails as
        | { exception?: { description?: string }; text?: string }
        | undefined
      const text = details?.exception?.description ?? details?.text
      if (text) for (const w of this.activityWatchers) w.onError(text.split('\n')[0])
    })
    this.listen('Network.requestWillBeSent', (params) => {
      const request = params.request as
        | { url?: string; method?: string; headers?: Record<string, string>; postData?: string }
        | undefined
      const id = params.requestId as string
      if (id && request?.url) this.inflightMeta.set(id, { url: request.url, method: request.method ?? 'GET' })
      if (this.requestListeners.length === 0 || !request?.url) return
      const event: NetworkRequestEvent = {
        url: request.url,
        method: request.method ?? 'GET',
        headers: lowerCaseKeys(request.headers ?? {}),
        postData: request.postData ?? null,
        resourceType: String(params.type ?? 'other'),
      }
      for (const listener of this.requestListeners) listener(event)
    })
    this.listen('Network.responseReceived', (params) => {
      if (this.responseListeners.length === 0) return
      const response = params.response as
        | { url?: string; status?: number; statusText?: string; headers?: Record<string, string>; fromDiskCache?: boolean }
        | undefined
      const requestId = params.requestId as string
      if (!response?.url) return
      const body = async (): Promise<string> => {
        const result = await this.session.send('Network.getResponseBody', { requestId }).catch(() => null)
        if (!result) {
          throw new Error(
            `the body of ${response.url} is no longer held by the browser; read it inside the handler`
          )
        }
        const raw = String(result.body ?? '')
        return result.base64Encoded === true ? Buffer.from(raw, 'base64').toString('utf8') : raw
      }
      const event: NetworkResponseEvent = {
        url: response.url,
        status: response.status ?? 0,
        statusText: response.statusText ?? '',
        headers: lowerCaseKeys(response.headers ?? {}),
        fromCache: response.fromDiskCache === true,
        text: body,
        json: async <T>() => JSON.parse(await body()) as T,
      }
      for (const listener of this.responseListeners) listener(event)
    })
    this.listen('Network.loadingFailed', (params) => {
      const id = params.requestId as string
      const meta = this.inflightMeta.get(id)
      this.inflightMeta.delete(id)
      if (this.requestFailedListeners.length === 0) return
      const event: NetworkFailureEvent = {
        url: meta?.url ?? '',
        method: meta?.method ?? 'GET',
        errorText: String(params.errorText ?? 'unknown failure'),
      }
      for (const listener of this.requestFailedListeners) listener(event)
    })
    this.listen('Runtime.executionContextCreated', (params) => {
      const context = params.context as
        | { id?: number; auxData?: { frameId?: string; isDefault?: boolean } }
        | undefined
      const frameId = context?.auxData?.frameId
      if (context?.id !== undefined && frameId && context.auxData?.isDefault !== false) {
        this.frameContexts.set(frameId, context.id)
      }
    })
    this.listen('Runtime.executionContextsCleared', () => {
      this.frameContexts.clear()
    })
    this.listen('Target.attachedToTarget', (params) => {
      const info = params.targetInfo as { type?: string; targetId?: string } | undefined
      const sessionId = params.sessionId as string | undefined
      if (info?.type !== 'iframe' || !sessionId || !info.targetId) return
      // An out-of-process iframe has its own DOM agent, so it needs its own mapper.
      const session = new CDPSession(this.session.connection, sessionId, info.targetId)
      const mapper = new ProtocolMapper(session)
      this.frameTargets.set(info.targetId, { session, mapper })
      void session.send('Page.enable').catch(() => undefined)
      void session.send('DOM.enable').catch(() => undefined)
      void session.send('Runtime.enable').catch(() => undefined)
      void session
        .send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true })
        .catch(() => undefined)
    })
    this.listen('Target.detachedFromTarget', (params) => {
      const targetId = params.targetId as string | undefined
      if (targetId) this.frameTargets.delete(targetId)
    })
    this.listen('Page.frameNavigated', (params) => {
      const frame = params.frame as { id?: string; parentId?: string; url?: string } | undefined
      if (!frame || frame.parentId) return
      if (this.mainFrameId && frame.id !== this.mainFrameId) return
      if (frame.url) this.currentUrl = frame.url
    })
    this.listen('Page.loadEventFired', () => {
      for (const l of this.loadListeners) l()
    })
    this.listen('Runtime.consoleAPICalled', (params) => {
      if (this.activityWatchers.length > 0 && params.type === 'error') {
        const args = (params.args as Array<{ value?: unknown; description?: string }>) ?? []
        const text = args.map((a) => String(a.value ?? a.description ?? '')).join(' ')
        if (text) for (const w of this.activityWatchers) w.onError(text)
      }
      if (this.consoleListeners.length === 0) return
      const msg = buildConsoleMessage(params)
      for (const l of this.consoleListeners) l(msg)
    })
    this.listen('Page.javascriptDialogOpening', (params) => {
      const dialog = buildDialog(params, this.mapper)
      if (this.dialogListeners.length === 0) {
        this.mapper.handleDialog(false).catch(() => undefined)
        return
      }
      for (const l of this.dialogListeners) l(dialog)
    })
  }

  /**
   * Apply device / viewport / user-agent emulation from context options.
   * @param opts - viewport, deviceScaleFactor, mobile, hasTouch, userAgent
   */
  async emulate(opts: {
    viewport?: Viewport
    deviceScaleFactor?: number
    isMobile?: boolean
    hasTouch?: boolean
    userAgent?: string
  }): Promise<void> {
    try {
      if (opts.viewport) {
        await this.mapper.setViewport(opts.viewport, opts.deviceScaleFactor ?? 1, opts.isMobile ?? false)
        this.viewport = { ...opts.viewport }
      }
      if (opts.userAgent) await this.mapper.setUserAgent(opts.userAgent)
      if (opts.hasTouch !== undefined) await this.mapper.setTouchEnabled(opts.hasTouch)
    } catch (err) {
      throw new Error(`Page.emulate failed: ${(err as Error).message}`)
    }
  }

  /**
   * Apply a full device descriptor (viewport, DPR, mobile, touch, UA).
   * @param device - Device descriptor
   */
  async emulateDevice(device: DeviceDescriptor): Promise<void> {
    await this.emulate({
      viewport: device.viewport,
      deviceScaleFactor: device.deviceScaleFactor,
      isMobile: device.isMobile,
      hasTouch: device.hasTouch,
      userAgent: device.userAgent,
    })
  }

  // ── Internal accessors (used by ElementHandle / engines) ─────────────────────

  /** Protocol mapper for this page. */
  mapperRef(): ProtocolMapper {
    return this.mapper
  }

  /** Protocol session for this page, used by the context to apply emulation. */
  sessionRef(): CDPSession {
    return this.session
  }

  /**
   * The mapper, as the async {@link LocatorHost} contract wants it.
   *
   * A page's mapper is available immediately; the interface is async only because a frame
   * locator may have to find its frame first.
   * @returns This page's protocol mapper
   */
  async resolveMapper(): Promise<ProtocolMapper> {
    return this.mapper
  }

  /**
   * The page a locator's elements belong to, which for a page is itself.
   * @returns This page
   */
  page(): Page {
    return this
  }

  /**
   * Resolve an expression to a nodeId in the main document.
   * @param expression - JavaScript expression returning an element or null
   * @returns nodeId, or null when it resolves to nothing
   */
  async nodeIdForExpression(expression: string): Promise<number | null> {
    return this.mapper.nodeIdForExpression(expression)
  }

  /**
   * The current default execution context for a frame.
   *
   * A frame gets a fresh context every time it navigates, so a `Frame` that has just called
   * `goto` must ask again rather than keep the one it was built with.
   * @param frameId - CDP frame id
   * @returns Context id, or undefined when the frame has no context yet
   */
  frameContextId(frameId: string): number | undefined {
    return this.frameContexts.get(frameId)
  }

  /**
   * The main document sits at the viewport origin.
   * @returns A zero offset
   */
  async nodeOffset(): Promise<{ x: number; y: number }> {
    return { x: 0, y: 0 }
  }
  /** Screenshot engine for this page. */
  screenshotEngineRef(): ScreenshotEngine {
    return this.screenshotEngine
  }
  /** Verification engine for this page. */
  verifierRef(): VerificationEngine {
    return this.verifier
  }
  /** Element resolver for this page. */
  resolverRef(): ElementResolver {
    return this.resolver
  }
  /** Device expectations inherited from the context (or null). */
  deviceExpectationsRef(): DeviceExpectations | null {
    return this.deviceExpectations
  }
  /** CDP target id. */
  targetId(): string {
    return this.session.targetId
  }

  // ── Navigation ──────────────────────────────────────────────────────────────

  /**
   * Navigate to a URL.
   * @param url - Absolute URL
   * @param options - waitUntil/timeout/referer
   */
  async goto(url: string, options?: NavigateOptions): Promise<void> {
    if (this.recorder?.active) {
      // recorded before the navigation so the screenshot shows what we were leaving
      await this.recorder.step('navigate', `goto ${url}`, null).catch(() => undefined)
    }
    this.assertOpen('goto')
    await this.mapper.navigate(url, options)
    this.currentUrl = await this.mapper.url()
  }

  /**
   * Reload the page.
   * @param options - waitUntil
   */
  async reload(options?: { waitUntil?: string }): Promise<void> {
    this.assertOpen('reload')
    await this.mapper.reload(options)
  }

  /** Go back in history. */
  async goBack(): Promise<void> {
    this.assertOpen('goBack')
    await this.mapper.goBack()
    this.currentUrl = await this.mapper.url()
  }

  /** Go forward in history. */
  async goForward(): Promise<void> {
    this.assertOpen('goForward')
    await this.mapper.goForward()
    this.currentUrl = await this.mapper.url()
  }

  /**
   * Document title.
   * @returns Title string
   */
  async title(): Promise<string> {
    this.assertOpen('title')
    return this.mapper.title()
  }

  /**
   * Last known URL of the main frame (updated on navigation events).
   * @returns URL string
   */
  url(): string {
    return this.currentUrl
  }

  // ── Standard DOM Access ──────────────────────────────────────────────────────

  /**
   * Query a single element.
   * @param selector - CSS selector
   * @returns Handle or null
   */
  async $(selector: string): Promise<ElementHandle | null> {
    this.assertOpen('$')
    const nodeId = await this.mapper.querySelector(selector)
    if (nodeId !== null) return new ElementHandle(this.mapper, nodeId, selector, this)
    // CSS cannot cross a shadow boundary, so a component's internals are invisible to the
    // ordinary query; fall through to a traversal that walks open shadow roots
    const pierced = await this.mapper.nodeIdForExpression(deepQueryExpression(selector)).catch(() => null)
    return pierced === null ? null : new ElementHandle(this.mapper, pierced, selector, this)
  }


  /**
   * Query all elements.
   * @param selector - CSS selector
   * @returns Handles
   */
  async $$(selector: string): Promise<ElementHandle[]> {
    this.assertOpen('$$')
    const ids = await this.mapper.querySelectorAll(selector)
    const total = await this.evaluate<number>(deepCountExpression(selector)).catch(() => ids.length)
    if (total <= ids.length) return ids.map((id) => new ElementHandle(this.mapper, id, selector, this))
    // some matches live inside shadow roots; collect them by index through the traversal
    const handles: ElementHandle[] = []
    for (let i = 0; i < total; i++) {
      const nodeId = await this.mapper.nodeIdForExpression(deepQueryNthExpression(selector, i)).catch(() => null)
      if (nodeId !== null) handles.push(new ElementHandle(this.mapper, nodeId, selector, this))
    }
    return handles
  }


  /**
   * Evaluate JavaScript in the page.
   * @param pageFunction - Expression string, or a function serialised with `toString()`
   * @param arg - JSON-serialisable argument passed to the function
   * @returns The serialisable result
   */
  async evaluate<T>(pageFunction: string | ((arg: unknown) => T), arg?: unknown): Promise<T> {
    this.assertOpen('evaluate')
    if (typeof pageFunction === 'string') return this.mapper.evaluate<T>(pageFunction)
    const expression = `(${pageFunction.toString()})(${arg === undefined ? '' : JSON.stringify(arg)})`
    return this.mapper.evaluate<T>(expression)
  }

  /**
   * Control the page's sense of time.
   *
   * Anything that waits — a session timeout, a polling interval, a relative timestamp, a
   * debounce — is otherwise tested by actually waiting, which is both slow and flaky.
   * @returns The clock for this page
   * @example
   * await page.clock.install({ time: '2026-01-01T09:00:00Z' })
   * await page.clock.tick('31m')
   * await page.expect('session banner').toHaveText('Your session has expired')
   */
  get clock(): Clock {
    if (!this.controlledClock) this.controlledClock = new Clock(this)
    return this.controlledClock
  }

  /**
   * Touch input, for pages that distinguish a tap from a click.
   * @example
   * await page.touchscreen.tap(120, 400)
   * await page.touchscreen.swipe({ x: 200, y: 600 }, { x: 200, y: 200 })
   */
  touchscreen = {
    /**
     * Tap at viewport coordinates.
     * @param x - Viewport x
     * @param y - Viewport y
     */
    tap: async (x: number, y: number): Promise<void> => {
      this.assertOpen('touchscreen.tap')
      await this.mapper.touchTap(x, y)
    },
    /**
     * Swipe between two points.
     * @param from - Start point
     * @param to - End point
     * @param options - steps: intermediate moves
     */
    swipe: async (
      from: { x: number; y: number },
      to: { x: number; y: number },
      options?: { steps?: number }
    ): Promise<void> => {
      this.assertOpen('touchscreen.swipe')
      await this.mapper.touchSwipe(from, to, options?.steps)
    },
  }

  // ── Locators ─────────────────────────────────────────────────────────────────

  /**
   * A lazy reference to elements, re-resolved on every use.
   *
   * Prefer this to `$` for anything that will be used after the page might change: a handle
   * points at an element found earlier, while a locator holds a description and resolves it
   * each time, so it survives a re-render by construction.
   * @param selector - CSS selector
   * @returns The locator
   * @example
   * await page.locator('#save').click()
   */
  locator(selector: string): Locator {
    this.assertOpen('locator')
    return new Locator(this, [cssOrEngineStep(selector)])
  }

  /**
   * Elements with an ARIA role, optionally by accessible name.
   * @param role - ARIA role, e.g. `'button'`
   * @param options - name and whether it must match exactly
   * @returns The locator
   * @example
   * await page.getByRole('row').filter({ hasText: 'Carol' }).getByRole('button', { name: 'Edit' }).click()
   */
  getByRole(role: string, options?: { name?: string; exact?: boolean }): Locator {
    this.assertOpen('getByRole')
    return new Locator(this, [{ kind: 'role', role, ...options }])
  }

  /**
   * Elements containing text.
   * @param text - Text to look for
   * @param options - exact match
   * @returns The locator
   */
  getByText(text: string, options?: { exact?: boolean }): Locator {
    this.assertOpen('getByText')
    return new Locator(this, [{ kind: 'text', text, ...options }])
  }

  /**
   * A form control by its label.
   * @param text - Label text
   * @param options - exact match
   * @returns The locator
   */
  getByLabel(text: string, options?: { exact?: boolean }): Locator {
    this.assertOpen('getByLabel')
    return new Locator(this, [{ kind: 'label', text, ...options }])
  }

  /**
   * A control by its placeholder.
   * @param text - Placeholder text
   * @returns The locator
   */
  getByPlaceholder(text: string): Locator {
    this.assertOpen('getByPlaceholder')
    return new Locator(this, [{ kind: 'placeholder', text }])
  }

  /**
   * An element by its `data-testid`.
   * @param id - Test id
   * @returns The locator
   */
  getByTestId(id: string): Locator {
    this.assertOpen('getByTestId')
    return new Locator(this, [{ kind: 'testid', id }])
  }

  /**
   * An element by its `title`.
   * @param text - Title text
   * @returns The locator
   */
  getByTitle(text: string): Locator {
    this.assertOpen('getByTitle')
    return new Locator(this, [{ kind: 'title', text }])
  }

  /**
   * An image by its alt text.
   * @param text - Alt text
   * @returns The locator
   */
  getByAltText(text: string): Locator {
    this.assertOpen('getByAltText')
    return new Locator(this, [{ kind: 'altText', text }])
  }

  // ── Agent API: observe and act ───────────────────────────────────────────────

  /**
   * A compact semantic model of what is on screen, for an agent to reason about.
   *
   * This is the alternative to handing a model raw HTML and hoping. It returns the page's
   * landmark regions, every action currently available with a stable `ref` to address it by,
   * the readable text, and a short list of conditions the agent would otherwise discover only
   * by failing, such as a modal covering the page.
   * @param options - What to include and how much text to keep
   * @returns The observation
   * @example
   * const view = await page.observe()
   * const submit = view.affordances.find((a) => a.role === 'button' && a.name === 'Submit')
   * await page.act({ do: 'click', ref: submit.ref })
   */
  async observe(options?: ObserveOptions): Promise<Observation> {
    this.assertOpen('observe')
    if (!this.observer) this.observer = new PageObserver(this)
    return this.observer.observe(options)
  }

  /**
   * Perform an action and return evidence of what it actually changed.
   *
   * The verdict is the point. `no-effect` means the action was performed and the page did
   * not respond in any observable way, which is the silent failure an agent otherwise
   * discovers several steps later. Supply `expect` to have specific consequences checked.
   * @param request - What to do, to what, and what should follow
   * @returns The outcome with its effects and expectation results
   * @example
   * const result = await page.act({
   *   do: 'click',
   *   target: 'submit button',
   *   expect: { textAppears: 'Thanks', requestMade: '/api/signup' },
   * })
   * if (!result.ok) console.log(result.summary)
   */
  async act(request: ActionRequest): Promise<ActionResult> {
    this.assertOpen('act')
    if (!this.actionEngine) this.actionEngine = new ActionEngine(this)
    const result = await this.actionEngine.act(request)
    if (request.evidence) {
      const opts: EvidenceOptions = request.evidence === true ? {} : request.evidence
      result.evidence = await this.captureActionEvidence(result, opts)
    }
    // a trace should be a by-product of doing the work, not a thing to remember to do
    if (this.recorder?.active) {
      await this.recorder.step('action', `${result.action} ${result.target.description}`, result)
    }
    return result
  }

  /**
   * Build the verification-annotated evidence screenshot for a finished action.
   *
   * The colour IS the verdict — green confirmed, orange no-effect, red side-effects/unexpected,
   * grey blocked — and the label is the action's one-sentence summary, so the image carries the
   * proof, not just the pixels. When the acted element can still be located it is boxed; when it
   * cannot (it was deleted, or the page navigated) the verdict is stated as a top banner rather
   * than dropped, because "the element is gone" is often the very thing the verdict is about.
   * @param result - The action result to illustrate.
   * @param opts - Path, redaction and full-page choices.
   * @returns The evidence image and, if saved, its path.
   */
  private async captureActionEvidence(
    result: ActionResult,
    opts: EvidenceOptions
  ): Promise<{ image: Buffer; path?: string }> {
    const VERDICT_COLOR: Record<ActionResult['verdict'], string> = {
      confirmed: '#34C759',
      'no-effect': '#FF9500',
      'side-effects': '#FF3B30',
      unexpected: '#FF3B30',
      blocked: '#8E8E93',
    }
    const color = VERDICT_COLOR[result.verdict] ?? '#FF3B30'
    const label = result.summary
    const annotate: AnnotationSpec[] = []
    const selector = result.target.resolvedSelector
    let handle: ElementHandle | null = null
    if (selector) handle = await this.$(selector).catch(() => null)
    if (handle && (await handle.boundingBox().catch(() => null))) {
      annotate.push({ element: handle, style: 'box', color, label })
    } else {
      // the element is gone: state the verdict as a banner pinned to the top-left
      annotate.push({ bbox: { x: 8, y: 26, width: 0, height: 0 }, style: 'label-only', color, label })
    }
    const image = await this.screenshot({
      fullPage: opts.fullPage ?? false,
      annotate,
      redact: opts.redact,
      path: opts.path,
    })
    return opts.path ? { image, path: opts.path } : { image }
  }

  /**
   * Record a trace of this run and write it as one self-contained HTML file.
   *
   * Every `act()` becomes a step automatically, with a screenshot, the URL, and the evidence
   * for what the action did. Unlike a conventional trace, each step carries the verdict, so
   * the report distinguishes an action that worked from one that was merely dispatched.
   * @example
   * await page.trace.start({ title: 'checkout flow' })
   * await page.act({ do: 'click', target: 'pay button' })
   * await page.trace.stop('artifacts/checkout.html')
   */
  get trace(): {
    start: (options?: TraceOptions) => Promise<void>
    note: (label: string) => Promise<void>
    stop: (filePath: string) => Promise<string>
    discard: () => void
    active: () => boolean
  } {
    if (!this.recorder) this.recorder = new TraceRecorder(this)
    const recorder = this.recorder
    return {
      start: (options?: TraceOptions) => {
        this.assertOpen('trace.start')
        return recorder.start(options)
      },
      note: (label: string) => recorder.step('note', label, null),
      stop: (filePath: string) => recorder.stop(filePath),
      discard: () => recorder.discard(),
      active: () => recorder.active,
    }
  }

  /**
   * Record what a person does on the page and generate the script that reproduces it.
   *
   * The generated script uses `act()` rather than bare clicks, so a recorded flow reports
   * when a step silently stops working instead of passing quietly.
   * @returns The recorder for this page
   * @example
   * await page.record.start()
   * // ... drive the browser by hand ...
   * await page.record.writeTest('tests/checkout.spec.ts', { name: 'buys a widget' })
   */
  get record(): Recorder {
    if (!this.codegen) this.codegen = new Recorder(this)
    return this.codegen
  }

  /** Every action performed on this page, in order, each with its evidence. */
  actions(): ActionResult[] {
    return [...this.actionLog]
  }

  /**
   * Record an observation so a later `act` can resolve a ref against it.
   * @param observation - The observation just taken
   */
  rememberObservation(observation: Observation): void {
    this.lastObservation = observation
  }

  /** The most recent observation, or null when none has been taken. */
  lastObserved(): Observation | null {
    return this.lastObservation
  }

  /**
   * Record a completed action.
   * @param result - The action outcome
   */
  recordAction(result: ActionResult): void {
    this.actionLog.push(result)
  }

  /**
   * Watch network requests and console errors until the returned function is called.
   * @param onRequest - Called with each request URL
   * @param onError - Called with each console error or uncaught exception
   * @returns A function that stops the watch
   */
  watchActivity(
    onRequest: (url: string, method: string) => void,
    onError: (text: string) => void
  ): () => void {
    const watcher = { onRequest, onError }
    this.activityWatchers.push(watcher)
    return () => {
      const i = this.activityWatchers.indexOf(watcher)
      if (i >= 0) this.activityWatchers.splice(i, 1)
    }
  }

  // ── Network waits and downloads ──────────────────────────────────────────────

  /**
   * Wait for a response whose URL matches.
   *
   * This is what replaces a fixed sleep after an action that talks to the server. A test that
   * sleeps is a test that is either slow or flaky, and usually both.
   * @param match - A substring of the URL, or a predicate over url and status
   * @param options - timeout in ms
   * @returns The matching response, with its body available on demand
   * @throws Error naming the responses that were seen, when none matched in time
   * @example
   * const [response] = await Promise.all([
   *   page.waitForResponse('/api/search'),
   *   page.click('#search'),
   * ])
   */
  async waitForResponse(
    match: string | RegExp | ((response: { url: string; status: number }) => boolean),
    options?: { timeout?: number }
  ): Promise<ObservedResponse> {
    this.assertOpen('waitForResponse')
    const timeout = options?.timeout ?? 30000
    const predicate = urlPredicate(match)
    const seen: string[] = []

    return new Promise<ObservedResponse>((resolve, reject) => {
      const finish = (fn: () => void): void => {
        clearTimeout(timer)
        this.session.off('Network.responseReceived', listener)
        fn()
      }
      const timer = setTimeout(() => {
        finish(() =>
          reject(
            new Error(
              `waitForResponse timed out after ${timeout}ms. ` +
                (seen.length
                  ? `Responses seen: ${seen.slice(0, 8).join(', ')}${seen.length > 8 ? `, and ${seen.length - 8} more` : ''}`
                  : 'No responses were received at all.')
            )
          )
        )
      }, timeout)

      const listener = (params: Record<string, unknown>): void => {
        const response = params.response as
          | { url?: string; status?: number; headers?: Record<string, string> }
          | undefined
        const requestId = params.requestId as string
        if (!response?.url) return
        if (seen.length < 50) seen.push(`${response.status} ${response.url}`)
        if (!predicate({ url: response.url, status: response.status ?? 0 })) return
        const headers = lowerCaseKeys(response.headers ?? {})
        const body = async (): Promise<string> => {
          const result = await this.session.send('Network.getResponseBody', { requestId }).catch(() => null)
          if (!result) {
            throw new Error(
              `the body of ${response.url} is no longer available; read it inside the wait rather than later`
            )
          }
          const raw = String(result.body ?? '')
          return result.base64Encoded === true ? Buffer.from(raw, 'base64').toString('utf8') : raw
        }
        finish(() =>
          resolve({
            url: response.url as string,
            status: response.status ?? 0,
            method: String((params.type as string) ?? 'GET'),
            headers,
            text: body,
            json: async <T>() => JSON.parse(await body()) as T,
          })
        )
      }
      this.session.on('Network.responseReceived', listener)
    })
  }

  /**
   * Wait for a request whose URL matches.
   * @param match - A substring of the URL, or a predicate
   * @param options - timeout in ms
   * @returns The matching request
   */
  async waitForRequest(
    match: string | RegExp | ((request: { url: string; method: string }) => boolean),
    options?: { timeout?: number }
  ): Promise<ObservedRequest> {
    this.assertOpen('waitForRequest')
    const timeout = options?.timeout ?? 30000
    const predicate = urlPredicate(match) as (r: { url: string; method: string }) => boolean
    const seen: string[] = []

    return new Promise<ObservedRequest>((resolve, reject) => {
      const finish = (fn: () => void): void => {
        clearTimeout(timer)
        this.session.off('Network.requestWillBeSent', listener)
        fn()
      }
      const timer = setTimeout(() => {
        finish(() =>
          reject(
            new Error(
              `waitForRequest timed out after ${timeout}ms. ` +
                (seen.length ? `Requests seen: ${seen.slice(0, 8).join(', ')}` : 'No requests were made at all.')
            )
          )
        )
      }, timeout)
      const listener = (params: Record<string, unknown>): void => {
        const request = params.request as
          | { url?: string; method?: string; headers?: Record<string, string>; postData?: string }
          | undefined
        if (!request?.url) return
        if (seen.length < 50) seen.push(`${request.method ?? 'GET'} ${request.url}`)
        if (!predicate({ url: request.url, method: request.method ?? 'GET' })) return
        finish(() =>
          resolve({
            url: request.url as string,
            method: request.method ?? 'GET',
            headers: lowerCaseKeys(request.headers ?? {}),
            postData: request.postData ?? null,
          })
        )
      }
      this.session.on('Network.requestWillBeSent', listener)
    })
  }

  /**
   * Wait for a download to start and finish, and return where it landed.
   *
   * Downloads are otherwise unreachable: the browser writes the file wherever it likes, or
   * refuses it entirely in headless mode, and nothing in the page tells you it happened.
   * @param options - timeout in ms, and a directory to download into
   * @returns The completed download
   * @example
   * const [download] = await Promise.all([page.waitForDownload(), page.click('#export')])
   * await download.saveAs('./artifacts/report.csv')
   */
  async waitForDownload(options?: { timeout?: number; directory?: string }): Promise<CompletedDownload> {
    this.assertOpen('waitForDownload')
    const timeout = options?.timeout ?? 30000
    const directory = options?.directory ?? (await fsp.mkdtemp(nodePath.join(nodeOs.tmpdir(), 'screenvision-dl-')))
    // browser-scoped, and scoped again to this page's context: without the context id the
    // browser happily configures the default context and writes the file somewhere else
    const params: Record<string, unknown> = {
      behavior: 'allow',
      downloadPath: nodePath.resolve(directory),
      eventsEnabled: true,
    }
    if (this.browserContextId) params.browserContextId = this.browserContextId
    await this.session.connection.send('Browser.setDownloadBehavior', params)

    return new Promise<CompletedDownload>((resolve, reject) => {
      let suggested = ''
      let url = ''
      const finish = (fn: () => void): void => {
        clearTimeout(timer)
        this.session.connection.off('Browser.downloadWillBegin', onBegin)
        this.session.connection.off('Browser.downloadProgress', onProgress)
        this.session.off('Page.downloadWillBegin', onBegin)
        this.session.off('Page.downloadProgress', onProgress)
        fn()
      }
      const timer = setTimeout(() => {
        finish(() =>
          reject(
            new Error(
              `waitForDownload timed out after ${timeout}ms` +
                (suggested ? `; "${suggested}" started but never completed` : ' and no download started')
            )
          )
        )
      }, timeout)

      const onBegin = (params: Record<string, unknown>): void => {
        suggested = String(params.suggestedFilename ?? '')
        url = String(params.url ?? '')
      }
      const onProgress = (params: Record<string, unknown>): void => {
        const state = String(params.state ?? '')
        if (state === 'canceled') {
          finish(() => reject(new Error(`the download of "${suggested}" was cancelled by the browser`)))
          return
        }
        if (state !== 'completed') return
        // Chrome writes the file under the download's guid and only sometimes renames it to
        // the suggested name, so neither can be assumed; resolve against what is on disk.
        const guid = String(params.guid ?? '')
        const candidates = [suggested, guid].filter(Boolean).map((n) => nodePath.join(directory, n))
        const file = candidates.find((c) => fsSync.existsSync(c)) ?? newestFileIn(directory) ?? candidates[0]
        finish(() =>
          resolve({
            suggestedFilename: suggested || nodePath.basename(file),
            path: file,
            url,
            saveAs: async (destination: string) => {
              const target = nodePath.resolve(destination)
              await fsp.mkdir(nodePath.dirname(target), { recursive: true })
              await fsp.copyFile(file, target)
              return target
            },
          })
        )
      }

      // Browser.* download events are emitted on the browser connection, not the page
      // session, so listening only on the session sees the start and never the completion
      const connection = this.session.connection
      connection.on('Browser.downloadWillBegin', onBegin)
      connection.on('Browser.downloadProgress', onProgress)
      this.session.on('Page.downloadWillBegin', onBegin)
      this.session.on('Page.downloadProgress', onProgress)
    })
  }

  // ── OS window affordances ─────────────────────────────────────────────────────

  /**
   * Bring this page's tab to the front and focus it.
   *
   * An OS-boundary affordance the DOM cannot reach: a background tab is throttled and, crucially,
   * cannot use the async clipboard or receive real focus, so a page's own "Copy" button silently
   * fails there. Activating the target restores those, which is why clipboard reads and writes
   * call this first.
   */
  async bringToFront(): Promise<void> {
    this.assertOpen('bringToFront')
    await this.session.send('Target.activateTarget', { targetId: this.session.targetId })
    await this.evaluate<void>('(() => { try { window.focus() } catch (e) {} })()').catch(() => undefined)
  }

  // ── OS clipboard ─────────────────────────────────────────────────────────────

  /**
   * Read the OS clipboard's text, so a "Copy" affordance can actually be verified.
   *
   * This is an OS-boundary the DOM cannot describe: a copy button that silently copied nothing,
   * or the wrong thing, leaves the page looking perfectly healthy. Reading the clipboard is the
   * only way to prove the effect, which is exactly the silent-wrong-answer class this library
   * exists to close, extended past the browser.
   *
   * Requires the `clipboard-read` permission (grant it on the context) and a focused page;
   * `navigator.clipboard.readText` rejects otherwise, and that rejection is surfaced with its
   * reason rather than swallowed into a misleading empty string.
   * @returns The clipboard's current text.
   * @throws Error if the clipboard cannot be read, naming why.
   */
  async clipboardText(): Promise<string> {
    this.assertOpen('clipboardText')
    await this.session.send('Target.activateTarget', { targetId: this.session.targetId }).catch(() => undefined)
    const raw = await this.evaluate<string>(
      `(async () => {
        try {
          const t = await navigator.clipboard.readText()
          return JSON.stringify({ ok: true, text: t })
        } catch (e) {
          return JSON.stringify({ ok: false, reason: (e && e.name ? e.name + ': ' : '') + (e && e.message ? e.message : 'clipboard read failed') })
        }
      })()`
    )
    const r = JSON.parse(raw) as { ok: boolean; text?: string; reason?: string }
    if (!r.ok) {
      throw new Error(
        `Page.clipboardText: ${r.reason}. The clipboard-read permission must be granted ` +
          `(context.grantPermissions(['clipboard-read'])) and the page focused.`
      )
    }
    return r.text ?? ''
  }

  /**
   * Write text to the OS clipboard, so a paste into the page can be driven.
   *
   * Tries `navigator.clipboard.writeText` first and falls back to a hidden-textarea
   * `execCommand('copy')`, which works without the async-clipboard permission when the page is
   * focused. Reports failure rather than pretending success.
   * @param text - The text to place on the clipboard.
   * @throws Error if neither method could write, naming why.
   */
  async setClipboardText(text: string): Promise<void> {
    this.assertOpen('setClipboardText')
    await this.session.send('Target.activateTarget', { targetId: this.session.targetId }).catch(() => undefined)
    const raw = await this.evaluate<string>(
      `(async (text) => {
        try {
          await navigator.clipboard.writeText(text)
          return JSON.stringify({ ok: true })
        } catch (e) {
          try {
            const ta = document.createElement('textarea')
            ta.value = text
            ta.style.position = 'fixed'; ta.style.opacity = '0'
            document.body.appendChild(ta); ta.focus(); ta.select()
            const done = document.execCommand('copy')
            ta.remove()
            return JSON.stringify(done ? { ok: true } : { ok: false, reason: 'execCommand copy returned false' })
          } catch (e2) {
            return JSON.stringify({ ok: false, reason: (e2 && e2.message) || 'clipboard write failed' })
          }
        }
      })(${JSON.stringify(text)})`
    )
    const r = JSON.parse(raw) as { ok: boolean; reason?: string }
    if (!r.ok) {
      throw new Error(
        `Page.setClipboardText: ${r.reason}. Grant clipboard-write ` +
          `(context.grantPermissions(['clipboard-write'])) or ensure the page is focused.`
      )
    }
  }

  // ── Frames ───────────────────────────────────────────────────────────────────

  /**
   * Every frame in the page, main document first.
   *
   * Both same-origin and cross-origin frames are included; the caller does not need to know
   * which kind it has.
   * @returns Frames in document order
   */
  /**
   * The accessibility tree beneath this page, as text.
   *
   * This is the representation to give a model: a screenshot costs thousands of tokens and
   * still hides structure, while this names every role, accessible name and state in a form
   * that maps directly onto `getByRole`. Presentational wrappers are collapsed, so the output
   * tracks meaning rather than markup.
   * @param options - includeHidden to keep nodes hidden from assistive technology;
   *   markInert to annotate controls that are present but cannot be interacted with
   * @returns The snapshot text
   */
  async ariaSnapshot(options?: { includeHidden?: boolean; markInert?: boolean }): Promise<string> {
    this.assertOpen('ariaSnapshot')
    return this.evaluate<string>(
      ariaSnapshotSource(options?.includeHidden ?? false, options?.markInert ?? true)
    )
  }

  /**
   * Start recording which JavaScript actually ran.
   *
   * Useful for the question "did my click reach the handler at all", which is otherwise only
   * answerable by adding logging to the application. Coverage says which functions executed,
   * so a click that appears to work but never enters the handler is visible rather than
   * inferred.
   *
   * **Call this before navigating.** V8 reports per-function counts only for code compiled
   * after coverage started, so starting it on an already-loaded page yields one coarse range
   * per script and no way to tell an unentered function from an entered one — which looks
   * like the feature is broken rather than mis-ordered.
   */
  async startJSCoverage(): Promise<void> {
    this.assertOpen('startJSCoverage')
    await this.session.send('Profiler.enable')
    await this.session.send('Profiler.startPreciseCoverage', { callCount: true, detailed: true })
  }

  /**
   * Stop recording and return what ran.
   * @returns One entry per script, with the byte ranges that executed
   */
  async stopJSCoverage(): Promise<
    Array<{ url: string; ranges: Array<{ start: number; end: number; count: number }> }>
  > {
    this.assertOpen('stopJSCoverage')
    const result = await this.session.send('Profiler.takePreciseCoverage')
    await this.session.send('Profiler.stopPreciseCoverage').catch(() => undefined)
    await this.session.send('Profiler.disable').catch(() => undefined)
    const entries = (result.result as Array<Record<string, unknown>>) ?? []
    return entries.map((entry) => {
      const functions = (entry.functions as Array<Record<string, unknown>>) ?? []
      const ranges: Array<{ start: number; end: number; count: number }> = []
      for (const fn of functions) {
        for (const r of (fn.ranges as Array<Record<string, number>>) ?? []) {
          ranges.push({ start: r.startOffset, end: r.endOffset, count: r.count })
        }
      }
      return { url: (entry.url as string) ?? '', ranges }
    })
  }

  /**
   * Watch WebSocket traffic for the rest of the page's life.
   *
   * A page that talks over a socket is invisible to request interception, so an agent working
   * on one has no way to tell "the server has not answered yet" from "the answer arrived and
   * the page ignored it". Those need different responses, and guessing between them is the
   * failure this library exists to remove.
   * @param onFrame - Called for each frame, in both directions
   * @returns A function that stops watching
   */
  onWebSocketFrame(
    onFrame: (frame: { direction: 'sent' | 'received'; url: string; payload: string }) => void
  ): () => void {
    this.assertOpen('onWebSocketFrame')
    const urls = new Map<string, string>()
    const created = (params: Record<string, unknown>): void => {
      urls.set(params.requestId as string, (params.url as string) ?? '')
    }
    const make =
      (direction: 'sent' | 'received') =>
      (params: Record<string, unknown>): void => {
        const response = params.response as { payloadData?: string } | undefined
        onFrame({
          direction,
          url: urls.get(params.requestId as string) ?? '',
          payload: response?.payloadData ?? '',
        })
      }
    const sent = make('sent')
    const received = make('received')
    this.session.on('Network.webSocketCreated', created)
    this.session.on('Network.webSocketFrameSent', sent)
    this.session.on('Network.webSocketFrameReceived', received)
    void this.session.send('Network.enable').catch(() => undefined)
    return () => {
      this.session.off('Network.webSocketCreated', created)
      this.session.off('Network.webSocketFrameSent', sent)
      this.session.off('Network.webSocketFrameReceived', received)
    }
  }

  /**
   * Web workers and service workers this page has started.
   *
   * A page that does its work in a worker looks idle from the outside: nothing in the DOM is
   * running, so a wait that watches the document concludes the page is finished when it has
   * not begun. Listing the workers at least makes that visible.
   * @returns One entry per worker, with its URL and a way to run code inside it
   */
  async workers(): Promise<Array<{ url: string; evaluate: <T>(expression: string) => Promise<T> }>> {
    this.assertOpen('workers')
    const targets = await this.session.connection.send('Target.getTargets').catch(() => null)
    const infos = (targets?.targetInfos as Array<Record<string, unknown>>) ?? []
    const out: Array<{ url: string; evaluate: <T>(expression: string) => Promise<T> }> = []
    for (const info of infos) {
      if (info.type !== 'worker' && info.type !== 'service_worker') continue
      const targetId = info.targetId as string
      const url = (info.url as string) ?? ''
      out.push({
        url,
        evaluate: async <T,>(expression: string): Promise<T> => {
          const attached = await this.session.connection.send('Target.attachToTarget', {
            targetId,
            flatten: true,
          })
          const sessionId = attached.sessionId as string
          const session = new CDPSession(this.session.connection, sessionId, targetId)
          const result = await session.send('Runtime.evaluate', {
            expression,
            returnByValue: true,
            awaitPromise: true,
          })
          const wrapped = result.result as { value?: unknown } | undefined
          return wrapped?.value as T
        },
      })
    }
    return out
  }

  /**
   * Record the page to a video file.
   *
   * Writes MJPEG in an AVI container, which VLC, mpv, QuickTime and Windows Media Player all
   * open. No encoder and no dependency are involved: the browser already hands back JPEG
   * frames, and AVI carries them directly, so only a container has to be assembled.
   *
   * Pass a `.html` path instead to get the self-contained frame player — useful when the file
   * has to be opened on a machine with no media player at all, such as through a CI web UI.
   * @param options - Where to write; the extension chooses the format. `fps` sets playback rate
   * @returns A handle whose `stop()` writes the file and returns its path
   */
  async recordVideo(options: {
    path: string
    fps?: number
    everyMs?: number
  }): Promise<{ stop: () => Promise<string> }> {
    this.assertOpen('recordVideo')
    const frames: Array<{ at: number; data: string }> = []
    const started = Date.now()
    let stopped = false
    const onFrame = (params: Record<string, unknown>): void => {
      frames.push({ at: Date.now() - started, data: params.data as string })
      void this.session
        .send('Page.screencastFrameAck', { sessionId: params.sessionId })
        .catch(() => undefined)
    }
    this.session.on('Page.screencastFrame', onFrame)
    await this.session.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 60,
      everyNthFrame: 1,
    })
    return {
      stop: async (): Promise<string> => {
        if (stopped) throw new Error('recordVideo: this recording has already been stopped')
        stopped = true
        await this.session.send('Page.stopScreencast').catch(() => undefined)
        this.session.off('Page.screencastFrame', onFrame)
        if (options.path.toLowerCase().endsWith('.html')) {
          return writeFramePlayer(options.path, frames, options.everyMs ?? 100)
        }
        const resolved = nodePath.resolve(options.path)
        await fsp.mkdir(nodePath.dirname(resolved), { recursive: true }).catch(() => undefined)
        const avi = buildMjpegAvi(
          frames.map((f) => Buffer.from(f.data, 'base64')),
          options.fps ?? 10
        )
        await fsp.writeFile(resolved, avi)
        return resolved
      },
    }
  }

  /**
   * A raw protocol session for this page.
   *
   * The escape hatch. This library covers what it covers, and the protocol is larger than any
   * wrapper around it; without a way down to the raw session, a caller who needs one unwrapped
   * domain has to abandon the library entirely. Everything reachable here is by definition
   * unverified — none of the actionability, strictness or effect-checking applies — so prefer
   * the typed API wherever one exists.
   * @returns The page's protocol session
   */
  newCDPSession(): CDPSession {
    this.assertOpen('newCDPSession')
    return this.session
  }

  /**
   * Measure what a `<canvas>` contains.
   *
   * The one place in this library where pixels are the right instrument, because it is the
   * one place the DOM has nothing to say: a canvas is a single element with no children, so
   * `observe()` and `ariaSnapshot()` see a chart, a map or a game as an empty box.
   *
   * The question it answers first is the one no DOM inspection can: a chart that silently
   * failed to draw is a blank canvas with a healthy element, correct dimensions and no console
   * error, and every other part of this library would report that page as fine.
   * @param selector - CSS selector for the canvas
   * @param options - sampleStep reads every Nth pixel; 1 is exact and slower
   * @returns What it contains, or why it could not be read
   */
  async canvasContent(
    selector: string,
    options?: { sampleStep?: number }
  ): Promise<CanvasContent> {
    this.assertOpen('canvasContent')
    const raw = await this.evaluate<string>(
      canvasProbeSource(selector, options?.sampleStep ?? 2)
    )
    return JSON.parse(raw) as CanvasContent
  }

  /**
   * Open a bounded, recorded, multi-step session against this page.
   *
   * Use this rather than bare `act()` whenever a task takes more than one step. The primitives
   * are good at single steps and say nothing about a sequence, which is exactly where
   * computer-use agents fail: short tasks are near solved while long-horizon ones sit around
   * 20%, and the reported cause is agents stalling in partial progress with nothing telling
   * them so.
   * @param options - Goal, step budget and stall threshold
   * @returns The episode
   * @example
   * const ep = page.episode({ goal: 'Pay invoice INV-1001', maxSteps: 8 })
   * await ep.observe()
   * await ep.act({ do: 'click', ref: 'e4', expect: { textAppears: 'Payment sent' }, confirmed: true })
   * await ep.save('runs/pay-invoice.json')
   */
  episode(options: EpisodeOptions): Episode {
    this.assertOpen('episode')
    return new Episode(this, options)
  }

  /**
   * Intercept the next file picker the page opens.
   *
   * A native dialog cannot be dismissed from the page, so a run that triggers one simply
   * stops. Interception means it never opens: call this, then do whatever makes the page ask
   * for a file, and answer with {@link FileChooser.setFiles}.
   *
   * Interception is armed before the action runs, so the listener cannot miss a dialog that
   * opens immediately.
   * @param options - timeout in ms
   * @returns The intercepted picker
   */
  async waitForFileChooser(options?: { timeout?: number }): Promise<FileChooser> {
    this.assertOpen('waitForFileChooser')
    const timeout = options?.timeout ?? 30000
    await this.session.send('Page.setInterceptFileChooserDialog', { enabled: true })
    try {
      const event = await this.mapper.waitForEvent('Page.fileChooserOpened', timeout)
      const backendNodeId = event.backendNodeId as number | undefined
      if (backendNodeId === undefined) {
        throw new Error(
          'the browser reported a file chooser without identifying the input element, so the ' +
            'files cannot be delivered'
        )
      }
      return new FileChooser(this, this.mapper, backendNodeId, event.mode === 'selectMultiple')
    } catch (err) {
      throw new Error(`waitForFileChooser: ${(err as Error).message}`)
    } finally {
      // Leaving interception on would swallow every later dialog in this page, including
      // ones a human is watching for.
      await this.session
        .send('Page.setInterceptFileChooserDialog', { enabled: false })
        .catch(() => undefined)
    }
  }

  /**
   * Name a frame now and reach into it later.
   *
   * Unlike {@link Page.frame} this does not resolve anything yet, so it composes into a
   * single expression and survives the frame reloading between statements:
   * `page.frameLocator('#checkout').getByRole('button', { name: 'Pay' }).click()`.
   * @param selector - CSS selector, frame name, or URL fragment
   * @returns A lazily resolved frame locator
   */
  frameLocator(selector: string): FrameLocator {
    this.assertOpen('frameLocator')
    return new FrameLocator(this, selector)
  }

  async frames(): Promise<Frame[]> {
    this.assertOpen('frames')
    const tree = await this.session.send('Page.getFrameTree')
    const frames: Frame[] = []
    const walk = (node: Record<string, unknown>): void => {
      const frame = node.frame as { id?: string; url?: string; name?: string } | undefined
      if (frame?.id) {
        const attached = this.frameTargets.get(frame.id)
        frames.push(
          new Frame(
            this,
            frame.id,
            frame.url ?? '',
            frame.name ?? '',
            attached ? attached.mapper : this.mapper,
            attached ? undefined : this.frameContexts.get(frame.id),
            attached !== undefined
          )
        )
      }
      for (const child of (node.childFrames as Record<string, unknown>[]) ?? []) walk(child)
    }
    walk(tree.frameTree as Record<string, unknown>)

    // A cross-origin frame may be attached as a target before it appears in the frame tree.
    for (const [frameId, attached] of this.frameTargets) {
      if (frames.some((f) => f.frameId === frameId)) continue
      const url = await attached.mapper.evaluate<string>('location.href').catch(() => '')
      frames.push(new Frame(this, frameId, url, '', attached.mapper, undefined, true))
    }
    return frames
  }

  /** The page's main frame. */
  async mainFrame(): Promise<Frame> {
    const all = await this.frames()
    return all[0]
  }

  /**
   * The frame behind an `<iframe>` element, by CSS selector, name or URL fragment.
   *
   * @param selector - A CSS selector for the iframe element, its `name`, or part of its URL
   * @param options - timeout in ms to wait for the frame to attach and load
   * @returns The frame
   * @throws Error listing the frames that do exist when none matches
   * @example
   * const checkout = await page.frame('#payment-iframe')
   * await checkout.fill('#card-number', '4242424242424242')
   */
  async frame(selector: string, options?: { timeout?: number }): Promise<Frame> {
    this.assertOpen('frame')
    const timeout = options?.timeout ?? 5000
    const deadline = Date.now() + timeout
    let seen: string[] = []
    for (;;) {
      // resolve the iframe element to its own frame id when the caller gave a CSS selector
      let wantedId: string | null = null
      try {
        const nodeId = await this.mapper.querySelector(selector)
        if (nodeId !== null) {
          const described = await this.session.send('DOM.describeNode', { nodeId })
          const node = described.node as { frameId?: string } | undefined
          wantedId = node?.frameId ?? null
        }
      } catch {
        /* not a CSS selector, or the element is not there yet */
      }

      const all = await this.frames()
      seen = all.slice(1).map((f) => f.describe())
      const match =
        (wantedId ? all.find((f) => f.frameId === wantedId) : undefined) ??
        all.slice(1).find((f) => f.name === selector) ??
        all.slice(1).find((f) => f.url.includes(selector))
      if (match) return match
      if (Date.now() >= deadline) break
      await new Promise((r) => setTimeout(r, 100))
    }
    throw new Error(
      `frame(${JSON.stringify(selector)}) not found after ${timeout}ms. ` +
        (seen.length ? `The page has these frames: ${seen.join(', ')}` : 'The page has no frames.')
    )
  }

  // ── ScreenVision Semantic API ─────────────────────────────────────────────────

  /**
   * Resolve a natural-language description to an element via code index → DOM → vision.
   * @param description - e.g. `'navigation bar'`, `'login button'`
   * @param options - timeout/strategy/context
   * @returns The resolved element
   * @throws Error when nothing matches within the timeout
   */
  async find(description: string, options?: FindOptions): Promise<ElementHandle> {
    const resolved = await this.findResolved(description, options)
    return resolved.handle
  }

  /**
   * Like {@link find} but also returns the strategy, confidence and selector used.
   * @param description - Semantic description
   * @param options - Find options
   * @returns ResolvedElement
   */
  async findResolved(description: string, options?: FindOptions): Promise<ResolvedElement> {
    this.assertOpen('find')
    return this.resolver.resolve(description, this, options)
  }

  /**
   * Begin a retrying assertion about a described element.
   *
   * The assertion re-resolves and re-reads until it holds or its timeout expires, so it
   * states that the page reached a condition rather than that it happened to be in it when
   * the line ran.
   * @param description - Semantic description, e.g. `'login button'`
   * @returns An expectation to call an assertion on
   * @example
   * await page.expect('cart badge').toHaveText('3')
   * await page.expect('error banner').not.toBeVisible()
   */
  expect(subject: string | Locator): Expectation {
    this.assertOpen('expect')
    return new Expectation(this, subject)
  }

  /**
   * The whole page looks like its stored baseline.
   * @param name - Baseline name
   * @param options - Baseline directory, tolerances, and whether to capture the full page
   * @throws Error naming the proportion that changed and where the images were written
   * @example
   * await page.expectScreenshot('checkout', { fullPage: true })
   */
  async expectScreenshot(
    name: string,
    options?: ScreenshotCompareOptions & { fullPage?: boolean }
  ): Promise<void> {
    this.assertOpen('expectScreenshot')
    const image = await this.screenshot({ type: 'png', fullPage: options?.fullPage })
    const comparison = await compareScreenshot(image, name, options)
    if (!comparison.matched) throw new Error(describeComparison(name, comparison))
  }

  /**
   * Wait for the page's URL to contain some text, or match a pattern.
   * @param expected - Substring or regular expression
   * @param options - timeout
   * @throws Error reporting the url it settled on
   */
  async expectURL(expected: string | RegExp, options?: { timeout?: number }): Promise<void> {
    const timeout = options?.timeout ?? 5000
    const deadline = Date.now() + timeout
    const matches = (url: string): boolean =>
      expected instanceof RegExp ? expected.test(url) : url.includes(expected)
    for (;;) {
      const url = this.url()
      if (matches(url)) return
      if (Date.now() >= deadline) {
        throw new Error(`expected the url to match ${String(expected)} after ${timeout}ms, but it is ${url}`)
      }
      await new Promise((r) => setTimeout(r, 100))
    }
  }

  /**
   * Wait for the page's title to contain some text, or match a pattern.
   * @param expected - Substring or regular expression
   * @param options - timeout
   * @throws Error reporting the title it settled on
   */
  async expectTitle(expected: string | RegExp, options?: { timeout?: number }): Promise<void> {
    const timeout = options?.timeout ?? 5000
    const deadline = Date.now() + timeout
    let title = ''
    for (;;) {
      title = await this.title().catch(() => '')
      const ok = expected instanceof RegExp ? expected.test(title) : title.includes(expected)
      if (ok) return
      if (Date.now() >= deadline) break
      await new Promise((r) => setTimeout(r, 100))
    }
    throw new Error(`expected the title to match ${String(expected)} after ${timeout}ms, but it is ${JSON.stringify(title)}`)
  }

  /**
   * Every element that could be what a description names, ranked, with the reason for each.
   *
   * Use it when a `find` returned the wrong element, or before acting on an ambiguous
   * description. Unlike `find`, this never picks for you.
   * @param description - Natural-language description
   * @param options - Restrict to a subtree, and how many to return
   * @returns Candidates, best first
   * @example
   * await page.findCandidates('submit button')
   * // [{ selector: '#place', role: 'button', name: 'Place order', score: 0.92, why: 'name starts with the query' },
   * //  { selector: '#to-payment', role: 'button', name: 'Continue to payment', score: 0.52, ... }]
   */
  async findCandidates(
    description: string,
    options?: { within?: ElementHandle; limit?: number }
  ): Promise<Candidate[]> {
    this.assertOpen('findCandidates')
    const matcher = new SemanticMatcher(this)
    return matcher.candidates(description, {
      withinSelector: options?.within?.selector,
      limit: options?.limit,
    })
  }

  /**
   * Like {@link find} but returns null instead of throwing.
   * @param description - Semantic description
   * @param options - Find options
   * @returns Handle or null
   */
  async findOrNull(description: string, options?: FindOptions): Promise<ElementHandle | null> {
    try {
      return await this.find(description, options)
    } catch {
      return null
    }
  }

  /**
   * All elements matching a description (all DOM matches of the resolved selector).
   * @param description - Semantic description
   * @param options - Find options
   * @returns Handles (possibly empty)
   */
  async findAll(description: string, options?: FindOptions): Promise<ElementHandle[]> {
    this.assertOpen('findAll')
    return this.resolver.resolveAll(description, this, options)
  }

  // ── Screenshots ──────────────────────────────────────────────────────────────

  /**
   * Take a screenshot (viewport by default, full page with `fullPage`), optionally annotated.
   * @param options - Screenshot options
   * @returns Image bytes
   */
  async screenshot(options?: ScreenshotOptions): Promise<Buffer> {
    this.assertOpen('screenshot')
    return this.screenshotEngine.screenshot(await this.withRedactions(options))
  }

  /**
   * Screenshot of a single semantically-named element.
   * @param description - Semantic description
   * @param options - Screenshot options
   * @returns Image bytes
   */
  async screenshotElement(
    description: string,
    options?: Omit<ScreenshotOptions, 'fullPage' | 'clip'>
  ): Promise<Buffer> {
    const handle = await this.find(description)
    return this.screenshotEngine.screenshotElement(handle, await this.withRedactions(options))
  }

  /**
   * Fold any `redact` selectors into the annotation list as opaque cover boxes.
   *
   * Redaction is expressed as selectors for the caller's convenience but drawn as annotations,
   * so it rides the same coordinate translation as every other overlay and cannot drift out of
   * alignment with the pixels it is meant to hide.
   * @param options - The caller's screenshot options.
   * @returns Options with redaction resolved into `annotate`.
   */
  private async withRedactions<T extends ScreenshotOptions>(options?: T): Promise<T | undefined> {
    if (!options?.redact || options.redact.length === 0) return options
    const covers: AnnotationSpec[] = []
    for (const selector of options.redact) {
      const handles = await this.$$(selector).catch(() => [] as ElementHandle[])
      for (const element of handles) covers.push({ element, style: 'redact', label: 'redacted' })
    }
    return { ...options, annotate: [...(options.annotate ?? []), ...covers] }
  }

  /**
   * Stitch a before and after image into one before/after diptych.
   *
   * The story of a change in a single artifact instead of two files the reader has to hold in
   * their head. Pair it with `canvasContent` energies in the `title` to make "blank -> drawn"
   * self-evident.
   * @param before - The earlier image bytes.
   * @param after - The later image bytes.
   * @param options - Captions, gutter, title, and an optional save path.
   * @returns The stitched PNG bytes.
   */
  async diptych(before: Buffer, after: Buffer, options?: DiptychOptions): Promise<Buffer> {
    const image = await this.annotationEngine.diptych(before, after, options ?? {})
    if (options?.path) await this.screenshotEngine.saveToFile(image, options.path)
    return image
  }

  /**
   * Capture the before/after of an action on a visual element as one labelled diptych.
   *
   * Built for the canvas blind spot: it reads `canvasContent` and shoots the element, runs the
   * action, reads and shoots again, and returns a diptych whose title carries the gradient
   * energy on each side — so "the chart drew" is one self-explaining image with a number behind
   * it, not a claim. Works for any element; the energy title is only added for a canvas/video.
   * @param selector - The visual element (canvas, video, img, or any element).
   * @param action - The action to run between the two captures.
   * @param options - Optional save path and diptych captions.
   * @returns The diptych bytes plus the before/after canvas measurements when applicable.
   */
  async canvasEvidence(
    selector: string,
    action: () => Promise<void>,
    options?: { path?: string; labels?: [string, string] }
  ): Promise<{ image: Buffer; before: CanvasContent; after: CanvasContent }> {
    this.assertOpen('canvasEvidence')
    const before = await this.canvasContent(selector).catch(() => null)
    const beforeShot = await this.screenshotElement(selector).catch(() => this.screenshot())
    await action()
    const after = await this.canvasContent(selector).catch(() => null)
    const afterShot = await this.screenshotElement(selector).catch(() => this.screenshot())
    const title =
      before && after && before.readable && after.readable
        ? `${selector}: energy ${before.energy.toFixed(2)} -> ${after.energy.toFixed(2)}`
        : undefined
    const labels: [string, string] = options?.labels ?? [
      before && before.readable ? `before (energy ${before.energy.toFixed(2)})` : 'before',
      after && after.readable ? `after (energy ${after.energy.toFixed(2)})` : 'after',
    ]
    const image = await this.diptych(beforeShot, afterShot, { title, labels, path: options?.path })
    return {
      image,
      before: before ?? ({ readable: false } as CanvasContent),
      after: after ?? ({ readable: false } as CanvasContent),
    }
  }

  // ── Verification ─────────────────────────────────────────────────────────────

  /**
   * Verify page structure against expected semantic elements / layout / device rules.
   * @param options - Verify options
   * @returns Structured pass/fail result
   */
  async verify(options: VerifyOptions): Promise<VerificationResult> {
    this.assertOpen('verify')
    return this.verifier.verify(this, options)
  }

  /**
   * Whether a named element exists and is visible.
   * @param description - Semantic description
   * @returns true when found and visible
   */
  async verifyElement(description: string): Promise<boolean> {
    const handle = await this.findOrNull(description, { timeout: 2000 })
    if (!handle) return false
    return handle.isVisible()
  }

  // ── Interaction ──────────────────────────────────────────────────────────────

  private async requireElement(selector: string, timeout?: number): Promise<ElementHandle> {
    const nodeId = await this.mapper.waitForSelector(selector, { state: 'attached', timeout: timeout ?? DEFAULT_TIMEOUT })
    return new ElementHandle(this.mapper, nodeId, selector, this)
  }

  /**
   * Click the first element matching a selector.
   * @param selector - CSS selector
   * @param options - Click options
   */
  /**
   * Run a selector-based operation, prefixing any failure with the call the user made.
   *
   * Without this the error from a failed `click('#nope')` reads "waitForSelector(...) timed
   * out", which names an internal step and neither the operation nor the caller's intent.
   * @param operation - Public method name
   * @param selector - Selector the caller passed
   * @param body - The work to run
   */
  private async named(operation: string, selector: string, body: () => Promise<void>): Promise<void> {
    try {
      await body()
    } catch (err) {
      throw new Error(`${operation}(${JSON.stringify(selector)}) failed: ${(err as Error).message}`)
    }
  }

  async click(selector: string, options?: ClickOptions): Promise<void> {
    await this.named('click', selector, async () => {
      const el = await this.requireElement(selector, options?.timeout)
      await el.click(options)
    })
  }

  /** Double-click the first element matching `selector`. */
  async dblclick(selector: string, options?: ClickOptions): Promise<void> {
    await this.named('dblclick', selector, async () => {
      const el = await this.requireElement(selector, options?.timeout)
      await el.dblclick(options)
    })
  }

  /** Resize the viewport mid-session (Playwright parity: `setViewportSize`). */
  async setViewportSize(size: { width: number; height: number }): Promise<void> {
    this.assertOpen('setViewportSize')
    await this.mapper.setViewport({ width: size.width, height: size.height })
  }

  /**
   * Render the current page to a PDF (headless only, like Playwright). Returns the bytes; the
   * caller decides where they go. `printBackground` defaults on so what renders is what prints.
   */
  async pdf(options?: { landscape?: boolean; printBackground?: boolean; scale?: number }): Promise<Buffer> {
    this.assertOpen('pdf')
    const res = (await this.session.send('Page.printToPDF', {
      printBackground: options?.printBackground ?? true,
      landscape: options?.landscape ?? false,
      ...(options?.scale ? { scale: options.scale } : {}),
    })) as { data: string }
    return Buffer.from(res.data, 'base64')
  }

  /**
   * Make closed shadow roots reachable (a thing raw Playwright cannot do). Installs an init script
   * that rewrites `attachShadow({mode:'closed'})` to open before any page script runs, so the
   * content inside closed roots becomes queryable by locators and the deep traversal. MUST be
   * called before `goto` (init scripts apply to the next document). Open shadow DOM is already
   * pierced without this; this only affects closed roots.
   */
  async pierceClosedShadowRoots(): Promise<void> {
    await this.addInitScript(
      `(() => { const orig = Element.prototype.attachShadow;
        Element.prototype.attachShadow = function (init) { return orig.call(this, Object.assign({}, init, { mode: 'open' })); }; })()`
    )
  }

  /** Emulate media features: print vs screen, dark/light color scheme, reduced motion. */
  async emulateMedia(options: {
    media?: 'screen' | 'print'
    colorScheme?: 'light' | 'dark'
    reducedMotion?: 'reduce' | 'no-preference'
  }): Promise<void> {
    this.assertOpen('emulateMedia')
    const features: Array<{ name: string; value: string }> = []
    if (options.colorScheme) features.push({ name: 'prefers-color-scheme', value: options.colorScheme })
    if (options.reducedMotion) features.push({ name: 'prefers-reduced-motion', value: options.reducedMotion })
    await this.session.send('Emulation.setEmulatedMedia', { ...(options.media ? { media: options.media } : {}), features })
  }

  /**
   * Wait until the page reaches a load state. Returns immediately if already there (so it never
   * hangs on an already-loaded page). `networkidle` is approximated by `load` here; use
   * `waitForNetworkIdle` when a true quiet-network wait is needed.
   */
  async waitForLoadState(state: 'load' | 'domcontentloaded' | 'networkidle' = 'load', options?: { timeout?: number }): Promise<void> {
    this.assertOpen('waitForLoadState')
    const want = state === 'networkidle' ? 'load' : state
    const ready = await this.evaluate<string>(`document.readyState`)
    if (want === 'domcontentloaded' && (ready === 'interactive' || ready === 'complete')) return
    if (want === 'load' && ready === 'complete') return
    await this.waitForNavigation({ waitUntil: want === 'domcontentloaded' ? 'domcontentloaded' : 'load', ...(options?.timeout ? { timeout: options.timeout } : {}) } as NavigateOptions)
  }

  /**
   * Wait until the page URL matches: an exact/prefix string, a `*` glob, or a RegExp. Polls the
   * live location so it works whether the change came from a navigation or a history push.
   */
  async waitForURL(url: string | RegExp, options?: { timeout?: number }): Promise<void> {
    this.assertOpen('waitForURL')
    const deadline = Date.now() + (options?.timeout ?? 30000)
    const matches = (u: string): boolean => {
      if (url instanceof RegExp) return url.test(u)
      if (url.includes('*')) return globToRegExp(url).test(u)
      return u === url || u.startsWith(url)
    }
    for (;;) {
      const u = await this.evaluate<string>(`location.href`)
      if (matches(u)) {
        this.currentUrl = u
        return
      }
      if (Date.now() >= deadline) throw new Error(`waitForURL: '${String(url)}' not reached within ${options?.timeout ?? 30000}ms (current: ${u})`)
      await new Promise((r) => setTimeout(r, 100))
    }
  }

  /**
   * Fill an input.
   * @param selector - CSS selector
   * @param value - Text
   * @param options - Fill options
   */
  async fill(selector: string, value: string, options?: FillOptions): Promise<void> {
    await this.named('fill', selector, async () => {
      const el = await this.requireElement(selector, options?.timeout)
      await el.fill(value, options)
    })
  }

  /**
   * Press a key on an element.
   * @param selector - CSS selector
   * @param key - Key name
   */
  async press(selector: string, key: string): Promise<void> {
    await this.named('press', selector, async () => {
      const el = await this.requireElement(selector)
      await el.press(key)
    })
  }

  /**
   * Select option(s) of a `<select>`.
   * @param selector - CSS selector
   * @param values - Option value(s)
   */
  async selectOption(selector: string, values: string | string[]): Promise<void> {
    await this.named('selectOption', selector, async () => {
      const el = await this.requireElement(selector)
      await el.selectOption(values)
    })
  }

  /**
   * Focus an element.
   * @param selector - CSS selector
   */
  async focus(selector: string): Promise<void> {
    await this.named('focus', selector, async () => {
      const el = await this.requireElement(selector)
      await el.focus()
    })
  }

  /**
   * Hover an element.
   * @param selector - CSS selector
   */
  async hover(selector: string): Promise<void> {
    await this.named('hover', selector, async () => {
      const el = await this.requireElement(selector)
      await el.hover()
    })
  }

  /**
   * Check a checkbox/radio (no-op if already checked).
   * @param selector - CSS selector
   */
  async check(selector: string): Promise<void> {
    await this.named('check', selector, async () => {
      const el = await this.requireElement(selector)
      if (!(await el.isChecked())) await el.click()
    })
  }

  /**
   * Uncheck a checkbox (no-op if already unchecked).
   * @param selector - CSS selector
   */
  async uncheck(selector: string): Promise<void> {
    await this.named('uncheck', selector, async () => {
      const el = await this.requireElement(selector)
      if (await el.isChecked()) await el.click()
    })
  }

  // ── Keyboard & Mouse ─────────────────────────────────────────────────────────

  keyboard = {
    /**
     * Press and release a key on the focused element.
     * @param key - Key name or `Modifier+Key`
     */
    press: async (key: string): Promise<void> => {
      await this.mapper.keyPress(key)
    },
    /**
     * Type text into the focused element.
     * @param text - Text
     * @param options - Per-character delay
     */
    type: async (text: string, options?: { delay?: number }): Promise<void> => {
      await this.mapper.typeText(text, options?.delay ?? 0)
    },
    /**
     * Key down.
     * @param key - Key name
     */
    down: async (key: string): Promise<void> => {
      await this.mapper.keyDown(key)
    },
    /**
     * Key up.
     * @param key - Key name
     */
    up: async (key: string): Promise<void> => {
      await this.mapper.keyUp(key)
    },
  }

  private mousePos = { x: 0, y: 0 }

  mouse = {
    /**
     * Move the mouse.
     * @param x - Viewport x
     * @param y - Viewport y
     */
    move: async (x: number, y: number): Promise<void> => {
      this.mousePos = { x, y }
      await this.mapper.mouseMove(x, y)
    },
    /**
     * Click at coordinates.
     * @param x - Viewport x
     * @param y - Viewport y
     * @param options - Click options
     */
    click: async (x: number, y: number, options?: ClickOptions): Promise<void> => {
      this.mousePos = { x, y }
      await this.mapper.mouseClick(x, y, options)
    },
    /** Press the left button at the current position. */
    down: async (): Promise<void> => {
      await this.mapper.mouseButton('mousePressed', this.mousePos.x, this.mousePos.y)
    },
    /** Release the left button at the current position. */
    up: async (): Promise<void> => {
      await this.mapper.mouseButton('mouseReleased', this.mousePos.x, this.mousePos.y)
    },
    /**
     * Scroll the mouse wheel by a delta at the current pointer position. Agents need this for
     * infinite / lazy-loaded lists that only fetch more on a real wheel event.
     */
    wheel: async (deltaX: number, deltaY: number): Promise<void> => {
      await this.session.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: this.mousePos.x, y: this.mousePos.y, deltaX, deltaY })
    },
  }

  // ── Waiting ──────────────────────────────────────────────────────────────────

  /**
   * Wait for a selector to reach a state.
   * @param selector - CSS selector
   * @param options - state/timeout
   * @returns Handle (for `hidden`/`detached` a handle with nodeId 0)
   */
  async waitForSelector(selector: string, options?: WaitForSelectorOptions): Promise<ElementHandle> {
    this.assertOpen('waitForSelector')
    const nodeId = await this.mapper.waitForSelector(selector, options)
    return new ElementHandle(this.mapper, nodeId, selector, this)
  }

  /**
   * Wait for the next navigation to complete.
   * @param options - waitUntil/timeout
   */
  async waitForNavigation(options?: NavigateOptions): Promise<void> {
    this.assertOpen('waitForNavigation')
    const timeout = options?.timeout ?? DEFAULT_TIMEOUT
    const event = options?.waitUntil === 'domcontentloaded' ? 'Page.domContentEventFired' : 'Page.loadEventFired'
    try {
      const wait = this.mapper.waitForEvent(event, timeout)
      try {
        await wait
      } finally {
        wait.cancel()
      }
      this.currentUrl = await this.mapper.url()
      if (options?.waitUntil === 'networkidle') await this.mapper.waitForNetworkIdle(timeout)
    } catch (err) {
      throw new Error(`waitForNavigation failed: ${(err as Error).message}`)
    }
  }

  /**
   * Wait until the network has been idle for 500ms.
   * @param options - timeout
   */
  async waitForNetworkIdle(options?: { timeout?: number }): Promise<void> {
    await this.mapper.waitForNetworkIdle(options?.timeout ?? DEFAULT_TIMEOUT)
  }

  /**
   * Wait until an expression evaluates truthy.
   * @param fn - JS expression
   * @param options - timeout
   */
  async waitForFunction(fn: string, options?: { timeout?: number }): Promise<void> {
    await this.mapper.waitForFunction(fn, options?.timeout ?? DEFAULT_TIMEOUT)
  }

  /**
   * Sleep.
   * @param ms - Milliseconds
   */
  async waitForTimeout(ms: number): Promise<void> {
    await new Promise((r) => setTimeout(r, ms))
  }

  // ── Events ───────────────────────────────────────────────────────────────────

  on(event: 'console', handler: (msg: ConsoleMessage) => void): void
  on(event: 'dialog', handler: (dialog: Dialog) => void): void
  on(event: 'load', handler: () => void): void
  on(event: 'close', handler: () => void): void
  /**
   * Subscribe to a page event.
   * @param event - `console` | `dialog` | `load` | `close`
   * @param handler - Callback
   */
  on(event: PageEvent, handler: AnyHandler): void {
    // Accepting an event we never emit is worse than not supporting it: the caller registers
    // a network listener, sees no error, and concludes the page made no requests.
    if (!SUPPORTED_PAGE_EVENTS.includes(event)) {
      throw new Error(
        `page.on(${JSON.stringify(event)}) is not a supported event. ` +
          `Supported: ${SUPPORTED_PAGE_EVENTS.join(', ')}. ` +
          `For network activity use page.route(), or page.act() which reports the requests an action caused.`
      )
    }
    switch (event) {
      case 'console':
        this.consoleListeners.push(handler as (msg: ConsoleMessage) => void)
        break
      case 'dialog':
        this.dialogListeners.push(handler as (dialog: Dialog) => void)
        break
      case 'load':
        this.loadListeners.push(handler as () => void)
        break
      case 'close':
        this.closeListeners.push(handler as () => void)
        break
      case 'request':
        this.requestListeners.push(handler as (event: NetworkRequestEvent) => void)
        break
      case 'response':
        this.responseListeners.push(handler as (event: NetworkResponseEvent) => void)
        break
      case 'requestfailed':
        this.requestFailedListeners.push(handler as (event: NetworkFailureEvent) => void)
        break
    }
  }

  /**
   * Unsubscribe from a page event.
   * @param event - Event name
   * @param handler - The callback passed to {@link on}
   */
  off(event: string, handler: AnyHandler): void {
    const remove = <T>(arr: T[]): void => {
      const i = arr.indexOf(handler as unknown as T)
      if (i >= 0) arr.splice(i, 1)
    }
    if (event === 'console') remove(this.consoleListeners)
    else if (event === 'dialog') remove(this.dialogListeners)
    else if (event === 'load') remove(this.loadListeners)
    else if (event === 'close') remove(this.closeListeners)
    else if (event === 'request') remove(this.requestListeners)
    else if (event === 'response') remove(this.responseListeners)
    else if (event === 'requestfailed') remove(this.requestFailedListeners)
  }

  // ── Network ──────────────────────────────────────────────────────────────────

  /**
   * Intercept requests matching a glob pattern.
   * @param pattern - Glob (`**`, `*`, `?`)
   * @param handler - Called with a Route and Request
   * @param options - times: how many requests to handle
   */
  async route(pattern: string, handler: RouteHandler, options?: RouteOptions): Promise<void> {
    this.assertOpen('route')
    const registration: RouteRegistration = {
      pattern,
      regex: globToRegExp(pattern),
      handler,
      remaining: options?.times ?? Number.POSITIVE_INFINITY,
    }
    this.routes.push(registration)
    await this.mapper.setupRouting(pattern, async (params) => {
      const requestId = params.requestId as string
      const active = this.routes.find((r) => r.pattern === pattern && r.remaining > 0)
      if (!active) {
        await this.mapper.continueRequest(requestId)
        return
      }
      active.remaining -= 1
      const { route, request } = buildRoute(params, this.mapper)
      try {
        await active.handler(route, request)
      } catch (err) {
        // A handler that throws leaves the interception dangling, and the browser then sends
        // the request to the real network. That is the worst outcome available: the run looks
        // intercepted, one request silently was not, and nothing says so. Fail the request
        // instead, and say why.
        process.stderr.write(
          `ScreenVision: route handler for ${pattern} threw, so the request to ` +
            `${request.url()} was failed rather than allowed through: ${(err as Error).message}
`
        )
        await this.mapper.failRequest(requestId, 'Failed').catch(() => undefined)
      }
    })
  }

  /**
   * Remove routes registered for a pattern.
   * @param pattern - Glob pattern
   */
  async unroute(pattern: string): Promise<void> {
    this.routes = this.routes.filter((r) => r.pattern !== pattern)
    await this.mapper.removeRouting(pattern)
  }

  // ── Misc ─────────────────────────────────────────────────────────────────────

  /**
   * Inject a `<script>` tag.
   * @param options - url or inline content; optional type
   */
  /**
   * Run a script before any of the page's own scripts, on every document this page loads.
   *
   * Use it to install a stub or seed a global that the app reads at module scope, which is
   * too early for `evaluate` to reach.
   * @param script - Source string, or a function serialised with `toString()`
   * @param arg - JSON-serialisable argument passed to the function form
   * @returns Identifier for `removeInitScript`
   */
  async addInitScript(script: string | ((arg: unknown) => unknown), arg?: unknown): Promise<string> {
    this.assertOpen('addInitScript')
    const source =
      typeof script === 'string'
        ? script
        : `(${script.toString()})(${arg === undefined ? '' : JSON.stringify(arg)})`
    const identifier = await this.mapper.addInitScript(source)
    this.initScripts.push(identifier)
    return identifier
  }

  /**
   * Stop running a previously registered init script on future documents.
   * @param identifier - Value returned by `addInitScript`
   */
  async removeInitScript(identifier: string): Promise<void> {
    this.assertOpen('removeInitScript')
    await this.mapper.removeInitScript(identifier)
    this.initScripts = this.initScripts.filter((id) => id !== identifier)
  }

  async addScriptTag(options: { url?: string; content?: string; type?: string }): Promise<void> {
    this.assertOpen('addScriptTag')
    try {
      await this.mapper.evaluate<void>(`new Promise((resolve, reject) => {
        const s = document.createElement('script')
        ${options.type ? `s.type = ${JSON.stringify(options.type)}` : ''}
        ${
          options.url
            ? `s.src = ${JSON.stringify(options.url)}; s.onload = () => resolve(); s.onerror = () => reject(new Error('script load failed'))`
            : `s.textContent = ${JSON.stringify(options.content ?? '')}`
        }
        document.head.appendChild(s)
        ${options.url ? '' : 'resolve()'}
      })`)
    } catch (err) {
      throw new Error(`addScriptTag failed: ${(err as Error).message}`)
    }
  }

  /**
   * Inject a stylesheet.
   * @param options - url or inline CSS
   */
  async addStyleTag(options: { url?: string; content?: string }): Promise<void> {
    this.assertOpen('addStyleTag')
    try {
      await this.mapper.evaluate<void>(`new Promise((resolve, reject) => {
        ${
          options.url
            ? `const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = ${JSON.stringify(options.url)}; l.onload = () => resolve(); l.onerror = () => reject(new Error('style load failed')); document.head.appendChild(l)`
            : `const s = document.createElement('style'); s.textContent = ${JSON.stringify(options.content ?? '')}; document.head.appendChild(s); resolve()`
        }
      })`)
    } catch (err) {
      throw new Error(`addStyleTag failed: ${(err as Error).message}`)
    }
  }

  /**
   * Replace the document with the given HTML.
   * @param html - Full HTML
   * @param options - waitUntil
   */
  async setContent(html: string, options?: NavigateOptions): Promise<void> {
    this.assertOpen('setContent')
    try {
      const load = this.mapper.waitForEvent('Page.loadEventFired', options?.timeout ?? 5000)
      load.catch(() => undefined)
      await this.mapper.evaluate<void>(
        `(() => { document.open(); document.write(${JSON.stringify(html)}); document.close() })()`
      )
      try {
        if (options?.waitUntil !== 'commit') {
          await Promise.race([load, this.mapper.waitForFunction(`document.readyState === 'complete'`, 5000)])
        }
      } finally {
        load.cancel()
      }
      if (options?.waitUntil === 'networkidle') await this.mapper.waitForNetworkIdle(options.timeout)
    } catch (err) {
      throw new Error(`setContent failed: ${(err as Error).message}`)
    }
  }

  /**
   * Full HTML of the document.
   * @returns HTML string
   */
  async content(): Promise<string> {
    this.assertOpen('content')
    return this.mapper.evaluate<string>('document.documentElement.outerHTML')
  }

  /** Close the page (CDP `Target.closeTarget`). */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    try {
      await this.session.connection.send('Target.closeTarget', { targetId: this.session.targetId })
    } catch (err) {
      const message = (err as Error).message
      if (!/No target with given id|not open|closed/i.test(message)) {
        throw new Error(`Page.close failed: ${message}`)
      }
    } finally {
      // a closed page must not keep its listeners, or a runner that opens pages in a loop
      // pins every dead page, mapper and inflight-request set for the life of the browser
      for (const [event, listener] of this.sessionListeners) this.session.off(event, listener)
      this.sessionListeners = []
      for (const attached of this.frameTargets.values()) attached.mapper.dispose()
      this.frameTargets.clear()
      this.frameContexts.clear()
      this.mapper.dispose()
      for (const l of this.closeListeners) l()
      this.consoleListeners = []
      this.dialogListeners = []
      this.loadListeners = []
      this.closeListeners = []
      this.requestListeners = []
      this.responseListeners = []
      this.requestFailedListeners = []
      this.inflightMeta.clear()
    }
  }

  /** Whether {@link close} has been called. */
  isClosed(): boolean {
    return this.closed
  }

  /**
   * Viewport set via emulation (null when the page uses the window's default size).
   * @returns Viewport or null
   */
  viewportSize(): { width: number; height: number } | null {
    return this.viewport ? { ...this.viewport } : null
  }

  private assertOpen(op: string): void {
    if (this.closed) throw new Error(`Page.${op}: page has been closed`)
  }
}

function buildConsoleMessage(params: Record<string, unknown>): ConsoleMessage {
  const type = String(params.type ?? 'log')
  const args = (params.args ?? []) as Array<{ value?: unknown; description?: string; type?: string }>
  const text = args
    .map((a) => (a.value !== undefined ? String(a.value) : (a.description ?? a.type ?? '')))
    .join(' ')
  const trace = params.stackTrace as { callFrames?: Array<{ url: string; lineNumber: number; columnNumber: number }> }
  const frame = trace?.callFrames?.[0]
  return {
    type: () => type,
    text: () => text,
    location: () => ({
      url: frame?.url ?? '',
      lineNumber: frame?.lineNumber ?? 0,
      columnNumber: frame?.columnNumber ?? 0,
    }),
  }
}

function buildDialog(params: Record<string, unknown>, mapper: ProtocolMapper): Dialog {
  const rawType = String(params.type ?? 'alert')
  const type: ReturnType<Dialog['type']> =
    rawType === 'confirm' || rawType === 'prompt' || rawType === 'beforeunload' ? rawType : 'alert'
  const message = String(params.message ?? '')
  let handled = false
  return {
    type: () => type,
    message: () => message,
    accept: async (promptText?: string) => {
      if (handled) throw new Error('Dialog already handled')
      handled = true
      await mapper.handleDialog(true, promptText)
    },
    dismiss: async () => {
      if (handled) throw new Error('Dialog already handled')
      handled = true
      await mapper.handleDialog(false)
    },
  }
}

function buildRoute(params: Record<string, unknown>, mapper: ProtocolMapper): { route: Route; request: Request } {
  const requestId = params.requestId as string
  const raw = params.request as {
    url: string
    method: string
    headers: Record<string, string>
    postData?: string
  }
  const resourceType = String(params.resourceType ?? 'other')
  const request: Request = {
    url: () => raw.url,
    method: () => raw.method,
    headers: () => raw.headers ?? {},
    postData: () => raw.postData ?? null,
    resourceType: () => resourceType,
  }
  let handled = false
  const once = (): void => {
    if (handled) throw new Error(`Route for ${raw.url} already handled`)
    handled = true
  }
  const route: Route = {
    request: () => request,
    fulfill: async (response: FulfillResponse) => {
      once()
      const headers: Record<string, string> = { ...(response.headers ?? {}) }
      if (response.contentType) headers['content-type'] = response.contentType
      const bodyBuffer =
        response.body === undefined
          ? Buffer.alloc(0)
          : Buffer.isBuffer(response.body)
            ? response.body
            : Buffer.from(response.body, 'utf8')
      if (!headers['content-length']) headers['content-length'] = String(bodyBuffer.length)
      await mapper.fulfillRequest(requestId, {
        responseCode: response.status ?? 200,
        responseHeaders: Object.entries(headers).map(([name, value]) => ({ name, value })),
        body: bodyBuffer.toString('base64'),
      })
    },
    continue: async (overrides?: ContinueOverrides) => {
      once()
      const o: Record<string, unknown> = {}
      if (overrides?.url) o.url = overrides.url
      if (overrides?.method) o.method = overrides.method
      if (overrides?.postData) o.postData = Buffer.from(overrides.postData, 'utf8').toString('base64')
      if (overrides?.headers) o.headers = Object.entries(overrides.headers).map(([name, value]) => ({ name, value }))
      await mapper.continueRequest(requestId, o)
    },
    abort: async (errorCode?: string) => {
      once()
      await mapper.failRequest(requestId, errorCode ?? 'Failed')
    },
  }
  return { route, request }
}

/**
 * Lower-case the keys of a header map.
 *
 * HTTP header names are case-insensitive and different servers disagree about casing, so a
 * caller looking for `content-type` should not have to guess.
 * @param headers - Raw headers
 * @returns Headers with lower-cased keys
 */
function lowerCaseKeys(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) out[key.toLowerCase()] = value
  return out
}

/**
 * The most recently written file in a directory.
 *
 * Used to locate a completed download, because the browser may name the file by its internal
 * identifier rather than the name the site suggested.
 * @param directory - Directory to look in
 * @returns Absolute path, or null when the directory is empty or unreadable
 */
function newestFileIn(directory: string): string | null {
  try {
    const entries = fsSync
      .readdirSync(directory)
      .map((name) => nodePath.join(directory, name))
      .filter((full) => fsSync.statSync(full).isFile())
    if (entries.length === 0) return null
    return entries.sort((a, b) => fsSync.statSync(b).mtimeMs - fsSync.statSync(a).mtimeMs)[0]
  } catch {
    return null
  }
}

/**
 * Turn a URL matcher into a predicate, accepting the forms callers actually reach for.
 *
 * A plain string is treated as a glob when it contains a wildcard and as a substring
 * otherwise, so both `'/api/items'` and `'**' + '/api/*'` behave as expected. Previously a
 * glob matched nothing and the wait simply hung until its timeout, which reads as an
 * application problem rather than a mistake in the test.
 * @param match - Substring, glob, regular expression, or predicate
 * @returns A predicate over the observed url
 */
function urlPredicate<T extends { url: string }>(
  match: string | RegExp | ((value: T) => boolean)
): (value: T) => boolean {
  if (typeof match === 'function') return match
  if (match instanceof RegExp) return (value: T) => match.test(value.url)
  if (/[*?]/.test(match)) {
    const pattern = globToRegExp(match)
    return (value: T) => pattern.test(value.url)
  }
  return (value: T) => value.url.includes(match)
}

/**
 * Write captured frames as a self-contained HTML player.
 *
 * Everything is inlined, so the file can be copied off a CI machine and opened anywhere. A
 * video file would be smaller, but only if ffmpeg happened to be installed.
 * @param destination - File to write
 * @param frames - Captured frames, base64 JPEG with millisecond offsets
 * @param everyMs - Playback interval
 * @returns The absolute path written
 */
async function writeFramePlayer(
  destination: string,
  frames: Array<{ at: number; data: string }>,
  everyMs: number
): Promise<string> {
  const resolved = nodePath.resolve(destination)
  await fsp.mkdir(nodePath.dirname(resolved), { recursive: true }).catch(() => undefined)
  const payload = JSON.stringify(frames.map((f) => ({ t: f.at, d: f.data })))
  const html = `<!doctype html><meta charset="utf-8"><title>Recording</title>
<style>body{margin:0;background:#111;color:#eee;font:13px system-ui}
#bar{display:flex;gap:8px;align-items:center;padding:8px}
img{max-width:100%;display:block}</style>
<div id="bar"><button id="play">Play</button>
<input id="seek" type="range" min="0" value="0" style="flex:1">
<span id="label"></span></div>
<img id="view">
<script>
const FRAMES = ${payload}
const view = document.getElementById('view'), seek = document.getElementById('seek')
const label = document.getElementById('label'), play = document.getElementById('play')
seek.max = String(Math.max(0, FRAMES.length - 1))
let i = 0, timer = null
const show = (n) => {
  if (!FRAMES.length) { label.textContent = 'no frames captured'; return }
  i = Math.max(0, Math.min(FRAMES.length - 1, n))
  view.src = 'data:image/jpeg;base64,' + FRAMES[i].d
  seek.value = String(i)
  label.textContent = (i + 1) + '/' + FRAMES.length + '  ' + FRAMES[i].t + 'ms'
}
seek.addEventListener('input', () => show(Number(seek.value)))
play.addEventListener('click', () => {
  if (timer) { clearInterval(timer); timer = null; play.textContent = 'Play'; return }
  play.textContent = 'Pause'
  timer = setInterval(() => {
    if (i >= FRAMES.length - 1) { clearInterval(timer); timer = null; play.textContent = 'Play'; return }
    show(i + 1)
  }, ${everyMs})
})
show(0)
</script>`
  await fsp.writeFile(resolved, html, 'utf8')
  return resolved
}
