import { describe, it, expect } from 'vitest'
import { AnnotationEngine } from '../../src/capture/AnnotationEngine'
import sharp from 'sharp'

// Create a blank 800x600 PNG for testing
async function blankPNG(): Promise<Buffer> {
  return sharp({
    create: { width: 800, height: 600, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } }
  }).png().toBuffer()
}

describe('AnnotationEngine', () => {

  const engine = new AnnotationEngine()
  const testBbox = { x: 100, y: 50, width: 200, height: 60 }

  it('returns a buffer', async () => {
    const input = await blankPNG()
    const result = await engine.annotate(input, [
      { bbox: testBbox, style: 'box', label: 'Test' }
    ])
    expect(Buffer.isBuffer(result)).toBe(true)
    expect(result.length).toBeGreaterThan(0)
  })

  it('annotated image has same dimensions as input', async () => {
    const input = await blankPNG()
    const result = await engine.annotate(input, [
      { bbox: testBbox, style: 'circle' }
    ])
    const meta = await sharp(result).metadata()
    expect(meta.width).toBe(800)
    expect(meta.height).toBe(600)
  })

  it('handles empty annotations', async () => {
    const input = await blankPNG()
    const result = await engine.annotate(input, [])
    expect(Buffer.isBuffer(result)).toBe(true)
  })

  it('handles all annotation styles without throwing', async () => {
    const input = await blankPNG()
    const styles = ['circle', 'highlight', 'arrow', 'box', 'crosshair', 'label-only'] as const
    for (const style of styles) {
      const result = await engine.annotate(input, [
        { bbox: testBbox, style, label: `Testing ${style}` }
      ])
      expect(Buffer.isBuffer(result)).toBe(true)
    }
  })
})
