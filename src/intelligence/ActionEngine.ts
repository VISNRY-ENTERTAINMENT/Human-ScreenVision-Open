import type { Page } from '../core/Page'
import type { ActionRequest, ActionResult, ActionEffects, MutationSummary } from '../core/types'
import { EffectRecorder } from './EffectRecorder'
import { ElementHandle } from '../core/ElementHandle'

/**
 * Performs an action and proves what it did.
 *
 * The failure this exists to remove is the silent one. An agent clicks a button, the click
 * lands, nothing happens, and ordinary automation reports success because the click was
 * dispatched. The agent proceeds on a false belief and the mistake surfaces several steps
 * later, somewhere unrelated. Every browser automation library has a rigorous precondition
 * model and no postcondition model at all.
 *
 * Two ideas make this cheap enough to do on every action:
 *
 * 1. Measure the change, not the page. Watching mutations costs in proportion to what
 *    actually changed, so a dead click produces a near-empty record rather than a second
 *    full read of a large page.
 * 2. Ask first. The protocol will say whether a control has any event listener at all, so an
 *    inert button can be diagnosed rather than merely observed to do nothing.
 *
 * The result separates two questions that are usually conflated: did anything happen, which
 * is deterministic and cheap, and did the intended thing happen, which needs the caller to
 * say what it intended.
 */
export class ActionEngine {
  private recorder: EffectRecorder

  /**
   * @param page - Page to act on
   */
  constructor(private page: Page) {
    this.recorder = new EffectRecorder(page)
  }

