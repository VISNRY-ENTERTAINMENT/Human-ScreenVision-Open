/**
 * The accessibility tree as text, which is the cheapest accurate thing to show a model.
 *
 * A screenshot costs thousands of tokens and still leaves the model guessing at structure; a
 * DOM dump is mostly noise. The accessibility tree is what a screen reader would announce:
 * roles, names, states and nesting, with presentational wrappers collapsed away. It is small,
 * stable across restyling, and every line names something the model can then act on by role
 * and name — which is exactly the vocabulary `getByRole` takes.
 *
 * The output is deliberately Playwright-shaped so a model that has seen one can read the
 * other, with one addition: elements that are present but cannot be interacted with are
 * marked, because "the button is there but nothing will happen" is the single most common
 * thing an agent gets wrong.
 */

/**
 * Roles that are named by their content but may also *contain* controls.
 *
 * A button named "Save" has no children worth reporting. A table cell named "Edit Delete" has
 * two, and reporting only the name hides them completely — which is what happened: a five-row
 * invoice grid reported zero actionable controls, silently, because `cell` took its name from
 * content and then refused to descend. Lists were unaffected only because `listitem` happens
 * not to be in the list below. These roles keep their content name when they hold nothing but
 * text, and descend when they hold something a model could act on.
 */
const CONTAINER_NAMED = ['cell', 'columnheader', 'rowheader', 'legend', 'caption', 'treeitem']

/** Roles whose accessible name comes from the text they contain. */
const NAME_FROM_CONTENT = [
  'button',
  'link',
  'heading',
  'option',
  'tab',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'checkbox',
  'radio',
  'switch',
  'cell',
  'columnheader',
  'rowheader',
  'legend',
  'caption',
  'tooltip',
  'treeitem',
]

/**
 * In-page source that renders the accessibility tree beneath a root element.
 * @param includeHidden - Include nodes hidden from assistive technology
 * @param markInert - Annotate elements that cannot receive interaction
 * @param rootExpression - Expression for the element to snapshot beneath
 * @returns JavaScript source producing the snapshot text
 */
