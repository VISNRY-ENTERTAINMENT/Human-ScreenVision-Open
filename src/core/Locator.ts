import { ElementHandle } from './ElementHandle'
import type { TreeContext } from './ElementHandle'
import type { Page } from './Page'
import type { ProtocolMapper } from '../cdp/ProtocolMapper'
import type { BoundingBox, ClickOptions, FillOptions, ScreenshotOptions } from './types'
import { DEEP_TRAVERSAL } from '../intelligence/domTraversal'
import { ariaSnapshotSource } from '../intelligence/ariaSnapshot'
import { parseEngineSelector, selectorEngineSource } from './selectorEngines'

/**
 * Anything a locator can resolve against.
 *
 * A locator needs surprisingly little: somewhere to run an expression, the protocol mapper
 * that owns the resulting nodes, and the page those nodes ultimately belong to. Both `Page`
 * and `Frame` supply all three, which is why frames can host locators rather than making do
 * with the thin imperative API they had before — and it matters, because the strictness
 * guarantee lives here. A frame without locators is a frame where ambiguity passes silently.
 *
 * `resolveMapper` is async so that a host can resolve lazily: `page.frameLocator('#shop')`
 * names a frame that need not exist yet, and finds it on use.
 */
export interface LocatorHost {
  evaluate<T>(pageFunction: string): Promise<T>
  resolveMapper(): Promise<ProtocolMapper>
  /**
   * Turn an expression into a nodeId **in this host's own tree**.
   *
   * The host owns this rather than the locator because a same-origin frame shares the page's
   * protocol mapper and is distinguished only by its execution context. Calling the mapper
   * directly would evaluate in the main document and return a node from the wrong tree —
   * which is exactly how an action on an iframe button once clicked its namesake in the page
   * behind it.
   */
  nodeIdForExpression(expression: string): Promise<number | null>
  /**
   * Where this host's elements sit in the top-level viewport.
   *
   * Input is delivered in top-level coordinates while a same-origin frame's elements report
   * boxes relative to the frame. Handing this to the element handle fixes every coordinate
   * action at once -- click, hover, tap and drag -- rather than each one separately, which
   * is how three of the four ended up wrong while the fourth was right.
   */
  nodeOffset(): Promise<{ x: number; y: number }>
  page(): Page
}

/**
 * The host itself could not be resolved -- e.g. a frame locator naming a frame that is not
 * on the page. Distinct from "no element matched" because the remedy is different, and
 * because the locator's retry loop must not swallow it into a generic zero-match message.
 */
export class HostResolutionError extends Error {}

/**
 * Turn a selector into a step, honouring a registered engine prefix.
 *
 * `cy=submit` becomes an engine step when `cy` is registered; `input[type=text]` stays CSS,
 * because a name has to be registered before the split happens at all.
 * @param selector - Raw selector
 * @returns The step to append
 */
export function cssOrEngineStep(selector: string): LocatorStep {
  const parsed = parseEngineSelector(selector)
  return parsed === null
    ? { kind: 'css', selector }
    : { kind: 'engine', engine: parsed.engine, value: parsed.value }
}

/** How many elements a locator matches, with a few described for an error message. */
interface LocatorMatches {
  count: number
  samples: string[]
}

/** One narrowing step in a locator's resolution plan. */
export type LocatorStep =
  | { kind: 'css'; selector: string }
  | { kind: 'engine'; engine: string; value: string }
  | { kind: 'role'; role: string; name?: string; exact?: boolean }
  | { kind: 'text'; text: string; exact?: boolean }
  | { kind: 'label'; text: string; exact?: boolean }
  | { kind: 'placeholder'; text: string }
  | { kind: 'testid'; id: string }
  | { kind: 'title'; text: string }
  | { kind: 'altText'; text: string }
  | { kind: 'filter'; hasText?: string; hasNotText?: string }
  | { kind: 'nth'; index: number }

/**
 * A lazy reference to elements, re-resolved on every use.
 *
 * The difference from an {@link ElementHandle} is when resolution happens. A handle points at
 * an element found earlier, which is fine until the page re-renders and that element is gone.
 * A locator holds a description and resolves it each time it is used, so it survives a
 * re-render by construction rather than by repair.
 *
 * Locators chain, and each link narrows the set. `page.getByRole('row').filter({ hasText:
 * 'Carol' }).getByRole('button', { name: 'Edit' })` reads as the thing you mean and cannot
 * accidentally match a different row, which is exactly the failure a bare CSS selector
 * produces on a table.
 */
