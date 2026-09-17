import sharp from 'sharp'
import { AnnotationSpec, BoundingBox, DiptychOptions } from '../core/types'

// COLOR DEFAULTS per style
const STYLE_COLORS: Record<string, string> = {
  circle: '#FF3B30', // red
  highlight: '#FFD60A', // yellow with 35% opacity
  arrow: '#FF3B30', // red
  box: '#007AFF', // blue
  crosshair: '#FF3B30', // red
  'label-only': '#000000', // black
}

const FONT = 'font-family="Helvetica, Arial, sans-serif" font-size="14" font-weight="600"'

/**
 * Draws circles, highlights, boxes, arrows, crosshairs and labels onto screenshot buffers.
 */
export class AnnotationEngine {
  /**
   * Apply annotations to an image and return a PNG.
   * @param screenshotBuffer - Source image (any format sharp can decode)
   * @param annotations - Annotations; each needs `bbox` or an `element` (resolved via `boundingBox()`)
   * @returns Annotated PNG bytes
   * @throws Error when the image cannot be decoded or composited
   */
  async annotate(screenshotBuffer: Buffer, annotations: AnnotationSpec[]): Promise<Buffer> {
    let width: number
    let height: number
    try {
      const meta = await sharp(screenshotBuffer).metadata()
      if (!meta.width || !meta.height) throw new Error('image has no dimensions')
      width = meta.width
      height = meta.height
    } catch (err) {
      throw new Error(`AnnotationEngine.annotate: cannot read image: ${(err as Error).message}`)
    }
    if (annotations.length === 0) {
      return sharp(screenshotBuffer).png().toBuffer()
    }

    const svgAnnotations: string[] = []
    for (const annotation of annotations) {
      let bbox = annotation.bbox
      if (!bbox && annotation.element) {
        const box = await annotation.element.boundingBox()
        if (!box) continue
        bbox = box
      }
      if (!bbox) continue
      const color = annotation.color ?? STYLE_COLORS[annotation.style] ?? '#FF3B30'
      switch (annotation.style) {
        case 'circle':
          this.drawCircle(svgAnnotations, bbox, annotation.label, color)
          break
        case 'highlight':
          this.drawHighlight(svgAnnotations, bbox, annotation.label, color)
          break
        case 'box':
          this.drawBox(svgAnnotations, bbox, annotation.label, color)
          break
        case 'arrow':
          this.drawArrow(svgAnnotations, bbox, annotation.label, color)
          break
        case 'crosshair':
          this.drawCrosshair(svgAnnotations, bbox, annotation.label, color)
          break
        case 'label-only':
          this.drawLabel(svgAnnotations, bbox, annotation.label ?? '', color)
          break
        case 'redact':
          this.drawRedact(svgAnnotations, bbox, annotation.label)
          break
      }
    }

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${svgAnnotations.join('')}</svg>`
    try {
      return await sharp(screenshotBuffer)
        .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
        .png()
        .toBuffer()
    } catch (err) {
      throw new Error(`AnnotationEngine.annotate: composite failed: ${(err as Error).message}`)
    }
  }

  /** Ellipse enclosing the box (stroke 3px) with an optional label above. */
  private drawCircle(svgAnnotations: string[], bbox: BoundingBox, label: string | undefined, color: string): void {
    const cx = bbox.x + bbox.width / 2
    const cy = bbox.y + bbox.height / 2
    const rx = bbox.width / 2 + 8
    const ry = bbox.height / 2 + 8
    svgAnnotations.push(
      `<ellipse cx="${n(cx)}" cy="${n(cy)}" rx="${n(rx)}" ry="${n(ry)}" fill="none" stroke="${color}" stroke-width="3"/>`
    )
    if (label) this.drawLabel(svgAnnotations, { ...bbox, y: bbox.y - 8 }, label, color)
  }

  /** Semi-transparent fill (opacity 0.35) over the box. */
  private drawHighlight(svgAnnotations: string[], bbox: BoundingBox, label: string | undefined, color: string): void {
    svgAnnotations.push(
      `<rect x="${n(bbox.x)}" y="${n(bbox.y)}" width="${n(bbox.width)}" height="${n(bbox.height)}" fill="${color}" fill-opacity="0.35" stroke="${color}" stroke-width="1"/>`
    )
    if (label) this.drawLabel(svgAnnotations, bbox, label, color)
  }

  /** Rectangle outline (stroke 2px). */
  private drawBox(svgAnnotations: string[], bbox: BoundingBox, label: string | undefined, color: string): void {
    svgAnnotations.push(
      `<rect x="${n(bbox.x)}" y="${n(bbox.y)}" width="${n(bbox.width)}" height="${n(bbox.height)}" fill="none" stroke="${color}" stroke-width="2"/>`
    )
    if (label) this.drawLabel(svgAnnotations, bbox, label, color)
  }

  /** 60px arrow from the top-left pointing at the box centre. */
  private drawArrow(svgAnnotations: string[], bbox: BoundingBox, label: string | undefined, color: string): void {
    const tipX = bbox.x + bbox.width / 2
    const tipY = bbox.y + bbox.height / 2
    const length = 60
    const dx = Math.SQRT1_2 * length
    const startX = tipX - dx
    const startY = tipY - dx
    // Arrow head: two short lines at ±30° from the shaft direction (45°).
    const headLen = 12
    const angle = Math.atan2(tipY - startY, tipX - startX)
    const h1x = tipX - headLen * Math.cos(angle - Math.PI / 6)
    const h1y = tipY - headLen * Math.sin(angle - Math.PI / 6)
    const h2x = tipX - headLen * Math.cos(angle + Math.PI / 6)
    const h2y = tipY - headLen * Math.sin(angle + Math.PI / 6)
    svgAnnotations.push(
      `<line x1="${n(startX)}" y1="${n(startY)}" x2="${n(tipX)}" y2="${n(tipY)}" stroke="${color}" stroke-width="3" stroke-linecap="round"/>`,
      `<polygon points="${n(tipX)},${n(tipY)} ${n(h1x)},${n(h1y)} ${n(h2x)},${n(h2y)}" fill="${color}"/>`
    )
    if (label) this.drawLabel(svgAnnotations, { x: startX - 4, y: startY - 6, width: 0, height: 0 }, label, color)
  }

  /** Crosshair at the box centre, lines 20px from centre. */
  private drawCrosshair(svgAnnotations: string[], bbox: BoundingBox, label: string | undefined, color: string): void {
    const cx = bbox.x + bbox.width / 2
    const cy = bbox.y + bbox.height / 2
    const r = 20
    svgAnnotations.push(
      `<line x1="${n(cx - r)}" y1="${n(cy)}" x2="${n(cx + r)}" y2="${n(cy)}" stroke="${color}" stroke-width="2"/>`,
      `<line x1="${n(cx)}" y1="${n(cy - r)}" x2="${n(cx)}" y2="${n(cy + r)}" stroke="${color}" stroke-width="2"/>`,
      `<circle cx="${n(cx)}" cy="${n(cy)}" r="4" fill="none" stroke="${color}" stroke-width="2"/>`
    )
    if (label) this.drawLabel(svgAnnotations, { x: cx + r + 4, y: cy + 5, width: 0, height: 0 }, label, color)
  }

  /**
   * Opaque cover over the box, so the content beneath is gone from the image, not merely
   * styled over. A thin border and an optional label mark that something was intentionally
   * removed rather than blank.
   */
  private drawRedact(svgAnnotations: string[], bbox: BoundingBox, label: string | undefined): void {
    svgAnnotations.push(
      `<rect x="${n(bbox.x)}" y="${n(bbox.y)}" width="${n(bbox.width)}" height="${n(bbox.height)}" fill="#000000" fill-opacity="1" stroke="#000000" stroke-width="1"/>`
    )
    const text = escapeXml(label ?? 'redacted')
    // centre a small marker inside the block so a viewer knows it was deliberate
    const cx = bbox.x + bbox.width / 2
    const cy = bbox.y + bbox.height / 2
    if (bbox.width > 60 && bbox.height > 14) {
      svgAnnotations.push(
        `<text x="${n(cx)}" y="${n(cy + 4)}" text-anchor="middle" fill="#FFFFFF" font-family="Helvetica, Arial, sans-serif" font-size="11" font-weight="600">${text}</text>`
      )
    }
  }

  /**
   * Stitch two images side by side into one PNG: the before/after story in a single artifact.
   *
   * Each half keeps its own size; the shorter is top-aligned. Per-half captions sit under the
   * pair and an optional title strip runs across the top — for a canvas that is where the
   * energy delta ("blank 0.00 -> drawn 12.79") belongs, turning two files and a log into one
   * self-explaining image.
   * @param left - The "before" image bytes.
   * @param right - The "after" image bytes.
   * @param options - Captions, gutter, title.
   * @returns The stitched PNG bytes.
   */
  async diptych(left: Buffer, right: Buffer, options: DiptychOptions = {}): Promise<Buffer> {
    const gap = options.gap ?? 16
    const titleH = options.title ? 28 : 0
    const captionH = options.labels ? 24 : 0
    const [lm, rm] = await Promise.all([sharp(left).metadata(), sharp(right).metadata()])
    const lw = lm.width ?? 0
    const lh = lm.height ?? 0
    const rw = rm.width ?? 0
    const rh = rm.height ?? 0
    if (!lw || !lh || !rw || !rh) {
      throw new Error('AnnotationEngine.diptych: one of the images has no dimensions')
    }
    const width = lw + gap + rw
    const bodyTop = titleH
    const bodyH = Math.max(lh, rh)
    const height = titleH + bodyH + captionH

    const overlays: string[] = []
    if (options.title) {
      overlays.push(
        `<rect x="0" y="0" width="${width}" height="${titleH}" fill="#1c1c1e"/>`,
        `<text x="${n(width / 2)}" y="${n(titleH / 2 + 5)}" text-anchor="middle" fill="#FFFFFF" ${FONT}>${escapeXml(options.title)}</text>`
      )
    }
    if (options.labels) {
      const y = titleH + bodyH + 16
      overlays.push(
        `<text x="${n(lw / 2)}" y="${n(y)}" text-anchor="middle" fill="#1c1c1e" ${FONT}>${escapeXml(options.labels[0])}</text>`,
        `<text x="${n(lw + gap + rw / 2)}" y="${n(y)}" text-anchor="middle" fill="#1c1c1e" ${FONT}>${escapeXml(options.labels[1])}</text>`
      )
    }
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="#FFFFFF"/>${overlays.join('')}</svg>`

    const [leftPng, rightPng] = await Promise.all([sharp(left).png().toBuffer(), sharp(right).png().toBuffer()])
    const out = await sharp(Buffer.from(svg))
      .composite([
        { input: leftPng, top: bodyTop, left: 0 },
        { input: rightPng, top: bodyTop, left: lw + gap },
      ])
      .png()
      .toBuffer()
    return out
  }

  /** Label text with a filled background pill, positioned above the box's top-left. */
  private drawLabel(svgAnnotations: string[], bbox: BoundingBox, label: string, color: string): void {
    if (!label) return
    const text = escapeXml(label)
    const padX = 6
    const boxH = 20
    const estimatedW = Math.max(12, label.length * 8 + padX * 2)
    const x = Math.max(0, bbox.x)
    const y = Math.max(0, bbox.y - boxH - 2)
    svgAnnotations.push(
      `<rect x="${n(x)}" y="${n(y)}" width="${n(estimatedW)}" height="${boxH}" rx="3" fill="${color}"/>`,
      `<text x="${n(x + padX)}" y="${n(y + 14.5)}" fill="${contrastText(color)}" ${FONT}>${text}</text>`
    )
  }
}

function n(v: number): string {
  return Number.isFinite(v) ? String(Math.round(v * 100) / 100) : '0'
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function contrastText(hex: string): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex)
  if (!m) return '#FFFFFF'
  const [r, g, b] = [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)]
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255
  return luminance > 0.6 ? '#000000' : '#FFFFFF'
}
