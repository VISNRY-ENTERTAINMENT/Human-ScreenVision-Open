import { BrowserLauncher } from '../cdp/BrowserLauncher'
import { CDPClient } from '../cdp/CDPClient'
import { Browser } from './Browser'
import { CodeIndex } from '../intelligence/CodeIndex'
import { LaunchOptions, BrowserType, CodeIndexResult } from './types'
import { DEVICES } from '../intelligence/DeviceContext'

/**
 * Entry point: launches browsers with optional code awareness.
 */
export class ScreenVision {
  /** Device profile library (pass-through). */
  readonly devices = DEVICES

  /** Launch helpers per engine. */
  readonly chromium = { launch: (options?: LaunchOptions): Promise<Browser> => this.launchType('chromium', options) }
  readonly firefox = { launch: (options?: LaunchOptions): Promise<Browser> => this.launchType('firefox', options) }
  readonly webkit = { launch: (options?: LaunchOptions): Promise<Browser> => this.launchType('webkit', options) }

  /**
   * Launch a browser.
   * 1. Build the code index when `options.codebase` is set.
   * 2. Spawn the browser and connect a CDP client.
   * 3. Enable target discovery and verify the connection with `Browser.getVersion`.
   * @param options - Launch options
   * @returns Connected Browser
   * @throws Error on launch/connect failure (the process is killed on failure)
   */
  async launch(options: LaunchOptions = {}): Promise<Browser> {
    let codeIndex: CodeIndexResult | null = null
    if (options.codebase) {
      try {
        codeIndex = await CodeIndex.build(options.codebase, options.framework ?? 'auto')
      } catch (err) {
        throw new Error(`ScreenVision.launch: code index failed for "${options.codebase}": ${(err as Error).message}`)
      }
    }

    const launched = await BrowserLauncher.launch(options)
    const client = new CDPClient(launched.wsEndpoint)
    try {
      await client.connect()
      await client.send('Target.setDiscoverTargets', { discover: true })
      await client.send('Browser.getVersion')
    } catch (err) {
      await client.close().catch(() => undefined)
      await BrowserLauncher.kill(launched.process)
      throw new Error(`ScreenVision.launch: CDP connection failed: ${(err as Error).message}`)
    }
    return new Browser(client, launched.process, options, codeIndex)
  }

  private launchType(browserType: BrowserType, options?: LaunchOptions): Promise<Browser> {
    return this.launch({ ...(options ?? {}), browserType })
  }
}