export class Locator {
  /**
   * @param host - Page or frame to resolve against
   * @param steps - Narrowing plan, applied in order
   */
  constructor(
    private host: LocatorHost,
    private steps: LocatorStep[]
  ) {}

  /** A readable description, used in error messages. */
  get description(): string {
    return this.steps.map(describeStep).join(' → ')
  }

  // ── chaining ─────────────────────────────────────────────────────────────────

  /**
   * Narrow to descendants matching a CSS selector.
   * @param selector - CSS selector
   * @returns A new locator
   */
  locator(selector: string): Locator {
    return new Locator(this.host, [...this.steps, cssOrEngineStep(selector)])
  }

  /**
   * Narrow to descendants with an ARIA role, optionally by accessible name.
   * @param role - ARIA role, e.g. `'button'`
   * @param options - name and whether it must match exactly
   * @returns A new locator
   */
  getByRole(role: string, options?: { name?: string; exact?: boolean }): Locator {
    return new Locator(this.host, [...this.steps, { kind: 'role', role, ...options }])
  }

  /**
   * Narrow to descendants containing text.
   * @param text - Text to look for
   * @param options - exact match
   * @returns A new locator
   */
  getByText(text: string, options?: { exact?: boolean }): Locator {
    return new Locator(this.host, [...this.steps, { kind: 'text', text, ...options }])
  }

  /**
   * Narrow to a form control by its label.
   * @param text - Label text
   * @param options - exact match
   * @returns A new locator
   */
  getByLabel(text: string, options?: { exact?: boolean }): Locator {
    return new Locator(this.host, [...this.steps, { kind: 'label', text, ...options }])
  }

  /**
   * Narrow to a control by its placeholder.
   * @param text - Placeholder text
   * @returns A new locator
   */
  getByPlaceholder(text: string): Locator {
    return new Locator(this.host, [...this.steps, { kind: 'placeholder', text }])
  }

  /**
   * Narrow to an element by its `data-testid`.
   * @param id - Test id
   * @returns A new locator
   */
  getByTestId(id: string): Locator {
    return new Locator(this.host, [...this.steps, { kind: 'testid', id }])
  }

  /**
   * Narrow to an element by its `title`.
   * @param text - Title text
   * @returns A new locator
   */
  getByTitle(text: string): Locator {
    return new Locator(this.host, [...this.steps, { kind: 'title', text }])
  }

  /**
   * Narrow to an image by its alt text.
   * @param text - Alt text
   * @returns A new locator
   */
  getByAltText(text: string): Locator {
    return new Locator(this.host, [...this.steps, { kind: 'altText', text }])
  }

  /**
   * Keep only the matches that contain, or do not contain, some text.
   * @param options - hasText and hasNotText
   * @returns A new locator
   */
  filter(options: { hasText?: string; hasNotText?: string }): Locator {
    return new Locator(this.host, [...this.steps, { kind: 'filter', ...options }])
  }

  /**
   * Narrow to the nth match, counting from zero.
   * @param index - Index; negative counts from the end
   * @returns A new locator
   */
  nth(index: number): Locator {
    return new Locator(this.host, [...this.steps, { kind: 'nth', index }])
  }

  /** The first match. */
  first(): Locator {
    return this.nth(0)
  }

  /** The last match. */
  last(): Locator {
    return this.nth(-1)
  }

  // ── reading ──────────────────────────────────────────────────────────────────

  /**
   * How many elements this locator currently matches.
   * @returns The count
   */
  async count(): Promise<number> {
    return this.host.evaluate<number>(`(() => {${DEEP_TRAVERSAL}
${resolverSource(this.steps)}
  return svResolve().length
})()`)
  }

