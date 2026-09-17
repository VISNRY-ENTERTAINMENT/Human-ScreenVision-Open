import { describe, it, expect } from 'vitest'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { runTests, collectTestFiles } from '../../src/index'

/**
 * The test runner, run end to end against a real test file.
 *
 * A test framework that only compiles is worthless, so this actually invokes it: it loads
 * `tests/fixtures/example.spec.ts`, runs its tests in isolated pages, and checks that passes
 * pass, the deliberate failure fails with a readable message, the skip is skipped, the JUnit
 * report is written, and the failing test leaves a trace behind.
 */
describe('the test runner', () => {
  it('runs a real test file and reports honestly', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sv-runner-'))
    const files = await collectTestFiles([path.join(process.cwd(), 'tests', 'fixtures')])
    expect(files.some((f) => f.endsWith('example.spec.ts'))).toBe(true)

    const summary = await runTests({
      files,
      workers: 2,
      timeoutMs: 25000,
      traceDir: path.join(tmp, 'traces'),
      reporter: path.join(tmp, 'junit.xml'),
    })

    expect(summary.passed).toBe(3)
    expect(summary.failed).toBe(1)
    expect(summary.skipped).toBe(1)

    const failure = summary.results.find((r) => r.status === 'failed')!
    expect(failure.name).toContain('fails on purpose')
    // the assertion message has to say what was expected and what was there
    expect(failure.error).toContain('this is not the title')
    expect(failure.error).toContain('Runner fixture')

    // a failing test must leave something you can look at
    expect(failure.trace).toBeDefined()
    const trace = await fs.readFile(failure.trace!, 'utf8')
    expect(trace).toContain('<!doctype html>')

    const junit = await fs.readFile(path.join(tmp, 'junit.xml'), 'utf8')
    expect(junit).toContain('tests="4"')
    expect(junit).toContain('failures="1"')

    await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined)
  }, 180000)

  it('filters by name with grep', async () => {
    const files = await collectTestFiles([path.join(process.cwd(), 'tests', 'fixtures')])
    const summary = await runTests({ files, workers: 2, grep: 'reads the title' })
    expect(summary.passed).toBe(1)
    expect(summary.failed).toBe(0)
  }, 120000)
})