  /**
   * Perform an action and report what changed.
   * @param request - What to do, to what, and what is expected to follow
   * @returns The outcome with its evidence
   */
  async act(request: ActionRequest): Promise<ActionResult> {
    const started = Date.now()
    const target = await this.resolveTarget(request)

    const urlBefore = this.page.url()
    const titleBefore = await this.page.title().catch(() => '')

    // An expectation key this engine does not know would otherwise be dropped in silence,
    // and the action would report "confirmed, expectations: []" -- claiming verification it
    // never performed. Refusing is the only safe default for a library whose whole purpose is
    // not to hand back unearned confidence.
    if (request.expect) {
      const known = [
        'urlContains',
        'textAppears',
        'textDisappears',
        'elementAppears',
        'elementDisappears',
        'requestMade',
      ]
      const unknown = Object.keys(request.expect).filter((k) => !known.includes(k))
      if (unknown.length > 0) {
        throw new Error(
          `act: unrecognised expectation ${unknown.length > 1 ? 'keys' : 'key'} ` +
            `${unknown.map((k) => JSON.stringify(k)).join(', ')}. Checking nothing and reporting ` +
            `"confirmed" would be worse than failing. Supported: ${known.join(', ')}.`
        )
      }
    }

    // The doctrine's gate. A control classified as requiring confirmation is refused unless
    // the caller says, in this call, that it is authorised. Payments, deletions, sending on
    // the user's behalf, accepting terms and personal-data submission all land here, and the
    // rule is "every time, no exception for small amounts" -- so this cannot be a session
    // flag or a default, or the classification would be decorative.
    //
    // Only refs carry a classification, because only an observation classifies. Acting by raw
    // selector bypasses this deliberately: it is the escape hatch for a caller who has
    // already decided, and `observe()` is the path an agent takes.
    if (request.ref !== undefined && request.confirmed !== true) {
      const observation = this.page.lastObserved()
      const found = observation?.affordances.find((a) => a.ref === request.ref)
      if (found?.consequence === 'confirm') {
        throw new Error(
          `act: ${request.ref} (${found.role} "${found.name}") needs explicit confirmation — ` +
            `${found.consequenceReason}. Pass { confirmed: true } once a human has authorised ` +
            `this specific action. This gate exists because an agent cannot decline a ` +
            `consequence nobody classified.`
        )
      }
      if (found?.consequence === 'prohibited') {
        throw new Error(
          `act: ${request.ref} (${found.role} "${found.name}") is prohibited — ` +
            `${found.consequenceReason}. This is refused regardless of confirmation.`
        )
      }
    }

    // Ask whether this control can do anything before asking whether it did.
    const inertness = await this.assessInertness(request, target)

    const requests: string[] = []
    const writeRequests: Array<{ method: string; url: string }> = []
    const consoleErrors: string[] = []
    const stopWatching = this.page.watchActivity(
      (url, method) => {
        if (requests.length < 50 && !/favicon\.ico$/.test(url)) requests.push(url)
        // GET and HEAD are reads; everything else can change state on the server
        const verb = (method || 'GET').toUpperCase()
        if (verb !== 'GET' && verb !== 'HEAD' && writeRequests.length < 50) {
          writeRequests.push({ method: verb, url })
        }
      },
      (text) => {
        if (consoleErrors.length < 20) consoleErrors.push(text)
      }
    )
    await this.recorder.start()

    let performed = false
    let failureReason = ''
    try {
      await this.perform(request, target)
      performed = true
    } catch (err) {
      failureReason = (err as Error).message
    }

    await this.settle()
    // Keep measuring while a declared postcondition has not yet held.
    //
    // Without this an async effect is a silent wrong verdict twice over: a table that loads
    // 800ms after the click lands outside the 150ms settle window, so the MutationObserver
    // records nothing and `changed` is false — reporting "no-effect, the control may be
    // inert" for an action that plainly worked — and `textAppears`/`textDisappears`, which
    // read the page once, miss content that `elementAppears` (which already polls) would have
    // caught. Polling here fixes both at the root: the recorder stays live so the late
    // mutation is measured as a real change, and every expectation is given the same chance to
    // come true. It returns the instant all declared expectations hold, so a synchronous page
    // pays nothing, and a genuinely-pre-satisfied expectation with no mutation still falls
    // through to `no-effect` exactly as before — the window was widened, the verdict was not.
    if (performed && request.expect) {
      const deadline = Date.now() + (request.timeout ?? 3000)
      while (Date.now() < deadline) {
        if (await this.expectationsHold(request.expect, requests)) break
        await new Promise((r) => setTimeout(r, 100))
      }
    }
    const mutations = await this.recorder.collect()
    stopWatching()

    const urlAfter = this.page.url()
    const titleAfter = await this.page.title().catch(() => '')

    const effects: ActionEffects = {
      urlChanged: urlBefore === urlAfter ? null : { from: urlBefore, to: urlAfter },
      titleChanged: titleBefore === titleAfter ? null : { from: titleBefore, to: titleAfter },
      mutations,
      requests,
      writeRequests,
      consoleErrors,
      valueSet: performed ? await this.readValue(request, target) : null,
    }

    const expectations = performed ? await this.checkExpectations(request, effects) : []
    const changed = this.anythingChanged(effects)
    const expectationsMet = expectations.every((e) => e.met)

    // Anything consequential that the caller did not declare. Only meaningful when there was
    // a declaration: without `expect` there is no boundary for an effect to fall outside of.
    const undeclared: ActionResult['undeclared'] = []
    if (expectations.length > 0) {
      const declaredNavigation = request.expect?.urlContains !== undefined
      if ((effects.urlChanged !== null || effects.mutations.navigated) && !declaredNavigation) {
        undeclared.push({
          kind: 'navigation',
          detail: effects.urlChanged
            ? `navigated to ${effects.urlChanged.to}`
            : 'the document was replaced',
        })
      }
      const declaredRequest = request.expect?.requestMade
      for (const w of effects.writeRequests) {
        if (declaredRequest !== undefined && w.url.includes(declaredRequest)) continue
        undeclared.push({ kind: 'write-request', detail: `${w.method} ${w.url}` })
      }
      for (const e of effects.consoleErrors) {
        undeclared.push({ kind: 'console-error', detail: e })
      }
    }

    let verdict: ActionResult['verdict']
    if (!performed) verdict = 'blocked'
    // a field that did not take the text is a failure however much else moved on the page
    else if (effects.valueSet && !effects.valueSet.matched) verdict = 'unexpected'
    else if (expectations.length > 0 && !expectationsMet) verdict = 'unexpected'
    // What was asked for happened, and something else did too. Reported separately because an
    // agent that treats this as plain success is exactly how a harmful side effect goes
    // unnoticed -- the click worked, and it also sent something.
    else if (expectations.length > 0 && expectationsMet && undeclared.length > 0) {
      verdict = 'side-effects'
    } else if (changed) verdict = 'confirmed'
    else verdict = 'no-effect'

    const result: ActionResult = {
      ok: verdict === 'confirmed',
      action: request.do,
      target,
      precondition: performed ? { met: true } : { met: false, reason: failureReason },
      inert: inertness,
      effects,
      expectations,
      undeclared,
      verdict,
      summary: this.summarise(
        request,
        target,
        verdict,
        effects,
        expectations,
        failureReason,
        inertness,
        undeclared
      ),
      durationMs: Date.now() - started,
    }
    this.page.recordAction(result)
    return result
  }

