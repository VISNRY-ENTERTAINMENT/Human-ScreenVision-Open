import {
  CheckRecord,
  VerifyOptions,
  VerificationResult,
  VerificationIssue,
  CheckedElement,
  DeviceExpectations,
  AnnotationSpec,
  BoundingBox,
  StructureExpectation,
} from '../core/types'
import type { Page } from '../core/Page'
import type { ElementHandle } from '../core/ElementHandle'
import { ElementResolver } from './ElementResolver'
import { AnnotationEngine } from '../capture/AnnotationEngine'
import { DeviceContext } from './DeviceContext'
import { CodeIndex } from './CodeIndex'

const DEFAULT_ELEMENT_TIMEOUT = 2000
const GREEN = '#34C759'
const RED = '#FF3B30'

interface CheckOutcome {
  issues: VerificationIssue[]
  checks: number
}

interface RectInfo {
  tag: string
  text: string
  x: number
  y: number
  width: number
  height: number
}

/**
 * Compares the rendered page against expected semantic structure, layout and
 * device rules, producing structured pass/fail results.
 */
/** Option keys `verify` understands; anything else is a typo the caller wants to hear about. */
const VERIFY_OPTION_KEYS = ['contains', 'notContains', 'structure', 'layout', 'device', 'timeout', 'screenshot']

/**
 * Refuse a verification that would assert nothing.
 *
 * A misspelled key (`elements` for `contains`) used to yield `pass: true, score: 1` with an
 * empty issue list, which reads exactly like a page that is fine. TypeScript catches the
 * literal typo but not options built from JSON, a config file, or a JavaScript caller.
 * @param options - The options passed to verify
 * @throws Error when a key is unrecognised or no check was requested
 */
function assertVerifiable(options: VerifyOptions): void {
  const unknown = Object.keys(options).filter((key) => !VERIFY_OPTION_KEYS.includes(key))
  if (unknown.length > 0) {
    throw new Error(
      `verify: unknown option${unknown.length > 1 ? 's' : ''} ${unknown.join(', ')} ` +
        `(expected any of ${VERIFY_OPTION_KEYS.join(', ')})`
    )
  }
  const requested =
    (options.contains?.length ?? 0) +
    (options.notContains?.length ?? 0) +
    (options.structure?.length ?? 0) +
    (options.layout ? 1 : 0) +
    (options.device ? 1 : 0)
  if (requested === 0) {
    throw new Error(
      'verify: nothing to check — pass at least one of contains, notContains, structure, layout or device'
    )
  }
}

export class VerificationEngine {
  /**
   * @param resolver - Element resolver used to find named elements
   * @param annotationEngine - Used to annotate the failure screenshot
   * @param deviceExpectations - Expectations from the owning context (or null)
   */
  constructor(
    private resolver: ElementResolver,
    private annotationEngine: AnnotationEngine,
    private deviceExpectations: DeviceExpectations | null
  ) {}

