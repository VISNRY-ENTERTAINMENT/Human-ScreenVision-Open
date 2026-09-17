import Parser from 'tree-sitter'
import TypeScript from 'tree-sitter-typescript'
import { ComponentEntry } from '../../core/types'
import { CodeIndex } from '../CodeIndex'

const UTILITY_CLASSES = new Set([
  'flex',
  'grid',
  'block',
  'inline',
  'hidden',
  'relative',
  'absolute',
  'fixed',
  'sticky',
  'container',
  'wrapper',
  'row',
  'col',
  'item',
  'items-center',
  'justify-between',
  'justify-center',
  'w-full',
  'h-full',
  'mx-auto',
  'text-center',
])

const JSX_ELEMENT_TYPES = ['jsx_element', 'jsx_self_closing_element']
const JSX_TAG_TYPES = ['jsx_opening_element', 'jsx_self_closing_element']

/**
 * Parses JSX/TSX files into ComponentEntry records using tree-sitter.
 */
export class ReactParser {
  private parser: Parser

  constructor() {
    this.parser = new Parser()
    this.parser.setLanguage(TypeScript.tsx) // handles both JSX and TSX
  }

  /**
   * Parse a single JSX/TSX file.
   * Finds uppercase function declarations, uppercase arrow/function-expression
   * variables, and classes extending (React.)Component; for each, reads the
   * root JSX element's className / data-testid / aria-label / id, derives a
   * selector, collects child component names and infers the semantic role.
   * @param filePath - Absolute file path (recorded in each entry)
   * @param sourceCode - File contents
   * @returns Component entries found in the file (possibly empty)
   * @throws Error when tree-sitter fails to produce a tree
   */
  async parseFile(filePath: string, sourceCode: string): Promise<ComponentEntry[]> {
    let tree: Parser.Tree
    try {
      tree = this.parser.parse(sourceCode)
    } catch (err) {
      throw new Error(`ReactParser.parseFile(${filePath}): parse failed: ${(err as Error).message}`)
    }
    const entries: ComponentEntry[] = []
    const seen = new Set<string>()

    const candidates = this.findComponentNodes(tree.rootNode)
    for (const { name, node } of candidates) {
      if (seen.has(name)) continue
      const jsxNodes = node.descendantsOfType(JSX_ELEMENT_TYPES)
      if (jsxNodes.length === 0) continue
      const root = jsxNodes[0]
      const tag = this.openingTag(root)
      if (!tag) continue
      seen.add(name)

      const attrs = this.attributes(tag)
      const cssClasses = this.extractClassNames(root)
      const testIds = attrs['data-testid'] ? [attrs['data-testid']] : []
      const ariaLabels = attrs['aria-label'] ? [attrs['aria-label']] : []
      // Collect nested test ids / aria labels too (children rendered by this component).
      for (const inner of jsxNodes.slice(1)) {
        const innerTag = this.openingTag(inner)
        if (!innerTag) continue
        const innerAttrs = this.attributes(innerTag)
        if (innerAttrs['data-testid'] && !testIds.includes(innerAttrs['data-testid'])) testIds.push(innerAttrs['data-testid'])
        if (innerAttrs['aria-label'] && !ariaLabels.includes(innerAttrs['aria-label']))
          ariaLabels.push(innerAttrs['aria-label'])
      }

      const selectors = this.selectorCandidates(root, name)
      const semanticRole = CodeIndex.inferSemanticRole(name, node.text)
      entries.push({
        name,
        filePath,
        selector: selectors[0],
        alternateSelectors: selectors.slice(1),
        childComponents: this.extractChildComponents(node),
        semanticRole,
        expectedPosition: CodeIndex.inferPosition(semanticRole),
        testIds,
        ariaLabels,
        cssClasses,
      })
    }
    return entries
  }

  private findComponentNodes(rootNode: Parser.SyntaxNode): Array<{ name: string; node: Parser.SyntaxNode }> {
    const found: Array<{ name: string; node: Parser.SyntaxNode }> = []
    const isUpper = (s: string): boolean => /^[A-Z]/.test(s)

    for (const fn of rootNode.descendantsOfType('function_declaration')) {
      const name = fn.childForFieldName('name')?.text
      if (name && isUpper(name)) found.push({ name, node: fn })
    }
    for (const decl of rootNode.descendantsOfType('variable_declarator')) {
      const name = decl.childForFieldName('name')?.text
      const value = decl.childForFieldName('value')
      if (!name || !isUpper(name) || !value) continue
      const inner = this.unwrapCall(value)
      if (inner.type === 'arrow_function' || inner.type === 'function_expression' || inner.type === 'function') {
        found.push({ name, node: decl })
      }
    }
    for (const cls of rootNode.descendantsOfType('class_declaration')) {
      const name = cls.childForFieldName('name')?.text
      if (!name || !isUpper(name)) continue
      const heritage = cls.children.find((c) => c.type === 'class_heritage')
      if (heritage && /\b(React\.)?(Pure)?Component\b/.test(heritage.text)) found.push({ name, node: cls })
    }
    // Sort by source position to keep document order.
    found.sort((a, b) => a.node.startIndex - b.node.startIndex)
    return found
  }

