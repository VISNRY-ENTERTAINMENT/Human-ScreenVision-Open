/**
 * WebKit protocol support.
 *
 * WebKit speaks the WebKit Inspector Protocol, not CDP. It shares domain and
 * method names for many operations (Page, Runtime, DOM, Network), but the
 * transport is a pipe to a Playwright-patched `MiniBrowser`, not a WebSocket.
 * This build records the mapping and candidate paths; launching WebKit throws
 * an informative error until a transport driver is added.
 */
import os from 'os'
import path from 'path'

export interface WebKitArgOptions {
  headless: boolean
  userDataDir: string
  extraArgs: string[]
}

export const WEBKIT_CANDIDATE_PATHS: string[] = [
  path.join(os.homedir(), '.screenvision', 'browsers', 'webkit', 'Playwright.app', 'Contents', 'MacOS', 'Playwright'),
  path.join(os.homedir(), '.screenvision', 'browsers', 'webkit', 'pw_run.sh'),
  path.join(os.homedir(), '.screenvision', 'browsers', 'webkit', 'MiniBrowser.exe'),
]

/**
 * Build the WebKit MiniBrowser command line.
 * @param opts - headless flag, profile directory and extra args
 * @returns argv array (without the executable)
 */
export function webkitLaunchArgs(opts: WebKitArgOptions): string[] {
  const args = ['--inspector-pipe', `--user-data-dir=${opts.userDataDir}`]
  if (opts.headless) args.push('--headless')
  args.push(...opts.extraArgs)
  args.push('about:blank')
  return args
}

/** WebKit Inspector Protocol equivalents for the operations ScreenVision uses. */
export const WEBKIT_COMMANDS = {
  navigate: 'Page.navigate',
  reload: 'Page.reload',
  captureScreenshot: 'Page.snapshotRect',
  evaluate: 'Runtime.evaluate',
  callFunctionOn: 'Runtime.callFunctionOn',
  getDocument: 'DOM.getDocument',
  querySelector: 'DOM.querySelector',
  querySelectorAll: 'DOM.querySelectorAll',
  getBoxModel: 'DOM.getBoxModel',
  setDeviceMetricsOverride: 'Page.setScreenSizeOverride',
  setUserAgentOverride: 'Page.overrideUserAgent',
  setTouchEmulationEnabled: 'Page.setTouchEmulationEnabled',
  dispatchMouseEvent: 'Input.dispatchMouseEvent',
  dispatchKeyEvent: 'Input.dispatchKeyEvent',
  setCookie: 'Page.setCookie',
  getAllCookies: 'Page.getCookies',
  clearBrowserCookies: 'Page.deleteAllCookies',
} as const
