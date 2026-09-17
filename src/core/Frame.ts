import type { ProtocolMapper } from '../cdp/ProtocolMapper'
import { ElementHandle } from './ElementHandle'
import type { TreeContext } from './ElementHandle'
import { ariaSnapshotSource } from '../intelligence/ariaSnapshot'
import { Locator, cssOrEngineStep } from './Locator'
import type { LocatorHost } from './Locator'
import type { Page } from './Page'
import type { ClickOptions, FillOptions, WaitForSelectorOptions } from './types'

/**
 * One frame of a page: the main document, or the content of an `<iframe>`.
 *
 * Frames are the reason a checkout or an embedded editor is normally unreachable. A
 * same-origin frame shares the page's DOM agent and is addressed by its execution context;
 * a cross-origin frame is a separate browser target with its own protocol session. Both are
 * presented here as the same thing, so calling code never has to know which it has.
 */
export class Frame implements LocatorHost {
  /**
   * @param pageRef - Page this frame belongs to
   * @param frameId - CDP frame id
   * @param url - Current URL of the frame's document
   * @param name - The iframe's `name` attribute, empty when it has none
   * @param mapper - Protocol mapper that owns this frame's DOM: the page's for a same-origin
   *   frame, the frame's own for a cross-origin one
   * @param contextId - Execution context for a same-origin frame; undefined when the frame
   *   has its own session, whose default context is already the right one
   * @param isolated - Whether this frame is a separate browser target (cross-origin)
   */
  constructor(
    private pageRef: Page,
    public readonly frameId: string,
    public readonly url: string,
    public readonly name: string,
    private mapper: ProtocolMapper,
    private contextId: number | undefined,
    public readonly isolated: boolean
  ) {}

  /** The page this frame belongs to. */
  page(): Page {
    return this.pageRef
  }

  /** The protocol mapper that owns this frame's DOM. */
  mapperRef(): ProtocolMapper {
    return this.mapper
  }

  /**
   * Evaluate an expression inside this frame.
   * @param pageFunction - Expression string, or a function serialised with `toString()`
   * @param arg - JSON-serialisable argument passed to the function form
   * @returns The serialisable result
   */
  async evaluate<T>(pageFunction: string | ((arg: unknown) => T), arg?: unknown): Promise<T> {
    const expression =
      typeof pageFunction === 'string'
        ? pageFunction
        : `(${pageFunction.toString()})(${arg === undefined ? '' : JSON.stringify(arg)})`
    return this.mapper.evaluate<T>(expression, this.contextId)
  }

  /**
   * Resolve an affordance the observer collected inside this frame.
   *
   * A same-origin frame shares the page's protocol mapper, so resolving through the mapper
   * alone reads the main document's collected elements and returns the wrong node. The
   * frame's own execution context is what makes this address the right tree.
   * @param index - Index within this frame's collected elements
   * @returns nodeId, or null when the observation is stale
   */
  async nodeIdForObservedRef(index: number): Promise<number | null> {
    return this.mapper
      .nodeIdForExpression(
        `(window.__svRefs && window.__svRefs[${index}] && window.__svRefs[${index}].isConnected) ` +
          `? window.__svRefs[${index}] : null`,
        this.contextId
      )
      .catch(() => null)
  }

  /**
   * Query one element inside this frame.
   * @param selector - CSS selector
   * @returns Handle, or null when nothing matches
   */
  async $(selector: string): Promise<ElementHandle | null> {
    const nodeId = await this.mapper.nodeIdForExpression(
      `document.querySelector(${JSON.stringify(selector)})`,
      this.contextId
    )
    return nodeId === null
      ? null
      : new ElementHandle(this.mapper, nodeId, selector, this.pageRef, this.treeContext())
  }

  /**
   * Query every matching element inside this frame.
   * @param selector - CSS selector
   * @returns Handles, possibly empty
   */
  async $$(selector: string): Promise<ElementHandle[]> {
    const count = await this.evaluate<number>(`document.querySelectorAll(${JSON.stringify(selector)}).length`)
    const handles: ElementHandle[] = []
    for (let i = 0; i < count; i++) {
      const nodeId = await this.mapper.nodeIdForExpression(
        `document.querySelectorAll(${JSON.stringify(selector)})[${i}]`,
        this.contextId
      )
      if (nodeId !== null)
        handles.push(new ElementHandle(this.mapper, nodeId, selector, this.pageRef, this.treeContext()))
    }
    return handles
  }

