/**
 * Chromium-specific launch arguments, well-known install paths, and the
 * CDP domains ScreenVision enables on each page session.
 */
import os from 'os'
import path from 'path'

export interface ChromiumArgOptions {
  headless: boolean
  userDataDir: string
  extraArgs: string[]
}

const PROGRAM_FILES = process.env['PROGRAMFILES'] ?? 'C:\\Program Files'
const PROGRAM_FILES_X86 = process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)'
const LOCAL_APP_DATA = process.env['LOCALAPPDATA'] ?? path.join(os.homedir(), 'AppData', 'Local')

/** Common Chrome locations first, then Microsoft Edge (Chromium) as a fallback. */
export const CHROMIUM_CANDIDATE_PATHS: string[] = [
  // Google Chrome
  path.join(PROGRAM_FILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  path.join(PROGRAM_FILES_X86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  path.join(LOCAL_APP_DATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
  // Microsoft Edge (Chromium)
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  path.join(PROGRAM_FILES, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/microsoft-edge',
  '/usr/bin/microsoft-edge-stable',
]

/**
 * Build the Chromium command line.
 * @param opts - headless flag, profile directory and user-provided extra args
 * @returns argv array (without the executable)
 */
export function chromiumLaunchArgs(opts: ChromiumArgOptions): string[] {
  const args = [
    '--remote-debugging-port=0',
    `--user-data-dir=${opts.userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-sync',
    '--no-sandbox',
    '--disable-features=Translate,OptimizationHints,MediaRouter,msEdgeStartupBoost',
    '--disable-extensions',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-popup-blocking',
    '--disable-hang-monitor',
    '--disable-prompt-on-repost',
    '--metrics-recording-only',
    '--mute-audio',
    '--hide-scrollbars',
  ]
  if (opts.headless) args.push('--headless=new')
  args.push(...opts.extraArgs)
  args.push('about:blank')
  return args
}

/** CDP domains enabled for every page session. */
export const CHROMIUM_PAGE_DOMAINS: readonly string[] = ['Page', 'Runtime', 'DOM', 'Network']

/** Map from high-level operation names to the exact CDP method used. */
export const CHROMIUM_COMMANDS = {
  navigate: 'Page.navigate',
  reload: 'Page.reload',
  captureScreenshot: 'Page.captureScreenshot',
  layoutMetrics: 'Page.getLayoutMetrics',
  handleDialog: 'Page.handleJavaScriptDialog',
  evaluate: 'Runtime.evaluate',
  callFunctionOn: 'Runtime.callFunctionOn',
  getDocument: 'DOM.getDocument',
  querySelector: 'DOM.querySelector',
  querySelectorAll: 'DOM.querySelectorAll',
  getBoxModel: 'DOM.getBoxModel',
  getOuterHTML: 'DOM.getOuterHTML',
  resolveNode: 'DOM.resolveNode',
  focus: 'DOM.focus',
  scrollIntoViewIfNeeded: 'DOM.scrollIntoViewIfNeeded',
  dispatchMouseEvent: 'Input.dispatchMouseEvent',
  dispatchKeyEvent: 'Input.dispatchKeyEvent',
  insertText: 'Input.insertText',
  setDeviceMetricsOverride: 'Emulation.setDeviceMetricsOverride',
  setUserAgentOverride: 'Emulation.setUserAgentOverride',
  setTouchEmulationEnabled: 'Emulation.setTouchEmulationEnabled',
  fetchEnable: 'Fetch.enable',
  fetchDisable: 'Fetch.disable',
  fulfillRequest: 'Fetch.fulfillRequest',
  continueRequest: 'Fetch.continueRequest',
  failRequest: 'Fetch.failRequest',
  setCookie: 'Network.setCookie',
  getAllCookies: 'Network.getAllCookies',
  clearBrowserCookies: 'Network.clearBrowserCookies',
} as const