  /**
   * Run verification.
   * 1. Each `contains` item must resolve and be visible.
   * 2. Each `notContains` item must be absent or hidden.
   * 3. Layout expectations (columns / navigationVisible / mobileMenuVisible).
   * 4. Device expectations (from `options.device`, else the context device).
   * 5. score = passing checks / total checks; an annotated screenshot is attached when issues exist.
   * @param page - Page to verify
   * @param options - What to verify
   * @param scope - Optional element restricting where `contains`/`notContains` are searched
   * @returns Verification result
   */
  async verify(page: Page, options: VerifyOptions, scope?: ElementHandle): Promise<VerificationResult> {
    const started = Date.now()
    const issues: VerificationIssue[] = []
    const checkedElements: CheckedElement[] = []
    const timeout = options.timeout ?? DEFAULT_ELEMENT_TIMEOUT
    assertVerifiable(options)
    let totalChecks = 0

    for (const name of options.contains ?? []) {
      totalChecks++
      try {
        const resolved = await this.resolver.resolve(name, page, { timeout }, scope)
        const visible = await resolved.handle.isVisible()
        checkedElements.push({ name, found: visible, selector: resolved.selector, bbox: resolved.bbox })
        if (!visible) {
          issues.push({
            severity: 'error',
            element: name,
            message: `"${name}" exists in the DOM but is not visible`,
            expected: 'visible',
            actual: 'hidden',
            bbox: resolved.bbox,
          })
        } else {
          // Actionability: a user must be able to SEE and REACH it. An element parked off the
          // canvas (left:-9999px) or covered by an overlay reads as "present and visible" to a
          // naive check while being useless to a person.
          // A failure of this probe is OUR problem, not the page's: never report it as a defect.
          const facts = await page
            .mapperRef()
            .elementFacts(resolved.handle.nodeId)
            .catch(() => ({ width: 0, height: 0, offCanvas: false, obscured: false, obscuredBy: null }))
          if (facts.offCanvas) {
            issues.push({
              severity: 'error',
              element: name,
              message: `"${name}" is positioned outside the page canvas, so it is invisible to a user`,
              expected: 'inside the document area',
              actual: `${Math.round(facts.width)}x${Math.round(facts.height)} off-canvas`,
              bbox: resolved.bbox,
            })
          } else if (facts.obscured) {
            issues.push({
              severity: 'error',
              element: name,
              message: `"${name}" is covered by ${facts.obscuredBy ?? 'another element'} at its centre point, so clicks would not reach it`,
              expected: 'topmost at its centre point',
              actual: `covered by ${facts.obscuredBy ?? 'unknown element'}`,
              bbox: resolved.bbox,
            })
          }
        }
      } catch (err) {
        checkedElements.push({ name, found: false })
        issues.push({
          severity: 'error',
          element: name,
          message: `"${name}" not found: ${(err as Error).message.split('. Last error')[0]}`,
          expected: 'present and visible',
          actual: 'missing',
        })
      }
    }

    for (const name of options.notContains ?? []) {
      totalChecks++
      try {
        const resolved = await this.resolver.resolve(name, page, { timeout: Math.min(timeout, 1000) }, scope)
        const visible = await resolved.handle.isVisible()
        checkedElements.push({ name, found: visible, selector: resolved.selector, bbox: resolved.bbox })
        if (visible) {
          issues.push({
            severity: 'error',
            element: name,
            message: `"${name}" should not be present but is visible`,
            expected: 'absent or hidden',
            actual: `visible (${resolved.selector})`,
            bbox: resolved.bbox,
          })
        }
      } catch {
        checkedElements.push({ name, found: false })
      }
    }

    for (const exp of options.structure ?? []) {
      const outcome = await this.checkStructure(page, exp, timeout, scope)
      issues.push(...outcome.issues)
      totalChecks += outcome.checks
    }

    if (options.layout) {
      const outcome = await this.checkLayoutOutcome(page, options.layout)
      issues.push(...outcome.issues)
      totalChecks += outcome.checks
    }

    let expectations = this.deviceExpectations
    if (options.device) {
      const device = typeof options.device === 'string' ? DeviceContext.getDevice(options.device) : options.device
      expectations = DeviceContext.buildExpectations(device)
    }
    if (expectations) {
      const outcome = await this.checkDeviceOutcome(page, expectations)
      issues.push(...outcome.issues)
      totalChecks += outcome.checks
    }

    // A check that could not run proves nothing, so it must not be scored as a pass and must
    // not be silently blended into a failure count either.
    const couldNotRun = issues.filter((i) => i.severity === 'error' && i.notRun === true)
    const failed = issues.filter((i) => i.severity === 'error' && i.notRun !== true).length
    const ranChecks = Math.max(0, totalChecks - couldNotRun.length)
    const score = ranChecks === 0 ? 0 : Math.max(0, (ranChecks - failed) / ranChecks)
    const checks: CheckRecord[] = [
      ...checkedElements.map((c) => ({
        id: `contains:${c.name}`,
        status: (c.found ? 'pass' : 'fail') as CheckRecord['status'],
        target: c.name,
        expected: 'present and visible',
        actual: c.found ? 'present and visible' : 'missing or not visible',
      })),
      ...issues
        .filter((i) => i.severity === 'error')
        .map((i) => ({
          id: `${i.notRun ? 'could-not-run' : 'issue'}:${i.element ?? 'page'}`,
          status: (i.notRun ? 'could-not-run' : 'fail') as CheckRecord['status'],
          target: i.element ?? 'page',
          expected: i.expected ?? '',
          actual: i.actual ?? i.message,
        })),
    ]
    const result: VerificationResult = {
      pass: failed === 0 && couldNotRun.length === 0,
      score,
      issues,
      checkedElements,
      checks,
      incomplete: couldNotRun.length > 0,
      durationMs: Date.now() - started,
    }
    if (options.screenshot === true && issues.length > 0) {
      result.screenshotBuffer = await this.annotatedScreenshot(page, checkedElements, issues)
    }
    result.durationMs = Date.now() - started
    return result
  }