  /**
   * Wait for an element to appear inside this frame.
   * @param selector - CSS selector
   * @param options - timeout in ms
   * @returns The element once it exists
   * @throws Error when it does not appear in time
   */
  async waitForSelector(selector: string, options?: WaitForSelectorOptions): Promise<ElementHandle> {
    const timeout = options?.timeout ?? 30000
    const deadline = Date.now() + timeout
    for (;;) {
      const found = await this.$(selector).catch(() => null)
      if (found) return found
      if (Date.now() >= deadline) {
        throw new Error(
          `waitForSelector(${JSON.stringify(selector)}) timed out after ${timeout}ms inside frame ${this.describe()}`
        )
      }
      await new Promise((r) => setTimeout(r, 100))
    }
  }

  /**
   * Click an element inside this frame, waiting for it to be actionable.
   * @param selector - CSS selector
   * @param options - Click options
   */
  async click(selector: string, options?: ClickOptions): Promise<void> {
    const el = await this.requireElement(selector, options?.timeout)
    try {
      if (this.isolated) {
        // an out-of-process frame dispatches input through its own session, which already
        // works in the frame's own coordinate space
        await el.click(options)
        return
      }
      // a same-origin frame reports element coordinates relative to itself, but input goes
      // to the main viewport, so the frame's content offset has to be added back
      await this.mapper.scrollIntoView(el.nodeId)
      const point = await this.mapper.waitForActionable(el.nodeId, {
        timeout: options?.timeout,
        position: options?.position,
      })
      const offset = (await this.mapper.frameContentOffset(this.frameId)) ?? { x: 0, y: 0 }
      await this.mapper.mouseClick(point.x + offset.x, point.y + offset.y, options)
    } catch (err) {
      throw new Error(`frame ${this.describe()} click(${JSON.stringify(selector)}) failed: ${(err as Error).message}`)
    }
  }

  /**
   * Click a node already resolved inside this frame.
   *
   * Exists because a caller that resolved the node itself, such as acting on an observed
   * reference, still needs this frame's coordinate offset applied. Dispatching frame-relative
   * coordinates into the main viewport lands the click on whatever happens to be there.
   * @param nodeId - Node inside this frame
   * @param options - Click options
   */
  async clickNode(nodeId: number, options?: ClickOptions): Promise<void> {
    await this.mapper.click(nodeId, options, await this.nodeOffset())
  }

  /**
   * Where this frame's content sits in the top-level viewport.
   *
   * A cross-origin frame has its own session, whose input events are already delivered in its
   * own coordinate space, so it needs no offset. A same-origin frame shares the page's
   * session: its elements report boxes relative to the frame while input is delivered to the
   * page, and the difference is this.
   * @returns The offset, or the origin when none applies
   */
  /**
   * This frame, as the tree an element handle belongs to.
   * @returns A tree context bound to this frame
   */
  treeContext(): TreeContext {
    return {
      offset: () => this.nodeOffset(),
      evaluate: <T,>(expression: string) => this.evaluate<T>(expression),
      // the same resolution path as $(), so a healed handle lands in this frame
      querySelector: (selector: string) =>
        this.mapper
          .nodeIdForExpression(`document.querySelector(${JSON.stringify(selector)})`, this.contextId)
          .catch(() => null),
    }
  }

  async nodeOffset(): Promise<{ x: number; y: number }> {
    if (this.isolated) return { x: 0, y: 0 }
    return (await this.mapper.frameContentOffset(this.frameId)) ?? { x: 0, y: 0 }
  }

  /**
   * Fill an input inside this frame.
   * @param selector - CSS selector
   * @param value - Text to enter
   * @param options - Fill options
   */
  async fill(selector: string, value: string, options?: FillOptions): Promise<void> {
    const el = await this.requireElement(selector, options?.timeout)
    try {
      await el.fill(value, options)
    } catch (err) {
      throw new Error(`frame ${this.describe()} fill(${JSON.stringify(selector)}) failed: ${(err as Error).message}`)
    }
  }

  /**
   * Text content of an element inside this frame.
   * @param selector - CSS selector
   * @returns The text, or null when the element does not exist
   */
  async textContent(selector: string): Promise<string | null> {
    const el = await this.$(selector)
    return el === null ? null : el.textContent()
  }

  // ── locators ─────────────────────────────────────────────────────────────────

  /**
   * The mapper that owns this frame's nodes.
   * @returns This frame's protocol mapper
   */
  async resolveMapper(): Promise<ProtocolMapper> {
    return this.mapper
  }

  /**
   * Resolve an expression to a nodeId inside THIS frame.
   *
   * The execution context is the whole point: a same-origin frame shares the page's mapper,
   * so without it the expression runs against the main document and returns a node from the
   * wrong tree.
   * @param expression - JavaScript expression returning an element or null
   * @returns nodeId, or null when it resolves to nothing
   */
  async nodeIdForExpression(expression: string): Promise<number | null> {
    return this.mapper.nodeIdForExpression(expression, this.contextId)
  }

