import fsSync from 'fs'
import pathModule from 'path'
import { ProtocolMapper } from '../cdp/ProtocolMapper'
import { BoundingBox, ClickOptions, FillOptions, ScreenshotOptions, VerifyOptions, VerificationResult } from './types'
import type { Page } from './Page'

/**
 * Wrapper around a DOM element identified by its CDP nodeId.
 */
/**
 * The tree an element handle belongs to: the main document, or one frame of it.
 *
 * Three separate defects came from a handle not knowing this. It clicked at frame-relative
 * coordinates in the parent page; it verified a drag by reading the top-level document, so a
 * successful drop inside a frame reported "nothing changed"; and when its node went stale it
 * re-queried the main document for a selector that only exists in the frame, reporting the
 * element as gone. One object, supplied once, closes all three.
 */
export interface TreeContext {
  /** Where this tree sits in the top-level viewport. */
  offset(): Promise<{ x: number; y: number }>
  /** Evaluate an expression inside this tree. */
  evaluate<T>(expression: string): Promise<T>
  /** Re-resolve a selector inside this tree. */
  querySelector(selector: string): Promise<number | null>
}

export class ElementHandle {
  /**
   * @param mapper - Protocol mapper of the owning page
   * @param nodeId - CDP DOM nodeId
   * @param selector - Selector (or description) that produced this element
   * @param pageRef - Owning page
   * @param tree - The tree this element lives in; omit for the main document
   */
  /** Current nodeId; replaced when the element is re-resolved after a re-render. */
  private currentNodeId: number
  /**
   * What this handle was pointing at when it was created: tag, accessible name and text.
   *
   * Healing checks the replacement against this. Without it a selector that matches several
   * elements can heal onto a different one, which is a silent wrong answer rather than a
   * loud failure, and much harder to notice.
   */
  private identity: string | null = null

  constructor(
    private mapper: ProtocolMapper,
    nodeId: number,
    public readonly selector: string,
    private pageRef: Page,
    private tree?: TreeContext
  ) {
    this.currentNodeId = nodeId
  }

  /**
   * Where this element's tree sits in the top-level viewport.
   *
   * Input events are delivered in top-level viewport coordinates, and the two ways this code
   * obtains a point do NOT agree about which space they are in. Measured on a frame offset by
   * (10, 270): `waitForActionable` returned y=83 and `getBoundingBox` returned y=318 for the
   * same element -- the protocol's box model is already absolute, while an actionability
   * point is relative to the frame. So this is added to points from `waitForActionable`
   * (click, tap) and must NOT be added to boxes from `getBoundingBox` (hover, drag).
   * Getting that backwards silently acts on whatever occupies those coordinates in the
   * parent page, which is why each call site below says which kind it is using.
   * @returns The offset, or the origin for the main document
   */
  private async viewportOffset(): Promise<{ x: number; y: number }> {
    if (this.tree === undefined) return { x: 0, y: 0 }
    return (await this.tree.offset().catch(() => null)) ?? { x: 0, y: 0 }
  }

  /** CDP nodeId of the element (re-resolved automatically if the page re-rendered). */
  get nodeId(): number {
    return this.currentNodeId
  }

  /**
   * Run a protocol call against this element, healing a stale nodeId once.
   *
   * A framework re-render destroys the node behind a CDP nodeId; the protocol then answers
   * "No node with given id found". Because the handle knows the selector that produced it,
   * we re-query, adopt the new nodeId and retry exactly once.
   * @param op - Operation taking the current nodeId
   * @returns The operation's result
   */
  private async withNode<T>(op: (nodeId: number) => Promise<T>, looksMissing?: (value: T) => boolean): Promise<T> {
    let result: T
    // captured before the first use: after the element is gone there is nothing left to read
    await this.rememberIdentity()
    try {
      result = await op(this.currentNodeId)
    } catch (err) {
      const message = (err as Error).message ?? ''
      if (!/No node with given id|Could not find node|Node is detached|is not connected|resolveNode|Cannot find context/i.test(message)) {
        throw err
      }
      return this.healAndRetry(op, message)
    }
    // The protocol layer answers null/false for a dead node instead of raising, so a
    // "missing" result is ambiguous: ask the node itself whether it is still connected.
    if (looksMissing?.(result) === true && !(await this.stillConnected())) {
      return this.healAndRetry(op, 'the element was replaced when the page re-rendered')
    }
    return result
  }

