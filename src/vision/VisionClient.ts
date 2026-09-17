export interface VisionRequest {
  imageBase64: string
  imageMediaType: 'image/png' | 'image/jpeg' | 'image/webp'
  prompt: string
  maxTokens?: number
}

export interface VisionResponse {
  text: string
  confidence?: number
}

const REQUEST_TIMEOUT = 60000

/**
 * HTTP client for a vision-capable model endpoint (Anthropic Messages API format by default).
 * Never invoked unless a `visionEndpoint` was configured at launch.
 */
export class VisionClient {
  /**
   * @param endpoint - e.g. `https://api.anthropic.com/v1/messages`
   * @param apiKey - API key sent as `x-api-key` (and `Authorization: Bearer`)
   * @param modelId - Model identifier
   */
  constructor(
    private endpoint: string,
    private apiKey: string,
    private modelId: string = 'claude-sonnet-4-6'
  ) {}

  /**
   * Send an image and prompt; return the model's text.
   * @param request - Image (base64), media type, prompt, maxTokens
   * @returns Model text (and confidence when the endpoint reports one)
   * @throws Error on network failure, non-2xx status, or an unrecognised response shape
   */
  async query(request: VisionRequest): Promise<VisionResponse> {
    const body = {
      model: this.modelId,
      max_tokens: request.maxTokens ?? 512,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: request.imageMediaType, data: request.imageBase64 },
            },
            { type: 'text', text: request.prompt },
          ],
        },
      ],
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT)
    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.apiKey,
          authorization: `Bearer ${this.apiKey}`,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      })
      const raw = await response.text()
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${raw.slice(0, 300)}`)
      }
      return parseVisionResponse(raw)
    } catch (err) {
      const reason = (err as Error).name === 'AbortError' ? `timeout after ${REQUEST_TIMEOUT}ms` : (err as Error).message
      throw new Error(`VisionClient.query(${this.endpoint}, model=${this.modelId}) failed: ${reason}`)
    } finally {
      clearTimeout(timer)
    }
  }
}

/**
 * Extract text from Anthropic (`content[].text`), OpenAI-style
 * (`choices[0].message.content`) or plain (`text` / `output`) response bodies.
 * @param raw - Response body
 * @returns Parsed text + optional confidence
 */
export function parseVisionResponse(raw: string): VisionResponse {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return { text: raw }
  }
  if (!data || typeof data !== 'object') return { text: raw }
  const obj = data as Record<string, unknown>
  const confidence = typeof obj.confidence === 'number' ? obj.confidence : undefined

  if (Array.isArray(obj.content)) {
    const text = (obj.content as Array<{ type?: string; text?: string }>)
      .filter((c) => c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text as string)
      .join('\n')
    return { text, confidence }
  }
  if (Array.isArray(obj.choices)) {
    const first = (obj.choices as Array<{ message?: { content?: unknown }; text?: string }>)[0]
    const content = first?.message?.content
    if (typeof content === 'string') return { text: content, confidence }
    if (typeof first?.text === 'string') return { text: first.text, confidence }
  }
  if (typeof obj.text === 'string') return { text: obj.text, confidence }
  if (typeof obj.output === 'string') return { text: obj.output, confidence }
  throw new Error('unrecognised vision response shape')
}
