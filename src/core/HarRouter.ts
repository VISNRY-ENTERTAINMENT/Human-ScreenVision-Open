import fs from 'fs/promises'
import path from 'path'
import type { ApiRequestContext } from './ApiRequest'
import type { Route, Request } from './types'

/**
 * Record a page's network traffic to a HAR file, then serve it back.
 *
 * This is the deterministic-replay story, and determinism is the whole point of the library:
 * a run that hits the real network is not reproducible, so a failure cannot be distinguished
 * from a backend that changed under it. With a HAR the page sees the same bytes every time,
 * and a difference in outcome is a difference in the page.
 *
 * The default for a request the HAR does not contain is to **fail it**, not to fall through
 * to the network. A replay that quietly reaches the internet is the worst of both worlds: it
 * looks deterministic and is not, and the one request that varies is invisible. Callers who
 * want the other behaviour ask for it explicitly.
 */

/** One recorded exchange. */
interface HarEntry {
  request: { method: string; url: string }
  response: {
    status: number
    headers: Array<{ name: string; value: string }>
    content: { text: string; encoding?: string; mimeType: string }
  }
}

/** The subset of the HAR format this reads and writes. */
interface HarFile {
  log: { version: string; creator: { name: string; version: string }; entries: HarEntry[] }
}

/** What to do with a request the HAR does not contain. */
export type HarNotFound = 'abort' | 'fallback'

export class HarRouter {
  private entries: HarEntry[] = []
  private recorded: HarEntry[] = []
  private used = new Set<number>()

  /**
   * @param harPath - File to read from, or write to when recording
   * @param mode - `replay` serves the file; `record` performs the requests and saves them
   * @param notFound - What to do when replaying a request the HAR lacks
   * @param fetcher - Used to perform requests for real while recording
   */
  constructor(
    private harPath: string,
    private mode: 'replay' | 'record',
    private notFound: HarNotFound,
    private fetcher: ApiRequestContext
  ) {}

  /** Load the HAR from disk, for replay. */
  async load(): Promise<void> {
    if (this.mode === 'record') return
    let raw: string
    try {
      raw = await fs.readFile(this.harPath, 'utf8')
    } catch {
      throw new Error(
        `routeFromHAR: cannot read ${this.harPath}. Record one first with ` +
          `routeFromHAR(path, { update: true }).`
      )
    }
    let parsed: HarFile
    try {
      parsed = JSON.parse(raw) as HarFile
    } catch (err) {
      throw new Error(`routeFromHAR: ${this.harPath} is not valid JSON: ${(err as Error).message}`)
    }
    this.entries = parsed.log?.entries ?? []
    if (this.entries.length === 0) {
      throw new Error(
        `routeFromHAR: ${this.harPath} contains no entries, so every request would fail. ` +
          `Re-record it.`
      )
    }
  }

  /**
   * Handle one intercepted request.
   * @param route - The interception
   * @param request - What the page asked for
   */
  async handle(route: Route, request: Request): Promise<void> {
    if (this.mode === 'record') return this.recordAndServe(route, request)
    return this.replay(route, request)
  }

  /**
   * Perform the request for real, serve it, and remember it.
   * @param route - The interception
   * @param request - What the page asked for
   */
  private async recordAndServe(route: Route, request: Request): Promise<void> {
    const method = request.method()
    const url = request.url()
    try {
      const postData = request.postData()
      const response = await this.fetcher.fetch(method, url, {
        headers: request.headers(),
        // `body` sends the bytes as-is; `data` would JSON-encode them and change the request
        body: postData ?? undefined,
      })
      const body = await response.text()
      const headers = response.headers ?? {}
      this.recorded.push({
        request: { method, url },
        response: {
          status: response.status,
          headers: Object.entries(headers).map(([name, value]) => ({ name, value: String(value) })),
          content: { text: body, mimeType: headers['content-type'] ?? 'text/plain' },
        },
      })
      await route.fulfill({ status: response.status, headers, body })
    } catch (err) {
      // A request that could not be performed is recorded as nothing and allowed through, so
      // recording never changes whether the page works.
      await route.continue().catch(() => undefined)
      void err
    }
  }

  /**
   * Serve a recorded response, or refuse.
   * @param route - The interception
   * @param request - What the page asked for
   */
  private async replay(route: Route, request: Request): Promise<void> {
    const index = this.findEntry(request.method(), request.url())
    if (index === -1) {
      if (this.notFound === 'fallback') {
        await route.continue()
        return
      }
      // Aborting is the honest failure. Reaching the network here would make the run look
      // reproducible while one request silently varied.
      // no argument: the protocol's error reason is `Failed`, capitalised, and an invalid
      // value makes the abort itself throw
      await route.abort()
      return
    }
    this.used.add(index)
    const entry = this.entries[index]
    const headers: Record<string, string> = {}
    for (const h of entry.response.headers ?? []) headers[h.name] = h.value
    const content = entry.response.content ?? { text: '', mimeType: 'text/plain' }
    const body =
      content.encoding === 'base64' ? Buffer.from(content.text, 'base64') : (content.text ?? '')
    await route.fulfill({ status: entry.response.status, headers, body })
  }

  /**
   * Find a recorded exchange for this request.
   *
   * Exact method and URL first; then URL ignoring the query, because a cache-busting
   * parameter would otherwise miss every time and make a valid HAR look empty.
   * @param method - HTTP method
   * @param url - Requested URL
   * @returns Index into the entries, or -1
   */
  private findEntry(method: string, url: string): number {
    const exact = this.entries.findIndex(
      (e) => e.request.method === method && e.request.url === url
    )
    if (exact !== -1) return exact
    const bare = url.split('?')[0]
    return this.entries.findIndex(
      (e) => e.request.method === method && e.request.url.split('?')[0] === bare
    )
  }

  /** Write the recording to disk. Does nothing when replaying. */
  async save(): Promise<string | null> {
    if (this.mode !== 'record') return null
    const har: HarFile = {
      log: {
        version: '1.2',
        creator: { name: 'ScreenVision', version: '1' },
        entries: this.recorded,
      },
    }
    const resolved = path.resolve(this.harPath)
    await fs.mkdir(path.dirname(resolved), { recursive: true }).catch(() => undefined)
    await fs.writeFile(resolved, JSON.stringify(har, null, 2), 'utf8')
    return resolved
  }

  /**
   * Entries the replay never used.
   *
   * Worth surfacing: a HAR full of unused entries usually means the matcher is missing, not
   * that the page stopped making the requests.
   * @returns URLs that were never served
   */
  unusedEntries(): string[] {
    return this.entries.filter((_, i) => !this.used.has(i)).map((e) => e.request.url)
  }
}
