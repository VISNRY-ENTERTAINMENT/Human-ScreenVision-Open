import fs from 'fs/promises'
import path from 'path'
import type { Page } from '../core/Page'
import type { RecordedStep } from '../core/types'

/**
 * Watches a person use the page and writes the script that reproduces what they did.
 *
 * Codegen exists because the tedious part of a browser test is not the logic, it is naming
 * the elements. Doing the flow by hand and getting a first draft removes that, and the draft
 * is then edited like any other code.
 *
 * The selector chosen for each step is the one a human would have picked, in the order a
 * human would prefer: a test id, then an accessible name, then an id, then a short structural
 * path. That ordering matters more than the recording itself, because a script full of
 * `div:nth-child(7)` is worse than no script.
 */
export class Recorder {
  private steps: RecordedStep[] = []
  private recording = false
  private listeners: Array<[string, (p: Record<string, unknown>) => void]> = []
  private pollTimer: NodeJS.Timeout | null = null

  /**
   * @param page - Page to record
   */
  constructor(private page: Page) {}

  /**
   * Start recording interactions.
   *
   * The page is instrumented before its own scripts run on any subsequent navigation, so a
   * flow that crosses pages keeps recording.
   */
  async start(): Promise<void> {
    if (this.recording) return
    this.recording = true
    this.steps = []
    await this.page.addInitScript(INSTRUMENT)
    await this.page.evaluate(INSTRUMENT).catch(() => undefined)
    this.steps.push({ kind: 'goto', selector: '', value: this.page.url(), at: Date.now() })

    // The recorder buffers events in the page; drain them rather than relying on a binding,
    // so a navigation that wipes the buffer costs at most one poll interval.
    this.pollTimer = setInterval(() => {
      void this.drain()
    }, 250)
  }

  /** Whether recording is in progress. */
  get active(): boolean {
    return this.recording
  }

  /** Pull buffered interactions out of the page. */
  private async drain(): Promise<void> {
    if (!this.recording) return
    const raw = await this.page.evaluate<string>(`(() => {
      const buf = window.__svRecord
      if (!buf || !buf.length) return '[]'
      const out = JSON.stringify(buf)
      buf.length = 0
      return out
    })()`).catch(() => '[]')
    let events: RecordedStep[] = []
    try {
      events = JSON.parse(raw) as RecordedStep[]
    } catch {
      return
    }
    for (const event of events) {
      const last = this.steps[this.steps.length - 1]
      // consecutive typing into the same field is one fill, not one per keystroke
      if (last && last.kind === 'fill' && event.kind === 'fill' && last.selector === event.selector) {
        last.value = event.value
        continue
      }
      this.steps.push(event)
    }
    const url = this.page.url()
    const lastNav = [...this.steps].reverse().find((s) => s.kind === 'goto')
    if (!lastNav || lastNav.value !== url) {
      this.steps.push({ kind: 'goto', selector: '', value: url, at: Date.now() })
    }
  }

  /**
   * Stop recording.
   * @returns The recorded steps
   */
  async stop(): Promise<RecordedStep[]> {
    if (!this.recording) throw new Error('Recorder.stop: nothing is being recorded')
    await this.drain()
    this.recording = false
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.pollTimer = null
    for (const [event, handler] of this.listeners) this.page.off(event, handler)
    this.listeners = []
    return [...this.steps]
  }

  /** The steps recorded so far. */
  recorded(): RecordedStep[] {
    return [...this.steps]
  }

  /**
   * Write the recording out as a runnable test file.
   * @param filePath - Where to write it
   * @param options - Test name
   * @returns The path written
   */
  async writeTest(filePath: string, options?: { name?: string }): Promise<string> {
    const target = path.resolve(filePath)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, generateTest(this.recorded(), options?.name ?? 'recorded flow'), 'utf8')
    return target
  }
}

/**
 * Turn recorded steps into a test file.
 * @param steps - Recorded steps
 * @param name - Test name
 * @returns TypeScript source
 */
