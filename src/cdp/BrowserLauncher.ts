import { spawn, ChildProcess } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { LaunchOptions, BrowserType } from '../core/types'
import { chromiumLaunchArgs, CHROMIUM_CANDIDATE_PATHS } from './protocols/chromium'
import { firefoxLaunchArgs, FIREFOX_CANDIDATE_PATHS } from './protocols/firefox'
import { WEBKIT_CANDIDATE_PATHS } from './protocols/webkit'

// eslint-disable-next-line no-console
const log: (...args: unknown[]) => void = process.env.SV_DEBUG ? console.log : () => undefined

export interface LaunchResult {
  process: ChildProcess
  wsEndpoint: string
  pid: number
}

const DEFAULT_LAUNCH_TIMEOUT = 30000

/** Root folder where `npm run install-browsers` places downloaded browsers. */
export function browsersRoot(): string {
  return path.join(os.homedir(), '.screenvision', 'browsers')
}

function existsFile(p: string | undefined): p is string {
  if (!p) return false
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

/** Walk `dir` (bounded depth) looking for a file whose basename matches one of `names`. */
function findInDownloadDir(dir: string, names: string[], depth = 4): string | null {
  if (depth < 0) return null
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return null
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isFile() && names.includes(entry.name.toLowerCase())) return full
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const found = findInDownloadDir(path.join(dir, entry.name), names, depth - 1)
      if (found) return found
    }
  }
  return null
}


/**
 * Temporary profiles that could not be removed yet, swept once at exit.
 *
 * A leaked profile is tens of megabytes, and a machine that runs this in a loop accumulates
 * them silently, so it is worth one last attempt on the way out.
 */
const PENDING_PROFILES = new Set<string>()
let sweepRegistered = false

/**
 * Try once to delete a directory.
 * @param dir - Directory to remove
 * @returns Whether it is now gone
 */
function tryRemove(dir: string): boolean {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 150 })
    return !fs.existsSync(dir)
  } catch {
    return false
  }
}

/** Register the exit sweep once per process. */
function registerProfileSweep(): void {
  if (sweepRegistered) return
  sweepRegistered = true
  process.once('exit', () => {
    for (const dir of PENDING_PROFILES) tryRemove(dir)
  })
}

export class BrowserLauncher {
  /**
   * Locate the browser binary for the given browser type.
   *
   * Search order (first existing path wins):
   * 1. `override` (LaunchOptions.executablePath)
   * 2. `PLAYWRIGHT_<TYPE>_PATH` / `SCREENVISION_<TYPE>_PATH` environment variables
   * 3. Well-known install locations (Chrome, then Microsoft Edge for chromium)
   * 4. `$HOME/.screenvision/browsers/<type>` (populated by `npm run install-browsers`)
   *
   * @param type - Browser engine to locate
   * @param override - Explicit executable path that short-circuits the search
   * @returns Absolute path to an existing browser executable
   * @throws Error when no binary can be found
   */
  static async findExecutable(type: BrowserType, override?: string): Promise<string> {
    if (override) {
      if (existsFile(override)) return override
      throw new Error(
        `BrowserLauncher.findExecutable: executablePath "${override}" does not exist (browserType=${type})`
      )
    }
    const upper = type.toUpperCase()
    const envCandidates = [
      process.env[`PLAYWRIGHT_${upper}_PATH`],
      process.env[`SCREENVISION_${upper}_PATH`],
    ]
    for (const c of envCandidates) {
      if (existsFile(c)) return c
    }

    const candidates =
      type === 'chromium'
        ? CHROMIUM_CANDIDATE_PATHS
        : type === 'firefox'
          ? FIREFOX_CANDIDATE_PATHS
          : WEBKIT_CANDIDATE_PATHS
    for (const c of candidates) {
      if (existsFile(c)) return c
    }

    const downloadDir = path.join(browsersRoot(), type)
    const binaryNames =
      type === 'chromium'
        ? ['chrome.exe', 'chrome', 'chromium', 'chromium-browser', 'headless_shell', 'headless_shell.exe']
        : type === 'firefox'
          ? ['firefox.exe', 'firefox']
          : ['minibrowser.exe', 'minibrowser', 'playwright.sh']
    const found = findInDownloadDir(downloadDir, binaryNames)
    if (found) return found

    throw new Error(
      `Browser binary not found for "${type}". Run: npx screenvision install ` +
        `(or set SCREENVISION_${upper}_PATH / LaunchOptions.executablePath)`
    )
  }