  /**
   * Device-specific checks (mobile: hamburger visible, desktop nav hidden, tap targets;
   * desktop: nav links visible, no horizontal scroll; all: no overlapping interactive elements).
   * @param page - Page
   * @param expectations - Device expectations
   * @returns Issues found
   */
  private async checkDeviceExpectations(page: Page, expectations: DeviceExpectations): Promise<VerificationIssue[]> {
    return (await this.checkDeviceOutcome(page, expectations)).issues
  }

  /**
   * Structural check for one named element: counts of links/buttons/headings/images/inputs,
   * an arbitrary selector count, and required text.
   * @param page - Page under test
   * @param exp - Expectation for one element
   * @param timeout - Resolution timeout in ms
   * @param scope - Optional element restricting resolution
   * @returns Issues found and the number of checks performed
   */
  private async checkStructure(
    page: Page,
    exp: StructureExpectation,
    timeout: number,
    scope?: ElementHandle
  ): Promise<CheckOutcome> {
    const issues: VerificationIssue[] = []
    let checks = 0
    let resolved
    try {
      resolved = await this.resolver.resolve(exp.element, page, { timeout }, scope)
    } catch (err) {
      return {
        checks: 1,
        issues: [
          {
            severity: 'error',
            element: exp.element,
            notRun: true,
            message:
              `structure check for "${exp.element}" could not run: the element was not found ` +
              `(${(err as Error).message.split('. Last error')[0]}). This check asserted nothing.`,
            expected: 'present',
            actual: 'missing',
          },
        ],
      }
    }
    const raw = await page.mapperRef().callFunctionOn<string>(
      resolved.handle.nodeId,
      `function() {
        const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
          return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' }
        const count = (sel) => Array.prototype.slice.call(this.querySelectorAll(sel)).filter(vis).length
        return JSON.stringify({
          links: count('a'),
          buttons: count('button, [role="button"], input[type="submit"], input[type="button"]'),
          headings: count('h1, h2, h3, h4, h5, h6'),
          images: count('img, svg'),
          inputs: count('input, select, textarea'),
          text: (this.textContent || '').replace(/\\s+/g, ' ').trim()
        })
      }`
    )
    const counts = JSON.parse(raw) as {
      links: number
      buttons: number
      headings: number
      images: number
      inputs: number
      text: string
    }

    const pairs: Array<[keyof StructureExpectation, number, string]> = [
      ['links', counts.links, 'link'],
      ['buttons', counts.buttons, 'button'],
      ['headings', counts.headings, 'heading'],
      ['images', counts.images, 'image'],
      ['inputs', counts.inputs, 'input'],
    ]
    for (const [key, actual, noun] of pairs) {
      const want = exp[key] as number | undefined
      if (want === undefined) continue
      checks++
      if (actual !== want) {
        issues.push({
          severity: 'error',
          element: exp.element,
          message: `"${exp.element}" should have ${want} ${noun}${want === 1 ? '' : 's'}; it has ${actual}`,
          expected: `${want} ${noun}${want === 1 ? '' : 's'}`,
          actual: String(actual),
          bbox: resolved.bbox,
        })
      }
    }
    if (exp.selector !== undefined && exp.count !== undefined) {
      checks++
      const n = await page.mapperRef().callFunctionOn<number>(
        resolved.handle.nodeId,
        `function() { return this.querySelectorAll(${JSON.stringify(exp.selector)}).length }`
      )
      if (n !== exp.count) {
        issues.push({
          severity: 'error',
          element: exp.element,
          message: `"${exp.element}" should contain ${exp.count} element(s) matching ${exp.selector}; it has ${n}`,
          expected: `${exp.count} x ${exp.selector}`,
          actual: String(n),
          bbox: resolved.bbox,
        })
      }
    }
    if (exp.text !== undefined) {
      checks++
      if (!counts.text.toLowerCase().includes(exp.text.toLowerCase())) {
        issues.push({
          severity: 'error',
          element: exp.element,
          message: `"${exp.element}" should contain the text "${exp.text}"`,
          expected: `text containing "${exp.text}"`,
          actual: counts.text.slice(0, 120),
          bbox: resolved.bbox,
        })
      }
    }
    return { issues, checks }
  }