  /**
   * A locator scoped to this frame.
   *
   * Same semantics as {@link Page.locator}, including strictness: an ambiguous locator
   * refuses rather than picking the first match. Before this existed a frame offered only
   * `click`/`fill`, which pick silently — so the guarantee stopped at the frame boundary.
   * @param selector - CSS selector
   * @returns A locator resolved inside this frame
   */
  locator(selector: string): Locator {
    return new Locator(this, [cssOrEngineStep(selector)])
  }

  /**
   * Find elements in this frame by ARIA role, optionally by accessible name.
   * @param role - ARIA role
   * @param options - Accessible name, and whether to match it exactly
   * @returns A locator
   */
  getByRole(role: string, options?: { name?: string; exact?: boolean }): Locator {
    return new Locator(this, [{ kind: 'role', role, ...options }])
  }

  /**
   * Find elements in this frame by their visible text.
   * @param text - Text to match
   * @param options - Whether to match exactly
   * @returns A locator
   */
  getByText(text: string, options?: { exact?: boolean }): Locator {
    return new Locator(this, [{ kind: 'text', text, ...options }])
  }

  /**
   * Find a form control in this frame by its label.
   * @param text - Label text
   * @param options - Whether to match exactly
   * @returns A locator
   */
  getByLabel(text: string, options?: { exact?: boolean }): Locator {
    return new Locator(this, [{ kind: 'label', text, ...options }])
  }

  /**
   * Find a control in this frame by placeholder text.
   * @param text - Placeholder text
   * @returns A locator
   */
  getByPlaceholder(text: string): Locator {
    return new Locator(this, [{ kind: 'placeholder', text }])
  }

  /**
   * Find an element in this frame by its test id.
   * @param id - Value of the data-testid attribute
   * @returns A locator
   */
  getByTestId(id: string): Locator {
    return new Locator(this, [{ kind: 'testid', id }])
  }

  /**
   * Find an element in this frame by its title attribute.
   * @param text - Title text
   * @returns A locator
   */
  getByTitle(text: string): Locator {
    return new Locator(this, [{ kind: 'title', text }])
  }

  /**
   * Find an image in this frame by its alt text.
   * @param text - Alt text
   * @returns A locator
   */
  getByAltText(text: string): Locator {
    return new Locator(this, [{ kind: 'altText', text }])
  }

  /**
   * Navigate this frame, leaving the rest of the page alone.
   *
   * Setting `src` from the parent would be blocked cross-origin and would race the load;
   * navigating the frame's own document through the protocol does neither.
   * @param url - URL to load in this frame
   * @param options - How long to wait for the load
   */
  async goto(url: string, options?: { timeout?: number }): Promise<void> {
    const timeout = options?.timeout ?? 30000
    const before = this.contextId
    await this.mapper.navigateFrame(this.frameId, url, timeout)

    // A navigated frame gets a NEW execution context and the old one is dead. Keeping the
    // stale id would make every later locator resolve against a context that no longer
    // exists -- the frame would look empty rather than report an error. Cross-origin frames
    // have their own session whose default context is already correct, so they are exempt.
    if (!this.isolated) {
      const deadline = Date.now() + 5000
      for (;;) {
        const fresh = this.pageRef.frameContextId(this.frameId)
        if (fresh !== undefined && fresh !== before) {
          this.contextId = fresh
          return
        }
        if (Date.now() >= deadline) {
          throw new Error(
            `frame ${this.describe()} navigated to ${url} but no new execution context appeared ` +
              `within 5000ms, so locators would resolve against the old document. This is a bug; ` +
              `re-resolve the frame with page.frame() as a workaround.`
          )
        }
        await new Promise((r) => setTimeout(r, 25))
      }
    }
  }

  /**
   * The accessibility tree beneath this frame, as text.
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
    return this.evaluate<string>(
      ariaSnapshotSource(options?.includeHidden ?? false, options?.markInert ?? true)
    )
  }

  /** A short human description used in error messages. */
  describe(): string {
    const label = this.name ? `name=${this.name}` : this.url
    return `${label}${this.isolated ? ' (cross-origin)' : ''}`
  }

  /**
   * Resolve a selector or explain clearly that it is not in this frame.
   * @param selector - CSS selector
   * @param timeout - How long to wait for it
   * @returns The element
   */
  private async requireElement(selector: string, timeout?: number): Promise<ElementHandle> {
    return this.waitForSelector(selector, { timeout: timeout ?? 5000 })
  }
}
