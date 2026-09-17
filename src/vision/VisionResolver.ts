import { VisionClient } from './VisionClient'
import { BoundingBox } from '../core/types'

export interface VisionElementResult {
  found: boolean
  bbox?: BoundingBox
  description?: string
  confidence: number
}

/**
 * Vision-guided element location and device detection.
 */
export class VisionResolver {
  /**
   * @param client - Vision model client
   */
  constructor(private client: VisionClient) {}

  /**
   * Ask the vision model for the bounding box of a described element.
   * @param screenshotBuffer - PNG screenshot
   * @param query - Element description
   * @returns found flag, bbox in image pixels, confidence
   * @throws Error when the model call fails (an unparsable answer yields `found: false`)
   */
  async findElement(screenshotBuffer: Buffer, query: string): Promise<VisionElementResult> {
    const prompt =
      `Identify the ${query} in this screenshot. ` +
      'Return a JSON object with this exact format: ' +
      '{"found": true, "x": N, "y": N, "width": N, "height": N, "confidence": 0.N} ' +
      'If not found: {"found": false, "confidence": 0} ' +
      'x, y are the top-left pixel coordinates. width and height are in pixels. ' +
      'Return ONLY the JSON object, no other text.'
    let text: string
    try {
      const response = await this.client.query({
        imageBase64: screenshotBuffer.toString('base64'),
        imageMediaType: 'image/png',
        prompt,
        maxTokens: 256,
      })
      text = response.text
    } catch (err) {
      throw new Error(`VisionResolver.findElement("${query}") failed: ${(err as Error).message}`)
    }
    const parsed = extractJson(text)
    if (!parsed || parsed.found !== true) {
      return { found: false, confidence: 0, description: text.slice(0, 200) }
    }
    const x = num(parsed.x)
    const y = num(parsed.y)
    const width = num(parsed.width)
    const height = num(parsed.height)
    if (x === null || y === null || width === null || height === null || width <= 0 || height <= 0) {
      return { found: false, confidence: 0, description: text.slice(0, 200) }
    }
    return {
      found: true,
      bbox: { x, y, width, height },
      confidence: clamp01(num(parsed.confidence) ?? 0.6),
      description: typeof parsed.description === 'string' ? parsed.description : undefined,
    }
  }

  /**
   * Ask the vision model what device class a screenshot is from.
   * @param screenshotBuffer - PNG screenshot
   * @returns device class and estimated CSS width
   * @throws Error when the model call fails or the answer cannot be parsed
   */
  async detectDevice(screenshotBuffer: Buffer): Promise<{
    device: 'mobile' | 'tablet' | 'desktop'
    widthEstimate: number
  }> {
    const prompt =
      'What type of device does this screenshot appear to be from? ' +
      'Return JSON: {"device": "mobile"|"tablet"|"desktop", "width_estimate": N}. Return ONLY the JSON object.'
    let text: string
    try {
      const response = await this.client.query({
        imageBase64: screenshotBuffer.toString('base64'),
        imageMediaType: 'image/png',
        prompt,
        maxTokens: 128,
      })
      text = response.text
    } catch (err) {
      throw new Error(`VisionResolver.detectDevice failed: ${(err as Error).message}`)
    }
    const parsed = extractJson(text)
    const device = parsed?.device
    if (device !== 'mobile' && device !== 'tablet' && device !== 'desktop') {
      throw new Error(`VisionResolver.detectDevice: unparsable answer: ${text.slice(0, 200)}`)
    }
    const widthEstimate = num(parsed?.width_estimate) ?? (device === 'mobile' ? 390 : device === 'tablet' ? 820 : 1440)
    return { device, widthEstimate }
  }
}

function extractJson(text: string): Record<string, unknown> | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return null
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v))
}