  /**
   * Whether the current nodeId still points at an element attached to the document.
   * @returns false when the node is gone or unreachable
   */
  private async stillConnected(): Promise<boolean> {
    try {
      return await this.mapper.callFunctionOn<boolean>(
        this.currentNodeId,
        `function() { return this.isConnected === true }`
      )
    } catch {
      return false
    }
  }

  /**
   * Re-resolve this element from its selector and run the operation against the new node.
   * @param op - Operation to retry
   * @param reason - Why healing was attempted; quoted if it fails
   * @returns The retried operation's result
   */
  private async healAndRetry<T>(op: (nodeId: number) => Promise<T>, reason: string): Promise<T> {
    if (!this.selector || this.selector.startsWith('vision:')) {
      throw new Error(`element handle is stale and has no selector to re-resolve from (${reason})`)
    }
    const fresh = await (this.tree === undefined
      ? this.mapper.querySelector(this.selector)
      : this.tree.querySelector(this.selector)
    ).catch(() => null)
    if (fresh === null) {
      throw new Error(`element "${this.selector}" no longer exists after the page changed (${reason})`)
    }

    // Only adopt the replacement if it is recognisably the same thing. A selector that
    // matched several elements will happily match a different one after a re-render, and
    // acting on that is a silent wrong answer.
    const expected = this.identity
    const actual = await this.describe(fresh)
    if (expected !== null && actual !== null && expected !== actual) {
      throw new Error(
        `element "${this.selector}" was replaced by a different element after the page changed. ` +
          `It was ${expected}, and the selector now matches ${actual}. ` +
          `Re-find it, or use a selector that identifies this one element.`
      )
    }
    this.currentNodeId = fresh
    if (this.identity === null) this.identity = actual
    return op(fresh)
  }

  /**
   * A short description of what a node is, used to tell one match from another.
   * @param nodeId - Node to describe
   * @returns Tag, accessible name and trimmed text, or null when it cannot be read
   */
  private async describe(nodeId: number): Promise<string | null> {
    return this.mapper
      .callFunctionOn<string>(
        nodeId,
        `function() {
          const name = this.getAttribute('aria-label') || this.getAttribute('name') || ''
          const text = (this.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80)
          return this.tagName.toLowerCase() + '|' + name + '|' + text
        }`
      )
      .catch(() => null)
  }

  /**
   * Remember what this handle points at, so a later heal can verify it found the same thing.
   *
   * Called lazily on first use rather than in the constructor, because constructing a handle
   * should not cost a protocol round trip.
   */
  private async rememberIdentity(): Promise<void> {
    if (this.identity !== null) return
    this.identity = await this.describe(this.currentNodeId)
  }

  /** The page this element belongs to. */
  page(): Page {
    return this.pageRef
  }

  // ── Interaction ──────────────────────────────────────────────────────────────

  /**
   * Click the element.
   * @param options - Click options
   */
  async click(options?: ClickOptions): Promise<void> {
    const offset = await this.viewportOffset()
    await this.withNode((n) => this.mapper.click(n, options, offset))
  }

  /**
   * Double-click the element: two rapid clicks at its centre, the same actionability path as
   * `click` but with `clickCount: 2` so the page sees a real `dblclick`.
   */
  async dblclick(options?: ClickOptions): Promise<void> {
    const offset = await this.viewportOffset()
    await this.withNode((n) => this.mapper.click(n, { ...options, clickCount: 2 }, offset))
  }

  /**
   * Fill an input with text.
   * @param value - Text value
   * @param options - Fill options
   */
  async fill(value: string, options?: FillOptions): Promise<void> {
    await this.withNode((n) => this.mapper.fill(n, value, options))
  }