  /**
   * Spawn the browser process and wait for its DevTools WebSocket endpoint.
   *
   * @param options - Launch options (headless, args, timeout, executablePath, browserType)
   * @returns The child process, its pid and the `ws://` DevTools endpoint
   * @throws Error on missing binary, spawn failure, early exit, or launch timeout
   */
  static async launch(options: LaunchOptions): Promise<LaunchResult> {
    const type: BrowserType = options.browserType ?? 'chromium'
    const timeout = options.timeout ?? DEFAULT_LAUNCH_TIMEOUT
    const headless = options.headless ?? true

    // Firefox removed its CDP endpoint and WebKit never had one, so neither can be driven
    // by this library. Refusing here, immediately and by name, is far better than letting
    // the launch sit for the full timeout waiting for a DevTools banner that never comes.
    if (type !== 'chromium') {
      throw new Error(
        `BrowserLauncher.launch: ${type} cannot be driven by ScreenVision — it speaks the Chrome DevTools ` +
          `Protocol only, and ${type} does not expose one. Use chromium (Chrome, Edge or any Chromium build); ` +
          `pass executablePath to point at a specific one.`
      )
    }

    const executable = await BrowserLauncher.findExecutable(type, options.executablePath)
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'screenvision-profile-'))
    registerProfileSweep()
    const args =
      type === 'chromium'
        ? chromiumLaunchArgs({ headless, userDataDir, extraArgs: options.args ?? [] })
        : firefoxLaunchArgs({ headless, userDataDir, extraArgs: options.args ?? [] })

    log('[screenvision] launching', executable, args.join(' '))

    /**
     * Delete the temporary profile, retrying while the browser's children release it.
     *
     * On Windows the child processes keep handles open for a moment after the parent exits,
     * so a single immediate rmSync always fails and, being swallowed, leaked the directory.
     */
    const removeProfile = (): void => {
      if (tryRemove(userDataDir)) {
        PENDING_PROFILES.delete(userDataDir)
        return
      }
      // Under load the browser's children keep their handles for a while, so a burst of
      // immediate attempts is not enough. Keep trying on a widening interval, and leave the
      // directory registered for the exit sweep in case it never becomes removable in time.
      PENDING_PROFILES.add(userDataDir)
      let delay = 250
      const attempt = (): void => {
        if (tryRemove(userDataDir)) {
          PENDING_PROFILES.delete(userDataDir)
          return
        }
        delay = Math.min(delay * 2, 4000)
        if (delay < 4000 || Date.now() < deadline) setTimeout(attempt, delay).unref()
      }
      const deadline = Date.now() + 30000
      setTimeout(attempt, delay).unref()
    }

    let child: ChildProcess
    try {
      child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (err) {
      throw new Error(
        `BrowserLauncher.launch: failed to spawn "${executable}": ${(err as Error).message}`
      )
    }

    const wsEndpoint = await new Promise<string>((resolve, reject) => {
      let settled = false
      let stderrBuf = ''
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        child.kill()
        removeProfile()
        reject(
          new Error(
            `Browser launch timeout after ${timeout}ms (executable=${executable}). stderr: ${stderrBuf.slice(-500)}`
          )
        )
      }, timeout)

      const onData = (chunk: Buffer): void => {
        stderrBuf += chunk.toString()
        const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(stderrBuf)
        if (match && !settled) {
          settled = true
          clearTimeout(timer)
          resolve(match[1])
        }
      }
      child.stderr?.on('data', onData)
      child.stdout?.on('data', onData)
      child.once('error', (err) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        removeProfile()
        reject(new Error(`BrowserLauncher.launch: process error: ${err.message}`))
      })
      child.once('exit', (code) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        removeProfile()
        reject(
          new Error(
            `BrowserLauncher.launch: browser exited early with code ${code}. stderr: ${stderrBuf.slice(-500)}`
          )
        )
      })
    })

    // Clean up the temporary profile once the process ends, after a beat so the browser's
    // child processes have released their handles. unref keeps this timer from holding the
    // event loop open, which is what made a script that only did goto() take 30s to exit.
    child.once('exit', () => {
      setTimeout(removeProfile, 500).unref()
    })
    child.unref()
    // the stdio pipes were only needed to read the DevTools endpoint out of stderr; left
    // referenced they keep the event loop alive for seconds after the browser has gone
    ;(child.stdout as unknown as { unref?: () => void } | null)?.unref?.()
    ;(child.stderr as unknown as { unref?: () => void } | null)?.unref?.()

    return { process: child, wsEndpoint, pid: child.pid ?? -1 }
  }

  /**
   * Terminate a browser process and wait for it to exit.
   *
   * @param proc - Child process returned from {@link BrowserLauncher.launch}
   * @returns Resolves once the process has exited (or after a 5s grace period)
   */
  static async kill(proc: ChildProcess): Promise<void> {
    if (proc.exitCode !== null || proc.signalCode !== null) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          proc.kill('SIGKILL')
        } catch {
          /* ignore */
        }
        resolve()
      }, 5000)
      proc.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
      try {
        proc.kill()
      } catch (err) {
        clearTimeout(timer)
        log('[screenvision] kill failed', (err as Error).message)
        resolve()
      }
    })
  }
}
