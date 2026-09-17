import type { ChildProcess } from 'child_process'
import { CDPClient } from '../cdp/CDPClient'
import { BrowserLauncher } from '../cdp/BrowserLauncher'
import { BrowserContext } from './BrowserContext'
import { BrowserContextOptions, BrowserType, LaunchOptions, CodeIndexResult } from './types'
import type { Page } from './Page'

/**
 * A running browser instance. Creates isolated contexts and pages.
 */
export class Browser {
  private contextList: BrowserContext[] = []
  private closed = false

  /**
   * @param client - Connected browser-level CDP client
   * @param process - Browser child process
   * @param options - Launch options used
   * @param codeIndex - Code index built at launch (or null)
   */
  constructor(
    private client: CDPClient,
    private process: ChildProcess,
    private options: LaunchOptions,
    private codeIndex: CodeIndexResult | null = null
  ) {}

  /**
   * Create an isolated context (CDP `Target.createBrowserContext`), applying device emulation to its pages.
   * @param options - Context options
   * @returns The new context
   */
  async newContext(options: BrowserContextOptions = {}): Promise<BrowserContext> {
    this.assertOpen('newContext')
    let contextId: string
    try {
      const result = await this.client.send('Target.createBrowserContext', { disposeOnDetach: true })
      contextId = result.browserContextId as string
    } catch (err) {
      throw new Error(`Browser.newContext failed: ${(err as Error).message}`)
    }
    const context = new BrowserContext(
      this.client,
      contextId,
      options,
      this.codeIndex,
      this.options.visionEndpoint ?? null,
      this.options.visionApiKey ?? null
    )
    this.contextList.push(context)
    return context
  }

  /**
   * Convenience: new context + new page.
   * @returns A page in a fresh context
   */
  async newPage(): Promise<Page> {
    const context = await this.newContext()
    return context.newPage()
  }

  /**
   * Contexts created through this Browser instance (verified against CDP `Target.getBrowserContexts`).
   * @returns Context list
   */
  async contexts(): Promise<BrowserContext[]> {
    this.assertOpen('contexts')
    try {
      const result = await this.client.send('Target.getBrowserContexts')
      const ids = new Set((result.browserContextIds ?? []) as string[])
      this.contextList = this.contextList.filter((c) => ids.has(c.id()))
      return [...this.contextList]
    } catch (err) {
      throw new Error(`Browser.contexts failed: ${(err as Error).message}`)
    }
  }

  /** The engine type this browser was launched as. */
  browserType(): BrowserType {
    return this.options.browserType ?? 'chromium'
  }

  /** The code index built at launch, if any. */
  codeIndexResult(): CodeIndexResult | null {
    return this.codeIndex
  }

  /**
   * Registered CDP event listeners across every page in this browser.
   *
   * A page that has been closed should leave none behind, so this count staying flat as
   * pages open and close is what proves the absence of the per-page listener leak.
   * @returns Listener count
   */
  listenerCount(): number {
    return this.client.listenerCount()
  }

  /** Close all contexts, close the CDP connection and kill the process. */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    const contexts = [...this.contextList]
    for (const c of contexts) await c.close().catch(() => undefined)
    try {
      const targets = await this.client.send('Target.getTargets')
      const infos = (targets.targetInfos ?? []) as Array<{ targetId: string; type: string }>
      for (const t of infos) {
        if (t.type === 'page') await this.client.send('Target.closeTarget', { targetId: t.targetId }).catch(() => undefined)
      }
      await this.client.send('Browser.close').catch(() => undefined)
    } catch {
      /* connection may already be gone */
    }
    await this.client.close()
    await BrowserLauncher.kill(this.process)
  }

  /**
   * Browser product/version string (CDP `Browser.getVersion`).
   * @returns e.g. `Chrome/128.0.0.0`
   */
  async version(): Promise<string> {
    this.assertOpen('version')
    try {
      const result = await this.client.send('Browser.getVersion')
      return String(result.product ?? result.userAgent ?? 'unknown')
    } catch (err) {
      throw new Error(`Browser.version failed: ${(err as Error).message}`)
    }
  }

  /** Whether {@link close} has been called or the connection dropped. */
  isConnected(): boolean {
    return !this.closed && this.client.isConnected()
  }

  private assertOpen(op: string): void {
    if (this.closed) throw new Error(`Browser.${op}: browser has been closed`)
  }
}
