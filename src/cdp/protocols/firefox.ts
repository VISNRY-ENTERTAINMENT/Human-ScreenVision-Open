/**
 * Firefox protocol support.
 *
 * Firefox exposed a CDP subset (`--remote-debugging-port`) up to Firefox 128;
 * newer builds only speak WebDriver BiDi. ScreenVision launches Firefox with
 * the CDP flag and reuses the Chromium ProtocolMapper for the subset that
 * overlaps. Commands not implemented by Firefox surface as CDP errors.
 */
import path from 'path'

export interface FirefoxArgOptions {
  headless: boolean
  userDataDir: string
  extraArgs: string[]
}

const PROGRAM_FILES = process.env['PROGRAMFILES'] ?? 'C:\\Program Files'
const PROGRAM_FILES_X86 = process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)'

export const FIREFOX_CANDIDATE_PATHS: string[] = [
  path.join(PROGRAM_FILES, 'Mozilla Firefox', 'firefox.exe'),
  path.join(PROGRAM_FILES_X86, 'Mozilla Firefox', 'firefox.exe'),
  '/Applications/Firefox.app/Contents/MacOS/firefox',
  '/usr/bin/firefox',
  '/snap/bin/firefox',
]

/**
 * Build the Firefox command line.
 * @param opts - headless flag, profile directory and extra args
 * @returns argv array (without the executable)
 */
export function firefoxLaunchArgs(opts: FirefoxArgOptions): string[] {
  const args = [
    '--remote-debugging-port=0',
    '--no-remote',
    '--profile',
    opts.userDataDir,
    '--new-instance',
  ]
  if (opts.headless) args.push('--headless')
  args.push(...opts.extraArgs)
  args.push('about:blank')
  return args
}

/** CDP domains Firefox's (legacy) remote agent implemented. */
export const FIREFOX_SUPPORTED_DOMAINS: readonly string[] = [
  'Browser',
  'Target',
  'Page',
  'Runtime',
  'Network',
  'Emulation',
  'Input',
  'IO',
  'Log',
  'Security',
]

/** CDP domains the Firefox remote agent never implemented. */
export const FIREFOX_UNSUPPORTED_DOMAINS: readonly string[] = ['DOM', 'Fetch', 'Accessibility']
