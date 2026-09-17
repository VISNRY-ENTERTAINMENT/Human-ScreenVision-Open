import type { ElementHandle } from './ElementHandle'
import type { Locator } from './Locator'
import type { Page } from './Page'
import { compareScreenshot, describeComparison, type ScreenshotCompareOptions } from '../capture/VisualCompare'

/** How long an assertion keeps retrying before it gives up. */
const DEFAULT_ASSERT_TIMEOUT = 5000
const ASSERT_POLL_INTERVAL = 100

/** Options accepted by every assertion. */
export interface AssertOptions {
  timeout?: number
}

/**
 * A retrying assertion about a semantically described element.
 *
 * A one-shot assertion on a live page is a race: the element may be a frame away from
 * appearing, or a re-render away from having its final text. Each assertion here re-resolves
 * the description and re-reads the page until it holds or the timeout expires, so a passing
 * assertion means the page reached that state, not that it happened to be in it.
 *
 * On failure the message reports what was expected, what was actually there, and how long
 * it waited.
 */
export class Expectation {
  /**
   * @param page - Page the assertion runs against
   * @param description - Semantic description of the element, e.g. `'login button'`
   * @param negated - Whether this is the `not` form
   */
  constructor(
    private page: Page,
    private subject: string | Locator,
    private negated = false
  ) {}

  /** How the subject reads in an error message. */
  private get description(): string {
    return typeof this.subject === 'string' ? this.subject : this.subject.description
  }

  /**
   * Resolve the subject freshly, however it was specified.
   *
   * Re-resolved on every poll, because the whole point of a retrying assertion is that the
   * page is allowed to change underneath it.
   * @returns The element, or null when nothing matches
   */
  private async resolve(): Promise<ElementHandle | null> {
    if (typeof this.subject === 'string') {
      return this.page.findOrNull(this.subject, { timeout: 250 })
    }
    return this.subject.elementHandle({ timeout: 250 }).catch(() => null)
  }

  /** The same assertions, inverted. */
  get not(): Expectation {
    return new Expectation(this.page, this.subject, !this.negated)
  }

  /**
   * The element exists and is visible.
   * @param options - timeout
   */
  async toBeVisible(options?: AssertOptions): Promise<void> {
    await this.poll(
      'be visible',
      async (el) => (el ? await el.isVisible() : false),
      async (el) => (el === null ? 'no element matched the description' : 'the element is present but not visible'),
      options
    )
  }

  /**
   * The element is present in the page at all.
   * @param options - timeout
   */
  async toExist(options?: AssertOptions): Promise<void> {
    await this.poll('exist', async (el) => el !== null, async () => 'no element matched the description', options)
  }

  /**
   * The element is enabled.
   * @param options - timeout
   */
  async toBeEnabled(options?: AssertOptions): Promise<void> {
    await this.poll(
      'be enabled',
      async (el) => (el ? await el.isEnabled() : false),
      async (el) => (el === null ? 'no element matched the description' : 'the element is disabled'),
      options
    )
  }

  /**
   * The element is checked.
   * @param options - timeout
   */
  async toBeChecked(options?: AssertOptions): Promise<void> {
    await this.poll(
      'be checked',
      async (el) => (el ? await el.isChecked() : false),
      async (el) => (el === null ? 'no element matched the description' : 'the element is not checked'),
      options
    )
  }

  /**
   * The element's text contains the given substring, ignoring whitespace differences.
   * @param expected - Substring to look for
   * @param options - timeout
   */
  async toHaveText(expected: string, options?: AssertOptions): Promise<void> {
    const want = normalise(expected)
    await this.poll(
      `have text containing ${JSON.stringify(expected)}`,
      async (el) => (el ? normalise((await el.textContent()) ?? '').includes(want) : false),
      async (el) =>
        el === null
          ? 'no element matched the description'
          : `its text is ${JSON.stringify(normalise((await el.textContent()) ?? ''))}`,
      options
    )
  }