  /**
   * Decide whether the control could plausibly do anything when activated.
   * @param request - The action request
   * @param selector - Resolved selector
   * @returns A diagnosis, or null when the control looks capable or the question is moot
   */
  private async assessInertness(
    request: ActionRequest,
    target: ActionResult['target']
  ): Promise<{ likely: boolean; reason: string } | null> {
    if (request.do !== 'click') return null
    try {
      const handle =
        target.nodeId !== undefined
          ? new ElementHandle(this.page.mapperRef(), target.nodeId, target.resolvedSelector, this.page)
          : await this.page.$(target.resolvedSelector)
      if (!handle) return null
      const listeners = await this.page.mapperRef().eventListeners(handle.nodeId)
      if (listeners.length > 0) return null
      // no listener anywhere up the chain: the remaining ways a click can matter are a link,
      // a form submit, or a label bound to a control
      const capable = await handle
        .evaluate((el: Element) => {
          const e = el as HTMLElement & { type?: string; form?: unknown; href?: string }
          if (e.tagName === 'A' && e.getAttribute('href')) return true
          if (e.tagName === 'LABEL') return true
          if ((e.type === 'submit' || e.type === 'reset') && e.form) return true
          if (e.getAttribute('onclick')) return true
          return false
        })
        .catch(() => true)
      if (capable) return null
      return {
        likely: true,
        reason:
          'the element has no event listener on it or any ancestor, no href, and is not a form ' +
          'submit control, so activating it cannot do anything',
      }
    } catch {
      return null
    }
  }

  /**
   * Work out which element the request refers to.
   * @param request - The action request
   * @returns Description and concrete selector
   */
  private async resolveTarget(request: ActionRequest): Promise<ActionResult['target']> {
    if (request.ref) {
      const observation = this.page.lastObserved()
      if (!observation) {
        throw new Error(`act({ ref: '${request.ref}' }) needs an observation first: call page.observe()`)
      }
      const found = observation.affordances.find((a) => a.ref === request.ref)
      if (!found) {
        const available = observation.affordances
          .slice(0, 12)
          .map((a) => `${a.ref}=${a.role} "${a.name}"`)
          .join(', ')
        throw new Error(
          `no affordance ${request.ref} in the current observation. Available: ${available}` +
            (observation.affordances.length > 12 ? `, and ${observation.affordances.length - 12} more` : '')
        )
      }
      // Resolve in the tree the element actually came from. A selector from a frame or a
      // shadow root means nothing in the main document, and falling back to it there is how
      // an action on an iframe button ended up clicking a namesake in the page behind it.
      const index = found.indexInTree ?? observation.affordances.indexOf(found)
      const live =
        found.frameId === undefined
          ? await this.page.mapperRef().nodeIdForObservedRef(index)
          : await this.nodeIdInFrame(found.frameId, index)
      if (live !== null) {
        return {
          ref: request.ref,
          description: `${found.role} "${found.name}"`,
          resolvedSelector: found.selector,
          nodeId: live,
          frameId: found.frameId,
        }
      }
      if (found.frameId !== undefined || found.inShadowRoot === true) {
        throw new Error(
          `affordance ${request.ref} (${found.role} "${found.name}") is in ` +
            `${found.frameId !== undefined ? `frame ${found.frame ?? found.frameId}` : 'a shadow root'} ` +
            `and can no longer be resolved there. Its selector ${JSON.stringify(found.selector)} does not ` +
            `address it from the main document, so acting on it would act on something else. ` +
            `Call observe() again.`
        )
      }
      return { ref: request.ref, description: `${found.role} "${found.name}"`, resolvedSelector: found.selector }
    }
    if (request.selector) {
      return { description: request.selector, resolvedSelector: request.selector }
    }
    if (request.target) {
      const resolved = await this.page.findResolved(request.target, { timeout: request.timeout ?? 5000 })
      return { description: request.target, resolvedSelector: resolved.selector }
    }
    throw new Error('act() needs one of ref, target or selector to say what to act on')
  }

