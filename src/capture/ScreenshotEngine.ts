import { TargetedCapture, type CaptureRegion } from './TargetedCapture'
import { AnnotationEngine } from './AnnotationEngine'
import type { ElementHandle } from '../core/ElementHandle'
import { AnnotationSpec, BoundingBox, ScreenshotOptions } from '../core/types'
import fs from 'fs/promises'
import path from 'path'
import sharp from 'sharp'

/**
 * A short human identity for an element, from the DOM signals that name it: the accessible
 * name, aria-label, a test id, a form name, an id, or the trimmed text — falling back to the
 * tag. This is what a DOM-attributed overlay labels itself with.
 * @param element - The element to identify.
 * @returns A concise label, or null if nothing usable was found.
 */
async function elementIdentity(element: ElementHandle): Promise<string | null> {
  try {
    const raw = await element.evaluate((el: Element) => {
      const h = el as HTMLElement
      const attr = (n: string): string => (h.getAttribute(n) || '').trim()
      const tag = h.tagName.toLowerCase()
      const name =
        attr('aria-label') ||
        attr('data-testid') ||
        attr('data-test') ||
        attr('name') ||
        (h.id ? '#' + h.id : '') ||
        (h.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40) ||
        attr('role') ||
        tag
      const role = attr('role') || tag
      return JSON.stringify({ name, role })
    })
    const { name, role } = JSON.parse(raw) as { name: string; role: string }
    if (!name) return role || null
    return name === role ? name : `${role}: ${name}`
  } catch {
    return null
  }
}

/**
 * Orchestrates capture + annotation + saving.
 */
export class ScreenshotEngine {
  /**
   * @param capture - Targeted capture for the page
   * @param annotation - Annotation engine
   */
  constructor(
    private capture: TargetedCapture,
    private annotation: AnnotationEngine
  ) {}

  /**
   * Viewport / full-page / clipped screenshot with optional annotations and file output.
   * @param options - Screenshot options
   * @returns Image bytes (PNG when annotated, otherwise the requested type)
   */
  async screenshot(options?: ScreenshotOptions): Promise<Buffer> {
    try {
      const captured = options?.clip
        ? await this.capture.captureBoundingBox(options.clip, options)
        : await this.capture.captureFullPage(options)
      let buffer = captured.buffer
      if (options?.annotate && options.annotate.length > 0) {
        buffer = await this.applyAnnotations(buffer, captured.region, options.annotate, options)
      }
      if (options?.path) await this.saveToFile(buffer, options.path)
      return buffer
    } catch (err) {
      throw new Error(`ScreenshotEngine.screenshot failed: ${(err as Error).message}`)
    }
  }

  /**
   * Screenshot of one element (8px padding) with optional annotations.
   * @param handle - Element
   * @param options - Screenshot options
   * @returns Image bytes
   */
  async screenshotElement(handle: ElementHandle, options?: ScreenshotOptions): Promise<Buffer> {
    try {
      const captured = await this.capture.captureElement(handle.nodeId, options)
      let buffer = captured.buffer
      if (options?.annotate && options.annotate.length > 0) {
        buffer = await this.applyAnnotations(buffer, captured.region, options.annotate, options)
      }
      if (options?.path) await this.saveToFile(buffer, options.path)
      return buffer
    } catch (err) {
      throw new Error(`ScreenshotEngine.screenshotElement(${handle.selector}) failed: ${(err as Error).message}`)
    }
  }

  /**
   * Write bytes to disk, creating parent directories.
   * @param buffer - Image bytes
   * @param filePath - Destination path
   */
  async saveToFile(buffer: Buffer, filePath: string): Promise<void> {
    try {
      await fs.mkdir(path.dirname(path.resolve(filePath)), { recursive: true })
      await fs.writeFile(filePath, buffer)
    } catch (err) {
      throw new Error(`ScreenshotEngine.saveToFile(${filePath}) failed: ${(err as Error).message}`)
    }
  }

  /**
   * Translate annotation boxes (viewport CSS px) into the captured image's pixel space,
   * accounting for the capture origin, scroll offset and device pixel ratio.
   * @param buffer - The captured image
   * @param region - Frame the captured pixels are measured in, from the capture itself
   * @param annotations - Boxes and labels to draw
   * @param options - The screenshot options the capture was made with
   */
  private async applyAnnotations(
    buffer: Buffer,
    region: CaptureRegion,
    annotations: AnnotationSpec[],
    options?: ScreenshotOptions
  ): Promise<Buffer> {
    const metrics = await this.capture.protocol.layoutMetrics()
    const resolved: AnnotationSpec[] = []
    for (const a of annotations) {
      let label = a.label
      // A DOM-attributed label: let the overlay name itself from the element's own identity
      // rather than a hand-typed string, using the same signals observe() ranks by.
      if (a.autoLabel && !label && a.element) {
        label = (await elementIdentity(a.element)) ?? undefined
      }
      let bbox: BoundingBox | undefined = a.bbox
      if (!bbox && a.element) {
        const box = await a.element.boundingBox()
        if (!box) continue
        // element boxes are viewport-relative → page coordinates
        bbox = { x: box.x + metrics.scroll.x, y: box.y + metrics.scroll.y, width: box.width, height: box.height }
      } else if (bbox) {
        // explicit boxes are page coordinates when fullPage/clip, else viewport-relative
        if (!options?.fullPage && !options?.clip) {
          bbox = { x: bbox.x + metrics.scroll.x, y: bbox.y + metrics.scroll.y, width: bbox.width, height: bbox.height }
        }
      }
      if (!bbox) continue
      resolved.push({
        ...a,
        label,
        element: undefined,
        bbox: {
          x: (bbox.x - region.origin.x) * region.scale,
          y: (bbox.y - region.origin.y) * region.scale,
          width: bbox.width * region.scale,
          height: bbox.height * region.scale,
        },
      })
    }
    const annotated = await this.annotation.annotate(buffer, resolved)
    if (options?.type === 'jpeg') return sharp(annotated).jpeg({ quality: options.quality ?? 80 }).toBuffer()
    if (options?.type === 'webp') return sharp(annotated).webp({ quality: options.quality ?? 80 }).toBuffer()
    return annotated
  }
}