  /** Clear an input by filling it with the empty string (the same actionability path as `fill`). */
  async clear(options?: FillOptions): Promise<void> {
    await this.withNode((n) => this.mapper.fill(n, '', options))
  }

  /** Rendered text of the element (`innerText`), which respects styling/visibility, unlike textContent. */
  async innerText(): Promise<string> {
    return this.evaluate((node: Element) => (node as HTMLElement).innerText)
  }

  /** Whether the element can be edited: an enabled, non-readonly input/textarea/select or contenteditable. */
  async isEditable(): Promise<boolean> {
    return this.evaluate((node: Element) => {
      const e = node as HTMLElement & { disabled?: boolean; readOnly?: boolean }
      const tag = e.tagName.toLowerCase()
      const editable = tag === 'input' || tag === 'textarea' || tag === 'select' || e.isContentEditable
      return editable && !e.disabled && !e.readOnly
    })
  }

  /** Select the element's text contents (like a user selecting it), for copy or replace-typing. */
  async selectText(): Promise<void> {
    await this.evaluate((node: Element) => {
      const range = document.createRange()
      range.selectNodeContents(node)
      const sel = window.getSelection()
      sel?.removeAllRanges()
      sel?.addRange(range)
    })
  }

  /**
   * Press a key with the element focused.
   * @param key - Key name, e.g. `Enter`
   */
  async press(key: string): Promise<void> {
    await this.withNode((n) => this.mapper.press(n, key))
  }

  /**
   * Select option(s) of a `<select>`.
   * @param values - Option value(s)
   */
  async selectOption(values: string | string[]): Promise<void> {
    await this.withNode((n) => this.mapper.selectOption(n, Array.isArray(values) ? values : [values]))
  }

  /** Focus the element. */
  async focus(): Promise<void> {
    await this.withNode((n) => this.mapper.focus(n))
  }

  /** Move the mouse over the element centre. */
  async hover(): Promise<void> {
    try {
      await this.withNode((n) => this.mapper.scrollIntoView(n))
      const bbox = await this.withNode(
        (n) => this.mapper.getBoundingBox(n),
        (box) => box === null
      )
      if (!bbox) throw new Error('element is not visible')
      // getBoundingBox is already in top-level coordinates; adding the frame offset here
      // would double-count it and hover the parent page instead.
      await this.mapper.mouseMove(bbox.x + bbox.width / 2, bbox.y + bbox.height / 2)
    } catch (err) {
      throw new Error(`hover(${this.selector}) failed: ${(err as Error).message}`)
    }
  }

  /**
   * Tap the element, waiting for it to be actionable first.
   *
   * Distinct from {@link click}: a page that binds `touchstart`, or that treats a tap
   * differently from a click, will not respond to a synthesised mouse event.
   * @param options - timeout in ms
   */
  async tap(options?: { timeout?: number }): Promise<void> {
    await this.scrollIntoViewIfNeeded()
    const point = await this.withNode((n) => this.mapper.waitForActionable(n, { timeout: options?.timeout }))
    // waitForActionable is frame-relative, so the offset is required here
    const offset = await this.viewportOffset()
    await this.mapper.touchTap(point.x + offset.x, point.y + offset.y)
  }

  /** Scroll the element into view if it is not already visible. */
  async scrollIntoViewIfNeeded(): Promise<void> {
    await this.withNode((n) => this.mapper.scrollIntoView(n))
  }

  // ── Info ─────────────────────────────────────────────────────────────────────

  /**
   * Bounding box in viewport CSS pixels.
   * @returns Box or null when the element has no layout
   */
  async boundingBox(): Promise<BoundingBox | null> {
    return this.withNode(
      (n) => this.mapper.getBoundingBox(n),
      (box) => box === null
    )
  }

  /**
   * Read an attribute.
   * @param name - Attribute name
   * @returns Value or null when absent
   */
  async getAttribute(name: string): Promise<string | null> {
    return this.withNode(
      (n) => this.mapper.callFunctionOn<string | null>(n, `function(a) { return this.getAttribute(a) }`, [name]),
      (value) => value === null
    )
  }

