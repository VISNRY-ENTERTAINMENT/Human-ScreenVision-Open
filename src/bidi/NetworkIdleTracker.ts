/**
 * Real network-idle for the BiDi (Firefox) path.
 *
 * BiDi has no `networkidle` readiness state, so the first cut degraded it to `complete` — a
 * page that kept polling in the background satisfied the wait where Chromium would still be
 * waiting. That was an honestly-documented gap, and this closes it: BiDi *does* emit network
 * events (`network.beforeRequestSent`, `network.responseCompleted`, `network.fetchError`), so
 * in-flight requests can be counted and "idle" defined exactly as Chromium defines it — the
 * in-flight count staying at or below a threshold for a quiet window.
 *
 * The counting logic is deliberately separated from the BiDi wiring so it can be tested without
 * a browser: feed it `requestStarted`/`requestFinished` and drive the clock. The FirefoxDriver
 * connects real events to those two calls.
 */

/** Options for what counts as idle. */
export interface NetworkIdleOptions {
  /** In-flight requests at or below this count is "idle". 0 = networkidle, 2 = networkidle2. */
  maxInflight?: number
  /** How long the count must stay idle before resolving, in ms. */
  idleMs?: number
  /** Give up and reject after this long, in ms. */
  timeoutMs?: number
}

const DEFAULTS = { maxInflight: 0, idleMs: 500, timeoutMs: 30_000 }

/**
 * Counts in-flight requests and resolves when the network has been quiet long enough.
 *
 * A request id may legitimately be reported finished more than once (a `responseCompleted`
 * after a redirect chain, say), and a finish may arrive for an id never seen started if the
 * tracker attached mid-flight; both are handled by treating the in-flight set as a set, so a
 * spurious delete is a no-op and the count never goes negative.
 */
export class NetworkIdleTracker {
  private readonly inflight = new Set<string>()
  private readonly opts: Required<NetworkIdleOptions>
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private timeoutTimer: ReturnType<typeof setTimeout> | null = null
  private resolve: (() => void) | null = null
  private reject: ((e: Error) => void) | null = null
  private settled = false

  constructor(options: NetworkIdleOptions = {}) {
    this.opts = { ...DEFAULTS, ...options }
  }

  /** Current number of in-flight requests. */
  get count(): number {
    return this.inflight.size
  }

  /**
   * Record that a request has begun.
   * @param requestId - The BiDi request id (`params.request.request`).
   */
  requestStarted(requestId: string): void {
    this.inflight.add(requestId)
    this.reassess()
  }

  /**
   * Record that a request has ended (completed or errored).
   * @param requestId - The BiDi request id.
   */
  requestFinished(requestId: string): void {
    this.inflight.delete(requestId)
    this.reassess()
  }

  /**
   * Resolve once the in-flight count has stayed idle for the quiet window.
   *
   * If the network is already idle when called, the quiet window starts immediately. The
   * returned promise rejects if the overall timeout elapses first, naming how many requests
   * were still outstanding — a far more useful failure than a bare timeout.
   * @returns A promise that resolves on idle and rejects on timeout.
   */
  whenIdle(): Promise<void> {
    if (this.resolve || this.reject) {
      return Promise.reject(new Error('NetworkIdleTracker.whenIdle: already waiting'))
    }
    return new Promise<void>((resolve, reject) => {
      this.settled = false
      this.resolve = resolve
      this.reject = reject
      this.timeoutTimer = setTimeout(() => {
        this.settle(() =>
          reject(
            new Error(
              `network did not go idle within ${this.opts.timeoutMs}ms; ` +
                `${this.inflight.size} request(s) still in flight`
            )
          )
        )
      }, this.opts.timeoutMs)
      this.reassess()
    })
  }

  /** Stop all timers. Call when abandoning a wait so nothing fires later. */
  dispose(): void {
    this.clearIdleTimer()
    if (this.timeoutTimer) {
      clearTimeout(this.timeoutTimer)
      this.timeoutTimer = null
    }
    this.resolve = null
    this.reject = null
  }

  /** React to a count change: arm the quiet-window timer when idle, cancel it when not. */
  private reassess(): void {
    if (!this.resolve || this.settled) return
    if (this.inflight.size <= this.opts.maxInflight) {
      if (!this.idleTimer) {
        this.idleTimer = setTimeout(() => {
          const done = this.resolve
          this.settle(() => done && done())
        }, this.opts.idleMs)
      }
    } else {
      this.clearIdleTimer()
    }
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
  }

  private settle(finish: () => void): void {
    if (this.settled) return
    this.settled = true
    this.clearIdleTimer()
    if (this.timeoutTimer) {
      clearTimeout(this.timeoutTimer)
      this.timeoutTimer = null
    }
    this.resolve = null
    this.reject = null
    finish()
  }
}
