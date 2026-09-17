import fs from 'fs/promises'
import path from 'path'
import { pathToFileURL } from 'url'
import { ScreenVision } from '../core/ScreenVision'
import { Runner, writeJUnitReport, type JobResult } from '../runner/Runner'
import type { Browser } from '../core/Browser'
import type { Page } from '../core/Page'
import type { BrowserContextOptions } from '../core/types'

/**
 * A small test framework for browser tests.
 *
 * I argued for a while that this should not exist, on the grounds that assertions and
 * fixtures are better inherited from whatever the team already runs. That argument is right
 * for a team that already has Vitest or Jest wired up, and wrong for anyone who does not,
 * because the gap between "a library" and "something you can run in CI" is exactly this.
 *
 * So it is deliberately small. It gives each test an isolated page, runs files in parallel,
 * retries, traces failures, reports as JUnit or JSON, splits across machines by shard, and
 * supplies per-test fixtures. It still does not attempt watch mode, snapshots, or a plugin
 * system. Anyone who needs those should use a real framework and call this library from
 * inside it, which remains fully supported.
 *
 * (Sharding and fixtures were listed here as deliberate omissions until 2026-09-11. They were
 * added because "runs in CI across machines" turned out to be the same requirement as "you
 * can run it in CI at all", not a step beyond it.)
 */

/** One registered test. */
interface TestCase {
  name: string
  fn: (page: Page, fixtures: Record<string, unknown>) => Promise<void>
  only: boolean
  skip: boolean
  retries?: number
  context?: BrowserContextOptions
  suite: string[]
}

/** Hooks registered around tests. */
interface Hooks {
  beforeEach: Array<(page: Page) => Promise<void>>
  afterEach: Array<(page: Page) => Promise<void>>
}

/**
 * Something built fresh for each test and torn down after it.
 *
 * `beforeEach` can already run setup, but it cannot hand a *value* to the test, so anything
 * it creates has to be smuggled through a module-level variable. That works until tests run
 * in parallel, at which point two tests share one variable and the failure looks like a bug
 * in the page rather than in the harness.
 */
interface FixtureDefinition {
  name: string
  setup: (page: Page) => Promise<unknown>
  teardown?: (value: never, page: Page) => Promise<void>
}

const registry: {
  tests: TestCase[]
  hooks: Hooks
  suite: string[]
  fixtures: FixtureDefinition[]
} = {
  tests: [],
  hooks: { beforeEach: [], afterEach: [] },
  suite: [],
  fixtures: [],
}

/**
 * Define a value built fresh for each test.
 *
 * The test receives it as a property of its second argument:
 * `it('checkout', async (page, { basket }) => ...)`. Teardown runs even when the test fails,
 * in reverse order of definition, so a fixture can depend on an earlier one.
 * @param name - Property name the test will read
 * @param setup - Builds the value, given that test's page
 * @param teardown - Disposes of it afterwards
 */
export function defineFixture<T>(
  name: string,
  setup: (page: Page) => Promise<T>,
  teardown?: (value: T, page: Page) => Promise<void>
): void {
  registry.fixtures.push({
    name,
    setup: setup as (page: Page) => Promise<unknown>,
    teardown: teardown as FixtureDefinition['teardown'],
  })
}

/**
 * What each file registered the first time it was imported.
 *
 * A module is evaluated once per process, so a second run has to replay these rather than
 * re-import. Re-importing under a cache-busting URL would work but would also re-run the
 * file's side effects, such as starting a fixture server on a port that is now taken.
 */
const registeredByFile = new Map<
  string,
  { tests: TestCase[]; hooks: Hooks; fixtures: FixtureDefinition[] }
>()

/** Options a test can carry. */
export interface TestOptions {
  retries?: number
  context?: BrowserContextOptions
}

/**
 * Group tests under a name.
 * @param name - Group name
 * @param body - Registers the tests in the group
 */
export function describe(name: string, body: () => void): void {
  registry.suite.push(name)
  body()
  registry.suite.pop()
}

/**
 * Register a test, which is handed its own isolated page.
 * @param name - Test name
 * @param fn - The test body
 * @param options - Retries and per-test context options
 */
export function it(
  name: string,
  fn: (page: Page, fixtures: Record<string, unknown>) => Promise<void>,
  options?: TestOptions
): void {
  registry.tests.push({ name, fn, only: false, skip: false, suite: [...registry.suite], ...options })
}

/** Register a test and run only tests marked this way. */
it.only = (
  name: string,
  fn: (page: Page, fixtures: Record<string, unknown>) => Promise<void>,
  options?: TestOptions
): void => {
  registry.tests.push({ name, fn, only: true, skip: false, suite: [...registry.suite], ...options })
}

/** Register a test that is reported but not run. */
it.skip = (
  name: string,
  fn: (page: Page, fixtures: Record<string, unknown>) => Promise<void>,
  options?: TestOptions
): void => {
  registry.tests.push({ name, fn, only: false, skip: true, suite: [...registry.suite], ...options })
}

/**
 * Run before every test, with that test's page.
 * @param fn - The hook
 */
