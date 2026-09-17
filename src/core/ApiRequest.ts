import type { BrowserContext } from './BrowserContext'
import type { Cookie } from './types'

/** What an API call returns. */
export interface ApiResponse {
  url: string
  status: number
  ok: boolean
  headers: Record<string, string>
  text: () => Promise<string>
  json: <T>() => Promise<T>
  body: () => Promise<Buffer>
}

/** Options for one API call. */
export interface ApiRequestOptions {
  headers?: Record<string, string>
  /** Sent as JSON, with the content type set for you. */
  data?: unknown
  /** Sent as a form body. */
  form?: Record<string, string>
  /** Sent verbatim. */
  body?: string | Buffer
  /** Query string parameters, appended to the url. */
  params?: Record<string, string | number | boolean>
  timeout?: number
  /** Whether to follow redirects. Default true. */
  followRedirects?: boolean
}

/**
 * Makes HTTP calls outside the browser, sharing the browser's cookies.
 *
 * Two jobs, both awkward without it. Setting a test up — creating the account, seeding the
 * order, granting the permission — is far faster and less brittle through the API than by
 * driving the interface, and the session it establishes then applies to the pages the context
 * opens. And checking an effect that has no visible trace, such as whether a click really
 * created the record, needs a way to ask the server directly.
 *
 * Cookies flow both ways: calls are sent with the context's cookies, and any the server sets
 * are written back into the context, so signing in through the API signs in the browser too.
 */
export class ApiRequestContext {
  /**
   * @param context - Browser context whose cookies this shares
   */
  constructor(private context: BrowserContext) {}

  /**
   * Send a GET.
   * @param url - Absolute URL
   * @param options - Headers, query parameters, timeout
   * @returns The response
   */
  async get(url: string, options?: ApiRequestOptions): Promise<ApiResponse> {
    return this.fetch('GET', url, options)
  }

  /**
   * Send a POST.
   * @param url - Absolute URL
   * @param options - Body, headers, timeout
   * @returns The response
   */
  async post(url: string, options?: ApiRequestOptions): Promise<ApiResponse> {
    return this.fetch('POST', url, options)
  }

  /**
   * Send a PUT.
   * @param url - Absolute URL
   * @param options - Body, headers, timeout
   * @returns The response
   */
  async put(url: string, options?: ApiRequestOptions): Promise<ApiResponse> {
    return this.fetch('PUT', url, options)
  }

  /**
   * Send a PATCH.
   * @param url - Absolute URL
   * @param options - Body, headers, timeout
   * @returns The response
   */
  async patch(url: string, options?: ApiRequestOptions): Promise<ApiResponse> {
    return this.fetch('PATCH', url, options)
  }

  /**
   * Send a DELETE.
   * @param url - Absolute URL
   * @param options - Headers, timeout
   * @returns The response
   */
  async delete(url: string, options?: ApiRequestOptions): Promise<ApiResponse> {
    return this.fetch('DELETE', url, options)
  }

  /**
   * Send a request with any method.
   * @param method - HTTP method
   * @param url - Absolute URL
   * @param options - Body, headers, query parameters, timeout
   * @returns The response
   * @throws Error naming the method and url when the request cannot be made
   */
  async fetch(method: string, url: string, options?: ApiRequestOptions): Promise<ApiResponse> {
    const target = new URL(url)
    for (const [key, value] of Object.entries(options?.params ?? {})) {
      target.searchParams.set(key, String(value))
    }

    const headers: Record<string, string> = { ...(options?.headers ?? {}) }
    let body: string | Buffer | undefined
    if (options?.data !== undefined) {
      body = JSON.stringify(options.data)
      headers['content-type'] = headers['content-type'] ?? 'application/json'
    } else if (options?.form !== undefined) {
      body = new URLSearchParams(options.form).toString()
      headers['content-type'] = headers['content-type'] ?? 'application/x-www-form-urlencoded'
    } else if (options?.body !== undefined) {
      body = options.body
    }

    const cookieHeader = await this.cookieHeaderFor(target)
    if (cookieHeader) headers['cookie'] = cookieHeader

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), options?.timeout ?? 30000)
    let response: Response
    try {
      response = await fetch(target.toString(), {
        method,
        headers,
        body: body as BodyInit | undefined,
        redirect: options?.followRedirects === false ? 'manual' : 'follow',
        signal: controller.signal,
      })
    } catch (err) {
      const reason = (err as Error).name === 'AbortError' ? `timed out after ${options?.timeout ?? 30000}ms` : (err as Error).message
      throw new Error(`${method} ${target.toString()} failed: ${reason}`)
    } finally {
      clearTimeout(timer)
    }

    await this.storeSetCookies(response, target)

    const buffer = Buffer.from(await response.arrayBuffer())
    const responseHeaders: Record<string, string> = {}
    response.headers.forEach((value, key) => {
      responseHeaders[key.toLowerCase()] = value
    })

    return {
      url: target.toString(),
      status: response.status,
      ok: response.ok,
      headers: responseHeaders,
      body: async () => buffer,
      text: async () => buffer.toString('utf8'),
      json: async <T>() => {
        const text = buffer.toString('utf8')
        try {
          return JSON.parse(text) as T
        } catch {
          throw new Error(
            `${method} ${target.toString()} returned ${response.status} with a body that is not JSON: ` +
              `${text.slice(0, 200)}`
          )
        }
      },
    }
  }

  /**
   * Build a Cookie header from the context's cookies that apply to a URL.
   * @param target - The URL being requested
   * @returns The header value, or an empty string when nothing applies
   */
  private async cookieHeaderFor(target: URL): Promise<string> {
    const cookies = await this.context.cookies().catch(() => [] as Cookie[])
    const applicable = cookies.filter((cookie) => {
      const domain = (cookie.domain ?? '').replace(/^\./, '')
      if (domain && !(target.hostname === domain || target.hostname.endsWith(`.${domain}`))) return false
      if (cookie.path && !target.pathname.startsWith(cookie.path)) return false
      if (cookie.secure && target.protocol !== 'https:') return false
      return true
    })
    return applicable.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ')
  }

  /**
   * Write any cookies the server set back into the browser context.
   *
   * This is what makes signing in through the API also sign in the browser, which is the main
   * reason to use this rather than a bare fetch.
   * @param response - The response just received
   * @param target - The URL that was requested
   */
  private async storeSetCookies(response: Response, target: URL): Promise<void> {
    const raw = (response.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? []
    const cookies: Cookie[] = []
    for (const line of raw) {
      const [pair, ...attributes] = line.split(';')
      const separator = pair.indexOf('=')
      if (separator <= 0) continue
      const cookie: Cookie = {
        name: pair.slice(0, separator).trim(),
        value: pair.slice(separator + 1).trim(),
        domain: target.hostname,
        path: '/',
        // a session cookie: no expiry, and the defaults the browser would apply itself
        expires: -1,
        httpOnly: false,
        secure: false,
        sameSite: 'Lax',
      }
      for (const attribute of attributes) {
        const [key, value] = attribute.split('=')
        const name = key.trim().toLowerCase()
        if (name === 'domain' && value) cookie.domain = value.trim().replace(/^\./, '')
        if (name === 'path' && value) cookie.path = value.trim()
        if (name === 'secure') cookie.secure = true
        if (name === 'httponly') cookie.httpOnly = true
      }
      cookies.push(cookie)
    }
    if (cookies.length > 0) await this.context.addCookies(cookies).catch(() => undefined)
  }
}
