import type { Page } from '../core/Page'
import { ElementHandle } from '../core/ElementHandle'
import {
  Candidate,
  CodeIndexResult,
  ComponentEntry,
  FindOptions,
  FindStrategy,
  ResolvedElement,
  SemanticRole,
} from '../core/types'
import { VisionResolver } from '../vision/VisionResolver'
import { splitWords } from './CodeIndex'
import { SemanticMatcher } from './SemanticMatcher'

// QUERY NORMALIZATION TABLE — natural-language phrasings → canonical semantic category.
const SEMANTIC_ALIASES: Record<string, string[]> = {
  navigation: ['nav', 'navbar', 'navigation bar', 'menu', 'nav bar', 'header nav', 'main nav', 'navigation'],
  header: ['header', 'page header', 'site header', 'top bar'],
  footer: ['footer', 'page footer', 'site footer', 'bottom bar'],
  hero: ['hero', 'hero section', 'banner', 'jumbotron', 'splash', 'landing'],
  sidebar: ['sidebar', 'side bar', 'aside', 'side panel', 'drawer'],
  'main-content': ['main', 'content', 'main content', 'body', 'page content'],
  form: ['form', 'login form', 'signup form', 'register form', 'contact form'],
  button: ['button', 'btn', 'submit button', 'cta', 'call to action'],
  modal: ['modal', 'dialog', 'popup', 'overlay', 'lightbox'],
  search: ['search', 'search bar', 'search box', 'search input'],
}

/** Bare element words that map to a concrete tag, used for "<container> <thing>" queries. */
const ELEMENT_TAG_FOR: Record<string, string> = {
  button: 'button, [role="button"]',
  link: 'a',
  input: 'input, textarea, select',
  image: 'img',
  heading: 'h1, h2, h3, h4, h5, h6',
  cta: 'button, a[class*="btn" i], [class*="cta" i]',
  logo: '[class*="logo" i], [alt*="logo" i]',
}

const ARIA_ROLE_FOR: Record<string, string> = {
  navigation: 'navigation',
  header: 'banner',
  footer: 'contentinfo',
  'main-content': 'main',
  form: 'form',
  search: 'search',
  modal: 'dialog',
  button: 'button',
}

const SEMANTIC_TAG_FOR: Record<string, string> = {
  navigation: 'nav',
  header: 'header',
  footer: 'footer',
  'main-content': 'main',
  sidebar: 'aside',
  form: 'form',
  modal: 'dialog',
  button: 'button',
  search: '[type="search"], .search, [data-search]',
}

const STOP_WORDS = new Set(['the', 'a', 'an', 'of', 'in', 'on', 'this', 'that', 'element', 'area', 'section', 'bar', 'component'])

const POLL_INTERVAL = 250
const DEFAULT_TIMEOUT = 30000

/**
 * Resolves natural-language element descriptions through three tiers:
 * code index → live DOM → vision model.
 */
export class ElementResolver {
  /**
   * @param codeIndex - Code index (or null when launched without `codebase`)
   * @param visionResolver - Vision resolver (or null when no `visionEndpoint` is configured)
   */
  constructor(
    private codeIndex: CodeIndexResult | null,
    private visionResolver: VisionResolver | null
  ) {}

  /**
   * Resolve a description to a single element, retrying tiers until `options.timeout`.
   * @param query - e.g. `'navigation bar'`
   * @param page - Page to search
   * @param options - timeout (default 30000), strategy (default `auto`), context hint
   * @param scope - Optional element to search within
   * @returns The resolved element with strategy/confidence/selector/bbox
   * @throws Error describing the query and tiers attempted when nothing matches
   */
  async resolve(query: string, page: Page, options?: FindOptions, scope?: ElementHandle): Promise<ResolvedElement> {
    const timeout = options?.timeout ?? DEFAULT_TIMEOUT
    const strategy: FindStrategy = options?.strategy ?? 'auto'
    const deadline = Date.now() + timeout
    const attempted: string[] = []
    let lastError: string | null = null

    for (;;) {
      try {
        if (strategy === 'auto' || strategy === 'code-index') {
          if (this.codeIndex) {
            attempted.push('code-index')
            const hit = await this.resolveFromCodeIndex(query, page, scope)
            if (hit) return hit
          }
        }
        if (strategy === 'auto' || strategy === 'dom') {
          attempted.push('dom')
          const hit = await this.resolveFromDOM(query, page, scope, options?.context)
          if (hit) return hit
        }
        if ((strategy === 'auto' || strategy === 'vision') && this.visionResolver && !scope) {
          attempted.push('vision')
          const hit = await this.resolveFromVision(query, page)
          if (hit) return hit
        }
      } catch (err) {
        lastError = (err as Error).message
      }
      if (Date.now() + POLL_INTERVAL > deadline) break
      await new Promise((r) => setTimeout(r, POLL_INTERVAL))
    }

    const tiers = Array.from(new Set(attempted)).join(', ') || 'none'
    throw new Error(
      `ElementResolver.resolve: no element matched "${query}" within ${timeout}ms ` +
        `(normalized: "${this.normalizeQuery(query)}", tiers tried: ${tiers}` +
        `${this.codeIndex ? '' : '; no code index'}${this.visionResolver ? '' : '; vision disabled'})` +
        (lastError ? `. Last error: ${lastError}` : '')
    )
  }