export function beforeEach(fn: (page: Page) => Promise<void>): void {
  registry.hooks.beforeEach.push(fn)
}

/**
 * Run after every test, with that test's page.
 * @param fn - The hook
 */
export function afterEach(fn: (page: Page) => Promise<void>): void {
  registry.hooks.afterEach.push(fn)
}

/** A failed assertion. */
export class AssertionError extends Error {}

/**
 * Minimal value assertions, for the things a browser test asserts about non-page values.
 *
 * Assertions about the page itself belong on `page.expect(...)`, which retries; these do not,
 * because a plain value does not change while you look at it.
 * @param actual - The value under test
 * @returns The assertion methods
 */
export function expect<T>(actual: T): {
  toBe: (expected: T) => void
  toEqual: (expected: unknown) => void
  toContain: (needle: string) => void
  toBeTruthy: () => void
  toBeGreaterThan: (n: number) => void
} {
  const show = (v: unknown): string => (typeof v === 'string' ? JSON.stringify(v) : String(v))
  return {
    toBe: (expected) => {
      if (!Object.is(actual, expected)) {
        throw new AssertionError(`expected ${show(expected)} but got ${show(actual)}`)
      }
    },
    toEqual: (expected) => {
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new AssertionError(`expected ${JSON.stringify(expected)} but got ${JSON.stringify(actual)}`)
      }
    },
    toContain: (needle) => {
      const haystack = typeof actual === 'string' ? actual : JSON.stringify(actual)
      if (!haystack.includes(needle)) {
        throw new AssertionError(`expected ${show(actual)} to contain ${show(needle)}`)
      }
    },
    toBeTruthy: () => {
      if (!actual) throw new AssertionError(`expected a truthy value but got ${show(actual)}`)
    },
    toBeGreaterThan: (n) => {
      if (typeof actual !== 'number' || !(actual > n)) {
        throw new AssertionError(`expected ${show(actual)} to be greater than ${n}`)
      }
    },
  }
}

/** How to run a suite of test files. */
export interface TestRunOptions {
  /** Files to load, in order. */
  files: string[]
  workers?: number
  timeoutMs?: number
  /** Directory for traces; failures are always traced when set. */
  traceDir?: string
  /** Write a JUnit report here. */
  reporter?: string
  headless?: boolean
  /** Only run tests whose full name contains this. */
  grep?: string
  /** Write a machine-readable JSON report here. */
  jsonReporter?: string
  /**
   * Run one slice of the suite, as `{ index, total }` with index starting at 1.
   *
   * The split is by test name hash rather than by position, so adding a test in the middle
   * of a file does not reshuffle every other shard -- which would make a CI cache useless
   * and, worse, make a flake look like it moved.
   */
  shard?: { index: number; total: number }
}

/** What a run produced. */
export interface TestRunSummary {
  passed: number
  failed: number
  skipped: number
  durationMs: number
  results: JobResult[]
}

/**
 * Load the given files, run every test they register, and report.
 * @param options - What to run and how
 * @returns The summary
 */