  /**
   * Text content of the element.
   * @returns `textContent` or null
   */
  async textContent(): Promise<string | null> {
    return this.withNode(
      (n) => this.mapper.callFunctionOn<string | null>(n, `function() { return this.textContent }`),
      (value) => value === null
    )
  }

  /**
   * Inner HTML of the element.
   * @returns HTML string
   */
  async innerHTML(): Promise<string> {
    return this.withNode((n) => this.mapper.callFunctionOn<string>(n, `function() { return this.innerHTML }`))
  }

  /**
   * Current value of an input/select/textarea.
   * @returns Value string
   */
  async inputValue(): Promise<string> {
    return this.withNode((n) =>
      this.mapper.callFunctionOn<string>(
        n,
        `function() { if (!('value' in this)) throw new Error('element has no value property'); return String(this.value) }`
      )
    )
  }

  /**
   * Whether the element is visible (rendered, non-zero size, not display:none/visibility:hidden).
   * @returns true when visible
   */
  async isVisible(): Promise<boolean> {
    return this.withNode(
      (n) => this.mapper.isVisible(n),
      (visible) => visible === false
    )
  }

  /**
   * Where this element actually is: rendered, on screen, and whether anything covers it.
   *
   * Prefer this to {@link isVisible} when deciding whether a user could interact with the
   * element. `isVisible` only reports whether the browser renders it, which is true of an
   * element positioned far outside the viewport.
   * @returns Rendering, viewport position and occlusion
   * @example
   * const v = await buyButton.visibility()
   * if (v.inViewport === 'none') console.log('rendered but off screen at', v.bbox)
   */
  async visibility(): Promise<{
    rendered: boolean
    inViewport: 'full' | 'partial' | 'none'
    occludedBy: string | null
    hiddenBy: string | null
    bbox: BoundingBox | null
  }> {
    return this.withNode((n) => this.mapper.visibility(n))
  }

  /**
   * Whether the element is enabled (not `disabled`).
   * @returns true when enabled
   */
  async isEnabled(): Promise<boolean> {
    return this.withNode((n) => this.mapper.callFunctionOn<boolean>(n, `function() { return !this.disabled }`))
  }

  /**
   * Whether a checkbox/radio is checked (or `aria-checked="true"`).
   * @returns true when checked
   */
  async isChecked(): Promise<boolean> {
    return this.withNode((n) =>
      this.mapper.callFunctionOn<boolean>(
        n,
        `function() { return 'checked' in this ? Boolean(this.checked) : this.getAttribute('aria-checked') === 'true' }`
      )
    )
  }

  /**
   * Attach files to this file input.
   *
   * The element must be an `<input type="file">`. There is no way to drive the operating
   * system's file chooser, so anything else is refused rather than silently doing nothing.
   * @param files - One or more absolute paths
   * @throws Error when the element cannot accept files or a path does not exist
   * @example
   * const input = await page.$('input[type=file]')
   * await input.setInputFiles([path.resolve('invoice.pdf')])
   */
  async setInputFiles(files: string | string[]): Promise<void> {
    const list = Array.isArray(files) ? files : [files]
    const kind = await this.withNode((n) =>
      this.mapper.callFunctionOn<string>(
        n,
        `function() { return this.tagName.toLowerCase() + ':' + (this.type || '') }`
      )
    )
    if (kind !== 'input:file') {
      throw new Error(
        `setInputFiles: ${JSON.stringify(this.selector)} is a <${kind.split(':')[0]}>, not a file input. ` +
          `A native file chooser cannot be driven; target the <input type="file"> element itself.`
      )
    }
    for (const file of list) {
      if (!fsSync.existsSync(file)) throw new Error(`setInputFiles: no such file: ${file}`)
    }
    await this.withNode((n) => this.mapper.setFileInputFiles(n, list.map((f) => pathModule.resolve(f))))
  }