  /**
   * The element's value equals the given string (inputs, selects, textareas).
   * @param expected - Expected value
   * @param options - timeout
   */
  async toHaveValue(expected: string, options?: AssertOptions): Promise<void> {
    await this.poll(
      `have value ${JSON.stringify(expected)}`,
      async (el) => (el ? (await el.inputValue()) === expected : false),
      async (el) =>
        el === null ? 'no element matched the description' : `its value is ${JSON.stringify(await el.inputValue())}`,
      options
    )
  }

  /**
   * The element has the given attribute, optionally with the given value.
   * @param name - Attribute name
   * @param expected - Expected value; omit to assert presence only
   * @param options - timeout
   */
  async toHaveAttribute(name: string, expected?: string, options?: AssertOptions): Promise<void> {
    await this.poll(
      expected === undefined ? `have attribute ${name}` : `have ${name}=${JSON.stringify(expected)}`,
      async (el) => {
        if (!el) return false
        const actual = await el.getAttribute(name)
        return expected === undefined ? actual !== null : actual === expected
      },
      async (el) =>
        el === null
          ? 'no element matched the description'
          : `its ${name} is ${JSON.stringify(await el.getAttribute(name))}`,
      options
    )
  }

  /**
   * The element is present but not visible, or absent entirely.
   * @param options - timeout
   */
  async toBeHidden(options?: AssertOptions): Promise<void> {
    await this.poll(
      'be hidden',
      async (el) => (el === null ? true : !(await el.isVisible())),
      async () => 'it is visible',
      options
    )
  }

  /**
   * The element is disabled.
   * @param options - timeout
   */
  async toBeDisabled(options?: AssertOptions): Promise<void> {
    await this.poll(
      'be disabled',
      async (el) => (el ? !(await el.isEnabled()) : false),
      async (el) => (el === null ? 'no element matched the description' : 'it is enabled'),
      options
    )
  }

  /**
   * The element has focus.
   * @param options - timeout
   */
  async toBeFocused(options?: AssertOptions): Promise<void> {
    await this.poll(
      'be focused',
      async (el) => (el ? el.evaluate((node: Element) => document.activeElement === node) : false),
      async (el) =>
        el === null
          ? 'no element matched the description'
          : `focus is on ${await this.page
              .evaluate<string>(`document.activeElement ? document.activeElement.tagName.toLowerCase() : 'nothing'`)
              .catch(() => 'something else')}`,
      options
    )
  }

  /**
   * The element has no text and no element children.
   * @param options - timeout
   */
  async toBeEmpty(options?: AssertOptions): Promise<void> {
    await this.poll(
      'be empty',
      async (el) =>
        el
          ? el.evaluate((node: Element) => (node.textContent ?? '').trim() === '' && node.children.length === 0)
          : false,
      async (el) =>
        el === null ? 'no element matched the description' : `it contains ${JSON.stringify(await el.textContent())}`,
      options
    )
  }

  /**
   * The element can be edited: an enabled input, textarea, select or contenteditable.
   * @param options - timeout
   */
  async toBeEditable(options?: AssertOptions): Promise<void> {
    await this.poll(
      'be editable',
      async (el) =>
        el
          ? el.evaluate((node: Element) => {
              const e = node as HTMLElement & { disabled?: boolean; readOnly?: boolean }
              const tag = e.tagName.toLowerCase()
              const editable = tag === 'input' || tag === 'textarea' || tag === 'select' || e.isContentEditable
              return editable && !e.disabled && !e.readOnly
            })
          : false,
      async (el) => (el === null ? 'no element matched the description' : 'it is not editable'),
      options
    )
  }

  /**
   * The element's text is exactly this, ignoring surrounding whitespace.
   *
   * Distinct from {@link toHaveText}, which is a containment check.
   * @param expected - The whole expected text
   * @param options - timeout
   */
  async toHaveExactText(expected: string, options?: AssertOptions): Promise<void> {
    const want = expected.replace(/\s+/g, ' ').trim()
    await this.poll(
      `have exactly the text ${JSON.stringify(expected)}`,
      async (el) => (el ? ((await el.textContent()) ?? '').replace(/\s+/g, ' ').trim() === want : false),
      async (el) =>
        el === null
          ? 'no element matched the description'
          : `its text is ${JSON.stringify(((await el.textContent()) ?? '').replace(/\s+/g, ' ').trim())}`,
      options
    )
  }