  /**
   * Resolve every element matching a description (all DOM matches of the first selector that hits).
   * @param query - Semantic description
   * @param page - Page to search
   * @param options - Find options
   * @returns Handles (empty when nothing matches)
   */
  async resolveAll(query: string, page: Page, options?: FindOptions): Promise<ElementHandle[]> {
    let first: ResolvedElement
    try {
      first = await this.resolve(query, page, options)
    } catch {
      return []
    }
    if (first.strategy === 'vision' || !first.selector) return [first.handle]
    try {
      const all = await page.$$(first.selector)
      return all.length > 0 ? all : [first.handle]
    } catch {
      return [first.handle]
    }
  }

  /**
   * TIER 1 — code index: exact name (1.0), semantic role (0.8), partial name (0.6);
   * each candidate's selectors are verified against the live DOM.
   */
  private async resolveFromCodeIndex(query: string, page: Page, scope?: ElementHandle): Promise<ResolvedElement | null> {
    if (!this.codeIndex) return null
    const canonical = this.normalizeQuery(query)
    const compact = query.toLowerCase().replace(/[^a-z0-9]/g, '')
    const terms = this.queryTerms(query)
    const candidates: Array<{ entry: ComponentEntry; confidence: number }> = []

    for (const entry of this.codeIndex.components.values()) {
      const nameLower = entry.name.toLowerCase()
      const nameWords = splitWords(entry.name)
      if (nameLower === compact || nameLower === canonical.replace(/[^a-z0-9]/g, '')) {
        candidates.push({ entry, confidence: 1.0 })
        continue
      }
      if (entry.semanticRole !== 'unknown' && entry.semanticRole === (canonical as SemanticRole)) {
        candidates.push({ entry, confidence: 0.8 })
        continue
      }
      if (terms.length > 0 && terms.every((t) => nameWords.includes(t) || nameLower.includes(t))) {
        candidates.push({ entry, confidence: 0.6 })
      }
    }
    if (candidates.length === 0) return null
    candidates.sort((a, b) => b.confidence - a.confidence)

    for (const { entry, confidence } of candidates) {
      for (const selector of [entry.selector, ...entry.alternateSelectors]) {
        const handle = await this.query(page, scope, selector)
        if (!handle) continue
        const bbox = await handle.boundingBox()
        if (!bbox) continue
        return { handle, strategy: 'code-index', confidence, selector, bbox, componentName: entry.name }
      }
    }
    return null
  }