  /**
   * Resolve to a handle, waiting for the element to appear.
   * @param options - timeout in ms
   * @returns The element
   * @throws Error describing the locator and how many elements it matched
   */
  async elementHandle(options?: { timeout?: number }): Promise<ElementHandle> {
    const timeout = options?.timeout ?? 10000
    const deadline = Date.now() + timeout
    let matches: LocatorMatches = { count: 0, samples: [] }

    for (;;) {
      matches = await this.describeMatches().catch((err) => {
        if (err instanceof HostResolutionError) throw err
        return { count: 0, samples: [] }
      })

      if (matches.count > 1 && !this.isDisambiguated) {
        // Strict by default. Acting on the first of several is how a test about the billing
        // address quietly edits the shipping one.
        throw new Error(
          `locator ${JSON.stringify(this.description)} matched ${matches.count} elements, and ` +
            `acting on one of them would be a guess. Narrow it with filter(), nth(), first() or ` +
            `last(). The matches are: ${matches.samples.map((s) => `\n  - ${s}`).join('')}`
        )
      }

      if (matches.count === 1) {
        const mapper = await this.host.resolveMapper()
        const nodeId = await this.host
          .nodeIdForExpression(
            `(() => {${DEEP_TRAVERSAL}
${resolverSource(this.steps)}
  const all = svResolve()
  return all.length ? all[0] : null
})()`
          )
          .catch(() => null)
        if (nodeId !== null)
          return new ElementHandle(mapper, nodeId, this.description, this.host.page(), this.treeContext())
      }

      if (Date.now() >= deadline) break
      await new Promise((r) => setTimeout(r, 100))
    }

    throw new Error(
      `locator ${JSON.stringify(this.description)} matched ${matches.count} elements after ${timeout}ms. ` +
        (matches.count === 0 ? 'Nothing on the page matches it.' : 'Narrow it with filter() or nth().')
    )
  }

  /**
   * The accessibility tree beneath this element, as text.
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
    // Root the walk at this locator's element rather than the document, so a snapshot of one
    // component is the component and not the whole page. Strictness still applies: an
    // ambiguous locator refuses here exactly as it would before an action.
    const handle = await this.elementHandle()
    const mapper = await this.host.resolveMapper()
    const source = ariaSnapshotSource(
      options?.includeHidden ?? false,
      options?.markInert ?? true,
      'this'
    )
    return mapper.callFunctionOn<string>(handle.nodeId, `function() { return ${source} }`)
  }

  /**
   * The host, expressed as the tree its handles belong to.
   * @returns A tree context for handles this locator produces
   */
  private treeContext(): TreeContext {
    const host = this.host
    return {
      offset: () => host.nodeOffset(),
      evaluate: <T,>(expression: string) => host.evaluate<T>(expression),
      querySelector: async (selector: string) =>
        host.nodeIdForExpression(`document.querySelector(${JSON.stringify(selector)})`).catch(() => null),
    }
  }

  /** Whether the plan already picks exactly one match, making strictness moot. */
  private get isDisambiguated(): boolean {
    const last = this.steps[this.steps.length - 1]
    return last !== undefined && last.kind === 'nth'
  }

  /**
   * How many elements match, and a readable description of the first few.
   *
   * The descriptions are what make a strict-mode failure actionable: being told a locator
   * matched three things is annoying, being told which three is useful.
   * @returns Count and samples
   */
  private async describeMatches(): Promise<LocatorMatches> {
    const raw = await this.host.evaluate<string>(`(() => {${DEEP_TRAVERSAL}
${resolverSource(this.steps)}
  const all = svResolve()
  const describe = (el) => {
    const tag = el.tagName.toLowerCase()
    const id = el.id ? '#' + el.id : ''
    const testid = el.getAttribute('data-testid') ? '[data-testid=' + el.getAttribute('data-testid') + ']' : ''
    const text = (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40)
    return tag + id + testid + (text ? ' "' + text + '"' : '')
  }
  return JSON.stringify({ count: all.length, samples: all.slice(0, 5).map(describe) })
})()`)
    return JSON.parse(raw) as LocatorMatches
  }


  /**
   * Every element this locator matches.
   * @returns Handles, possibly empty
   */
  async all(): Promise<ElementHandle[]> {
    const total = await this.count()
    const handles: ElementHandle[] = []
    for (let i = 0; i < total; i++) {
      const mapper = await this.host.resolveMapper()
      const nodeId = await this.host
        .nodeIdForExpression(
          `(() => {${DEEP_TRAVERSAL}
${resolverSource([...this.steps, { kind: 'nth', index: i }])}
  const all = svResolve()
  return all.length ? all[0] : null
})()`
        )
        .catch(() => null)
      if (nodeId !== null) {
        handles.push(
          new ElementHandle(mapper, nodeId, `${this.description}[${i}]`, this.host.page(), this.treeContext())
        )
      }
    }
    return handles
  }

  /**
   * Wait until this locator matches at least one element.
   * @param options - timeout in ms
   */
  async waitFor(options?: { timeout?: number }): Promise<void> {
    await this.elementHandle(options)
  }

