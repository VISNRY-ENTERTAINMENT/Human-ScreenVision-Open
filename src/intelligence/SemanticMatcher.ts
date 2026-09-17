import type { Page } from '../core/Page'
import type { Candidate } from '../core/types'
import { DEEP_TRAVERSAL } from './domTraversal'

/**
 * Finds elements the way a person names them: by what they say, not by what they are called
 * in the markup.
 *
 * The resolver's attribute tiers match substrings of `id`, `class` and `data-testid`, which
 * fails on the most ordinary markup there is. `<button id="submit">Sign in</button>` does not
 * match "sign in button", because the only place those words appear is the visible text, and
 * CSS cannot select on text. The consequence is worse than a miss: asking for "Export CSV"
 * matched `#export` on the id while ignoring the label, so the same query could return the
 * right element for the wrong reason and a different element on a page that renamed its ids.
 *
 * This scores every plausible candidate in one pass and returns them ranked, with the reason
 * for each score. Ranked candidates also let a caller see the runners-up instead of silently
 * receiving the first match.
 */
export class SemanticMatcher {
  /**
   * @param page - Page to search
   */
  constructor(private page: Page) {}

  /**
   * Rank the elements that could be what the query names.
   * @param query - Natural-language description, e.g. `'sign in button'`
   * @param options - Restrict to a subtree, and how many candidates to return
   * @returns Candidates, best first; empty when nothing scores above the floor
   */
  async candidates(query: string, options?: { withinSelector?: string; limit?: number }): Promise<Candidate[]> {
    const limit = options?.limit ?? 10
    const raw = await this.page
      .evaluate<string>(matcherSource(query, options?.withinSelector ?? '', limit))
      .catch(() => '[]')
    try {
      return JSON.parse(raw) as Candidate[]
    } catch {
      return []
    }
  }
}

/** Role words a query may end with, mapped to the elements that can satisfy them. */
const ROLE_VOCABULARY: Record<string, string[]> = {
  button: ['button'],
  link: ['link'],
  input: ['textbox', 'searchbox', 'combobox', 'spinbutton'],
  field: ['textbox', 'searchbox', 'combobox', 'spinbutton'],
  textbox: ['textbox'],
  checkbox: ['checkbox'],
  radio: ['radio'],
  dropdown: ['combobox', 'listbox'],
  select: ['combobox', 'listbox'],
  table: ['table'],
  row: ['row'],
  cell: ['cell'],
  column: ['columnheader'],
  header: ['columnheader', 'banner', 'heading'],
  heading: ['heading'],
  tab: ['tab'],
  dialog: ['dialog'],
  modal: ['dialog'],
  image: ['img'],
  list: ['list'],
  item: ['listitem'],
  menu: ['menu', 'navigation'],
  nav: ['navigation'],
  navigation: ['navigation'],
  form: ['form'],
  footer: ['contentinfo'],
  section: ['region', 'section'],
}

/**
 * The browser-side scorer.
 *
 * One pass, one round trip. Scores are comparative within a single query, which is the only
 * way a caller can meaningfully threshold on them.
 * @param query - The natural-language query
 * @param withinSelector - Restrict to descendants of this selector, or empty for the document
 * @param limit - Maximum candidates to return
 * @returns JavaScript source producing a JSON string
 */