  private async checkDeviceOutcome(page: Page, expectations: DeviceExpectations): Promise<CheckOutcome> {
    const issues: VerificationIssue[] = []
    let checks = 0
    try {
      // ROOT-CAUSE CHECK (runs before the layout checks it explains).
      // A page with no <meta name="viewport"> is laid out at Chrome's 980px "wide viewport"
      // fallback on a phone, so every max-width media query silently fails to match. Without
      // this check the report blames the symptom ("hamburger missing") instead of the cause.
      let viewportMetaMissing = false
      if (expectations.layoutType === 'mobile' || expectations.layoutType === 'tablet') {
        checks++
        const vp = await this.viewportMetaState(page)
        if (!vp.hasDeviceWidth) {
          viewportMetaMissing = true
          issues.push({
            severity: 'error',
            element: 'viewport meta',
            message: vp.hasTag
              ? `<meta name="viewport"> does not set a device width ("${vp.content}"), so the page lays out at ${vp.layoutWidth}px on this device and mobile media queries never match`
              : `Page has no <meta name="viewport">, so it lays out at ${vp.layoutWidth}px on this ${expectations.layoutType} device (media queries never match, text renders small)`,
            expected: '<meta name="viewport" content="width=device-width, initial-scale=1">',
            actual: vp.hasTag ? `content="${vp.content}"` : 'tag absent',
          })
        }
      }

      if (expectations.layoutType === 'mobile') {
        checks++
        const hamburger = await this.hamburgerVisible(page)
        if (!hamburger) {
          issues.push({
            severity: viewportMetaMissing ? 'info' : 'error',
            element: 'hamburger menu',
            message: viewportMetaMissing
              ? 'Hamburger menu not visible (consequence of the missing viewport meta tag above, not an independent defect)'
              : 'Mobile layout expected a visible hamburger menu button',
            expected: 'visible [aria-label*="menu"], .hamburger or .menu-toggle',
            actual: 'not visible',
          })
        }
        checks++
        const desktopNavVisible = await page.evaluate<boolean>(
          `(() => { const el = document.querySelector('nav ul, nav .nav-links'); if (!el) return false; const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' })()`
        )
        if (desktopNavVisible) {
          issues.push({
            severity: viewportMetaMissing ? 'info' : 'warning',
            element: 'navigation',
            message: viewportMetaMissing
              ? 'Desktop navigation links visible (consequence of the missing viewport meta tag above)'
              : 'Desktop navigation links are visible on a mobile viewport',
            expected: 'nav links collapsed into a menu',
            actual: 'nav ul visible',
          })
        }
        checks++
        const small = await this.smallTapTargets(page, expectations.minTapTargetSize)
        if (small.length > 0) {
          const sample = small.slice(0, 5).map((t) => `${t.tag} "${t.text}" ${Math.round(t.width)}x${Math.round(t.height)}`)
          issues.push({
            severity: 'warning',
            message: `${small.length} tap target(s) smaller than ${expectations.minTapTargetSize}px: ${sample.join('; ')}`,
            expected: `>= ${expectations.minTapTargetSize}x${expectations.minTapTargetSize}px`,
            actual: `${small.length} undersized`,
            bbox: { x: small[0].x, y: small[0].y, width: small[0].width, height: small[0].height },
          })
        }
      } else if (expectations.layoutType === 'desktop') {
        checks++
        const navLinks = await page.evaluate<number>(
          `Array.from(document.querySelectorAll('nav a, [role="navigation"] a')).filter(a => { const r = a.getBoundingClientRect(); return r.width > 0 && r.height > 0 }).length`
        )
        const hasNav = await page.evaluate<boolean>(`Boolean(document.querySelector('nav, [role="navigation"]'))`)
        if (hasNav && navLinks === 0) {
          issues.push({
            severity: 'error',
            element: 'navigation',
            message: 'Desktop layout expected visible navigation links',
            expected: 'nav a visible',
            actual: 'no visible links inside nav',
          })
        }
        checks++
        const scroll = await page.evaluate<{ scrollWidth: number; clientWidth: number }>(
          `({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth })`
        )
        if (scroll.scrollWidth > scroll.clientWidth + 1) {
          issues.push({
            severity: 'error',
            message: 'Page has horizontal overflow on desktop',
            expected: `scrollWidth <= ${scroll.clientWidth}`,
            actual: `scrollWidth ${scroll.scrollWidth}`,
          })
        }
      }
      checks++
      const overlaps = await this.overlappingInteractive(page)
      if (overlaps.length > 0) {
        issues.push({
          severity: 'warning',
          message: `${overlaps.length} pair(s) of overlapping interactive elements: ${overlaps.slice(0, 3).join('; ')}`,
          expected: 'no intersecting buttons/links',
          actual: `${overlaps.length} overlaps`,
        })
      }
    } catch (err) {
      issues.push({ severity: 'warning', message: `Device checks incomplete: ${(err as Error).message}` })
    }
    return { issues, checks }
  }