  /**
   * Text content of the first match.
   * @returns The text, or null
   */
  async textContent(): Promise<string | null> {
    return (await this.elementHandle()).textContent()
  }

  /**
   * Value of the first match.
   * @returns The value
   */
  async inputValue(): Promise<string> {
    return (await this.elementHandle()).inputValue()
  }

  /**
   * Whether the first match is visible. Returns false rather than throwing when nothing
   * matches, because "is it visible" has a sensible answer for an absent element.
   * @returns true when present and visible
   */
  async isVisible(): Promise<boolean> {
    const handle = await this.elementHandle({ timeout: 1000 }).catch(() => null)
    return handle === null ? false : handle.isVisible()
  }

  /**
   * Whether the first match is enabled.
   * @returns true when enabled
   */
  async isEnabled(): Promise<boolean> {
    return (await this.elementHandle()).isEnabled()
  }

  // ── acting ───────────────────────────────────────────────────────────────────

  /**
   * Click the match, waiting for it to appear and become actionable.
   * @param options - Click options
   */
  /**
   * An attribute of the match.
   * @param name - Attribute name
   * @returns The value, or null when the attribute is absent
   */
  async getAttribute(name: string): Promise<string | null> {
    return (await this.elementHandle()).getAttribute(name)
  }

  async click(options?: ClickOptions): Promise<void> {
    await (await this.elementHandle({ timeout: options?.timeout })).click(options)
  }

  /**
   * Fill the match.
   * @param value - Text to enter
   * @param options - Fill options
   */
  async fill(value: string, options?: FillOptions): Promise<void> {
    await (await this.elementHandle({ timeout: options?.timeout })).fill(value, options)
  }

  /**
   * Check the match.
   */
  async check(): Promise<void> {
    const handle = await this.elementHandle()
    if (!(await handle.isChecked())) await handle.click()
  }

  /**
   * Uncheck the match.
   */
  async uncheck(): Promise<void> {
    const handle = await this.elementHandle()
    if (await handle.isChecked()) await handle.click()
  }

  /**
   * Select an option in the match.
   * @param values - Option value or values
   */
  async selectOption(values: string | string[]): Promise<void> {
    await (await this.elementHandle()).selectOption(values)
  }

  /**
   * Press a key with the match focused.
   * @param key - Key name
   */
  async press(key: string): Promise<void> {
    await (await this.elementHandle()).press(key)
  }

  /** Double-click the matched element. */
  async dblclick(options?: ClickOptions): Promise<void> {
    await (await this.elementHandle({ timeout: options?.timeout })).dblclick(options)
  }

  /** Clear the matched input (fill with the empty string). */
  async clear(options?: FillOptions): Promise<void> {
    await (await this.elementHandle({ timeout: options?.timeout })).clear(options)
  }

  /** Set the file(s) on the matched `<input type=file>`. */
  async setInputFiles(files: string | string[]): Promise<void> {
    await (await this.elementHandle()).setInputFiles(files)
  }

  /** Drag the matched element onto the element matched by `target`. */
  async dragTo(target: Locator, options?: { steps?: number; force?: boolean }): Promise<void> {
    const to = await target.elementHandle()
    await (await this.elementHandle()).dragTo(to, options)
  }

  /** Scroll the matched element into view if it is not already. */
  async scrollIntoViewIfNeeded(): Promise<void> {
    await (await this.elementHandle()).scrollIntoViewIfNeeded()
  }

  /** Bounding box of the matched element in top-level page coordinates, or null if not visible. */
  async boundingBox(): Promise<BoundingBox | null> {
    return (await this.elementHandle()).boundingBox()
  }

  /** Screenshot just the matched element. */
  async screenshot(options?: Omit<ScreenshotOptions, 'fullPage' | 'clip'>): Promise<Buffer> {
    return (await this.elementHandle()).screenshot(options)
  }

  /** innerHTML of the matched element. */
  async innerHTML(): Promise<string> {
    return (await this.elementHandle()).innerHTML()
  }

  /** Whether the matched checkbox/radio is checked. */
  async isChecked(): Promise<boolean> {
    return (await this.elementHandle()).isChecked()
  }

  /** Rendered text (`innerText`) of the matched element. */
  async innerText(): Promise<string> {
    return (await this.elementHandle()).innerText()
  }

  /** Whether the matched element is editable. */
  async isEditable(): Promise<boolean> {
    return (await this.elementHandle()).isEditable()
  }

  /** Select the matched element's text contents. */
  async selectText(): Promise<void> {
    await (await this.elementHandle()).selectText()
  }

