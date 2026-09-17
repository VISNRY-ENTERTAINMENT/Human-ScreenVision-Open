import { CDPClient } from '../cdp/CDPClient'
import { CDPSession } from '../cdp/CDPSession'
import { Page } from './Page'
import { ApiRequestContext } from './ApiRequest'
import { HarRouter, type HarNotFound } from './HarRouter'
import { DeviceContext } from '../intelligence/DeviceContext'
import {
  BrowserContextOptions,
  Cookie,
  StorageState,
  RouteOptions,
  RouteHandler,
  DeviceExpectations,
  DeviceDescriptor,
  CodeIndexResult,
  OriginStorage,
} from './types'

/**
 * An isolated browser context (separate cookies/storage), optionally emulating a device.
 */
export class BrowserContext {
  public readonly deviceExpectations: DeviceExpectations | null
  public readonly device: DeviceDescriptor | null
  private pageList: Page[] = []
  /** Emulation applied to every page in this context, including ones opened later. */
  private geolocation: { latitude: number; longitude: number; accuracy?: number } | null = null
  private offline = false
  /** Init-script sources replayed onto every new page in this context. */
  private initScriptSources: string[] = []
  private routeRegistrations: Array<{ pattern: string; handler: RouteHandler; options?: RouteOptions }> = []
  private closed = false
  /** Lazily built API client sharing this context's cookies. */
  private apiRequest: ApiRequestContext | null = null
  /** Callers waiting for the next page this context opens by itself. */
  private popupWaiters: Array<(page: Page) => void> = []
  /** Page targets already adopted, so a second announcement is ignored. */
  private adopted = new Set<string>()
  private discovering = false

  /**
   * @param client - Browser-level CDP client
   * @param contextId - `Target.createBrowserContext` id ('' for the default context)
   * @param options - Context options (device, viewport, UA, ...)
   * @param codeIndex - Launch-time code index (or null)
   * @param visionEndpoint - Vision API endpoint (or null)
   * @param visionApiKey - Vision API key (or null)
   */
  constructor(
    private client: CDPClient,
    private contextId: string,
    private options: BrowserContextOptions,
    private codeIndex: CodeIndexResult | null,
    private visionEndpoint: string | null,
    private visionApiKey: string | null
  ) {
    let device: DeviceDescriptor | null = null
    if (options.device) {
      device = typeof options.device === 'string' ? DeviceContext.getDevice(options.device) : options.device
    } else if (options.viewport) {
      device = {
        name: `custom ${options.viewport.width}x${options.viewport.height}`,
        viewport: options.viewport,
        userAgent: options.userAgent ?? '',
        deviceScaleFactor: 1,
        isMobile: options.viewport.width <= 480,
        hasTouch: options.viewport.width <= 1024,
        defaultBrowserType: 'chromium',
      }
    }
    this.device = device
    this.deviceExpectations = device ? DeviceContext.buildExpectations(device) : null
  }

  /** CDP browser context id. */
  id(): string {
    return this.contextId
  }

  /**
   * Open a new page (CDP `Target.createTarget` + `Target.attachToTarget`), apply emulation and options.
   * @returns The initialised page
   */
  /**
   * Ask the browser to announce targets, and adopt the pages this context opens itself.
   *
   * Called lazily: a caller that never opens a popup should not pay for target discovery, and
   * the events are noisy on a browser with many tabs.
   */
  private async startDiscovery(): Promise<void> {
    if (this.discovering) return
    this.discovering = true
    this.client.on('Target.targetCreated', (params) => {
      const info = params.targetInfo as
        | { targetId?: string; type?: string; browserContextId?: string; openerId?: string }
        | undefined
      if (!info?.targetId || info.type !== 'page') return
      // only pages belonging to this context, and only ones we did not create ourselves
      if ((info.browserContextId ?? '') !== this.contextId) return
      if (this.adopted.has(info.targetId)) return
      void this.adopt(info.targetId)
    })
    await this.client.send('Target.setDiscoverTargets', { discover: true }).catch(() => undefined)
  }