  /**
   * Layout checks: column count, navigation visibility, mobile menu visibility.
   * @param page - Page
   * @param layout - Layout expectation
   * @returns Issues found
   */
  private async checkLayout(page: Page, layout: NonNullable<VerifyOptions['layout']>): Promise<VerificationIssue[]> {
    return (await this.checkLayoutOutcome(page, layout)).issues
  }

  private async checkLayoutOutcome(page: Page, layout: NonNullable<VerifyOptions['layout']>): Promise<CheckOutcome> {
    const issues: VerificationIssue[] = []
    let checks = 0
    try {
      if (typeof layout.columns === 'number') {
        checks++
        const actual = await page.evaluate<number>(`(() => {
          const root = document.querySelector('main') || document.body
          let best = 1
          const visit = (el, depth) => {
            if (depth > 4) return
            const kids = Array.from(el.children).filter(k => { const r = k.getBoundingClientRect(); return r.width > 0 && r.height > 0 })
            if (kids.length > 1) {
              const firstTop = Math.round(kids[0].getBoundingClientRect().top)
              const row = kids.filter(k => Math.abs(Math.round(k.getBoundingClientRect().top) - firstTop) < 4)
              if (row.length > 1) {
                const widths = row.map(k => k.getBoundingClientRect().width)
                const avg = widths.reduce((a, b) => a + b, 0) / widths.length
                const uniform = widths.every(w => Math.abs(w - avg) / avg < 0.25)
                if (uniform && row.length > best) best = row.length
              }
            }
            for (const k of kids) visit(k, depth + 1)
          }
          visit(root, 0)
          return best
        })()`)
        if (actual !== layout.columns) {
          issues.push({
            severity: 'error',
            message: `Expected ${layout.columns} column(s) in main content, found ${actual}`,
            expected: String(layout.columns),
            actual: String(actual),
          })
        }
      }
      if (typeof layout.navigationVisible === 'boolean') {
        checks++
        const visible = await page.evaluate<boolean>(
          `(() => { const el = document.querySelector('nav, [role="navigation"]'); if (!el) return false; const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden' })()`
        )
        if (visible !== layout.navigationVisible) {
          issues.push({
            severity: 'error',
            element: 'navigation',
            message: `Navigation visibility mismatch`,
            expected: layout.navigationVisible ? 'visible' : 'hidden',
            actual: visible ? 'visible' : 'hidden',
          })
        }
      }
      if (typeof layout.mobileMenuVisible === 'boolean') {
        checks++
        const visible = await this.hamburgerVisible(page)
        if (visible !== layout.mobileMenuVisible) {
          issues.push({
            severity: 'error',
            element: 'hamburger menu',
            message: `Mobile menu visibility mismatch`,
            expected: layout.mobileMenuVisible ? 'visible' : 'hidden',
            actual: visible ? 'visible' : 'hidden',
          })
        }
      }
    } catch (err) {
      issues.push({ severity: 'warning', message: `Layout checks incomplete: ${(err as Error).message}` })
    }
    return { issues, checks }
  }


  /**
   * Read the page's viewport meta tag and its effective layout width.
   * @param page - Page under test
   * @returns tag presence, its content, whether it sets a device width, and the layout width in CSS px
   */
  private async viewportMetaState(
    page: Page
  ): Promise<{ hasTag: boolean; content: string; hasDeviceWidth: boolean; layoutWidth: number }> {
    const raw = await page.evaluate<string>(
      `(() => { const m = document.querySelector('meta[name="viewport" i]'); ` +
        `return JSON.stringify({ hasTag: Boolean(m), content: m ? (m.getAttribute('content') || '') : '', layoutWidth: document.documentElement.clientWidth }) })()`
    )
    const parsed = JSON.parse(raw) as { hasTag: boolean; content: string; layoutWidth: number }
    const content = parsed.content.toLowerCase()
    const hasDeviceWidth = parsed.hasTag && (/width\s*=\s*device-width/.test(content) || /width\s*=\s*\d+/.test(content))
    return { ...parsed, hasDeviceWidth }
  }