  /**
   * Resolve an observed affordance inside a particular frame.
   * @param frameId - CDP frame id
   * @param index - Index within that frame's collected elements
   * @returns nodeId, or null when the frame or the element is gone
   */
  private async nodeIdInFrame(frameId: string, index: number): Promise<number | null> {
    const frames = await this.page.frames().catch(() => [])
    const frame = frames.find((f) => f.frameId === frameId)
    return frame ? frame.nodeIdForObservedRef(index) : null
  }


  /**
   * Carry out the requested interaction.
   * @param request - The action request
   * @param selector - Resolved selector
   */
  private async perform(request: ActionRequest, target: ActionResult['target']): Promise<void> {
    const timeout = request.timeout ?? 5000
    // when the ref resolved to a live element, act on that element and not on a selector that
    // may now match a different one
    if (target.nodeId !== undefined) {
      // A node inside a same-origin frame reports frame-relative coordinates, so a click
      // dispatched straight at them lands wherever that point is in the main viewport.
      if (target.frameId !== undefined && request.do === 'click') {
        const frames = await this.page.frames().catch(() => [])
        const frame = frames.find((f) => f.frameId === target.frameId)
        if (frame) return frame.clickNode(target.nodeId, { timeout })
      }
      const handle = new ElementHandle(this.page.mapperRef(), target.nodeId, target.resolvedSelector, this.page)
      switch (request.do) {
        case 'click':
          return handle.click({ timeout })
        case 'fill':
          return handle.fill(request.value ?? '', { timeout })
        case 'check':
          if (!(await handle.isChecked())) await handle.click({ timeout })
          return
        case 'uncheck':
          if (await handle.isChecked()) await handle.click({ timeout })
          return
        case 'select':
          return handle.selectOption(request.value ?? '')
        case 'press':
          return handle.press(request.value ?? 'Enter')
        case 'hover':
          return handle.hover()
        default:
          throw new Error(`unknown action ${String(request.do)}`)
      }
    }
    const selector = target.resolvedSelector
    switch (request.do) {
      case 'click':
        return this.page.click(selector, { timeout })
      case 'fill':
        return this.page.fill(selector, request.value ?? '', { timeout })
      case 'check':
        return this.page.check(selector)
      case 'uncheck':
        return this.page.uncheck(selector)
      case 'select':
        return this.page.selectOption(selector, request.value ?? '')
      case 'press':
        return this.page.press(selector, request.value ?? 'Enter')
      case 'hover':
        return this.page.hover(selector)
      default:
        throw new Error(`unknown action ${String(request.do)}`)
    }
  }

  /** Let the page react: two animation frames, then a short settle. */
  private async settle(): Promise<void> {
    await this.page
      .evaluate(`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))`)
      .catch(() => undefined)
    await new Promise((r) => setTimeout(r, 150))
  }

  /**
   * Whether anything at all measurably changed.
   * @param e - The measured effects
   * @returns true when the page responded in some observable way
   */
  private anythingChanged(e: ActionEffects): boolean {
    return (
      e.urlChanged !== null ||
      e.titleChanged !== null ||
      e.mutations.total > 0 ||
      e.mutations.navigated ||
      e.requests.length > 0 ||
      e.valueSet?.matched === true
    )
  }

  /**
   * Read back what a value-bearing action actually set.
   * @param request - The action request
   * @param selector - Resolved selector
   * @returns Expected and actual value, or null when the action has no intrinsic value
   */
  private async readValue(
    request: ActionRequest,
    target: ActionResult['target']
  ): Promise<{ expected: string; actual: string; matched: boolean } | null> {
    const expectedFor: Partial<Record<ActionRequest['do'], string>> = {
      fill: request.value ?? '',
      check: 'true',
      uncheck: 'false',
      select: request.value ?? '',
    }
    const expected = expectedFor[request.do]
    if (expected === undefined) return null
    try {
      const read = `function() {
        if (this.type === 'checkbox' || this.type === 'radio') return String(this.checked)
        return String(this.value === undefined ? '' : this.value)
      }`
      const actual =
        target.nodeId !== undefined
          ? await this.page.mapperRef().callFunctionOn<string>(target.nodeId, read)
          : await this.page.evaluate<string>(
              `(() => {
                const el = document.querySelector(${JSON.stringify(target.resolvedSelector)})
                if (!el) return ''
                if (el.type === 'checkbox' || el.type === 'radio') return String(el.checked)
                return String(el.value === undefined ? '' : el.value)
              })()`
            )
      return { expected, actual, matched: actual === expected }
    } catch {
      return null
    }
  }

