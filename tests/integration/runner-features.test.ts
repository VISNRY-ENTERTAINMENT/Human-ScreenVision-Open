import { describe, it, expect } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { runTests, shardOf } from '../../src/testing/TestRunner'

/**
 * The three things a runner needs before it can honestly be run in CI: a way to split work
 * across machines, a machine-readable report, and fixtures that survive parallelism.
 *
 * The fixture case is the one that matters most. `beforeEach` can already do setup, but it
 * cannot hand a value to the test, so anything it builds has to travel through a
 * module-level variable — which works until two tests run at once and quietly share it.
 */

function writeSuite(dir: string, name: string, body: string): string {
  const file = path.join(dir, name)
  fs.writeFileSync(file, body, 'utf8')
  return file
}

const HARNESS = `import { it, defineFixture, expect } from '${path
  .resolve('src/testing/TestRunner')
  .replace(/\\/g, '/')}'`

describe('sharding splits the suite deterministically', () => {
  it('assigns every test to exactly one shard, and always the same one', () => {
    const names = Array.from({ length: 200 }, (_, i) => `suite › test number ${i}`)
    const total = 4
    const assignment = names.map((n) => shardOf(n, total))
    // every shard index is legal
    expect(assignment.every((s) => s >= 1 && s <= total)).toBe(true)
    // and stable: the same name always lands in the same place
    expect(names.map((n) => shardOf(n, total))).toEqual(assignment)
    // and the split is not degenerate
    const counts = new Map<number, number>()
    for (const s of assignment) counts.set(s, (counts.get(s) ?? 0) + 1)
    expect(counts.size).toBe(total)
    for (const c of counts.values()) expect(c).toBeGreaterThan(200 / total / 3)
  })

  it('does not migrate unrelated tests when one is inserted', () => {
    // position-based slicing would shift everything after the insertion point onto a
    // different machine, which makes a CI cache useless and makes a flake look like it moved
    const before = ['a', 'b', 'c', 'd', 'e'].map((n) => [n, shardOf(n, 3)] as const)
    const after = ['a', 'NEW', 'b', 'c', 'd', 'e'].map((n) => [n, shardOf(n, 3)] as const)
    for (const [name, shard] of before) {
      expect(after.find(([n]) => n === name)?.[1]).toBe(shard)
    }
  })

  it('rejects a nonsensical shard spec rather than running nothing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-shard-'))
    const file = writeSuite(dir, 'a.test.mjs', `${HARNESS}\nit('one', async () => {})\n`)
    await expect(
      runTests({ files: [file], shard: { index: 5, total: 3 }, workers: 1 })
    ).rejects.toThrow(/1 <= index <= total/)
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe('fixtures give each test its own value', () => {
  it('builds one per test and tears it down, even when the test fails', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-fixture-'))
    const log = path.join(dir, 'log.txt').replace(/\\/g, '/')
    const file = writeSuite(
      dir,
      'fx.test.mjs',
      `${HARNESS}
import fs from 'fs'
const append = (s) => fs.appendFileSync('${log}', s + '\\n')
let counter = 0
defineFixture('basket', async () => { counter += 1; append('setup ' + counter); return { id: counter } },
              async (value) => { append('teardown ' + value.id) })
it('first', async (page, { basket }) => { append('test1 sees ' + basket.id) })
it('second, which fails', async (page, { basket }) => { append('test2 sees ' + basket.id); throw new Error('boom') })
`
    )
    const summary = await runTests({ files: [file], workers: 1, timeoutMs: 20000 })
    const lines = fs.readFileSync(log, 'utf8').trim().split('\n')

    expect(summary.passed).toBe(1)
    expect(summary.failed).toBe(1)
    // each test saw a distinct value, not a shared module-level one
    const seen = lines.filter((l) => l.startsWith('test')).map((l) => l.split(' sees ')[1])
    expect(new Set(seen).size).toBe(2)
    // and teardown ran for both, including the failing one
    expect(lines.filter((l) => l.startsWith('teardown')).length).toBe(2)
    fs.rmSync(dir, { recursive: true, force: true })
  }, 90000)
})

describe('the JSON report', () => {
  it('records every test with its status and error', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-json-'))
    const out = path.join(dir, 'nested', 'report.json')
    const file = writeSuite(
      dir,
      'r.test.mjs',
      `${HARNESS}
it('passes', async () => {})
it('fails', async () => { throw new Error('deliberate') })
it.skip('skipped', async () => {})
`
    )
    await runTests({ files: [file], workers: 1, timeoutMs: 20000, jsonReporter: out })

    // the directory did not exist: a reporter that cannot create its own output path is a
    // reporter that fails on the first CI run
    const report = JSON.parse(fs.readFileSync(out, 'utf8'))
    expect(report.passed).toBe(1)
    expect(report.failed).toBe(1)
    expect(report.skipped).toBe(1)
    expect(report.tests.map((t: { name: string }) => t.name).sort()).toEqual(['fails', 'passes'])
    const failed = report.tests.find((t: { status: string }) => t.status === 'failed')
    expect(failed.error).toMatch(/deliberate/)
    expect(report.skippedTests).toEqual(['skipped'])
    fs.rmSync(dir, { recursive: true, force: true })
  }, 90000)
})
