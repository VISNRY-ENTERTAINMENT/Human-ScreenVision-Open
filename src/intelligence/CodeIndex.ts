import path from 'path'
import fs from 'fs/promises'
import { glob } from 'glob'
import {
  CodeIndexResult,
  ComponentEntry,
  FrameworkType,
  SemanticRole,
  ExpectedPosition,
  IndexError,
} from '../core/types'
import { ReactParser } from './parsers/ReactParser'
import { VueParser } from './parsers/VueParser'
import { SvelteParser } from './parsers/SvelteParser'
import { HTMLParser } from './parsers/HTMLParser'

const IGNORE_DIRS = ['node_modules', 'dist', 'build', '.git', 'coverage']

const ROLE_RULES: Array<{ role: SemanticRole; keywords: string[] }> = [
  { role: 'navigation', keywords: ['nav', 'navbar', 'navigation'] },
  { role: 'header', keywords: ['header'] },
  { role: 'footer', keywords: ['footer'] },
  { role: 'hero', keywords: ['hero', 'banner', 'jumbotron'] },
  { role: 'sidebar', keywords: ['sidebar', 'aside', 'drawer'] },
  { role: 'main-content', keywords: ['main', 'content', 'body'] },
  { role: 'form', keywords: ['form', 'login', 'register'] },
  { role: 'button', keywords: ['button', 'btn', 'cta'] },
  { role: 'modal', keywords: ['modal', 'dialog', 'overlay'] },
  { role: 'card', keywords: ['card', 'tile', 'item'] },
  { role: 'list', keywords: ['list', 'grid', 'gallery'] },
  { role: 'table', keywords: ['table', 'datatable', 'datagrid'] },
  { role: 'search', keywords: ['search', 'searchbar'] },
]

/**
 * Builds a semantic map (component → selector/role/position) from a codebase.
 */
export class CodeIndex {
  /**
   * Index a codebase.
   * 1. Detect framework when `auto`.
   * 2. Discover source files.
   * 3. Parse each file with the framework parser.
   * 4. Link parent/child components and return the result.
   * @param codebasePath - Root directory of the source code
   * @param framework - Framework, or `auto` to detect from package.json
   * @returns Index result (errors are collected per file, never thrown)
   * @throws Error when `codebasePath` is not a directory
   */
  static async build(codebasePath: string, framework: FrameworkType = 'auto'): Promise<CodeIndexResult> {
    const root = path.resolve(codebasePath)
    try {
      const stat = await fs.stat(root)
      if (!stat.isDirectory()) throw new Error('not a directory')
    } catch (err) {
      throw new Error(`CodeIndex.build: codebase path "${root}" is not accessible: ${(err as Error).message}`)
    }

    const resolved = framework === 'auto' ? await CodeIndex.detectFramework(root) : framework
    const files = await CodeIndex.findSourceFiles(root, resolved)
    const components = new Map<string, ComponentEntry>()
    const errors: IndexError[] = []

    const react = new ReactParser()
    const vue = new VueParser()
    const svelte = new SvelteParser()
    const html = new HTMLParser()

    for (const filePath of files) {
      let source: string
      try {
        source = await fs.readFile(filePath, 'utf8')
      } catch (err) {
        errors.push({ filePath, message: `read failed: ${(err as Error).message}` })
        continue
      }
      try {
        let entries: ComponentEntry[]
        switch (resolved) {
          case 'react':
            entries = await react.parseFile(filePath, source)
            break
          case 'vue':
            entries = await vue.parseFile(filePath, source)
            break
          case 'svelte':
            entries = await svelte.parseFile(filePath, source)
            break
          default:
            entries = await html.parseFile(filePath, source)
        }
        for (const entry of entries) {
          if (!components.has(entry.name)) components.set(entry.name, entry)
        }
      } catch (err) {
        errors.push({ filePath, message: (err as Error).message })
      }
    }

    // Link parents: the first component that renders a child becomes its parent.
    for (const entry of components.values()) {
      for (const childName of entry.childComponents) {
        const child = components.get(childName)
        if (child && !child.parentComponent && child.name !== entry.name) child.parentComponent = entry.name
      }
    }

    return {
      components,
      framework: resolved,
      indexedAt: new Date(),
      fileCount: files.length,
      componentCount: components.size,
      errors,
    }
  }