  /**
   * The element carries this class.
   * @param expected - Class name
   * @param options - timeout
   */
  async toHaveClass(expected: string, options?: AssertOptions): Promise<void> {
    const has = async (el: ElementHandle): Promise<boolean> =>
      this.page
        .mapperRef()
        .callFunctionOn<boolean>(el.nodeId, `function(name) { return this.classList.contains(name) }`, [expected])
        .catch(() => false)
    await this.poll(
      `have the class ${JSON.stringify(expected)}`,
      async (el) => (el ? has(el) : false),
      async (el) =>
        el === null ? 'no element matched the description' : `its classes are ${await el.getAttribute('class')}`,
      options
    )
  }

  /**
   * A computed CSS property has this value.
   *
   * The property name is passed as an argument rather than captured, because a function
   * serialised into the page loses its closure and would otherwise read `undefined`.
   * @param property - CSS property name, e.g. `'display'`
   * @param expected - Expected computed value
   * @param options - timeout
   */
  async toHaveCSS(property: string, expected: string, options?: AssertOptions): Promise<void> {
    const read = async (el: ElementHandle): Promise<string> =>
      this.page
        .mapperRef()
        .callFunctionOn<string>(
          el.nodeId,
          `function(prop) { return window.getComputedStyle(this).getPropertyValue(prop) }`,
          [property]
        )
        .catch(() => '')
    await this.poll(
      `have ${property} of ${JSON.stringify(expected)}`,
      async (el) => (el ? (await read(el)).trim() === expected : false),
      async (el) =>
        el === null ? 'no element matched the description' : `${property} is ${JSON.stringify((await read(el)).trim())}`,
      options
    )
  }

  /**
   * The subject matches this many elements. Only meaningful for a locator.
   * @param expected - Expected count
   * @param options - timeout
   */
  async toHaveCount(expected: number, options?: AssertOptions): Promise<void> {
    if (typeof this.subject === 'string') {
      throw new Error('toHaveCount needs a locator: page.expect(page.getByRole("row")).toHaveCount(3)')
    }
    const locator = this.subject
    const timeout = options?.timeout ?? 5000
    const deadline = Date.now() + timeout
    let actual = -1
    for (;;) {
      actual = await locator.count().catch(() => -1)
      if ((actual === expected) !== this.negated) return
      if (Date.now() >= deadline) break
      await new Promise((r) => setTimeout(r, 100))
    }
    throw new Error(
      `expected ${JSON.stringify(this.description)} to ${this.negated ? 'not ' : ''}match ${expected} ` +
        `element${expected === 1 ? '' : 's'} after waiting ${timeout}ms, but it matched ${actual}`
    )
  }

  /** The element is attached to the DOM (present), visible or not. Playwright parity: toBeAttached. */
  async toBeAttached(options?: AssertOptions): Promise<void> {
    await this.poll('be attached to the DOM', async (el) => el !== null, async () => 'no element matched the description', options)
  }

  /** The element's text contains the substring (whitespace-normalised). Alias of the containment
   * form, under Playwright's name so agents can use either. */
  async toContainText(expected: string, options?: AssertOptions): Promise<void> {
    await this.toHaveText(expected, options)
  }

  /** The element intersects the viewport rectangle. */
  async toBeInViewport(options?: AssertOptions): Promise<void> {
    await this.poll(
      'be in the viewport',
      async (el) =>
        el
          ? el.evaluate((node: Element) => {
              const r = node.getBoundingClientRect()
              const vw = window.innerWidth || document.documentElement.clientWidth
              const vh = window.innerHeight || document.documentElement.clientHeight
              return r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw
            })
          : false,
      async (el) => (el === null ? 'no element matched the description' : 'it is outside the viewport'),
      options
    )
  }

