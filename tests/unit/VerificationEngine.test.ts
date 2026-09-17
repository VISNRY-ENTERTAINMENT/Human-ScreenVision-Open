import { describe, it, expect } from 'vitest'
import { VerificationEngine } from '../../src/intelligence/VerificationEngine'
import { AnnotationEngine } from '../../src/capture/AnnotationEngine'
import type { ElementResolver } from '../../src/intelligence/ElementResolver'
import type { Page } from '../../src/core/Page'
import type { ResolvedElement } from '../../src/core/types'
import sharp from 'sharp'

function resolved(name: string, visible = true): ResolvedElement {
  return {
    handle: { isVisible: async () => visible, selector: name } as unknown as ResolvedElement['handle'],
    strategy: 'dom',
    confidence: 0.85,
    selector: name,
    bbox: { x: 0, y: 0, width: 200, height: 50 },
  }
}

function fakeResolver(found: Record<string, boolean>): ElementResolver {
  return {
    resolve: async (query: string) => {
      if (query in found) return resolved(query, found[query])
      throw new Error(`no element matched "${query}"`)
    },
  } as unknown as ElementResolver
}

async function fakePage(): Promise<Page> {
  const png = await sharp({ create: { width: 200, height: 100, channels: 4, background: '#fff' } }).png().toBuffer()
  const mapper = {
    screenshot: async () => png,
    layoutMetrics: async () => ({ viewport: { width: 200, height: 100 }, contentSize: { width: 200, height: 100 }, scroll: { x: 0, y: 0 } }),
    evaluate: async () => 1,
    elementFacts: async () => ({ width: 200, height: 50, offCanvas: false, obscured: false, obscuredBy: null }),
    callFunctionOn: async () =>
      JSON.stringify({ links: 0, buttons: 0, headings: 0, images: 0, inputs: 0, text: '' }),
  }
  return {
    mapperRef: () => mapper,
    evaluate: async () => false,
  } as unknown as Page
}

describe('VerificationEngine', () => {
  it('passes when all contains items are found and visible', async () => {
    const engine = new VerificationEngine(fakeResolver({ nav: true, footer: true }), new AnnotationEngine(), null)
    const result = await engine.verify(await fakePage(), { contains: ['nav', 'footer'] })
    expect(result.pass).toBe(true)
    expect(result.score).toBe(1)
    expect(result.issues).toHaveLength(0)
    expect(result.checkedElements.map((c) => c.found)).toEqual([true, true])
    expect(result.screenshotBuffer).toBeUndefined()
  })

  it('fails with an error issue and screenshot when an element is missing', async () => {
    const engine = new VerificationEngine(fakeResolver({ nav: true }), new AnnotationEngine(), null)
    const result = await engine.verify(await fakePage(), { contains: ['nav', 'purple elephant'], screenshot: true })
    expect(result.pass).toBe(false)
    expect(result.score).toBe(0.5)
    expect(result.issues[0].severity).toBe('error')
    expect(result.issues[0].element).toBe('purple elephant')
    expect(Buffer.isBuffer(result.screenshotBuffer)).toBe(true)
  })

  it('fails when a notContains element is visible', async () => {
    const engine = new VerificationEngine(fakeResolver({ modal: true }), new AnnotationEngine(), null)
    const result = await engine.verify(await fakePage(), { notContains: ['modal'] })
    expect(result.pass).toBe(false)
    expect(result.issues[0].message).toMatch(/should not be present/)
  })

  it('treats hidden elements as not found', async () => {
    const engine = new VerificationEngine(fakeResolver({ nav: false }), new AnnotationEngine(), null)
    const result = await engine.verify(await fakePage(), { contains: ['nav'] })
    expect(result.pass).toBe(false)
    expect(result.issues[0].actual).toBe('hidden')
  })
})
