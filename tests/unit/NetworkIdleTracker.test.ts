import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NetworkIdleTracker } from '../../src/bidi/NetworkIdleTracker'

/**
 * The counting brain behind Firefox's network-idle, tested without a browser.
 *
 * `networkidle` used to degrade to `complete` on the BiDi path, letting a background-polling
 * page through too early. This is the logic that closes that gap: count in-flight requests from
 * BiDi's network events and resolve only after the count has held at the threshold for a quiet
 * window. Fake timers let the quiet window and the timeout be exercised deterministically.
 */
describe('NetworkIdleTracker', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('resolves after the quiet window once requests drain', async () => {
    const t = new NetworkIdleTracker({ idleMs: 500, timeoutMs: 10_000 })
    t.requestStarted('a')
    t.requestStarted('b')
    const p = t.whenIdle()
    let done = false
    p.then(() => (done = true))

    // still two in flight: no quiet window can start
    await vi.advanceTimersByTimeAsync(600)
    expect(done).toBe(false)

    t.requestFinished('a')
    await vi.advanceTimersByTimeAsync(300)
    expect(done).toBe(false) // one still in flight

    t.requestFinished('b')
    // now idle; must wait the full quiet window, not resolve instantly
    await vi.advanceTimersByTimeAsync(499)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await p
    expect(done).toBe(true)
  })

  it('a new request during the quiet window resets it', async () => {
    const t = new NetworkIdleTracker({ idleMs: 500, timeoutMs: 10_000 })
    t.requestStarted('a')
    const p = t.whenIdle()
    let done = false
    p.then(() => (done = true))

    t.requestFinished('a') // idle begins
    await vi.advanceTimersByTimeAsync(400)
    t.requestStarted('b') // interrupts before the window closed
    await vi.advanceTimersByTimeAsync(400)
    expect(done).toBe(false) // the earlier window was cancelled
    t.requestFinished('b')
    await vi.advanceTimersByTimeAsync(500)
    await p
    expect(done).toBe(true)
  })

  it('resolves immediately-ish when already idle at the call', async () => {
    const t = new NetworkIdleTracker({ idleMs: 500, timeoutMs: 10_000 })
    const p = t.whenIdle()
    let done = false
    p.then(() => (done = true))
    await vi.advanceTimersByTimeAsync(500)
    await p
    expect(done).toBe(true)
  })

  it('rejects on timeout naming the outstanding count', async () => {
    const t = new NetworkIdleTracker({ idleMs: 500, timeoutMs: 2_000 })
    t.requestStarted('x')
    t.requestStarted('y')
    const p = t.whenIdle()
    const caught = p.catch((e: Error) => e.message)
    await vi.advanceTimersByTimeAsync(2_000)
    const msg = await caught
    expect(msg).toMatch(/did not go idle within 2000ms/)
    expect(msg).toMatch(/2 request\(s\) still in flight/)
  })

  it('treats a finish for an unknown or repeated id as a no-op', () => {
    const t = new NetworkIdleTracker()
    t.requestFinished('never-started') // must not underflow
    expect(t.count).toBe(0)
    t.requestStarted('a')
    t.requestFinished('a')
    t.requestFinished('a') // repeated finish
    expect(t.count).toBe(0)
  })

  it('supports networkidle2 via a threshold above zero', async () => {
    const t = new NetworkIdleTracker({ maxInflight: 2, idleMs: 300, timeoutMs: 10_000 })
    t.requestStarted('a')
    t.requestStarted('b')
    const p = t.whenIdle()
    let done = false
    p.then(() => (done = true))
    // two in flight is already <= threshold, so the quiet window runs
    await vi.advanceTimersByTimeAsync(300)
    await p
    expect(done).toBe(true)
  })
})