  /**
   * Drag this element onto another.
   * @param target - The element to drop onto
   * @param options - steps: how many intermediate moves to send
   * @throws Error when either element has no layout
   * @example
   * await (await page.$('#card-1')).dragTo(await page.$('#done-column'))
   */
  async dragTo(target: ElementHandle, options?: { steps?: number; force?: boolean }): Promise<void> {
    await this.scrollIntoViewIfNeeded()
    const from = await this.boundingBox()
    const to = await target.boundingBox()
    if (!from || !to) {
      throw new Error(`dragTo: ${!from ? 'the source' : 'the target'} element has no layout, so it cannot be dragged`)
    }

    // Read the element's own document. Checking the top-level one reports "nothing changed"
    // for a drop that succeeded inside a frame, turning a working drag into a hard error.
    // What a drag changes is STRUCTURE: which element sits where. Two earlier attempts were
    // each blind in one direction. Comparing innerHTML.length missed every reorder, because a
    // reorder is length-invariant by definition -- same nodes, same text, different order.
    // Hashing innerHTML caught the reorder but then counted a ticking clock elsewhere on the
    // page as evidence the drop worked, which is worse: it turns a no-op into a false success.
    // So the signature is the document-ordered sequence of element identities, which changes
    // when something moves and does not change when text does.
    // Deciding whether a drop worked means separating "this changed because of the drag"
    // from "this was changing anyway", and four cheaper signatures each failed on one side:
    //
    //   innerHTML.length      missed every reorder (a reorder is length-invariant)
    //   hash of innerHTML     counted a ticking clock as proof the drop worked
    //   tag/id/class sequence missed a reorder of identical siblings
    //   live element order    missed a drop whose only effect is text elsewhere
    //
    // A false "it worked" is the worst of those, so the page's own churn is measured first:
    // two baselines a short interval apart, with no action between them. Anything whose text
    // differs across that interval was moving on its own and is excluded from the verdict.
    // What remains is a page that has been asked what it does when nothing happens, before
    // being asked what it did when something did.
    const captureBaseline = `(() => {
      const all = Array.prototype.slice.call(document.body.getElementsByTagName('*'))
      window.__svDragA = { nodes: all, text: all.map((e) => e.textContent) }
      return String(all.length)
    })()`
    const markChurn = `(() => {
      const a = window.__svDragA
      const now = Array.prototype.slice.call(document.body.getElementsByTagName('*'))
      const churning = new Set()
      if (a && a.nodes.length === now.length) {
        for (let i = 0; i < now.length; i++) {
          if (a.nodes[i] !== now[i] || a.text[i] !== now[i].textContent) churning.add(now[i])
        }
      }
      window.__svDragB = { nodes: now, text: now.map((e) => e.textContent), churning: churning }
      return String(churning.size)
    })()`
    const compareAfter = `(() => {
      const b = window.__svDragB
      const now = document.body.getElementsByTagName('*')
      delete window.__svDragA
      delete window.__svDragB
      if (!b) return 'unknown'
      if (b.nodes.length !== now.length) return 'changed'
      for (let i = 0; i < b.nodes.length; i++) {
        // an element that moved is decisive, whatever its text does
        if (b.nodes[i] !== now[i]) return 'changed'
      }
      for (let i = 0; i < b.nodes.length; i++) {
        if (b.churning.has(now[i])) continue
        if (b.text[i] !== now[i].textContent) return 'changed'
      }
      return 'same'
    })()`
    const inTree = async (expr: string): Promise<string> =>
      this.tree === undefined
        ? this.pageRef.evaluate<string>(expr)
        : this.tree.evaluate<string>(expr)
    await inTree(captureBaseline)
    await new Promise((r) => setTimeout(r, 120))
    await inTree(markChurn)
    const native = await this.evaluate((el: Element) => (el as HTMLElement).draggable === true).catch(() => false)

    if (native) {
      // A `draggable="true"` element responds to the HTML5 drag events, and mouse events
      // alone will never produce a drop on it.
      await this.dispatchHtml5Drag(target)
    } else {
      // both boxes come from getBoundingBox, so they are already absolute
      await this.mapper.dragMouse(
        { x: from.x + from.width / 2, y: from.y + from.height / 2 },
        { x: to.x + to.width / 2, y: to.y + to.height / 2 },
        options?.steps
      )
    }

    if (options?.force === true) return
    // Dragging is unusually prone to succeeding as an operation while achieving nothing, so
    // it reports that rather than returning quietly.
    await new Promise((r) => setTimeout(r, 120))
    const after = await inTree(compareAfter)
    if (after !== 'changed') {
      throw new Error(
        `dragTo: the drag was performed but nothing on the page changed, so the drop did not take effect. ` +
          `The source is ${native ? 'a native draggable' : 'not a native draggable, so pointer events were used'}. ` +
          `Pass { force: true } to skip this check.`
      )
    }
  }