  /** A JS property on the element equals the expected value (deep-equal by JSON). */
  async toHaveJSProperty(name: string, expected: unknown, options?: AssertOptions): Promise<void> {
    const read = async (el: ElementHandle): Promise<unknown> =>
      this.page
        .mapperRef()
        .callFunctionOn<unknown>(el.nodeId, `function(n) { return this[n] }`, [name])
        .catch(() => undefined)
    await this.poll(
      `have JS property ${name} = ${JSON.stringify(expected)}`,
      async (el) => (el ? JSON.stringify(await read(el)) === JSON.stringify(expected) : false),
      async (el) => (el === null ? 'no element matched the description' : `its ${name} is ${JSON.stringify(await read(el))}`),
      options
    )
  }

  /** A multi-select's selected option values equal this array, in order. */
  async toHaveValues(expected: string[], options?: AssertOptions): Promise<void> {
    const read = async (el: ElementHandle): Promise<string[]> =>
      el.evaluate((node: Element) => Array.from((node as HTMLSelectElement).selectedOptions ?? []).map((o) => o.value))
    await this.poll(
      `have selected values ${JSON.stringify(expected)}`,
      async (el) => (el ? JSON.stringify(await read(el)) === JSON.stringify(expected) : false),
      async (el) => (el === null ? 'no element matched the description' : `its selected values are ${JSON.stringify(await read(el))}`),
      options
    )
  }