export function ariaSnapshotSource(
  includeHidden: boolean,
  markInert: boolean,
  rootExpression = 'document.body'
): string {
  return `(() => {
  const INCLUDE_HIDDEN = ${includeHidden}
  const MARK_INERT = ${markInert}
  const NAME_FROM_CONTENT = ${JSON.stringify(NAME_FROM_CONTENT)}
  const CONTAINER_NAMED = ${JSON.stringify(CONTAINER_NAMED)}

  const hiddenFromAT = (el) => {
    if (el.getAttribute('aria-hidden') === 'true') return true
    if (el.hasAttribute('hidden')) return true
    const style = getComputedStyle(el)
    if (style.display === 'none' || style.visibility === 'hidden') return true
    return false
  }

  const roleOf = (el) => {
    const explicit = el.getAttribute('role')
    if (explicit) return explicit.trim().split(/\\s+/)[0]
    const tag = el.tagName.toLowerCase()
    switch (tag) {
      case 'a': return el.hasAttribute('href') ? 'link' : 'generic'
      case 'button': return 'button'
      case 'select': return el.hasAttribute('multiple') || (el.size > 1) ? 'listbox' : 'combobox'
      case 'textarea': return 'textbox'
      case 'summary': return 'button'
      case 'img': return el.getAttribute('alt') === '' ? 'presentation' : 'img'
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': return 'heading'
      case 'header': return el.closest('article, aside, main, nav, section') ? 'generic' : 'banner'
      case 'footer': return el.closest('article, aside, main, nav, section') ? 'generic' : 'contentinfo'
      case 'main': return 'main'
      case 'nav': return 'navigation'
      case 'aside': return 'complementary'
      case 'form': return 'form'
      case 'search': return 'search'
      case 'section': return el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') ? 'region' : 'generic'
      case 'article': return 'article'
      case 'ul': case 'menu': return 'list'
      case 'ol': return 'list'
      case 'li': return 'listitem'
      case 'dl': return 'list'
      case 'table': return 'table'
      case 'thead': case 'tbody': case 'tfoot': return 'rowgroup'
      case 'tr': return 'row'
      case 'td': return 'cell'
      case 'th': return el.getAttribute('scope') === 'row' ? 'rowheader' : 'columnheader'
      case 'fieldset': return 'group'
      case 'legend': return 'legend'
      case 'label':
        // Its text is announced as the control's accessible name. Emitting it again as a
        // sibling makes every labelled field appear twice and invites a model to treat the
        // label as something it can act on.
        return el.hasAttribute('for') || el.querySelector('input, select, textarea')
          ? 'none'
          : 'generic'
      case 'figure': return 'figure'
      case 'hr': return 'separator'
      case 'dialog': return 'dialog'
      case 'progress': return 'progressbar'
      case 'meter': return 'meter'
      case 'output': return 'status'
      case 'p': return 'paragraph'
      case 'blockquote': return 'blockquote'
      case 'code': return 'code'
      case 'input': {
        const t = (el.getAttribute('type') || 'text').toLowerCase()
        if (t === 'checkbox') return 'checkbox'
        if (t === 'radio') return 'radio'
        if (t === 'submit' || t === 'button' || t === 'reset' || t === 'image') return 'button'
        if (t === 'range') return 'slider'
        if (t === 'number') return 'spinbutton'
        if (t === 'search') return 'searchbox'
        if (t === 'hidden') return 'none'
        return 'textbox'
      }
      default: return 'generic'
    }
  }

  const ownText = (el) => {
    let out = ''
    for (const node of el.childNodes) {
      if (node.nodeType === 3) out += node.textContent
      else if (node.nodeType === 1 && !hiddenFromAT(node)) out += ' ' + (node.textContent || '')
    }
    return out.replace(/\\s+/g, ' ').trim()
  }

  const accessibleName = (el, role) => {
    const label = el.getAttribute('aria-label')
    if (label && label.trim()) return label.trim()
    const labelledBy = el.getAttribute('aria-labelledby')
    if (labelledBy) {
      const root = el.getRootNode ? el.getRootNode() : document
      const parts = labelledBy.split(/\\s+/).map((id) => {
        const n = root.getElementById ? root.getElementById(id) : document.getElementById(id)
        return n ? (n.textContent || '') : ''
      })
      const joined = parts.join(' ').replace(/\\s+/g, ' ').trim()
      if (joined) return joined
    }
    const tag = el.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      if (el.id) {
        const scope = el.getRootNode ? el.getRootNode() : document
        const forLabel = scope.querySelector
          ? scope.querySelector('label[for="' + CSS.escape(el.id) + '"]')
          : null
        if (forLabel && forLabel.textContent.trim()) return forLabel.textContent.replace(/\\s+/g, ' ').trim()
      }
      const wrapping = el.closest ? el.closest('label') : null
      if (wrapping && wrapping.textContent.trim()) return wrapping.textContent.replace(/\\s+/g, ' ').trim()
      const ph = el.getAttribute('placeholder')
      if (ph) return ph.trim()
    }
    if (tag === 'IMG') {
      const alt = el.getAttribute('alt')
      if (alt) return alt.trim()
    }
    if (NAME_FROM_CONTENT.indexOf(role) !== -1) {
      const text = ownText(el)
      if (text) return text.slice(0, 120)
    }
    const title = el.getAttribute('title')
    if (title) return title.trim()
    return ''
  }

  /** States a model needs in order to predict whether acting will do anything. */
  const statesOf = (el, role) => {
    const out = []
    const level = (() => {
      const explicit = el.getAttribute('aria-level')
      if (explicit) return parseInt(explicit, 10) || undefined
      const m = /^H([1-6])$/.exec(el.tagName)
      return m ? parseInt(m[1], 10) : undefined
    })()
    if (role === 'heading' && level) out.push('level=' + level)
    if (el.disabled === true || el.getAttribute('aria-disabled') === 'true') out.push('disabled')
    const checked = el.getAttribute('aria-checked') || (typeof el.checked === 'boolean' ? String(el.checked) : null)
    if (checked === 'true' || checked === 'mixed') out.push('checked' + (checked === 'mixed' ? '=mixed' : ''))
    const expanded = el.getAttribute('aria-expanded')
    if (expanded) out.push('expanded=' + expanded)
    const selected = el.getAttribute('aria-selected')
    if (selected === 'true') out.push('selected')
    if (el.getAttribute('aria-required') === 'true' || el.required === true) out.push('required')
    if (el.readOnly === true) out.push('readonly')
    if (typeof el.value === 'string' && el.value && (role === 'textbox' || role === 'searchbox' || role === 'spinbutton')) {
      out.push('value=' + JSON.stringify(el.value.slice(0, 40)))
    }
    if (MARK_INERT) {
      // Present but unusable. An agent that cannot see this difference tries the click,
      // observes nothing, and concludes the page is broken rather than the control inert.
      const style = getComputedStyle(el)
      if (style.pointerEvents === 'none') out.push('no-pointer-events')
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) out.push('zero-size')
    }
    return out
  }

  const quote = (s) => JSON.stringify(s)
  const lines = []

  const childrenOf = (el) => {
    const kids = []
    if (el.shadowRoot) for (const c of el.shadowRoot.children) kids.push(c)
    for (const c of el.children) kids.push(c)
    return kids
  }

  /** Whether anything inside this element has a role a model could act on. */
  const hasRoledDescendant = (el) => {
    for (const c of childrenOf(el)) {
      const r = roleOf(c)
      if (r !== 'generic' && r !== 'none' && r !== 'presentation') return true
      if (hasRoledDescendant(c)) return true
    }
    return false
  }

  const walk = (el, depth) => {
    if (!INCLUDE_HIDDEN && hiddenFromAT(el)) return
    const role = roleOf(el)
    if (role === 'none' || role === 'presentation') {
      for (const c of childrenOf(el)) walk(el === c ? el : c, depth)
      return
    }
    if (role === 'generic') {
      // A layout wrapper contributes nothing a model can act on, so it is flattened away
      // rather than spending a line and a level of indentation.
      const kids = childrenOf(el)
      if (kids.length === 0) {
        const text = ownText(el)
        if (text) lines.push('  '.repeat(depth) + '- text: ' + text.slice(0, 200))
        return
      }
      for (const c of kids) walk(c, depth)
      return
    }

    const name = accessibleName(el, role)
    const states = statesOf(el, role)
    let line = '  '.repeat(depth) + '- ' + role
    if (name) line += ' ' + quote(name)
    if (states.length) line += ' [' + states.join('] [') + ']'

    const kids = childrenOf(el)
    // A control's own text is already its name; repeating it as a child is noise. But a
    // container that is named by its content and also holds controls must still descend,
    // or those controls vanish from the snapshot entirely.
    const nameIsContent =
      NAME_FROM_CONTENT.indexOf(role) !== -1 &&
      !(CONTAINER_NAMED.indexOf(role) !== -1 && hasRoledDescendant(el))
    const descend = kids.length > 0 && !nameIsContent
    if (!descend && !name) {
      // A leaf that carries text but takes no name from it -- a listitem, a paragraph --
      // would otherwise print as a bare role and lose everything it said.
      const text = ownText(el)
      if (text) line += ': ' + text.slice(0, 200)
    }
    lines.push(line + (descend ? ':' : ''))
    if (descend) for (const c of kids) walk(c, depth + 1)
  }

  const root = ${rootExpression}
  if (!root) return ''
  for (const c of childrenOf(root)) walk(c, 0)
  return lines.join('\\n')
})()`
}