  /**
   * Attach to a page target the site opened and present it as a Page.
   * @param targetId - The new target
   */
  private async adopt(targetId: string): Promise<void> {
    if (this.adopted.has(targetId)) return
    this.adopted.add(targetId)
    try {
      const attached = await this.client.send('Target.attachToTarget', { targetId, flatten: true })
      const session = new CDPSession(this.client, attached.sessionId as string, targetId)
      const page = new Page(
        session,
        this.codeIndex,
        this.deviceExpectations,
        this.visionEndpoint,
        this.visionApiKey,
        this.contextId
      )
      await page.initialize()
      await this.applyOptions(page, session)
      this.pageList.push(page)
      page.on('close', () => {
        this.pageList = this.pageList.filter((p) => p !== page)
        this.adopted.delete(targetId)
      })
      const waiters = this.popupWaiters.splice(0)
      for (const waiter of waiters) waiter(page)
    } catch {
      // a target that vanished before we attached is not an error worth failing a run over
      this.adopted.delete(targetId)
    }
  }

  /**
   * Wait for the next page this context opens by itself.
   *
   * Use it for a `target="_blank"` link, a `window.open`, or an authentication popup. The
   * wait must be started before the action that triggers it, or the page can appear first.
   * @param options - timeout in ms
   * @returns The new page, already initialised
   * @throws Error when no page appears in time
   * @example
   * const [popup] = await Promise.all([context.waitForPage(), page.click('#sign-in-with')])
   * await popup.fill('#password', secret)
   */
  async waitForPage(options?: { timeout?: number }): Promise<Page> {
    this.assertOpen('waitForPage')
    await this.startDiscovery()
    const timeout = options?.timeout ?? 30000
    return new Promise<Page>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.popupWaiters = this.popupWaiters.filter((w) => w !== waiter)
        reject(
          new Error(
            `waitForPage timed out after ${timeout}ms: this context opened no new page. ` +
              `Start the wait before the action that opens it.`
          )
        )
      }, timeout)
      const waiter = (page: Page): void => {
        clearTimeout(timer)
        resolve(page)
      }
      this.popupWaiters.push(waiter)
    })
  }

  async newPage(): Promise<Page> {
    this.assertOpen('newPage')
    let targetId: string
    let sessionId: string
    try {
      const createParams: Record<string, unknown> = { url: 'about:blank' }
      if (this.contextId) createParams.browserContextId = this.contextId
      const created = await this.client.send('Target.createTarget', createParams)
      targetId = created.targetId as string
      const attached = await this.client.send('Target.attachToTarget', { targetId, flatten: true })
      sessionId = attached.sessionId as string
    } catch (err) {
      throw new Error(`BrowserContext.newPage: failed to create target: ${(err as Error).message}`)
    }

    this.adopted.add(targetId)
    const session = new CDPSession(this.client, sessionId, targetId)
    const page = new Page(
      session,
      this.codeIndex,
      this.deviceExpectations,
      this.visionEndpoint,
      this.visionApiKey,
      this.contextId
    )
    await page.initialize()
    await this.applyOptions(page, session)
    this.pageList.push(page)
    page.on('close', () => {
      this.pageList = this.pageList.filter((p) => p !== page)
    })
    return page
  }

  private async applyOptions(page: Page, session: CDPSession): Promise<void> {
    if (this.device?.hasTouch) await page.mapperRef().setTouchEmulation(true, 5)
    for (const source of this.initScriptSources) await page.addInitScript(source)
    try {
      if (this.device) {
        await page.emulateDevice({
          ...this.device,
          userAgent: this.options.userAgent ?? this.device.userAgent,
        })
      } else if (this.options.userAgent) {
        await page.emulate({ userAgent: this.options.userAgent })
      }
      if (this.options.locale || this.options.timezoneId) {
        if (this.options.timezoneId) {
          await session.send('Emulation.setTimezoneOverride', { timezoneId: this.options.timezoneId })
        }
        if (this.options.locale) {
          await session.send('Emulation.setLocaleOverride', { locale: this.options.locale })
        }
      }
      if (this.options.extraHTTPHeaders) {
        await session.send('Network.setExtraHTTPHeaders', { headers: this.options.extraHTTPHeaders })
      }
      if (this.options.permissions && this.options.permissions.length > 0) {
        const grantParams: Record<string, unknown> = { permissions: this.options.permissions }
        if (this.contextId) grantParams.browserContextId = this.contextId
        await this.client.send('Browser.grantPermissions', grantParams)
      }
      if (this.options.storageState) {
        if (this.options.storageState.cookies.length > 0) await this.addCookies(this.options.storageState.cookies)
        for (const origin of this.options.storageState.origins) {
          await this.seedLocalStorage(page, origin)
        }
      }
      for (const r of this.routeRegistrations) await page.route(r.pattern, r.handler, r.options)
      // emulation set on the context has to reach pages opened after it was set
      if (this.geolocation !== null) await this.applyGeolocation(page)
      if (this.offline) await this.applyOffline(page)
    } catch (err) {
      throw new Error(`BrowserContext.newPage: failed to apply context options: ${(err as Error).message}`)
    }
  }

  private async seedLocalStorage(page: Page, origin: OriginStorage): Promise<void> {
    const mapper = page.mapperRef()
    await mapper.navigate(origin.origin, { waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => undefined)
    await mapper.evaluate<void>(
      `(() => { for (const kv of ${JSON.stringify(origin.localStorage)}) localStorage.setItem(kv.name, kv.value) })()`
    )
    await mapper.navigate('about:blank', { waitUntil: 'commit' })
  }

  /**
   * Pages currently open in this context.
   * @returns Page list
   */
  /**
   * Run a script before any page script, on every page this context creates from now on
   * and on the pages it has already created.
   * @param script - Source string, or a function serialised with `toString()`
   * @param arg - JSON-serialisable argument passed to the function form
   */
  async addInitScript(script: string | ((arg: unknown) => unknown), arg?: unknown): Promise<void> {
    this.assertOpen('addInitScript')
    const source =
      typeof script === 'string'
        ? script
        : `(${script.toString()})(${arg === undefined ? '' : JSON.stringify(arg)})`
    this.initScriptSources.push(source)
    for (const page of this.pageList) {
      if (!page.isClosed()) await page.addInitScript(source)
    }
  }

  /**
   * Make HTTP calls outside the browser, sharing this context's cookies.
   *
   * Setting a test up through the API is faster and less brittle than driving the interface
   * to do it, and the session it establishes applies to the pages this context opens. It is
   * also the only way to check an effect the interface does not show.
   * @returns The API client for this context
   * @example
   * await context.request.post('http://localhost:3000/api/login', { data: { user: 'dana' } })
   * const page = await context.newPage()   // already signed in
   */
  get request(): ApiRequestContext {
    this.assertOpen('request')
    if (!this.apiRequest) this.apiRequest = new ApiRequestContext(this)
    return this.apiRequest
  }

  async pages(): Promise<Page[]> {
    // discovery is started here too, so a caller that simply lists pages after a popup has
    // opened still sees it rather than getting a stale list
    await this.startDiscovery()
    const known = new Set(this.pageList.map((p) => p.targetId()))
    const targets = await this.client.send('Target.getTargets').catch(() => null)
    if (targets) {
      const infos = (targets.targetInfos as Array<Record<string, unknown>>) ?? []
      for (const info of infos) {
        if (info.type !== 'page') continue
        if ((info.browserContextId ?? '') !== this.contextId) continue
        const id = String(info.targetId)
        if (!known.has(id)) await this.adopt(id)
      }
    }
    return [...this.pageList]
  }


  /**
   * Add cookies to the context (CDP `Storage.setCookies`).
   * @param cookies - Cookies to add
   */
  /**
   * Grant browser permissions without a prompt.
   *
   * Permissions could previously only be set when the context was created, which is no use
   * for the common case: an agent that reaches a page, is prompted, and has to decide. A
   * prompt is a modal an automated run cannot answer, so the grant has to be able to happen
   * at the moment the decision is made.
   * @param permissions - CDP permission names, e.g. `geolocation`, `clipboard-read`
   * @param options - origin to scope the grant to
   */
  async grantPermissions(permissions: string[], options?: { origin?: string }): Promise<void> {
    const params: Record<string, unknown> = { permissions }
    if (this.contextId) params.browserContextId = this.contextId
    if (options?.origin) params.origin = options.origin
    await this.client.send('Browser.grantPermissions', params)
  }

  /**
   * Revoke everything granted, returning the context to its default prompting behaviour.
   */
  async clearPermissions(): Promise<void> {
    const params: Record<string, unknown> = {}
    if (this.contextId) params.browserContextId = this.contextId
    await this.client.send('Browser.resetPermissions', params)
  }

  /**
   * Set the position reported by the Geolocation API.
   *
   * Applied to every page in the context and remembered for pages opened later, because a
   * location that silently stops applying to the next tab is worse than one that never
   * worked. Pass null to stop overriding.
   * @param geolocation - Coordinates, or null to clear the override
   */
  async setGeolocation(
    geolocation: { latitude: number; longitude: number; accuracy?: number } | null
  ): Promise<void> {
    if (
      geolocation !== null &&
      (Math.abs(geolocation.latitude) > 90 || Math.abs(geolocation.longitude) > 180)
    ) {
      throw new Error(
        `setGeolocation: latitude must be within ±90 and longitude within ±180, got ` +
          `${geolocation.latitude}, ${geolocation.longitude}`
      )
    }
    this.geolocation = geolocation
    for (const page of await this.pages()) await this.applyGeolocation(page)
  }

  /**
   * Cut the context off from the network, or restore it.
   *
   * The offline branch is the one no test suite exercises and every real user hits, so making
   * it a single call is the point.
   * @param offline - Whether pages should behave as though disconnected
   */
  async setOffline(offline: boolean): Promise<void> {
    this.offline = offline
    for (const page of await this.pages()) await this.applyOffline(page)
  }

  /**
   * Push the current geolocation override onto one page.
   * @param page - Page to apply it to
   */
  private async applyGeolocation(page: Page): Promise<void> {
    const session = page.sessionRef()
    if (this.geolocation === null) {
      await session.send('Emulation.clearGeolocationOverride', {}).catch(() => undefined)
      return
    }
    await session
      .send('Emulation.setGeolocationOverride', {
        latitude: this.geolocation.latitude,
        longitude: this.geolocation.longitude,
        accuracy: this.geolocation.accuracy ?? 10,
      })
      .catch(() => undefined)
  }

  /**
   * Push the current offline state onto one page.
   * @param page - Page to apply it to
   */
  private async applyOffline(page: Page): Promise<void> {
    await page
      .sessionRef()
      .send('Network.emulateNetworkConditions', {
        offline: this.offline,
        latency: 0,
        downloadThroughput: this.offline ? 0 : -1,
        uploadThroughput: this.offline ? 0 : -1,
      })
      .catch(() => undefined)
  }

  async addCookies(cookies: Cookie[]): Promise<void> {
    this.assertOpen('addCookies')
    try {
      const params: Record<string, unknown> = {
        cookies: cookies.map((c) => ({
          name: c.name,
          value: c.value,
          domain: c.domain,
          path: c.path,
          httpOnly: c.httpOnly,
          secure: c.secure,
          sameSite: c.sameSite,
          ...(c.expires > 0 ? { expires: c.expires } : {}),
        })),
      }
      if (this.contextId) params.browserContextId = this.contextId
      await this.client.send('Storage.setCookies', params)
    } catch (err) {
      throw new Error(`BrowserContext.addCookies failed: ${(err as Error).message}`)
    }
  }

  /**
   * Cookies of the context (CDP `Storage.getCookies`), optionally filtered by URL.
   * @param urls - Only cookies that would be sent to these URLs
   * @returns Cookie list
   */
  async cookies(urls?: string[]): Promise<Cookie[]> {
    this.assertOpen('cookies')
    try {
      const params: Record<string, unknown> = {}
      if (this.contextId) params.browserContextId = this.contextId
      const result = await this.client.send('Storage.getCookies', params)
      const raw = (result.cookies ?? []) as Array<Record<string, unknown>>
      const all: Cookie[] = raw.map((r) => ({
        name: String(r.name ?? ''),
        value: String(r.value ?? ''),
        domain: String(r.domain ?? ''),
        path: String(r.path ?? '/'),
        expires: typeof r.expires === 'number' ? r.expires : -1,
        httpOnly: Boolean(r.httpOnly),
        secure: Boolean(r.secure),
        sameSite: r.sameSite === 'Strict' || r.sameSite === 'None' ? r.sameSite : 'Lax',
      }))
      if (!urls || urls.length === 0) return all
      const hosts = urls.map((u) => new URL(u).hostname)
      return all.filter((c) =>
        hosts.some((h) => {
          const d = c.domain.replace(/^\./, '')
          return h === d || h.endsWith(`.${d}`)
        })
      )
    } catch (err) {
      throw new Error(`BrowserContext.cookies failed: ${(err as Error).message}`)
    }
  }

  /** Clear all cookies (CDP `Storage.clearCookies`). */
  async clearCookies(): Promise<void> {
    this.assertOpen('clearCookies')
    try {
      const params: Record<string, unknown> = {}
      if (this.contextId) params.browserContextId = this.contextId
      await this.client.send('Storage.clearCookies', params)
    } catch (err) {
      throw new Error(`BrowserContext.clearCookies failed: ${(err as Error).message}`)
    }
  }

  /**
   * Snapshot of cookies plus localStorage of every open page's origin.
   * @returns Storage state
   */
  async storageState(): Promise<StorageState> {
    this.assertOpen('storageState')
    const cookies = await this.cookies()
    const origins: OriginStorage[] = []
    const seen = new Set<string>()
    for (const page of this.pageList) {
      try {
        const data = await page.mapperRef().evaluate<{ origin: string; items: Array<{ name: string; value: string }> }>(
          `(() => { const items = []; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); items.push({ name: k, value: localStorage.getItem(k) }) } return { origin: location.origin, items } })()`
        )
        if (!data || data.origin === 'null' || seen.has(data.origin)) continue
        seen.add(data.origin)
        origins.push({ origin: data.origin, localStorage: data.items })
      } catch {
        /* page may be closed or on about:blank; skip */
      }
    }
    return { cookies, origins }
  }

  /**
   * Route requests for every current and future page in this context.
   * @param pattern - Glob pattern
   * @param handler - Route handler
   * @param options - times
   */
  async route(pattern: string, handler: RouteHandler, options?: RouteOptions): Promise<void> {
    this.assertOpen('route')
    this.routeRegistrations.push({ pattern, handler, options })
    for (const page of this.pageList) await page.route(pattern, handler, options)
  }

  /**
   * Serve this context's network from a HAR file, or record one.
   *
   * Determinism is the point. A run that reaches the real network cannot distinguish "my
   * change broke this" from "the backend changed underneath me", so a failure is unarguable
   * only when the bytes are fixed.
   *
   * A request the HAR does not contain **fails** by default rather than falling through to
   * the network, because a replay that quietly reaches the internet looks reproducible and is
   * not, and the one varying request is invisible. Pass `notFound: 'fallback'` to allow it.
   * @param harPath - File to read, or write when recording
   * @param options - `update` to record; `notFound` to allow unmatched requests through
   * @returns A handle for saving the recording and inspecting what went unused
   */
  async routeFromHAR(
    harPath: string,
    options?: { update?: boolean; notFound?: HarNotFound; url?: string }
  ): Promise<HarRouter> {
    this.assertOpen('routeFromHAR')
    const router = new HarRouter(
      harPath,
      options?.update === true ? 'record' : 'replay',
      options?.notFound ?? 'abort',
      this.request
    )
    await router.load()
    await this.route(options?.url ?? '**/*', (route, request) => router.handle(route, request))
    return router
  }

  /** Close all pages, then dispose the context (CDP `Target.disposeBrowserContext`). */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    const pages = [...this.pageList]
    for (const page of pages) await page.close().catch(() => undefined)
    this.pageList = []
    if (!this.contextId) return
    try {
      await this.client.send('Target.disposeBrowserContext', { browserContextId: this.contextId })
    } catch (err) {
      const message = (err as Error).message
      if (!/Failed to find context|not found/i.test(message)) {
        throw new Error(`BrowserContext.close failed: ${message}`)
      }
    }
  }

  private assertOpen(op: string): void {
    if (this.closed) throw new Error(`BrowserContext.${op}: context has been closed`)
  }
}