  /** The element's ARIA role (explicit `role`, else the implicit role for its tag). */
  async toHaveRole(expected: string, options?: AssertOptions): Promise<void> {
    // Mirrors Locator.svRoleOf exactly so getByRole and toHaveRole never disagree on the same element.
    const read = async (el: ElementHandle): Promise<string> =>
      el.evaluate((node: Element) => {
        const explicit = node.getAttribute('role')
        if (explicit) return explicit.trim().split(/\s+/)[0] ?? ''
        const tag = node.tagName.toLowerCase()
        if (tag === 'a') return (node as HTMLAnchorElement).hasAttribute('href') ? 'link' : 'generic'
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
          const t = ((node as HTMLInputElement).getAttribute('type') || 'text').toLowerCase()
          if (t === 'checkbox') return 'checkbox'
          if (t === 'radio') return 'radio'
          if (t === 'submit' || t === 'button' || t === 'reset') return 'button'
          if (t === 'search') return 'searchbox'
          return 'textbox'
        }
        return 'generic'
      })
    await this.poll(
      `have role ${JSON.stringify(expected)}`,
      async (el) => (el ? (await read(el)) === expected : false),
      async (el) => (el === null ? 'no element matched the description' : `its role is ${JSON.stringify(await read(el))}`),
      options
    )
  }

  /** The element's accessible name (common accname sources, whitespace-normalised). */
  async toHaveAccessibleName(expected: string, options?: AssertOptions): Promise<void> {
    const norm = (s: string): string => s.replace(/\s+/g, ' ').trim()
    const read = async (el: ElementHandle): Promise<string> =>
      el.evaluate((node: Element) => {
        const t = (s: string | null | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim()
        // Accessible-name precedence (WAI-ARIA / Playwright): aria-labelledby wins over aria-label.
        const lb = node.getAttribute('aria-labelledby')
        if (lb) {
          const txt = lb.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ')
          if (t(txt)) return t(txt)
        }
        const al = node.getAttribute('aria-label')
        if (t(al)) return t(al)
        const id = (node as HTMLElement).id
        if (id) {
          const lab = document.querySelector(`label[for="${id.replace(/"/g, '\\"')}"]`)
          if (lab && t(lab.textContent)) return t(lab.textContent)
        }
        const wrap = node.closest('label')
        if (wrap && t(wrap.textContent)) return t(wrap.textContent)
        const tag = node.tagName.toLowerCase()
        if (tag === 'img') return t(node.getAttribute('alt'))
        if (t(node.textContent)) return t(node.textContent)
        return t(node.getAttribute('title') ?? node.getAttribute('placeholder'))
      })
    await this.poll(
      `have accessible name ${JSON.stringify(expected)}`,
      async (el) => (el ? norm(await read(el)) === norm(expected) : false),
      async (el) => (el === null ? 'no element matched the description' : `its accessible name is ${JSON.stringify(await read(el))}`),
      options
    )
  }

  /**
   * The subject's ARIA snapshot contains every line of the expected snapshot (a containment
   * match, tolerant of extra structure). Needs a locator subject, like toHaveCount.
   */
  async toMatchAriaSnapshot(expected: string, options?: AssertOptions): Promise<void> {
    if (typeof this.subject === 'string') {
      throw new Error('toMatchAriaSnapshot needs a locator: page.expect(page.locator("main")).toMatchAriaSnapshot(...)')
    }
    const locator = this.subject
    const want = expected.split('\n').map((l) => l.trim()).filter(Boolean)
    const timeout = options?.timeout ?? DEFAULT_ASSERT_TIMEOUT
    const deadline = Date.now() + timeout
    let actual = ''
    for (;;) {
      actual = await locator.ariaSnapshot().catch(() => '')
      const flat = actual.split('\n').map((l) => l.trim())
      const contained = want.every((w) => flat.some((line) => line.includes(w)))
      if (contained !== this.negated) return
      if (Date.now() >= deadline) break
      await new Promise((r) => setTimeout(r, ASSERT_POLL_INTERVAL))
    }
    throw new Error(
      `expected ${JSON.stringify(this.description)} to ${this.negated ? 'not ' : ''}match the aria snapshot after ${timeout}ms.\nExpected lines:\n${want.join('\n')}\nActual snapshot:\n${actual}`
    )
  }

  /**
   * The element looks like its stored baseline.
   *
   * Visual comparison catches what assertions cannot express: a collapsed layout, a font that
   * failed to load, a control that moved behind another. On the first run it writes the
   * baseline and passes; afterwards it compares, and on a mismatch it writes the actual image
   * and a diff with the changed pixels in red, because "images differ" is not actionable.
   * @param name - Baseline name
   * @param options - Baseline directory and tolerances
   * @throws Error naming the proportion that changed and where the images were written
   */
  async toHaveScreenshot(name: string, options?: ScreenshotCompareOptions & AssertOptions): Promise<void> {
    const element = await this.resolve()
    if (element === null) {
      throw new Error(`expected ${JSON.stringify(this.description)} to match a screenshot, but it was not found`)
    }
    const image = await element.screenshot({ type: 'png' })
    const comparison = await compareScreenshot(image, name, options)
    if (comparison.matched !== this.negated) return
    if (this.negated) {
      throw new Error(`expected ${JSON.stringify(this.description)} to differ from ${name}, but it matched`)
    }
    throw new Error(describeComparison(name, comparison))
  }

  /**
   * Re-resolve and re-test until the condition holds, or report why it never did.
   * @param what - Human phrase describing the expectation
   * @param condition - Test applied to the freshly resolved element
   * @param describeActual - Produces the "but" half of the failure message
   * @param options - timeout
   */
  private async poll(
    what: string,
    condition: (el: ElementHandle | null) => Promise<boolean>,
    describeActual: (el: ElementHandle | null) => Promise<string>,
    options?: AssertOptions
  ): Promise<void> {
    const timeout = options?.timeout ?? DEFAULT_ASSERT_TIMEOUT
    const deadline = Date.now() + timeout
    let last: ElementHandle | null = null
    for (;;) {
      // re-resolve every round: on a live page the element may not exist yet, or may have
      // been replaced by a re-render since the previous attempt
      last = await this.resolve()
      let holds = false
      try {
        holds = await condition(last)
      } catch {
        holds = false
      }
      if (holds !== this.negated) return
      if (Date.now() >= deadline) break
      await new Promise((r) => setTimeout(r, ASSERT_POLL_INTERVAL))
    }
    let actual: string
    try {
      actual = await describeActual(last)
    } catch (err) {
      actual = `reading it failed: ${(err as Error).message}`
    }
    const expectation = this.negated ? `should not ${what}` : `should ${what}`
    throw new Error(
      `expected ${JSON.stringify(this.description)} to ${expectation.replace(/^should /, '')} ` +
        `after waiting ${timeout}ms, but ${this.negated ? 'it did' : actual}`
    )
  }
}

/**
 * Collapse whitespace so that markup indentation does not decide whether text matches.
 * @param value - Raw text
 * @returns Normalised text
 */
function normalise(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}
