import type { Page } from '../core/Page'
import type { MutationSummary } from '../core/types'

/**
 * Records what a page actually did, by watching it change rather than by re-reading it.
 *
 * The naive way to prove an action had an effect is to snapshot the page before and after
 * and diff the two. That costs a full page read per action, and on a large page most of
 * what it reads is unchanged. Watching mutations instead costs in proportion to what
 * changed, not to how big the page is: an action that did nothing produces an empty record.
 *
 * The recorder lives in the page, so a navigation destroys it. That is not a problem, since
 * a navigation is itself the strongest possible evidence that the action did something.
 */
export class EffectRecorder {
  /**
   * @param page - Page to record
   */
  constructor(private page: Page) {}

  /**
   * Begin recording DOM mutations.
   * @returns Resolves once the observer is installed
   */
  async start(): Promise<void> {
    await this.page.evaluate(INSTALL).catch(() => undefined)
  }

  /**
   * Stop recording and return a compact summary of what changed.
   * @returns The summary; an empty one when nothing changed or the recorder was lost
   */
  async collect(): Promise<MutationSummary> {
    const empty: MutationSummary = {
      total: 0,
      nodesAdded: [],
      nodesRemoved: [],
      textChanges: [],
      attributeChanges: [],
      navigated: false,
    }
    try {
      const raw = await this.page.evaluate<string>(COLLECT)
      if (!raw) return empty
      const parsed = JSON.parse(raw) as MutationSummary
      return { ...empty, ...parsed }
    } catch {
      // the recorder is gone, which in practice means the document was replaced
      return { ...empty, navigated: true }
    }
  }
}

/** Installs a mutation observer that buffers a bounded, already-summarised record. */
const INSTALL = `(() => {
  if (window.__svEffects && window.__svEffects.observer) {
    window.__svEffects.observer.disconnect()
  }
  const state = {
    total: 0,
    nodesAdded: [],
    nodesRemoved: [],
    textChanges: [],
    attributeChanges: [],
    observer: null
  }
  const LIMIT = 25
  const describe = (node) => {
    if (!node || node.nodeType !== 1) return null
    const tag = node.tagName.toLowerCase()
    const label = node.getAttribute('aria-label') || (node.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60)
    const role = node.getAttribute('role') || tag
    return { tag: tag, role: role, name: label }
  }
  const observer = new MutationObserver((records) => {
    for (const r of records) {
      state.total++
      if (r.type === 'childList') {
        for (const n of r.addedNodes) {
          if (state.nodesAdded.length >= LIMIT) break
          const d = describe(n)
          if (d) state.nodesAdded.push(d)
          else if (n.nodeType === 3 && (n.textContent || '').trim()) {
            if (state.textChanges.length < LIMIT) {
              state.textChanges.push({ from: '', to: n.textContent.trim().slice(0, 120) })
            }
          }
        }
        for (const n of r.removedNodes) {
          if (state.nodesRemoved.length >= LIMIT) break
          const d = describe(n)
          if (d) state.nodesRemoved.push(d)
        }
      } else if (r.type === 'characterData') {
        if (state.textChanges.length < LIMIT) {
          const to = (r.target.textContent || '').trim().slice(0, 120)
          const from = (r.oldValue || '').trim().slice(0, 120)
          if (from !== to) state.textChanges.push({ from: from, to: to })
        }
      } else if (r.type === 'attributes') {
        if (state.attributeChanges.length < LIMIT) {
          const el = r.target
          const name = el.getAttribute && (el.getAttribute('aria-label') || el.id || el.tagName.toLowerCase())
          const to = el.getAttribute ? el.getAttribute(r.attributeName) : null
          if ((r.oldValue || '') !== (to || '')) {
            state.attributeChanges.push({
              target: String(name).slice(0, 40),
              attribute: r.attributeName,
              from: (r.oldValue || '').slice(0, 60),
              to: (to || '').slice(0, 60)
            })
          }
        }
      }
    }
  })
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true,
    attributeOldValue: true,
    characterDataOldValue: true
  })
  state.observer = observer
  window.__svEffects = state
  return true
})()`

/** Reads the buffered record back and stops observing. */
const COLLECT = `(() => {
  const s = window.__svEffects
  if (!s) return ''
  if (s.observer) {
    // flush anything the observer has queued but not yet delivered
    const pending = s.observer.takeRecords()
    if (pending && pending.length) s.total += pending.length
    s.observer.disconnect()
  }
  const out = JSON.stringify({
    total: s.total,
    nodesAdded: s.nodesAdded,
    nodesRemoved: s.nodesRemoved,
    textChanges: s.textChanges,
    attributeChanges: s.attributeChanges,
    navigated: false
  })
  window.__svEffects = null
  return out
})()`