  private async hamburgerVisible(page: Page): Promise<boolean> {
    return page.evaluate<boolean>(
      `(() => {
        const candidates = document.querySelectorAll('[aria-label*="menu" i], .hamburger, .menu-toggle, [data-testid*="menu" i], button[aria-controls]')
        for (const el of candidates) {
          const r = el.getBoundingClientRect(); const s = getComputedStyle(el)
          if (r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden') return true
        }
        return false
      })()`
    )
  }

  private async smallTapTargets(page: Page, min: number): Promise<RectInfo[]> {
    return page.evaluate<RectInfo[]>(`(() => {
      const out = []
      for (const el of document.querySelectorAll('a, button, input, select, textarea, [role="button"]')) {
        const r = el.getBoundingClientRect(); const s = getComputedStyle(el)
        if (r.width === 0 || r.height === 0 || s.display === 'none' || s.visibility === 'hidden') continue
        if (r.width < ${min} || r.height < ${min}) out.push({ tag: el.tagName.toLowerCase(), text: (el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 30), x: r.x, y: r.y, width: r.width, height: r.height })
      }
      return out
    })()`)
  }

  private async overlappingInteractive(page: Page): Promise<string[]> {
    return page.evaluate<string[]>(`(() => {
      const els = Array.from(document.querySelectorAll('a, button, input, select, [role="button"]')).slice(0, 200)
      const boxes = els.map(el => ({ el, r: el.getBoundingClientRect() })).filter(b => b.r.width > 0 && b.r.height > 0)
      const out = []
      for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i], b = boxes[j]
        if (a.el.contains(b.el) || b.el.contains(a.el)) continue
        const ix = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left)
        const iy = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top)
        if (ix > 2 && iy > 2) out.push(a.el.tagName.toLowerCase() + ' "' + (a.el.textContent || '').trim().slice(0, 20) + '" x ' + b.el.tagName.toLowerCase() + ' "' + (b.el.textContent || '').trim().slice(0, 20) + '"')
        if (out.length >= 20) return out
      }
      return out
    })()`)
  }

  private async annotatedScreenshot(
    page: Page,
    checked: CheckedElement[],
    issues: VerificationIssue[]
  ): Promise<Buffer | undefined> {
    try {
      const raw = await page.mapperRef().screenshot({ format: 'png' })
      const metrics = await page.mapperRef().layoutMetrics()
      const dpr = await page.mapperRef().evaluate<number>('window.devicePixelRatio || 1')
      const annotations: AnnotationSpec[] = []
      for (const c of checked) {
        if (c.found && c.bbox) annotations.push({ bbox: scaleBox(c.bbox, dpr), style: 'highlight', label: c.name, color: GREEN })
      }
      let missingIndex = 0
      for (const issue of issues) {
        if (issue.severity !== 'error') continue
        if (issue.bbox) {
          annotations.push({ bbox: scaleBox(issue.bbox, dpr), style: 'box', label: issue.element ?? issue.message, color: RED })
          continue
        }
        const region = issue.element ? this.regionFor(issue.element) : 'center'
        const w = metrics.viewport.width
        const h = metrics.viewport.height
        const y = region === 'top' ? 24 : region === 'bottom' ? h - 48 : h / 2
        const bbox: BoundingBox = { x: 24, y: y + missingIndex * 22, width: Math.max(1, w - 48), height: 18 }
        annotations.push({ bbox: scaleBox(bbox, dpr), style: 'label-only', label: `MISSING: ${issue.element ?? issue.message}`, color: RED })
        missingIndex++
      }
      return await this.annotationEngine.annotate(raw, annotations)
    } catch {
      return undefined
    }
  }

  private regionFor(name: string): 'top' | 'bottom' | 'center' {
    const role = CodeIndex.inferSemanticRole(name.replace(/\s+/g, ''), '')
    const region = CodeIndex.inferPosition(role).region
    return region === 'top' ? 'top' : region === 'bottom' ? 'bottom' : 'center'
  }

  /** Exposed for direct use in tests / diagnostics. */
  async deviceIssues(page: Page, expectations: DeviceExpectations): Promise<VerificationIssue[]> {
    return this.checkDeviceExpectations(page, expectations)
  }

  /** Exposed for direct use in tests / diagnostics. */
  async layoutIssues(page: Page, layout: NonNullable<VerifyOptions['layout']>): Promise<VerificationIssue[]> {
    return this.checkLayout(page, layout)
  }
}

function scaleBox(b: BoundingBox, s: number): BoundingBox {
  return { x: b.x * s, y: b.y * s, width: b.width * s, height: b.height * s }
}