export async function runTests(options: TestRunOptions): Promise<TestRunSummary> {
  const started = Date.now()
  registry.tests = []
  registry.hooks = { beforeEach: [], afterEach: [] }
  registry.suite = []
  registry.fixtures = []

  for (const file of options.files) {
    const key = path.resolve(file)
    const cached = registeredByFile.get(key)
    if (cached) {
      registry.tests.push(...cached.tests)
      registry.hooks.beforeEach.push(...cached.hooks.beforeEach)
      registry.hooks.afterEach.push(...cached.hooks.afterEach)
      // fixtures replay too: a module is evaluated once per process, so a second run in the
      // same process would otherwise start with none and every test would see an empty object
      registry.fixtures.push(...cached.fixtures)
      continue
    }
    const testsBefore = registry.tests.length
    const beforeCount = registry.hooks.beforeEach.length
    const afterCount = registry.hooks.afterEach.length
    const fixtureCount = registry.fixtures.length
    await import(pathToFileURL(key).href)
    registeredByFile.set(key, {
      tests: registry.tests.slice(testsBefore),
      hooks: {
        beforeEach: registry.hooks.beforeEach.slice(beforeCount),
        afterEach: registry.hooks.afterEach.slice(afterCount),
      },
      fixtures: registry.fixtures.slice(fixtureCount),
    })
  }

  const full = (t: TestCase): string => [...t.suite, t.name].join(' › ')
  let tests = registry.tests
  if (tests.some((t) => t.only)) tests = tests.filter((t) => t.only)
  if (options.grep) tests = tests.filter((t) => full(t).includes(options.grep as string))
  if (options.shard) {
    const { index, total } = options.shard
    if (!Number.isInteger(index) || !Number.isInteger(total) || total < 1 || index < 1 || index > total) {
      throw new Error(
        `shard must be { index, total } with 1 <= index <= total, got ${index}/${total}`
      )
    }
    tests = tests.filter((t) => shardOf(full(t), total) === index)
  }
  const skipped = tests.filter((t) => t.skip)
  const toRun = tests.filter((t) => !t.skip)

  const browser: Browser = await new ScreenVision().launch({ headless: options.headless !== false })
  const hooks = registry.hooks
  const fixtures = registry.fixtures
  let results: JobResult[] = []
  try {
    const runner = new Runner(browser)
    results = await runner.run(
      toRun.map((t) => ({
        name: full(t),
        retries: t.retries,
        context: t.context ?? { device: 'Desktop 1440x900' },
        run: async (page: Page) => {
          for (const hook of hooks.beforeEach) await hook(page)
          const built: Array<{ def: FixtureDefinition; value: unknown }> = []
          const values: Record<string, unknown> = {}
          try {
            for (const def of fixtures) {
              const value = await def.setup(page)
              built.push({ def, value })
              values[def.name] = value
            }
            await t.fn(page, values)
          } finally {
            // reverse order, and each one isolated: a fixture that throws while disposing
            // must not strand the ones defined before it
            for (const { def, value } of built.reverse()) {
              if (def.teardown) await def.teardown(value as never, page).catch(() => undefined)
            }
            for (const hook of hooks.afterEach) {
              await hook(page).catch(() => undefined)
            }
          }
        },
      })),
      {
        workers: options.workers ?? 4,
        timeoutMs: options.timeoutMs ?? 30000,
        traceDir: options.traceDir,
        traceOnFailure: true,
        onResult: (r) => {
          const mark = r.status === 'passed' ? 'ok  ' : 'FAIL'
          const retry = r.attempts > 1 ? ` (attempt ${r.attempts})` : ''
          process.stdout.write(`${mark} ${r.name}${retry}  ${r.durationMs}ms\n`)
          if (r.status === 'failed') {
            process.stdout.write(`     ${r.error}\n`)
            if (r.trace) process.stdout.write(`     trace: ${r.trace}\n`)
          }
        },
      }
    )
  } finally {
    await browser.close()
  }

  for (const t of skipped) process.stdout.write(`skip ${full(t)}\n`)

  const passed = results.filter((r) => r.status === 'passed').length
  const failed = results.filter((r) => r.status === 'failed').length
  const durationMs = Date.now() - started
  process.stdout.write(
    `\n${passed} passed, ${failed} failed, ${skipped.length} skipped in ${(durationMs / 1000).toFixed(1)}s\n`
  )

  if (options.reporter) {
    const written = await writeJUnitReport(results, options.reporter)
    process.stdout.write(`report: ${written}\n`)
  }
  if (options.jsonReporter) {
    const written = await writeJsonReport(
      { passed, failed, skipped: skipped.length, durationMs, results },
      skipped.map(full),
      options.jsonReporter
    )
    process.stdout.write(`json report: ${written}\n`)
  }
  return { passed, failed, skipped: skipped.length, durationMs, results }
}

/**
 * Which shard a test belongs to, from its name.
 *
 * Hashing the name rather than slicing by position means membership depends only on which
 * tests exist, not on their order. Inserting a test at the top of a file would otherwise
 * migrate unrelated tests between machines, making a CI cache useless and making a flake
 * look as though it moved.
 * @param name - Full test name
 * @param total - Number of shards
 * @returns 1-based shard index
 */
export function shardOf(name: string, total: number): number {
  let h = 2166136261
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return ((h >>> 0) % total) + 1
}

/**
 * Write the run as JSON, for a machine to read.
 *
 * JUnit XML is what CI servers parse; this is what a script or an agent parses, without
 * needing to understand XML to find out which test failed and why.
 * @param summary - Counts and results
 * @param skippedNames - Names of tests that were skipped
 * @param destination - File path to write
 * @returns The absolute path written
 */
async function writeJsonReport(
  summary: TestRunSummary,
  skippedNames: string[],
  destination: string
): Promise<string> {
  const body = {
    passed: summary.passed,
    failed: summary.failed,
    skipped: summary.skipped,
    durationMs: summary.durationMs,
    tests: summary.results.map((r) => ({
      name: r.name,
      status: r.status,
      durationMs: r.durationMs,
      attempts: r.attempts,
      error: r.error ?? null,
      trace: r.trace ?? null,
    })),
    skippedTests: skippedNames,
  }
  const resolved = path.resolve(destination)
  await fs.mkdir(path.dirname(resolved), { recursive: true }).catch(() => undefined)
  await fs.writeFile(resolved, JSON.stringify(body, null, 2), 'utf8')
  return resolved
}

/**
 * Expand file arguments, accepting directories and plain paths.
 * @param inputs - Paths or directories
 * @returns Test file paths
 */
export async function collectTestFiles(inputs: string[]): Promise<string[]> {
  const out: string[] = []
  for (const input of inputs) {
    const resolved = path.resolve(input)
    const stat = await fs.stat(resolved).catch(() => null)
    if (!stat) continue
    if (stat.isDirectory()) {
      for (const entry of await fs.readdir(resolved)) {
        if (/\.(spec|test)\.(ts|js|mjs)$/.test(entry)) out.push(path.join(resolved, entry))
      }
    } else {
      out.push(resolved)
    }
  }
  return out.sort()
}