  /** Run a function against the matched element in the page and return the JSON-serialisable result. */
  async evaluate<T>(fn: (el: Element) => T): Promise<T> {
    return (await this.elementHandle()).evaluate(fn)
  }

  /**
   * Tap the match.
   * @param options - timeout in ms
   */
  async tap(options?: { timeout?: number }): Promise<void> {
    await (await this.elementHandle(options)).tap(options)
  }

  /** Hover the match. */
  async hover(): Promise<void> {
    await (await this.elementHandle()).hover()
  }
}

/**
 * Describe one step for an error message.
 * @param step - The step
 * @returns A short phrase
 */
function describeStep(step: LocatorStep): string {
  switch (step.kind) {
    case 'css':
      return step.selector
    case 'engine':
      return `${step.engine}=${step.value}`
    case 'role':
      return `role=${step.role}${step.name ? `[name="${step.name}"]` : ''}`
    case 'text':
      return `text="${step.text}"`
    case 'label':
      return `label="${step.text}"`
    case 'placeholder':
      return `placeholder="${step.text}"`
    case 'testid':
      return `testid=${step.id}`
    case 'title':
      return `title="${step.text}"`
    case 'altText':
      return `alt="${step.text}"`
    case 'filter':
      return `filter(${step.hasText ? `hasText="${step.hasText}"` : `hasNotText="${step.hasNotText}"`})`
    case 'nth':
      return `nth(${step.index})`
  }
}

/**
 * Build the browser-side resolver for a plan.
 *
 * Declares `svResolve()`, returning the matching elements in document order. Runs entirely in
 * the page so a chain of five steps still costs one round trip.
 * @param steps - The plan
 * @returns JavaScript source declaring svResolve
 */