  /**
   * A quick, single-shot test of whether every declared expectation currently holds.
   *
   * Used only to decide whether to keep waiting for a slow effect; the authoritative,
   * itemised evaluation is {@link checkExpectations}. It does no internal waiting of its own
   * (a zero timeout on element lookups), because the waiting is the caller's polling loop —
   * doing it here as well would stack timeouts.
   * @param expect - The declared expectation set
   * @param requests - URLs seen so far during the action
   * @returns true only when all declared clauses hold right now
   */
  private async expectationsHold(
    expect: NonNullable<ActionRequest['expect']>,
    requests: string[]
  ): Promise<boolean> {
    if (expect.urlContains !== undefined && !this.page.url().includes(expect.urlContains)) return false
    if (expect.textAppears !== undefined && !(await this.pageContains(expect.textAppears))) return false
    if (expect.textDisappears !== undefined && (await this.pageContains(expect.textDisappears))) return false
    if (expect.elementAppears !== undefined) {
      const found = await this.page.findOrNull(expect.elementAppears, { timeout: 0 })
      if (found === null || !(await found.isVisible().catch(() => false))) return false
    }
    if (expect.elementDisappears !== undefined) {
      const found = await this.page.findOrNull(expect.elementDisappears, { timeout: 0 })
      if (found !== null && (await found.isVisible().catch(() => false))) return false
    }
    if (expect.requestMade !== undefined && !requests.some((u) => u.includes(expect.requestMade as string)))
      return false
    return true
  }

  /**
   * Check each stated expectation against what actually happened.
   * @param request - The action request
   * @param effects - The measured effects
   * @returns One entry per expectation
   */
  private async checkExpectations(
    request: ActionRequest,
    effects: ActionEffects
  ): Promise<ActionResult['expectations']> {
    const expect = request.expect
    if (!expect) return []
    const out: ActionResult['expectations'] = []

    if (expect.urlContains !== undefined) {
      const url = this.page.url()
      const met = url.includes(expect.urlContains)
      out.push({
        expectation: `url contains "${expect.urlContains}"`,
        met,
        detail: met ? `url is ${url}` : `url is still ${url}`,
      })
    }
    if (expect.textAppears !== undefined) {
      const met = await this.pageContains(expect.textAppears)
      out.push({
        expectation: `text "${expect.textAppears}" appears`,
        met,
        detail: met ? 'found on the page' : 'not found anywhere on the page after the action',
      })
    }
    if (expect.textDisappears !== undefined) {
      const stillThere = await this.pageContains(expect.textDisappears)
      out.push({
        expectation: `text "${expect.textDisappears}" disappears`,
        met: !stillThere,
        detail: stillThere ? 'still present on the page' : 'no longer present',
      })
    }
    if (expect.elementAppears !== undefined) {
      const found = await this.page.findOrNull(expect.elementAppears, { timeout: 1500 })
      const met = found !== null && (await found.isVisible().catch(() => false))
      out.push({
        expectation: `element "${expect.elementAppears}" becomes visible`,
        met,
        detail: met ? 'it is visible' : 'it was not found or is not visible',
      })
    }
    if (expect.elementDisappears !== undefined) {
      const found = await this.page.findOrNull(expect.elementDisappears, { timeout: 800 })
      const stillVisible = found !== null && (await found.isVisible().catch(() => false))
      out.push({
        expectation: `element "${expect.elementDisappears}" stops being visible`,
        met: !stillVisible,
        detail: stillVisible ? 'it is still visible' : 'it is gone or hidden',
      })
    }
    if (expect.requestMade !== undefined) {
      const wanted = expect.requestMade
      const match = effects.requests.find((u) => u.includes(wanted))
      out.push({
        expectation: `a request to "${wanted}" is made`,
        met: match !== undefined,
        detail: match
          ? `saw ${match}`
          : effects.requests.length === 0
            ? 'no requests were made at all'
            : `requests seen: ${effects.requests.slice(0, 5).join(', ')}`,
      })
    }
    return out
  }

