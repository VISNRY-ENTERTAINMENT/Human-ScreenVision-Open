import Parser from 'tree-sitter'
import HTML from 'tree-sitter-html'
import { ComponentEntry, SemanticRole } from '../../core/types'
import { CodeIndex, toPascalCase } from '../CodeIndex'
import { cssEscape } from './ReactParser'

const SEMANTIC_TAGS: Record<string, { name: string; role: SemanticRole }> = {
  nav: { name: 'NavigationComponent', role: 'navigation' },
  header: { name: 'HeaderComponent', role: 'header' },
  footer: { name: 'FooterComponent', role: 'footer' },
  main: { name: 'MainContentComponent', role: 'main-content' },
  aside: { name: 'SidebarComponent', role: 'sidebar' },
  form: { name: 'FormComponent', role: 'form' },
  dialog: { name: 'DialogComponent', role: 'modal' },
}

export interface ParsedHTMLElement {
  tag: string
  attrs: Record<string, string>
  node: Parser.SyntaxNode
  childTags: string[]
}

/**
 * Parses plain HTML (and, via Vue/Svelte parsers, template markup) into ComponentEntry
 * records. Semantic elements and elements carrying id / data-testid / role / aria-label
 * become "components".
 */
export class HTMLParser {
  private parser: Parser

  constructor() {
    this.parser = new Parser()
    this.parser.setLanguage(HTML)
  }

  /**
   * Parse an HTML file into component entries.
   * @param filePath - Absolute path (recorded in entries)
   * @param sourceCode - HTML source
   * @returns Component entries
   * @throws Error when parsing fails
   */
  async parseFile(filePath: string, sourceCode: string): Promise<ComponentEntry[]> {
    const elements = this.parseElements(sourceCode, filePath)
    const entries: ComponentEntry[] = []
    const used = new Set<string>()

    for (const el of elements) {
      const semantic = SEMANTIC_TAGS[el.tag]
      const hasIdentity = Boolean(el.attrs.id || el.attrs['data-testid'] || el.attrs.role || el.attrs['aria-label'])
      if (!semantic && !hasIdentity) continue

      let name: string
      if (el.tag === 'section' && el.attrs.id) name = `Section_${el.attrs.id}_Component`
      else if (semantic) name = semantic.name
      else name = `${toPascalCase(el.attrs['data-testid'] || el.attrs.id || el.attrs['aria-label'] || el.attrs.role || el.tag)}Component`
      name = uniqueName(name, used)

      const role: SemanticRole = semantic
        ? semantic.role
        : roleFromAria(el.attrs.role) ?? CodeIndex.inferSemanticRole(name, el.node.text)
      const selectors = this.selectorsFor(el)
      entries.push({
        name,
        filePath,
        selector: selectors[0],
        alternateSelectors: selectors.slice(1),
        childComponents: el.childTags,
        semanticRole: role,
        expectedPosition: CodeIndex.inferPosition(role),
        testIds: el.attrs['data-testid'] ? [el.attrs['data-testid']] : [],
        ariaLabels: el.attrs['aria-label'] ? [el.attrs['aria-label']] : [],
        cssClasses: (el.attrs.class ?? '').split(/\s+/).filter(Boolean),
      })
    }
    return entries
  }

  /**
   * Flat list of all elements in document order with their attributes and
   * uppercase / custom-element child tag names.
   * @param sourceCode - HTML source
   * @param filePath - For error messages
   * @returns Parsed elements
   */
  parseElements(sourceCode: string, filePath: string): ParsedHTMLElement[] {
    let tree: Parser.Tree
    try {
      tree = this.parser.parse(sourceCode)
    } catch (err) {
      throw new Error(`HTMLParser.parseFile(${filePath}): parse failed: ${(err as Error).message}`)
    }
    const out: ParsedHTMLElement[] = []
    for (const node of tree.rootNode.descendantsOfType('element')) {
      const tagNode = node.children.find((c) => c.type === 'start_tag' || c.type === 'self_closing_tag')
      if (!tagNode) continue
      const tagNameNode = tagNode.children.find((c) => c.type === 'tag_name')
      if (!tagNameNode) continue
      const rawTag = tagNameNode.text
      const attrs = this.attributes(tagNode)
      const childTags: string[] = []
      for (const inner of node.descendantsOfType('element')) {
        if (inner.id === node.id) continue
        const innerTag = inner.children.find((c) => c.type === 'start_tag' || c.type === 'self_closing_tag')
        const innerName = innerTag?.children.find((c) => c.type === 'tag_name')?.text
        if (innerName && isComponentTag(innerName)) {
          const pascal = /^[A-Z]/.test(innerName) ? innerName : toPascalCase(innerName)
          if (!childTags.includes(pascal)) childTags.push(pascal)
        }
      }
      out.push({ tag: rawTag.toLowerCase(), attrs, node, childTags })
    }
    return out
  }

  /**
   * Ordered selector candidates for an element: data-testid → #id → [role] → [aria-label] → class → tag.
   * @param el - Parsed element
   * @returns Selector list (at least one)
   */
  selectorsFor(el: ParsedHTMLElement): string[] {
    const s: string[] = []
    if (el.attrs['data-testid']) s.push(`[data-testid="${el.attrs['data-testid']}"]`)
    if (el.attrs.id) s.push(`#${cssEscape(el.attrs.id)}`)
    if (el.attrs['aria-label']) s.push(`${el.tag}[aria-label="${el.attrs['aria-label']}"]`)
    if (el.attrs.role) s.push(`${el.tag}[role="${el.attrs.role}"]`)
    const firstClass = (el.attrs.class ?? '').split(/\s+/).find((c) => c.length >= 4)
    if (firstClass) s.push(`${el.tag}.${cssEscape(firstClass)}`)
    if (/^[a-z]/.test(el.tag)) s.push(el.tag)
    if (s.length === 0) s.push(el.tag)
    return Array.from(new Set(s))
  }

  private attributes(tagNode: Parser.SyntaxNode): Record<string, string> {
    const out: Record<string, string> = {}
    for (const attr of tagNode.children) {
      if (attr.type !== 'attribute') continue
      const nameNode = attr.children.find((c) => c.type === 'attribute_name')
      if (!nameNode) continue
      const valueNode = attr.descendantsOfType('attribute_value')[0]
      out[nameNode.text.toLowerCase()] = valueNode ? valueNode.text : 'true'
    }
    return out
  }
}

function isComponentTag(tag: string): boolean {
  return /^[A-Z]/.test(tag) || (tag.includes('-') && !/^(v-|x-)/.test(tag))
}

function uniqueName(base: string, used: Set<string>): string {
  let name = base
  let i = 2
  while (used.has(name)) name = `${base}_${i++}`
  used.add(name)
  return name
}

function roleFromAria(role: string | undefined): SemanticRole | null {
  switch (role) {
    case 'navigation':
      return 'navigation'
    case 'banner':
      return 'header'
    case 'contentinfo':
      return 'footer'
    case 'main':
      return 'main-content'
    case 'complementary':
      return 'sidebar'
    case 'form':
      return 'form'
    case 'search':
      return 'search'
    case 'dialog':
    case 'alertdialog':
      return 'modal'
    case 'button':
      return 'button'
    case 'list':
    case 'listbox':
      return 'list'
    case 'table':
    case 'grid':
      return 'table'
    default:
      return null
  }
}