  /**
   * Dispatch a full HTML5 drag sequence from this element to another.
   *
   * The events share one DataTransfer, because an application's `drop` handler reads what its
   * `dragstart` handler wrote and separate objects break that.
   * @param target - Element to drop onto
   */
  private async dispatchHtml5Drag(target: ElementHandle): Promise<void> {
    const dropped = await this.withNode((n) =>
      this.mapper.callFunctionOn<boolean>(
        n,
        `function(targetSelector) {
          const to = document.querySelector(targetSelector)
          if (!to) return false
          const data = new DataTransfer()
          const fire = (node, type) => node.dispatchEvent(
            new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: data })
          )
          fire(this, 'dragstart')
          fire(to, 'dragenter')
          fire(to, 'dragover')
          fire(to, 'drop')
          fire(this, 'dragend')
          return true
        }`,
        [target.selector]
      )
    )
    if (!dropped) {
      throw new Error(
        `dragTo: the drop target ${JSON.stringify(target.selector)} could not be found in the page`
      )
    }
  }

  // ── Children ─────────────────────────────────────────────────────────────────

  /**
   * Query a descendant.
   * @param selector - CSS selector
   * @returns Handle or null
   */
  async $(selector: string): Promise<ElementHandle | null> {
    const nodeId = await this.withNode((n) => this.mapper.querySelectorWithin(n, selector))
    return nodeId === null
      ? null
      : new ElementHandle(this.mapper, nodeId, selector, this.pageRef, this.tree)
  }

  /**
   * Query all descendants.
   * @param selector - CSS selector
   * @returns Handles (possibly empty)
   */
  async $$(selector: string): Promise<ElementHandle[]> {
    const ids = await this.withNode((n) => this.mapper.querySelectorAllWithin(n, selector))
    return ids.map((id) => new ElementHandle(this.mapper, id, selector, this.pageRef, this.tree))
  }

  // ── Screenshot ───────────────────────────────────────────────────────────────

  /**
   * Screenshot just this element (8px padding).
   * @param options - Screenshot options (type, quality, annotate, path)
   * @returns Image bytes
   */
  async screenshot(options?: Omit<ScreenshotOptions, 'fullPage' | 'clip'>): Promise<Buffer> {
    return this.pageRef.screenshotEngineRef().screenshotElement(this, options)
  }

  // ── Verification ─────────────────────────────────────────────────────────────

  /**
   * Verify structure scoped to this element (descriptions are resolved within its subtree).
   * @param options - Verify options
   * @returns Verification result
   */
  async verify(options: VerifyOptions): Promise<VerificationResult> {
    return this.pageRef.verifierRef().verify(this.pageRef, options, this)
  }

  // ── Evaluate ─────────────────────────────────────────────────────────────────

  /**
   * Run a function in the page with this element as its argument.
   * @param fn - Function receiving the element
   * @returns The function's serialisable return value
   */
  async evaluate<T>(fn: (el: Element) => T): Promise<T> {
    const source = fn.toString()
    return this.withNode((n) => this.mapper.callFunctionOn<T>(n, `function() { return (${source})(this) }`))
  }
}