  /**
   * Whether some text is anywhere in the rendered page.
   * @param text - Text to look for
   * @returns true when present
   */
  private async pageContains(text: string): Promise<boolean> {
    return this.page
      .evaluate<boolean>(`(document.body.innerText || '').indexOf(${JSON.stringify(text)}) >= 0`)
      .catch(() => false)
  }

  /**
   * One sentence stating what happened, written to be actionable on its own.
   * @param request - The action request
   * @param target - Resolved target
   * @param verdict - The verdict reached
   * @param effects - The measured effects
   * @param expectations - Expectation outcomes
   * @param failureReason - Why the action could not be performed, when it could not
   * @param inert - Inertness diagnosis, when there is one
   * @param undeclared - Consequential effects outside what the caller declared
   * @returns The summary line
   */
  private summarise(
    request: ActionRequest,
    target: ActionResult['target'],
    verdict: ActionResult['verdict'],
    effects: ActionEffects,
    expectations: ActionResult['expectations'],
    failureReason: string,
    inert: { likely: boolean; reason: string } | null,
    undeclared: ActionResult['undeclared'] = []
  ): string {
    const what = `${request.do} on ${target.description}`
    if (verdict === 'blocked') return `Could not ${what}: ${failureReason}`

    if (verdict === 'no-effect') {
      const cause = inert
        ? ` Diagnosis: ${inert.reason}.`
        : effects.consoleErrors.length
          ? ` The console reported: ${effects.consoleErrors[0]}`
          : ' The control may be inert, or its handler failed silently.'
      return (
        `${what} was performed, but nothing changed: no navigation, no DOM mutation and no ` +
        `network request.${cause}`
      )
    }

    if (verdict === 'unexpected' && effects.valueSet && !effects.valueSet.matched) {
      return (
        `${what} was performed, but the control did not take the value: expected ` +
        `"${effects.valueSet.expected}", it holds "${effects.valueSet.actual}". The input may be ` +
        `masked, formatted, length-limited, or controlled by code that rewrote it.`
      )
    }

    if (verdict === 'side-effects') {
      const shown = undeclared.slice(0, 3).map((u) => u.detail).join('; ')
      const more = undeclared.length > 3 ? `, and ${undeclared.length - 3} more` : ''
      return (
        `${what} did what was expected, but also caused something undeclared: ${shown}${more}. ` +
        `Treat this as a success only if that was intended.`
      )
    }

    if (verdict === 'unexpected') {
      const failed = expectations.filter((e) => !e.met)
      return (
        `${what} changed the page, but ${failed.length} expectation${failed.length > 1 ? 's' : ''} ` +
        `did not hold: ${failed.map((f) => `${f.expectation} (${f.detail})`).join('; ')}`
      )
    }

    const parts: string[] = []
    if (effects.valueSet?.matched) parts.push(`the control now holds "${effects.valueSet.actual}"`)
    if (effects.urlChanged) parts.push(`navigated to ${effects.urlChanged.to}`)
    const m = effects.mutations
    if (m.nodesAdded.length) {
      parts.push(
        `${m.nodesAdded.length} element${m.nodesAdded.length > 1 ? 's' : ''} appeared ` +
          `(${m.nodesAdded
            .slice(0, 2)
            .map((n) => `${n.role}${n.name ? ` "${n.name.slice(0, 30)}"` : ''}`)
            .join(', ')})`
      )
    }
    if (m.nodesRemoved.length) parts.push(`${m.nodesRemoved.length} element(s) removed`)
    if (m.textChanges.length) parts.push(`text became "${m.textChanges[0].to.slice(0, 50)}"`)
    if (m.attributeChanges.length) {
      const a = m.attributeChanges[0]
      parts.push(`${a.target} ${a.attribute} changed to "${a.to}"`)
    }
    if (effects.requests.length) parts.push(`${effects.requests.length} network request(s)`)
    return `${what} succeeded: ${parts.slice(0, 3).join('; ') || `${m.total} DOM mutation(s)`}.`
  }
}

/** Re-exported so callers can type a summary without reaching into the module. */
export type { MutationSummary }
