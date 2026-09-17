import { describe, it, expect } from 'vitest'
import { ElementResolver } from '../../src/intelligence/ElementResolver'
import type { Page } from '../../src/core/Page'
import type { ElementHandle } from '../../src/core/ElementHandle'
import type { CodeIndexResult, ComponentEntry } from '../../src/core/types'

// A minimal fake Page: `$` resolves selectors from a static table.
function fakePage(selectors: Record<string, boolean>): Page {
  const handleFor = (selector: string): ElementHandle =>
    ({
      selector,
      nodeId: 1,
      boundingBox: async () => ({ x: 0, y: 0, width: 100, height: 40 }),
      isVisible: async () => true,
      $: async (s: string) => (selectors[s] ? handleFor(s) : null),
    }) as unknown as ElementHandle
  return {
    $: async (selector: string) => (selectors[selector] ? handleFor(selector) : null),
    $$: async (selector: string) => (selectors[selector] ? [handleFor(selector)] : []),
  } as unknown as Page
}

function indexWith(entries: ComponentEntry[]): CodeIndexResult {
  return {
    components: new Map(entries.map((e) => [e.name, e])),
    framework: 'react',
    indexedAt: new Date(),
    fileCount: 1,
    componentCount: entries.length,
    errors: [],
  }
}

const navEntry: ComponentEntry = {
  name: 'NavBar',
  filePath: '/x/NavBar.tsx',
  selector: '[data-testid="navbar"]',
  alternateSelectors: ['.navbar', 'nav'],
  childComponents: [],
  semanticRole: 'navigation',
  expectedPosition: { region: 'top', stacked: true, sticky: true, zIndex: 'high' },
  testIds: ['navbar'],
  ariaLabels: [],
  cssClasses: ['navbar'],
}

describe('ElementResolver', () => {
  it('resolves via code index with role match confidence 0.8', async () => {
    const resolver = new ElementResolver(indexWith([navEntry]), null)
    const page = fakePage({ '[data-testid="navbar"]': true })
    const r = await resolver.resolve('navigation bar', page, { timeout: 500 })
    expect(r.strategy).toBe('code-index')
    expect(r.componentName).toBe('NavBar')
    expect(r.confidence).toBe(0.8)
  })

  it('exact component name match has confidence 1.0', async () => {
    const resolver = new ElementResolver(indexWith([navEntry]), null)
    const page = fakePage({ '[data-testid="navbar"]': true })
    const r = await resolver.resolve('NavBar', page, { timeout: 500 })
    expect(r.confidence).toBe(1)
  })

  it('falls back to alternate selectors when primary is absent from DOM', async () => {
    const resolver = new ElementResolver(indexWith([navEntry]), null)
    const page = fakePage({ nav: true })
    const r = await resolver.resolve('navbar', page, { timeout: 500 })
    expect(r.selector).toBe('nav')
  })

  it('falls back to DOM tier (semantic tag) without a code index', async () => {
    const resolver = new ElementResolver(null, null)
    const page = fakePage({ footer: true })
    const r = await resolver.resolve('page footer', page, { timeout: 500 })
    expect(r.strategy).toBe('dom')
    expect(r.confidence).toBe(0.85)
  })

  it('prefers ARIA role over tag in the DOM tier', async () => {
    const resolver = new ElementResolver(null, null)
    const page = fakePage({ '[role="navigation"]': true, nav: true })
    const r = await resolver.resolve('menu', page, { timeout: 500 })
    expect(r.selector).toBe('[role="navigation"]')
    expect(r.confidence).toBe(0.9)
  })

  it('matches attribute terms (aria-label) for free-form queries', async () => {
    const resolver = new ElementResolver(null, null)
    const page = fakePage({ '[aria-label*="login" i]': true })
    const r = await resolver.resolve('login button', page, { timeout: 500 })
    expect(r.confidence).toBe(0.7)
  })

  it('throws a descriptive error when nothing matches and vision is disabled', async () => {
    const resolver = new ElementResolver(null, null)
    const page = fakePage({})
    await expect(resolver.resolve('purple elephant', page, { timeout: 300 })).rejects.toThrow(/purple elephant.*vision disabled/)
  })
})