  /** Unwrap `memo(...)`, `forwardRef(...)`, `styled(...)`-style wrappers to the inner function. */
  private unwrapCall(node: Parser.SyntaxNode): Parser.SyntaxNode {
    let current = node
    for (let i = 0; i < 3; i++) {
      if (current.type === 'parenthesized_expression' && current.namedChildren[0]) {
        current = current.namedChildren[0]
        continue
      }
      if (current.type === 'call_expression') {
        const args = current.childForFieldName('arguments')
        const first = args?.namedChildren.find((c) => c.type === 'arrow_function' || c.type === 'function_expression')
        if (first) {
          current = first
          continue
        }
      }
      break
    }
    return current
  }

  private openingTag(jsxNode: Parser.SyntaxNode): Parser.SyntaxNode | null {
    if (jsxNode.type === 'jsx_self_closing_element') return jsxNode
    const byField = jsxNode.childForFieldName('open_tag')
    if (byField) return byField
    return jsxNode.children.find((c) => c.type === 'jsx_opening_element') ?? null
  }

  private tagName(tag: Parser.SyntaxNode): string {
    const nameNode =
      tag.childForFieldName('name') ??
      tag.namedChildren.find((c) =>
        ['identifier', 'nested_identifier', 'member_expression', 'jsx_namespace_name'].includes(c.type)
      )
    return nameNode?.text ?? ''
  }

  private attributes(tag: Parser.SyntaxNode): Record<string, string> {
    const out: Record<string, string> = {}
    for (const attr of tag.namedChildren) {
      if (attr.type !== 'jsx_attribute') continue
      const key = attr.namedChildren[0]?.text
      const valueNode = attr.namedChildren[1]
      if (!key) continue
      if (!valueNode) {
        out[key] = 'true'
        continue
      }
      out[key] = this.staticStringValue(valueNode)
    }
    return out
  }

  /** Static string parts of a JSX attribute value (string literal, template, or expression). */
  private staticStringValue(valueNode: Parser.SyntaxNode): string {
    if (valueNode.type === 'string') {
      return valueNode.namedChildren
        .filter((c) => c.type === 'string_fragment')
        .map((c) => c.text)
        .join('')
    }
    const fragments = valueNode.descendantsOfType('string_fragment').map((c) => c.text.trim())
    return fragments.filter(Boolean).join(' ')
  }

  /**
   * Ordered selector candidates for a root JSX element:
   * data-testid → data-sv-id → distinctive className → #id → tag.
   */
  private selectorCandidates(rootJSXElement: Parser.SyntaxNode, componentName: string): string[] {
    const tag = this.openingTag(rootJSXElement)
    const attrs = tag ? this.attributes(tag) : {}
    const candidates: string[] = []
    if (attrs['data-testid']) candidates.push(`[data-testid="${attrs['data-testid']}"]`)
    if (attrs['data-sv-id']) candidates.push(`[data-sv-id="${attrs['data-sv-id']}"]`)
    for (const cls of this.extractClassNames(rootJSXElement)) {
      if (cls.length >= 4 && !UTILITY_CLASSES.has(cls) && !/^[a-z]{1,2}-/.test(cls)) {
        candidates.push(`.${cssEscape(cls)}`)
        break
      }
    }
    if (attrs.id) candidates.push(`#${cssEscape(attrs.id)}`)
    if (attrs['aria-label']) candidates.push(`[aria-label="${attrs['aria-label']}"]`)
    const name = tag ? this.tagName(tag) : ''
    if (name && /^[a-z]/.test(name)) candidates.push(name)
    if (candidates.length === 0) {
      candidates.push(`[data-testid="${kebab(componentName)}"]`, `.${kebab(componentName)}`)
    }
    return Array.from(new Set(candidates))
  }

  /**
   * The CSS selector for a component's root element (first of {@link selectorCandidates}).
   */
  private extractSelector(rootJSXElement: Parser.SyntaxNode): string {
    return this.selectorCandidates(rootJSXElement, 'component')[0]
  }

  /**
   * Class names from the root element's className. Handles string literals,
   * template strings (static parts) and expressions like clsx('a', cond && 'b').
   */
  private extractClassNames(rootJSXElement: Parser.SyntaxNode): string[] {
    const tag = this.openingTag(rootJSXElement)
    if (!tag) return []
    for (const attr of tag.namedChildren) {
      if (attr.type !== 'jsx_attribute') continue
      const key = attr.namedChildren[0]?.text
      if (key !== 'className' && key !== 'class') continue
      const valueNode = attr.namedChildren[1]
      if (!valueNode) return []
      return this.staticStringValue(valueNode)
        .split(/\s+/)
        .map((c) => c.trim())
        .filter((c) => c && /^[A-Za-z_-][\w-]*$/.test(c))
    }
    return []
  }

  /** Uppercase JSX tag names used inside the component body (child components). */
  private extractChildComponents(componentNode: Parser.SyntaxNode): string[] {
    const names = new Set<string>()
    for (const tag of componentNode.descendantsOfType(JSX_TAG_TYPES)) {
      const name = this.tagName(tag)
      if (/^[A-Z]/.test(name)) names.add(name)
    }
    return Array.from(names)
  }

  /** Exposed for callers that only need the selector of an already-located root node. */
  selectorFor(rootJSXElement: Parser.SyntaxNode): string {
    return this.extractSelector(rootJSXElement)
  }
}

function kebab(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[\s_]+/g, '-')
    .toLowerCase()
}

/**
 * Escape a class/id token for use in a CSS selector.
 * @param token - Raw token
 * @returns Escaped token
 */
export function cssEscape(token: string): string {
  return token.replace(/([^\w-])/g, '\\$1').replace(/^(\d)/, '\\3$1 ')
}
