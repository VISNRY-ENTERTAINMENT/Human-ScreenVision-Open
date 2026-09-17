import { ProtocolMapper } from '../cdp/ProtocolMapper'
import { BoundingBox, ScreenshotOptions } from '../core/types'
import sharp from 'sharp'

const ELEMENT_PADDING = 8
const GROUP_PADDING = 16

export interface CaptureRegion {
  /** Crop origin in CSS page coordinates. */
  origin: { x: number; y: number }
  /** Image pixels per CSS pixel. */
  scale: number
}

/**
 * Element-level capture: full page, arbitrary bounding boxes, single or multiple elements.
 */
/** A captured image together with the frame its pixels are measured in. */
export interface CaptureResult {
  buffer: Buffer
  region: CaptureRegion
}

export class TargetedCapture {
  /** Region metadata of the most recent capture (origin + scale), for annotation alignment. */
  /**
   * Region of the most recent capture, for debugging only.
   *
   * Do not use it to place annotations: with two captures in flight on one page it may
   * already describe the other one. Use the region returned with the buffer.
   */
  lastRegion: CaptureRegion = { origin: { x: 0, y: 0 }, scale: 1 }

  /**
   * @param mapper - Protocol mapper of the page
   */
  constructor(private mapper: ProtocolMapper) {}

  /** The mapper (used by ScreenshotEngine for metrics). */
  get protocol(): ProtocolMapper {
    return this.mapper
  }

  /**
   * Viewport screenshot, or the whole document when `options.fullPage`.
   * @param options - type/quality/fullPage/omitBackground
   * @returns Image bytes in the requested format
   */
  async captureFullPage(options?: ScreenshotOptions): Promise<CaptureResult> {
    try {
      const metrics = await this.mapper.layoutMetrics()
      const dpr = await this.devicePixelRatio()
      if (options?.fullPage) {
        const buffer = await this.mapper.screenshot({
          format: options.type ?? 'png',
          quality: options.quality,
          clip: { x: 0, y: 0, width: metrics.contentSize.width, height: metrics.contentSize.height },
          captureBeyondViewport: true,
          omitBackground: options.omitBackground,
        })
        const region = { origin: { x: 0, y: 0 }, scale: dpr }
        this.lastRegion = region
        return { buffer, region }
      }
      const buffer = await this.mapper.screenshot({
        format: options?.type ?? 'png',
        quality: options?.quality,
        omitBackground: options?.omitBackground,
      })
      const region = { origin: { x: metrics.scroll.x, y: metrics.scroll.y }, scale: dpr }
      this.lastRegion = region
      return { buffer, region }
    } catch (err) {
      throw new Error(`TargetedCapture.captureFullPage failed: ${(err as Error).message}`)
    }
  }

  /**
   * Capture a bounding box given in CSS page coordinates: full-page capture, then crop with sharp.
   * @param bbox - Region in page coordinates
   * @param options - type/quality
   * @returns Cropped image bytes
   */
  async captureBoundingBox(bbox: BoundingBox, options?: ScreenshotOptions): Promise<CaptureResult> {
    try {
      const metrics = await this.mapper.layoutMetrics()
      const full = await this.mapper.screenshot({
        format: 'png',
        clip: { x: 0, y: 0, width: metrics.contentSize.width, height: metrics.contentSize.height },
        captureBeyondViewport: true,
        omitBackground: options?.omitBackground,
      })
      const image = sharp(full)
      const meta = await image.metadata()
      const imgW = meta.width ?? metrics.contentSize.width
      const imgH = meta.height ?? metrics.contentSize.height
      const scale = imgW / metrics.contentSize.width
      const left = clamp(Math.floor(bbox.x * scale), 0, imgW - 1)
      const top = clamp(Math.floor(bbox.y * scale), 0, imgH - 1)
      const width = clamp(Math.ceil(bbox.width * scale), 1, imgW - left)
      const height = clamp(Math.ceil(bbox.height * scale), 1, imgH - top)
      const region = { origin: { x: left / scale, y: top / scale }, scale }
      this.lastRegion = region
      return { buffer: await encode(image.extract({ left, top, width, height }), options), region }
    } catch (err) {
      throw new Error(
        `TargetedCapture.captureBoundingBox(${JSON.stringify(bbox)}) failed: ${(err as Error).message}`
      )
    }
  }

  /**
   * Capture one element with 8px padding (clamped to the page).
   * @param nodeId - Element nodeId
   * @param options - type/quality
   * @returns Image bytes
   * @throws Error when the element has no bounding box
   */
  async captureElement(nodeId: number, options?: ScreenshotOptions): Promise<CaptureResult> {
    const bbox = await this.mapper.getBoundingBox(nodeId)
    if (!bbox) throw new Error('Element has no bounding box — it may be hidden')
    const pageBox = await this.toPageCoordinates(bbox)
    return this.captureBoundingBox(await this.pad(pageBox, ELEMENT_PADDING), options)
  }

  /**
   * Capture the union of several elements with 16px padding.
   * @param nodeIds - Element nodeIds
   * @param options - type/quality
   * @returns Image bytes
   * @throws Error when no element has a bounding box
   */
  async captureElements(nodeIds: number[], options?: ScreenshotOptions): Promise<CaptureResult> {
    const boxes: BoundingBox[] = []
    for (const id of nodeIds) {
      const b = await this.mapper.getBoundingBox(id)
      if (b) boxes.push(await this.toPageCoordinates(b))
    }
    if (boxes.length === 0) throw new Error('TargetedCapture.captureElements: none of the elements has a bounding box')
    const minX = Math.min(...boxes.map((b) => b.x))
    const minY = Math.min(...boxes.map((b) => b.y))
    const maxX = Math.max(...boxes.map((b) => b.x + b.width))
    const maxY = Math.max(...boxes.map((b) => b.y + b.height))
    const union = { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
    return this.captureBoundingBox(await this.pad(union, GROUP_PADDING), options)
  }

  /**
   * Convert a viewport-relative box to page coordinates by adding the scroll offset.
   * @param bbox - Viewport-relative box
   * @returns Page-relative box
   */
  async toPageCoordinates(bbox: BoundingBox): Promise<BoundingBox> {
    const metrics = await this.mapper.layoutMetrics()
    return { x: bbox.x + metrics.scroll.x, y: bbox.y + metrics.scroll.y, width: bbox.width, height: bbox.height }
  }

  private async pad(bbox: BoundingBox, padding: number): Promise<BoundingBox> {
    const metrics = await this.mapper.layoutMetrics()
    const x = Math.max(0, bbox.x - padding)
    const y = Math.max(0, bbox.y - padding)
    const right = Math.min(metrics.contentSize.width, bbox.x + bbox.width + padding)
    const bottom = Math.min(metrics.contentSize.height, bbox.y + bbox.height + padding)
    return { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) }
  }

  private async devicePixelRatio(): Promise<number> {
    try {
      const dpr = await this.mapper.evaluate<number>('window.devicePixelRatio || 1')
      return typeof dpr === 'number' && dpr > 0 ? dpr : 1
    } catch {
      return 1
    }
  }
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v))
}

async function encode(image: sharp.Sharp, options?: ScreenshotOptions): Promise<Buffer> {
  const type = options?.type ?? 'png'
  if (type === 'jpeg') return image.jpeg({ quality: options?.quality ?? 80 }).toBuffer()
  if (type === 'webp') return image.webp({ quality: options?.quality ?? 80 }).toBuffer()
  return image.png().toBuffer()
}
