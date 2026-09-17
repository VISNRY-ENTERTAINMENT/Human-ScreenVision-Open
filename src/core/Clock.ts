import type { Page } from './Page'

/**
 * Control over the page's sense of time.
 *
 * Anything that waits — a session timeout, a polling interval, a "last updated 3 minutes ago"
 * label, a debounce — is otherwise tested by actually waiting, which makes a suite slow and
 * flaky in equal measure. Taking the clock lets a test say "now it is an hour later" and
 * assert what the application does about it.
 *
 * The clock is installed before the page's own scripts run, so code that captures `Date.now`
 * or `setTimeout` at module scope gets the controlled versions too. That is the whole
 * difficulty: installing it after load leaves the application holding the real ones.
 */
export class Clock {
  private installed = false

  /**
   * @param page - Page whose clock to control
   */
  constructor(private page: Page) {}

  /**
   * Take control of time, starting from a given instant.
   *
   * Timers do not fire on their own afterwards: they fire when {@link tick} or
   * {@link runFor} says so, which is what makes the result deterministic.
   * @param options - The instant to start from; defaults to now
   */
  async install(options?: { time?: Date | number | string }): Promise<void> {
    const start = options?.time === undefined ? Date.now() : new Date(options.time).getTime()
    if (Number.isNaN(start)) throw new Error(`clock.install: ${String(options?.time)} is not a valid time`)
    await this.page.addInitScript(installSource(start))
    // also install into the document already loaded, so the call works either side of a goto
    await this.page.evaluate(installSource(start)).catch(() => undefined)
    this.installed = true
  }

  /**
   * Move time forward, firing whatever the application had scheduled.
   * @param ms - Milliseconds to advance, or a duration like `'30s'`, `'5m'`, `'2h'`
   */
  async tick(ms: number | string): Promise<void> {
    this.assertInstalled('tick')
    await this.page.evaluate(`window.__svClock.tick(${duration(ms)})`)
  }

  /**
   * Jump to an instant without firing the timers in between.
   *
   * Use this for "the session expired overnight"; use {@link tick} when the intervals along
   * the way are supposed to run.
   * @param time - The instant to jump to
   */
  async setTime(time: Date | number | string): Promise<void> {
    this.assertInstalled('setTime')
    const target = new Date(time).getTime()
    if (Number.isNaN(target)) throw new Error(`clock.setTime: ${String(time)} is not a valid time`)
    await this.page.evaluate(`window.__svClock.setTime(${target})`)
  }

  /**
   * Advance in small steps, so intervals fire the number of times they really would.
   * @param ms - Total to advance, or a duration string
   * @param options - Step size in ms; default 100
   */
  async runFor(ms: number | string, options?: { stepMs?: number }): Promise<void> {
    this.assertInstalled('runFor')
    await this.page.evaluate(`window.__svClock.runFor(${duration(ms)}, ${options?.stepMs ?? 100})`)
  }

  /** Hand time back to the browser. */
  async uninstall(): Promise<void> {
    if (!this.installed) return
    await this.page.evaluate(`window.__svClock && window.__svClock.uninstall()`).catch(() => undefined)
    this.installed = false
  }

  /** The page's current time, as the page sees it. */
  async now(): Promise<number> {
    this.assertInstalled('now')
    return this.page.evaluate<number>(`window.__svClock.now()`)
  }

  /**
   * Fail clearly when the clock was never installed.
   * @param operation - What was attempted
   */
  private assertInstalled(operation: string): void {
    if (!this.installed) {
      throw new Error(`clock.${operation}: the clock is not installed. Call clock.install() first.`)
    }
  }
}

/**
 * Parse a duration, accepting milliseconds or a short string.
 * @param value - Milliseconds, or `'250ms'`, `'30s'`, `'5m'`, `'2h'`
 * @returns Milliseconds
 */
function duration(value: number | string): number {
  if (typeof value === 'number') return value
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/.exec(value.trim())
  if (!match) throw new Error(`clock: "${value}" is not a duration; use 250, '250ms', '30s', '5m' or '2h'`)
  const amount = Number(match[1])
  const unit = match[2] ?? 'ms'
  return amount * { ms: 1, s: 1000, m: 60000, h: 3600000 }[unit as 'ms' | 's' | 'm' | 'h']
}

/**
 * The in-page clock.
 *
 * Replaces Date, setTimeout, setInterval and their cancels, keeping a queue ordered by due
 * time. Timers only run when the driver advances the clock, which is what makes a test of
 * elapsed time deterministic rather than a race.
 * @param start - Epoch milliseconds to start from
 * @returns JavaScript source installing the clock
 */
function installSource(start: number): string {
  return `(() => {
  if (window.__svClock) { window.__svClock.setTime(${start}); return true }
  const real = {
    Date: window.Date,
    setTimeout: window.setTimeout.bind(window),
    clearTimeout: window.clearTimeout.bind(window),
    setInterval: window.setInterval.bind(window),
    clearInterval: window.clearInterval.bind(window),
    now: Date.now.bind(Date)
  }
  let current = ${start}
  let nextId = 1
  const timers = new Map()

  const NativeDate = real.Date
  class FakeDate extends NativeDate {
    constructor(...args) {
      if (args.length === 0) super(current)
      else super(...args)
    }
    static now() { return current }
  }
  FakeDate.parse = NativeDate.parse
  FakeDate.UTC = NativeDate.UTC

  const fire = (upTo) => {
    for (let guard = 0; guard < 10000; guard++) {
      let soonest = null
      for (const timer of timers.values()) {
        if (timer.due <= upTo && (soonest === null || timer.due < soonest.due)) soonest = timer
      }
      if (!soonest) break
      current = Math.max(current, soonest.due)
      if (soonest.repeat) soonest.due = current + Math.max(1, soonest.delay)
      else timers.delete(soonest.id)
      try { soonest.fn.apply(null, soonest.args) } catch (e) { /* the page's problem, not ours */ }
    }
    current = Math.max(current, upTo)
  }

  window.Date = FakeDate
  window.setTimeout = (fn, delay, ...args) => {
    const id = nextId++
    timers.set(id, { id, fn: typeof fn === 'function' ? fn : () => eval(String(fn)), due: current + (delay || 0), delay: delay || 0, repeat: false, args })
    return id
  }
  window.setInterval = (fn, delay, ...args) => {
    const id = nextId++
    timers.set(id, { id, fn: typeof fn === 'function' ? fn : () => eval(String(fn)), due: current + (delay || 0), delay: delay || 0, repeat: true, args })
    return id
  }
  window.clearTimeout = (id) => { timers.delete(id) }
  window.clearInterval = (id) => { timers.delete(id) }
  if (window.performance) {
    const base = current
    try { Object.defineProperty(window.performance, 'now', { value: () => current - base, configurable: true }) } catch (e) {}
  }

  window.__svClock = {
    now: () => current,
    tick: (ms) => { fire(current + ms) },
    setTime: (t) => { current = t },
    runFor: (total, step) => {
      const target = current + total
      while (current < target) fire(Math.min(current + step, target))
    },
    pending: () => timers.size,
    uninstall: () => {
      window.Date = real.Date
      window.setTimeout = real.setTimeout
      window.clearTimeout = real.clearTimeout
      window.setInterval = real.setInterval
      window.clearInterval = real.clearInterval
      delete window.__svClock
    }
  }
  return true
})()`
}
