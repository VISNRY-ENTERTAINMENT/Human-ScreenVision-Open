import path from 'path'
import { ComponentEntry } from '../../core/types'
import { CodeIndex, toPascalCase } from '../CodeIndex'
import { HTMLParser } from './HTMLParser'

/**
 * Parses Vue single-file components: the `<template>` block's root element
 * becomes the component (named after the file), child components are the
 * PascalCase / kebab-case custom tags inside it.
 */
export class VueParser {
  private html = new HTMLParser()

  /**
   * Parse a `.vue` file.
   * @param filePath - Absolute path
   * @param sourceCode - SFC source
   * @returns Component entry for the root plus prefixed entries for semantic elements inside the template
   */
  async parseFile(filePath: string, sourceCode: string): Promise<ComponentEntry[]> {
    const template = extractTemplate(sourceCode)
    if (!template) return []
    return buildTemplateEntries(this.html, filePath, template)
  }
}

/**
 * Extract the outermost `<template>` block of an SFC.
 * @param source - SFC source
 * @returns Template inner HTML or null
 */
export function extractTemplate(source: string): string | null {
  const open = /<template(\s[^>]*)?>/i.exec(source)
  if (!open) return null
  const start = open.index + open[0].length
  const end = source.lastIndexOf('</template>')
  if (end <= start) return null
  return source.slice(start, end)
}

/**
 * Shared Vue/Svelte template → entries logic.
 * @param html - HTML parser instance
 * @param filePath - Source file
 * @param markup - Template markup
 * @returns Entries: file-named root component first, then `<Name>/<Semantic>` entries
 */
export function buildTemplateEntries(html: HTMLParser, filePath: string, markup: string): ComponentEntry[] {
  const componentName = toPascalCase(path.basename(filePath).replace(/\.(vue|svelte)$/i, ''))
  const elements = html.parseElements(markup, filePath)
  const root = elements.find((el) => !/^(script|style)$/.test(el.tag))
  if (!root) return []

  const semanticRole = CodeIndex.inferSemanticRole(componentName, markup)
  const selectors = html.selectorsFor(root)
  const testIds = elements.map((e) => e.attrs['data-testid']).filter((v): v is string => Boolean(v))
  const ariaLabels = elements.map((e) => e.attrs['aria-label']).filter((v): v is string => Boolean(v))

  const rootEntry: ComponentEntry = {
    name: componentName,
    filePath,
    selector: selectors[0],
    alternateSelectors: selectors.slice(1),
    childComponents: root.childTags,
    semanticRole,
    expectedPosition: CodeIndex.inferPosition(semanticRole),
    testIds: Array.from(new Set(testIds)),
    ariaLabels: Array.from(new Set(ariaLabels)),
    cssClasses: (root.attrs.class ?? '').split(/\s+/).filter(Boolean),
  }

  const nested: ComponentEntry[] = []
  return [rootEntry, ...nested]
}