function resolverSource(steps: LocatorStep[]): string {
  return `
  ${selectorEngineSource()}
  const svRoleOf = (el) => {
    const explicit = el.getAttribute('role')
    if (explicit) return explicit
    const tag = el.tagName.toLowerCase()
    if (tag === 'a') return el.hasAttribute('href') ? 'link' : 'generic'
    if (tag === 'button') return 'button'
    if (tag === 'select') return 'combobox'
    if (tag === 'textarea') return 'textbox'
    if (tag === 'table') return 'table'
    if (tag === 'tr') return 'row'
    if (tag === 'td') return 'cell'
    if (tag === 'th') return 'columnheader'
    if (tag === 'nav') return 'navigation'
    if (tag === 'header') return 'banner'
    if (tag === 'footer') return 'contentinfo'
    if (tag === 'main') return 'main'
    if (tag === 'form') return 'form'
    if (tag === 'dialog') return 'dialog'
    if (tag === 'img') return 'img'
    if (tag === 'ul' || tag === 'ol') return 'list'
    if (tag === 'li') return 'listitem'
    if (tag === 'article') return 'article'
    if (/^h[1-6]$/.test(tag)) return 'heading'
    if (tag === 'input') {
      const t = (el.getAttribute('type') || 'text').toLowerCase()
      if (t === 'checkbox') return 'checkbox'
      if (t === 'radio') return 'radio'
      if (t === 'submit' || t === 'button' || t === 'reset') return 'button'
      if (t === 'search') return 'searchbox'
      return 'textbox'
    }
    return 'generic'
  }
  const svNameOf = (el) => {
    const aria = el.getAttribute('aria-label')
    if (aria) return aria.trim()
    const tag = el.tagName.toLowerCase()
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      if (el.id) {
        const scope = el.getRootNode ? el.getRootNode() : document
        const lab = scope.querySelector('label[for="' + CSS.escape(el.id) + '"]')
        if (lab && lab.textContent.trim()) return lab.textContent.trim()
      }
      const wrap = el.closest('label')
      if (wrap && wrap.textContent.trim()) return wrap.textContent.trim()
      if (el.getAttribute('placeholder')) return el.getAttribute('placeholder').trim()
      return ''
    }
    if (tag === 'img') return (el.getAttribute('alt') || '').trim()
    return (el.textContent || '').replace(/\\s+/g, ' ').trim()
  }
  const svText = (el) => (el.textContent || '').replace(/\\s+/g, ' ').trim()
  const svMatch = (actual, wanted, exact) =>
    exact ? actual.toLowerCase() === wanted.toLowerCase() : actual.toLowerCase().includes(wanted.toLowerCase())

  const svResolve = () => {
    let current = null
    const steps = ${JSON.stringify(steps)}
    for (const step of steps) {
      const scope = current
      const within = (test) => {
        // A Set, because when the scope contains nested elements every descendant is reached
        // once per matching ancestor, and counting it twice makes count(), nth() and
        // toHaveCount() all quietly wrong.
        const found = new Set()
        if (scope === null) {
          svWalk((node) => { if (test(node)) found.add(node) })
        } else {
          for (const parent of scope) {
            const nodes = parent.querySelectorAll ? parent.querySelectorAll('*') : []
            for (const node of nodes) if (test(node)) found.add(node)
            if (parent.shadowRoot) {
              for (const node of parent.shadowRoot.querySelectorAll('*')) if (test(node)) found.add(node)
            }
          }
        }
        // document order, so nth(0) means the first one on the page rather than the first one
        // some ancestor happened to reach
        return Array.from(found).sort((a, b) => {
          const rel = a.compareDocumentPosition(b)
          if (rel & Node.DOCUMENT_POSITION_FOLLOWING) return -1
          if (rel & Node.DOCUMENT_POSITION_PRECEDING) return 1
          return 0
        })
      }
      if (step.kind === 'css') {
        current = within((n) => { try { return n.matches(step.selector) } catch (e) { return false } })
      } else if (step.kind === 'engine') {
        const fn = svEngines[step.engine]
        if (!fn) {
          current = []
        } else {
          // An engine is whichever shape it turns out to be. A predicate is filtered through
          // the same deep traversal as every built-in step; a query is handed each scope root
          // and returns what it likes, which is the only way to express position or
          // relationship. Detected by what comes back, so neither has to be declared.
          const roots = current === null ? [document.body] : current
          const collected = []
          let isQuery = false
          for (const root of roots) {
            let produced
            try { produced = fn(root, step.value) } catch (e) { produced = false }
            if (produced === true || produced === false || produced === undefined || produced === null) continue
            isQuery = true
            const list = produced.length === undefined ? [produced] : Array.prototype.slice.call(produced)
            for (const el of list) {
              if (el && el.nodeType === 1 && collected.indexOf(el) === -1) collected.push(el)
            }
          }
          if (isQuery) {
            current = collected.sort((a, b) => {
              const rel = a.compareDocumentPosition(b)
              if (rel & Node.DOCUMENT_POSITION_FOLLOWING) return -1
              if (rel & Node.DOCUMENT_POSITION_PRECEDING) return 1
              return 0
            })
          } else {
            current = within((n) => {
              try { return fn(n, step.value) === true } catch (e) { return false }
            })
          }
        }
      } else if (step.kind === 'role') {
        current = within((n) => svRoleOf(n) === step.role &&
          (step.name === undefined || svMatch(svNameOf(n), step.name, step.exact === true)))
      } else if (step.kind === 'text') {
        current = within((n) => svMatch(svText(n), step.text, step.exact === true))
        // prefer the innermost element that matches, the way a person means it
        current = current.filter((n) => !current.some((other) => other !== n && n.contains(other)))
      } else if (step.kind === 'label') {
        current = within((n) => {
          const tag = n.tagName.toLowerCase()
          if (tag !== 'input' && tag !== 'textarea' && tag !== 'select') return false
          return svMatch(svNameOf(n), step.text, step.exact === true)
        })
      } else if (step.kind === 'placeholder') {
        current = within((n) => svMatch(n.getAttribute('placeholder') || '', step.text, false))
      } else if (step.kind === 'testid') {
        current = within((n) => (n.getAttribute('data-testid') || '') === step.id)
      } else if (step.kind === 'title') {
        current = within((n) => svMatch(n.getAttribute('title') || '', step.text, false))
      } else if (step.kind === 'altText') {
        current = within((n) => svMatch(n.getAttribute('alt') || '', step.text, false))
      } else if (step.kind === 'filter') {
        const base = current === null ? [] : current
        current = base.filter((n) => {
          const text = svText(n).toLowerCase()
          if (step.hasText !== undefined && !text.includes(step.hasText.toLowerCase())) return false
          if (step.hasNotText !== undefined && text.includes(step.hasNotText.toLowerCase())) return false
          return true
        })
      } else if (step.kind === 'nth') {
        const base = current === null ? [] : current
        const index = step.index < 0 ? base.length + step.index : step.index
        current = index >= 0 && index < base.length ? [base[index]] : []
      }
    }
    return current === null ? [] : current
  }
`
}