export function generateTest(steps: RecordedStep[], name: string): string {
  const lines: string[] = []
  for (const step of steps) {
    const sel = quote(step.selector)
    switch (step.kind) {
      case 'goto':
        lines.push(`  await page.goto(${quote(step.value)})`)
        break
      case 'click':
        // act() rather than click(): the recorded script then reports if a step stops working
        lines.push(`  await page.act({ do: 'click', selector: ${sel} })`)
        break
      case 'fill':
        lines.push(`  await page.act({ do: 'fill', selector: ${sel}, value: ${quote(step.value)} })`)
        break
      case 'check':
        lines.push(`  await page.act({ do: '${step.value === 'true' ? 'check' : 'uncheck'}', selector: ${sel} })`)
        break
      case 'select':
        lines.push(`  await page.act({ do: 'select', selector: ${sel}, value: ${quote(step.value)} })`)
        break
      case 'press':
        lines.push(`  await page.act({ do: 'press', selector: ${sel}, value: ${quote(step.value)} })`)
        break
      case 'assert':
        lines.push(`  await page.expect(${quote(step.selector)}).toHaveText(${quote(step.value)})`)
        break
    }
  }
  if (lines.length === 0) lines.push('  // nothing was recorded')

  return `import { describe, it } from 'screenvision'

/**
 * Recorded with \`screenvision codegen\`. Edit freely: the recording is a first draft, and
 * the assertions in particular are worth reviewing before this is trusted in CI.
 */
describe('recorded', () => {
  it(${quote(name)}, async (page) => {
${lines.join('\n')}
  })
})
`
}

/**
 * The in-page recorder.
 *
 * Listens in the capture phase so it sees the interaction even when the application stops
 * propagation, and buffers into an array the driver drains. Selector choice is the whole
 * value here: a recording full of positional selectors is not worth having.
 */
const INSTRUMENT = `(() => {
  if (window.__svRecord) return true
  window.__svRecord = []
  const buf = window.__svRecord

  const selectorFor = (el) => {
    if (!el || el.nodeType !== 1) return 'body'
    const testid = el.getAttribute('data-testid')
    if (testid) return '[data-testid="' + testid + '"]'
    const label = el.getAttribute('aria-label')
    if (label) return el.tagName.toLowerCase() + '[aria-label="' + label + '"]'
    if (el.id && !/^[0-9]/.test(el.id)) return '#' + el.id
    const name = el.getAttribute('name')
    if (name) return el.tagName.toLowerCase() + '[name="' + name + '"]'
    // a short structural path, kept shallow so it survives ordinary markup edits
    const parts = []
    let node = el
    for (let depth = 0; node && node.nodeType === 1 && depth < 4; depth++) {
      let part = node.tagName.toLowerCase()
      if (node.id && !/^[0-9]/.test(node.id)) { parts.unshift('#' + node.id); break }
      const parent = node.parentElement
      if (parent) {
        const sibs = Array.prototype.filter.call(parent.children, (c) => c.tagName === node.tagName)
        if (sibs.length > 1) part += ':nth-of-type(' + (sibs.indexOf(node) + 1) + ')'
      }
      parts.unshift(part)
      node = node.parentElement
      if (node && (node.tagName === 'BODY' || node.tagName === 'HTML')) break
    }
    return parts.join(' > ')
  }

  const push = (kind, el, value) => {
    buf.push({ kind: kind, selector: selectorFor(el), value: value == null ? '' : String(value), at: Date.now() })
    if (buf.length > 500) buf.shift()
  }

  document.addEventListener('click', (e) => {
    const el = e.target.closest('a, button, [role="button"], input[type="submit"], input[type="button"], label, summary')
    if (el) push('click', el)
  }, true)

  document.addEventListener('input', (e) => {
    const el = e.target
    if (!el || !el.tagName) return
    if (el.type === 'checkbox' || el.type === 'radio') return
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') push('fill', el, el.value)
  }, true)

  document.addEventListener('change', (e) => {
    const el = e.target
    if (!el || !el.tagName) return
    if (el.type === 'checkbox' || el.type === 'radio') push('check', el, String(el.checked))
    else if (el.tagName === 'SELECT') push('select', el, el.value)
  }, true)

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === 'Escape' || e.key === 'Tab') push('press', e.target, e.key)
  }, true)

  return true
})()`

/**
 * Quote a string for generated source, choosing the quote that avoids escaping.
 *
 * CSS selectors are full of double quotes, and `[data-testid=\"x\"]` in the generated file
 * is technically correct and horrible to read. Generated code is read by people.
 * @param value - The string to quote
 * @returns A quoted literal
 */
function quote(value: string): string {
  // a selector is usually full of double quotes, so single-quoting it avoids a wall of
  // backslashes in code a person has to read
  if (value.includes('"') && !value.includes("'") && !/[\\\n\r]/.test(value)) {
    return `'${value}'`
  }
  return JSON.stringify(value)
}