function matcherSource(query: string, withinSelector: string, limit: number): string {
  return `(() => {${DEEP_TRAVERSAL}
  const QUERY = ${JSON.stringify(query.toLowerCase().trim())}
  const WITHIN = ${JSON.stringify(withinSelector)}
  const LIMIT = ${limit}
  const ROLE_VOCAB = ${JSON.stringify(ROLE_VOCABULARY)}

  const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim().toLowerCase()

  // "sign in button" -> wanted roles [button], text "sign in"
  let words = QUERY.split(/[\\s\\-_]+/).filter(Boolean)
  let wantedRoles = null
  if (words.length > 1) {
    const last = words[words.length - 1]
    if (ROLE_VOCAB[last]) {
      wantedRoles = ROLE_VOCAB[last]
      words = words.slice(0, -1)
    }
  } else if (words.length === 1 && ROLE_VOCAB[words[0]]) {
    // "table" or "button" alone names a kind of thing, not a thing that says "table"; leaving
    // the word in the text requirement is why asking for a table never found <table>
    wantedRoles = ROLE_VOCAB[words[0]]
    words = []
  }
  const wantedText = words.join(' ')

  const roleOf = (el) => {
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
    if (tag === 'aside') return 'complementary'
    if (tag === 'section') return 'region'
    if (tag === 'dialog') return 'dialog'
    if (tag === 'img') return 'img'
    if (tag === 'ul' || tag === 'ol') return 'list'
    if (tag === 'li') return 'listitem'
    if (/^h[1-6]$/.test(tag)) return 'heading'
    if (tag === 'input') {
      const t = (el.getAttribute('type') || 'text').toLowerCase()
      if (t === 'checkbox') return 'checkbox'
      if (t === 'radio') return 'radio'
      if (t === 'submit' || t === 'button' || t === 'reset') return 'button'
      if (t === 'search') return 'searchbox'
      if (t === 'number') return 'spinbutton'
      return 'textbox'
    }
    return 'generic'
  }

  const nameOf = (el) => {
    const aria = el.getAttribute('aria-label')
    if (aria) return aria.trim()
    const by = el.getAttribute('aria-labelledby')
    if (by) {
      const parts = by.split(' ').map((id) => { const n = document.getElementById(id); return n ? n.textContent : '' })
      const joined = parts.join(' ').trim()
      if (joined) return joined
    }
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
      if (el.getAttribute('name')) return el.getAttribute('name').trim()
      return ''
    }
    if (tag === 'img') return (el.getAttribute('alt') || '').trim()
    if (tag === 'table' || tag === 'form' || tag === 'nav' || tag === 'section') {
      const cap = el.querySelector('caption, legend, h1, h2, h3')
      if (cap) return cap.textContent.replace(/\\s+/g, ' ').trim().slice(0, 80)
      return ''
    }
    return (el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80)
  }

  const selectorFor = (el) => {
    const testid = el.getAttribute('data-testid')
    if (testid) return '[data-testid="' + testid + '"]'
    if (el.id) return '#' + CSS.escape(el.id)
    const label = el.getAttribute('aria-label')
    if (label) return el.tagName.toLowerCase() + '[aria-label="' + label + '"]'
    const nm = el.getAttribute('name')
    if (nm) return el.tagName.toLowerCase() + '[name="' + nm + '"]'
    let path = el.tagName.toLowerCase()
    if (el.className && typeof el.className === 'string') {
      const first = el.className.trim().split(' ')[0]
      if (first) path += '.' + CSS.escape(first)
    }
    const parent = el.parentElement
    if (parent) {
      const sibs = Array.prototype.filter.call(parent.children, (c) => c.tagName === el.tagName)
      if (sibs.length > 1) path += ':nth-of-type(' + (sibs.indexOf(el) + 1) + ')'
    }
    return path
  }

  const root = WITHIN ? document.querySelector(WITHIN) : document
  if (!root) return '[]'

  const SEARCHABLE = 'a, button, input, select, textarea, summary, table, tr, th, td, nav, header, footer, main, aside, section, form, dialog, ul, ol, li, h1, h2, h3, h4, h5, h6, img, [role], [onclick], [data-testid], [tabindex]:not([tabindex="-1"])'

  const out = []
  const searchSpace = WITHIN ? Array.from(root.querySelectorAll(SEARCHABLE)) : svQueryAll(SEARCHABLE)
  for (const el of searchSpace) {
    const role = roleOf(el)
    const name = norm(nameOf(el))
    const r = el.getBoundingClientRect()
    const style = window.getComputedStyle(el)
    const shown = style.display !== 'none' && style.visibility !== 'hidden' && r.width > 0 && r.height > 0

    let score = 0
    let why = ''

    if (wantedText) {
      if (name === wantedText) { score = 1.0; why = 'exact name match' }
      else if (name.startsWith(wantedText)) { score = 0.92; why = 'name starts with the query' }
      else if (name.includes(wantedText)) { score = 0.86; why = 'name contains the query' }
      else {
        const hits = words.filter((w) => name.includes(w)).length
        if (hits > 0) { score = 0.4 + 0.4 * (hits / words.length); why = hits + ' of ' + words.length + ' words in the name' }
      }
      if (score === 0) {
        const attrs = [el.getAttribute('data-testid'), el.id, typeof el.className === 'string' ? el.className : '', el.getAttribute('name')]
          .filter(Boolean).join(' ').toLowerCase()
        const joined = words.join('')
        const dashed = words.join('-')
        if (attrs.includes(dashed) || attrs.includes(joined)) { score = 0.7; why = 'identifier contains the query' }
        else {
          const hits = words.filter((w) => attrs.includes(w)).length
          if (hits === words.length) { score = 0.6; why = 'identifier contains every query word' }
          else if (hits > 0) { score = 0.35; why = 'identifier contains ' + hits + ' query word(s)' }
        }
      }
    } else if (wantedRoles) {
      score = 0.6
      why = 'role match, no text given'
    }

    if (wantedRoles) {
      if (wantedRoles.indexOf(role) >= 0) { score = Math.min(1, score + 0.12); why = why + ', role matches' }
      // asking for a button and being handed a div is the wrong answer, not a weaker one
      else { score = score * 0.45; why = why + ', but role is ' + role }
    }
    if (!shown) { score = score * 0.35; why = why + ', not visible' }

    if (score >= 0.35) {
      out.push({
        selector: selectorFor(el),
        role: role,
        name: nameOf(el).slice(0, 80),
        score: Math.round(score * 100) / 100,
        why: why,
        visible: shown,
        bbox: { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) }
      })
    }
  }

  out.sort((a, b) => b.score - a.score)
  // an ancestor and its child often both match; prefer the more specific one at equal score
  const seen = new Set()
  const deduped = []
  for (const c of out) {
    if (seen.has(c.selector)) continue
    seen.add(c.selector)
    deduped.push(c)
    if (deduped.length >= LIMIT) break
  }
  return JSON.stringify(deduped)
})()`
}