  /**
   * Detect the UI framework from `package.json` dependencies.
   * @param codebasePath - Directory containing (or below) a package.json
   * @returns `react` | `vue` | `svelte`, or `html` when nothing matches
   */
  static async detectFramework(codebasePath: string): Promise<FrameworkType> {
    const root = path.resolve(codebasePath)
    const candidates = [path.join(root, 'package.json'), path.join(path.dirname(root), 'package.json')]
    for (const pkgPath of candidates) {
      let raw: string
      try {
        raw = await fs.readFile(pkgPath, 'utf8')
      } catch {
        continue
      }
      try {
        const pkg = JSON.parse(raw) as {
          dependencies?: Record<string, string>
          devDependencies?: Record<string, string>
          peerDependencies?: Record<string, string>
        }
        const deps = { ...(pkg.peerDependencies ?? {}), ...(pkg.devDependencies ?? {}), ...(pkg.dependencies ?? {}) }
        if (deps.react || deps['react-dom']) return 'react'
        if (deps.vue) return 'vue'
        if (deps.svelte) return 'svelte'
        return 'html'
      } catch (err) {
        throw new Error(`CodeIndex.detectFramework: invalid JSON in ${pkgPath}: ${(err as Error).message}`)
      }
    }
    return 'html'
  }

  /**
   * Find source files for a framework, ignoring node_modules/dist/build/.git/coverage.
   * @param codebasePath - Root directory
   * @param framework - Framework whose file extensions to search
   * @returns Absolute file paths, sorted
   */
  static async findSourceFiles(codebasePath: string, framework: FrameworkType): Promise<string[]> {
    const root = path.resolve(codebasePath)
    const pattern =
      framework === 'react'
        ? '**/*.{jsx,tsx}'
        : framework === 'vue'
          ? '**/*.vue'
          : framework === 'svelte'
            ? '**/*.svelte'
            : '**/*.{html,htm}'
    try {
      const files = await glob(pattern, {
        cwd: root,
        absolute: true,
        nodir: true,
        dot: false,
        windowsPathsNoEscape: true,
        ignore: IGNORE_DIRS.map((d) => `**/${d}/**`),
      })
      return files.map((f) => path.normalize(f)).sort()
    } catch (err) {
      throw new Error(`CodeIndex.findSourceFiles(${framework}) failed in ${root}: ${(err as Error).message}`)
    }
  }

  /**
   * Infer a component's semantic role from its name (keyword rules, first match wins).
   * @param componentName - e.g. `NavBar`
   * @param sourceCode - Component source (used as a tiebreaker for `unknown` names via root tag)
   * @returns Semantic role
   */
  static inferSemanticRole(componentName: string, sourceCode: string): SemanticRole {
    const words = splitWords(componentName)
    const lowerName = componentName.toLowerCase()
    for (const rule of ROLE_RULES) {
      for (const kw of rule.keywords) {
        if (words.includes(kw) || (kw.length > 3 && lowerName.includes(kw))) return rule.role
      }
    }
    const tagMatch = /<\s*(nav|header|footer|main|aside|form|dialog|table)\b/i.exec(sourceCode)
    if (tagMatch) {
      const tag = tagMatch[1].toLowerCase()
      const byTag: Record<string, SemanticRole> = {
        nav: 'navigation',
        header: 'header',
        footer: 'footer',
        main: 'main-content',
        aside: 'sidebar',
        form: 'form',
        dialog: 'modal',
        table: 'table',
      }
      return byTag[tag] ?? 'unknown'
    }
    return 'unknown'
  }

  /**
   * Expected on-screen position for a semantic role.
   * @param role - Semantic role
   * @returns Expected position descriptor
   */
  static inferPosition(role: SemanticRole): ExpectedPosition {
    switch (role) {
      case 'navigation':
        return { region: 'top', stacked: true, sticky: true, zIndex: 'high' }
      case 'header':
        return { region: 'top', stacked: true, sticky: false, zIndex: 'normal' }
      case 'footer':
        return { region: 'bottom', stacked: true, sticky: false, zIndex: 'normal' }
      case 'hero':
        return { region: 'top', stacked: true, sticky: false, zIndex: 'normal' }
      case 'sidebar':
        return { region: 'left', stacked: false, sticky: true, zIndex: 'normal' }
      case 'modal':
        return { region: 'center', stacked: false, sticky: true, zIndex: 'high' }
      default:
        return { region: 'unknown', stacked: true, sticky: false, zIndex: 'low' }
    }
  }
}

/**
 * Split a PascalCase / camelCase / kebab / snake identifier into lowercase words.
 * @param name - Identifier
 * @returns Lowercase word list
 */
export function splitWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s\-_./]+/)
    .map((w) => w.toLowerCase())
    .filter(Boolean)
}

/**
 * Convert an arbitrary identifier (`nav-bar`, `site_header`) to PascalCase.
 * @param value - Identifier
 * @returns PascalCase string
 */
export function toPascalCase(value: string): string {
  return splitWords(value)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('')
}