  /**
   * TIER 2 — live DOM: ARIA role (0.9) → semantic tag (0.85) → data-testid / aria-label /
   * class / id containing a query term (0.7).
   */
  private async resolveFromDOM(
    query: string,
    page: Page,
    scope?: ElementHandle,
    contextHint?: string
  ): Promise<ResolvedElement | null> {
    const canonical = this.normalizeQuery(query)

    // TEXT AND ROLE FIRST. What a control says is what a person calls it, and it is the one
    // thing CSS cannot select on, so an ordinary `<button id="submit">Sign in</button>` is
    // invisible to every identifier-matching tier below.
    const matcher = new SemanticMatcher(page)
    const ranked = await matcher
      .candidates(query, { withinSelector: scope ? scope.selector : undefined, limit: 5 })
      .catch(() => [])
    const best = ranked.find((c) => c.visible && c.score >= 0.6)
    if (best) {
      const handle = await this.query(page, scope, best.selector).catch(() => null)
      if (handle) {
        const bbox = await handle.boundingBox()
        if (bbox) {
          return { handle, strategy: 'dom', confidence: best.score, selector: best.selector, bbox }
        }
      }
    }

    const attempts: Array<{ selector: string; confidence: number }> = []

    // SPECIFIC BEFORE GENERIC. A multi-word query like "hero cta" or "login button" names one
    // element, not its category; collapsing it straight to the "hero" / "button" alias returns
    // the container and silently answers a different question. Try the whole phrase as an
    // identifier first (hero cta -> [data-testid*="hero-cta"]), and only then the category.
    const rawTerms = this.queryTerms(query)
    if (rawTerms.length > 1) {
      const joined = Array.from(new Set([rawTerms.join('-'), rawTerms.join('_'), rawTerms.join('')]))
      for (const form of joined) {
        const f = form.replace(/["\\]/g, '')
        if (!f) continue
        attempts.push({ selector: `[data-testid*="${f}" i]`, confidence: 0.88 })
        attempts.push({ selector: `[aria-label*="${f}" i]`, confidence: 0.88 })
        attempts.push({ selector: `[id*="${f}" i]`, confidence: 0.86 })
        attempts.push({ selector: `[class*="${f}" i]`, confidence: 0.82 })
      }
      // "<container> <thing>" — e.g. "hero cta" as a descendant of the hero
      const containerTag = SEMANTIC_TAG_FOR[this.normalizeQuery(rawTerms[0])]
      const containerRole = ARIA_ROLE_FOR[this.normalizeQuery(rawTerms[0])]
      const lastTerm = rawTerms[rawTerms.length - 1].replace(/["\\]/g, '')
      const scopeSel = containerTag ?? (containerRole ? `[role="${containerRole}"]` : '')
      if (scopeSel && lastTerm) {
        for (const attr of ['data-testid', 'aria-label', 'class', 'id']) {
          attempts.push({ selector: `${scopeSel} [${attr}*="${lastTerm}" i]`, confidence: 0.8 })
        }
        if (ELEMENT_TAG_FOR[lastTerm]) {
          attempts.push({ selector: `${scopeSel} ${ELEMENT_TAG_FOR[lastTerm]}`, confidence: 0.78 })
        }
      }
    }

    const role = ARIA_ROLE_FOR[canonical]
    if (role) attempts.push({ selector: `[role="${role}"]`, confidence: 0.9 })
    const tag = SEMANTIC_TAG_FOR[canonical]
    if (tag) attempts.push({ selector: tag, confidence: 0.85 })

    const terms = this.queryTerms(query)
    if (canonical !== query.toLowerCase().trim() && !terms.includes(canonical)) terms.unshift(canonical)
    const attributeTerms = Array.from(new Set(terms.concat(terms.length > 1 ? [terms.join('-'), terms.join('')] : [])))
    for (const term of attributeTerms) {
      const t = term.replace(/["\\]/g, '')
      if (!t) continue
      attempts.push({ selector: `[data-testid*="${t}" i]`, confidence: 0.7 })
      attempts.push({ selector: `[aria-label*="${t}" i]`, confidence: 0.7 })
      attempts.push({ selector: `[class*="${t}" i]`, confidence: 0.7 })
      attempts.push({ selector: `[id*="${t}" i]`, confidence: 0.7 })
    }

    const hintPrefix = contextHint ? `${SEMANTIC_TAG_FOR[this.normalizeQuery(contextHint)] ?? ''} ` : ''
    for (const attempt of attempts) {
      const selector = hintPrefix.trim() ? `${hintPrefix}${attempt.selector}` : attempt.selector
      const handle = await this.query(page, scope, selector).catch(() => null)
      if (!handle) continue
      const bbox = await handle.boundingBox()
      if (!bbox) continue
      return { handle, strategy: 'dom', confidence: attempt.confidence, selector, bbox }
    }
    // record what was closest so the failure can say something useful about the page
    this.lastNearMisses = ranked.slice(0, 3)
    return null
  }

  /** The closest non-matching candidates from the most recent DOM resolution. */
  lastNearMisses: Candidate[] = []

  /**
   * TIER 3 — vision: screenshot → bounding box from the vision model → DOM element
   * at the box centre (`document.elementFromPoint`). Confidence 0.6.
   */
  private async resolveFromVision(query: string, page: Page): Promise<ResolvedElement | null> {
    if (!this.visionResolver) return null
    const mapper = page.mapperRef()
    const screenshot = await mapper.screenshot({ format: 'png' })
    const result = await this.visionResolver.findElement(screenshot, query)
    if (!result.found || !result.bbox) return null
    const dpr = await mapper.evaluate<number>('window.devicePixelRatio || 1')
    const cssBox = {
      x: result.bbox.x / dpr,
      y: result.bbox.y / dpr,
      width: result.bbox.width / dpr,
      height: result.bbox.height / dpr,
    }
    const cx = cssBox.x + cssBox.width / 2
    const cy = cssBox.y + cssBox.height / 2
    const nodeId = await mapper.nodeIdForExpression(`document.elementFromPoint(${cx}, ${cy})`)
    if (nodeId === null) return null
    const handle = new ElementHandle(mapper, nodeId, `vision:${query}`, page)
    const bbox = (await handle.boundingBox()) ?? cssBox
    return { handle, strategy: 'vision', confidence: Math.min(0.6, result.confidence || 0.6), selector: '', bbox }
  }

  /**
   * Lowercase + trim, then map through SEMANTIC_ALIASES (exact phrase, then
   * phrase minus stop words) to a canonical category; otherwise the cleaned query.
   */
  private normalizeQuery(query: string): string {
    const q = query.toLowerCase().trim().replace(/\s+/g, ' ')
    for (const [canonical, aliases] of Object.entries(SEMANTIC_ALIASES)) {
      if (canonical === q || aliases.includes(q)) return canonical
    }
    const stripped = q
      .split(' ')
      .filter((w) => !STOP_WORDS.has(w))
      .join(' ')
    for (const [canonical, aliases] of Object.entries(SEMANTIC_ALIASES)) {
      if (canonical === stripped || aliases.includes(stripped)) return canonical
    }
    return q
  }

  private queryTerms(query: string): string[] {
    return query
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 2 && !STOP_WORDS.has(w))
  }

  private async query(page: Page, scope: ElementHandle | undefined, selector: string): Promise<ElementHandle | null> {
    return scope ? scope.$(selector) : page.$(selector)
  }
}
