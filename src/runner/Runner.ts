import fs from 'fs/promises'
import path from 'path'
import type { Browser } from '../core/Browser'
import type { Page } from '../core/Page'
import type { BrowserContextOptions } from '../core/types'

/** One unit of work: a named job handed its own page. */
export interface Job<T = unknown> {
  name: string
  run: (page: Page) => Promise<T>
  /** Per-job context options, e.g. a different device. */
  context?: BrowserContextOptions
  /** Retries on failure. Default 0. */
  retries?: number
}

/** What happened to one job. */
export interface JobResult<T = unknown> {
  name: string
  status: 'passed' | 'failed'
  value?: T
  error?: string
  attempts: number
  durationMs: number
  /** Path to the trace, when tracing was enabled. */
  trace?: string
}

/** How to run a batch of jobs. */
export interface RunOptions {
  /** How many jobs run at once. Default 4. */
  workers?: number
  /** Give up on a job after this long. Default 120000. */
  timeoutMs?: number
  /** Record a trace per job into this directory. */
  traceDir?: string
  /** Record traces only for jobs that fail, which is usually what you want. */
  traceOnFailure?: boolean
  /** Called as each job finishes, for progress output. */
  onResult?: (result: JobResult) => void
}

/**
 * Runs many jobs across a pool of pages.
 *
 * Each job gets its own browser context, so cookies, storage and device emulation are
 * isolated and jobs cannot interfere with one another. The pool bounds concurrency: browser
 * work is memory-hungry, and running fifty pages at once on a laptop is slower than running
 * four, not faster.
 *
 * This is deliberately not a test framework. It has no assertions, no fixtures and no
 * configuration file, because those are the parts of a test framework that are worth
 * inheriting from whatever the caller already uses. It supplies the part that is specific to
 * driving browsers: isolation, bounded concurrency, timeouts, retries and per-job traces.
 */
export class Runner {
  /**
   * @param browser - Browser to allocate contexts from
   */
  constructor(private browser: Browser) {}

  /**
   * Run every job, at most `workers` at a time.
   * @param jobs - The jobs to run
   * @param options - Concurrency, timeout and tracing
   * @returns One result per job, in the order the jobs were given
   */
  async run<T>(jobs: Job<T>[], options?: RunOptions): Promise<JobResult<T>[]> {
    const workers = Math.max(1, options?.workers ?? 4)
    const timeoutMs = options?.timeoutMs ?? 120000
    const results = new Array<JobResult<T>>(jobs.length)
    let next = 0

    const worker = async (): Promise<void> => {
      for (;;) {
        const index = next++
        if (index >= jobs.length) return
        results[index] = await this.runOne(jobs[index], timeoutMs, options)
        options?.onResult?.(results[index] as JobResult)
      }
    }

    await Promise.all(Array.from({ length: Math.min(workers, jobs.length) }, worker))
    return results
  }

  /**
   * Run one job, with its retries.
   * @param job - The job
   * @param timeoutMs - Per-attempt timeout
   * @param options - Run options, for tracing
   * @returns The job's result
   */
  private async runOne<T>(job: Job<T>, timeoutMs: number, options?: RunOptions): Promise<JobResult<T>> {
    const started = Date.now()
    const maxAttempts = (job.retries ?? 0) + 1
    let lastError = ''
    let tracePath: string | undefined

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const context = await this.browser.newContext(job.context ?? {})
      const page = await context.newPage()
      const wantTrace = options?.traceDir !== undefined
      // Always record when tracing is configured. A failure cannot be traced retroactively,
      // so `traceOnFailure` has to mean "throw it away if the job passes", not "start
      // recording once it has already gone wrong".
      if (wantTrace) await page.trace.start({ title: `${job.name} (attempt ${attempt})` })

      try {
        const value = await withTimeout(job.run(page), timeoutMs, `job "${job.name}" timed out after ${timeoutMs}ms`)
        if (wantTrace && options?.traceDir) {
          if (options.traceOnFailure) page.trace.discard()
          else tracePath = await page.trace.stop(path.join(options.traceDir, `${safeName(job.name)}.html`))
        }
        await context.close()
        return { name: job.name, status: 'passed', value, attempts: attempt, durationMs: Date.now() - started, trace: tracePath }
      } catch (err) {
        lastError = (err as Error).message
        if (wantTrace && options?.traceDir && page.trace.active()) {
          await page.trace.note(`failed: ${lastError}`).catch(() => undefined)
          tracePath = await page.trace
            .stop(path.join(options.traceDir, `${safeName(job.name)}-failed.html`))
            .catch(() => undefined)
        }
        await context.close().catch(() => undefined)
        if (attempt === maxAttempts) {
          return {
            name: job.name,
            status: 'failed',
            error: lastError,
            attempts: attempt,
            durationMs: Date.now() - started,
            trace: tracePath,
          }
        }
      }
    }
    /* unreachable: the loop always returns on its last attempt */
    return { name: job.name, status: 'failed', error: lastError, attempts: maxAttempts, durationMs: Date.now() - started }
  }
}

/**
 * Write a JUnit XML report, which every CI system can display.
 * @param results - Job results
 * @param filePath - Destination path
 * @returns The path written
 */
export async function writeJUnitReport(results: JobResult[], filePath: string): Promise<string> {
  const failures = results.filter((r) => r.status === 'failed').length
  const totalSeconds = (results.reduce((a, r) => a + r.durationMs, 0) / 1000).toFixed(3)
  const cases = results
    .map((r) => {
      const time = (r.durationMs / 1000).toFixed(3)
      if (r.status === 'passed') return `  <testcase name="${xml(r.name)}" time="${time}"/>`
      return `  <testcase name="${xml(r.name)}" time="${time}">
    <failure message="${xml(r.error ?? 'failed')}">${xml(r.error ?? '')}${r.trace ? `\n\ntrace: ${xml(r.trace)}` : ''}</failure>
  </testcase>`
    })
    .join('\n')
  const doc = `<?xml version="1.0" encoding="UTF-8"?>
<testsuite name="screenvision" tests="${results.length}" failures="${failures}" time="${totalSeconds}">
${cases}
</testsuite>
`
  const target = path.resolve(filePath)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, doc, 'utf8')
  return target
}

/**
 * Reject if a promise has not settled in time.
 * @param promise - The work
 * @param ms - Deadline
 * @param message - Error message on timeout
 * @returns The promise's value
 */
async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Turn a job name into something safe for a filename.
 * @param name - Job name
 * @returns Filename-safe form
 */
function safeName(name: string): string {
  return name.replace(/[^a-z0-9._-]+/gi, '-').slice(0, 80)
}

/**
 * Escape text for XML.
 * @param value - Raw text
 * @returns Escaped text
 */
function xml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
