import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'http'
import fs from 'fs'
import os from 'os'
import path from 'path'
import screenvision from '../../src/index'
import type { Browser } from '../../src/core/Browser'

/**
 * A sequence is not a series of steps.
 *
 * Single-step primitives are near solved; long-horizon computer use is not — roughly 85% on
 * short OSWorld tasks against 20.6% on long-horizon ones, with agents "stalling in
 * partial-progress states" as the reported cause and "more visible monitoring and self-repair"
 * as the reported remedy. Both are environment properties: an agent cannot notice a stall
 * nobody reports, and cannot repair what nobody recorded.
 *
 * So the tests here are about the sequence, not the actions: does the budget bind, does the
 * stall get caught on the step it happens, and does the ledger record enough for a human to
 * audit the run afterwards.
 */
const PORT = 9954

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Workflow</title></head><body>
<main>
 <button id="step1" onclick="document.getElementById('s1').textContent='one done'">Step one</button>
 <div id="s1">pending</div>

 <button id="step2" onclick="document.getElementById('s2').textContent='two done'">Step two</button>
 <div id="s2">pending</div>

 <button id="dead">Does nothing</button>
 <button id="alsodead">Also nothing</button>

 <button id="leaky" onclick="
   document.getElementById('s1').textContent='one done';
   fetch('/charge', { method: 'POST', body: 'x' })
 ">Step one (leaky)</button>
</main></body></html>`

let server: http.Server
let browser: Browser
let tmp: string

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-episode-'))
  server = http.createServer((req, res) => {
    if (req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('ok')
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(PAGE)
  })
  await new Promise<void>((r) => server.listen(PORT, r))
  browser = await screenvision.launch({ headless: true })
}, 60000)

afterAll(async () => {
  if (browser) await browser.close()
  if (server) server.close()
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
})

async function open() {
  const ctx = await browser.newContext({ device: 'Desktop 1440x900' })
  const p = await ctx.newPage()
  await p.goto(`http://127.0.0.1:${PORT}/`)
  return p
}

describe('the budget binds', () => {
  it('refuses the step after the budget is spent, and says what got done', async () => {
    const p = await open()
    const ep = p.episode({ goal: 'do two things', maxSteps: 2 })
    await ep.act({ do: 'click', selector: '#step1', expect: { textAppears: 'one done' } })
    await ep.act({ do: 'click', selector: '#step2', expect: { textAppears: 'two done' } })
    expect(ep.stepsRemaining).toBe(0)
    await expect(ep.act({ do: 'click', selector: '#step1' })).rejects.toThrow(
      /used its 2-step budget.*2 of 2 action\(s\) were confirmed/s
    )
    await p.close()
  }, 60000)

  it('does not charge observations against the budget', async () => {
    const p = await open()
    const ep = p.episode({ goal: 'look a lot', maxSteps: 1 })
    await ep.observe()
    await ep.observe()
    await ep.observe()
    // looking is not acting; an agent that must ration looking acts on stale information
    expect(ep.stepsRemaining).toBe(1)
    await ep.act({ do: 'click', selector: '#step1', expect: { textAppears: 'one done' } })
    expect(ep.stepsRemaining).toBe(0)
    await p.close()
  }, 60000)
})

describe('stall detection', () => {
  it('catches two consecutive actions that changed nothing', async () => {
    const p = await open()
    const ep = p.episode({ goal: 'click dead things', maxSteps: 10 })
    const first = await ep.act({ do: 'click', selector: '#dead' })
    expect(first.verdict).toBe('no-effect')
    expect(ep.stalled, 'one no-effect is ordinary').toBe(false)

    const second = await ep.act({ do: 'click', selector: '#alsodead' })
    expect(second.verdict).toBe('no-effect')
    // two in a row means the agent's model of the page is wrong
    expect(ep.stalled).toBe(true)
    expect(ep.stoppedBecause).toBe('stalled')
    await p.close()
  }, 60000)

  it('refuses further steps once stalled, rather than spending the rest of the budget', async () => {
    const p = await open()
    const ep = p.episode({ goal: 'click dead things', maxSteps: 10 })
    await ep.act({ do: 'click', selector: '#dead' })
    await ep.act({ do: 'click', selector: '#alsodead' })
    await expect(ep.act({ do: 'click', selector: '#step1' })).rejects.toThrow(
      /has stalled.*Observe again/s
    )
    // and it still has budget left: it stopped because it was lost, not because it ran out
    expect(ep.stepsRemaining).toBeGreaterThan(0)
    await p.close()
  }, 60000)

  it('resets the counter when something does work', async () => {
    const p = await open()
    const ep = p.episode({ goal: 'mixed', maxSteps: 10 })
    await ep.act({ do: 'click', selector: '#dead' })
    await ep.act({ do: 'click', selector: '#step1', expect: { textAppears: 'one done' } })
    await ep.act({ do: 'click', selector: '#dead' })
    // a no-effect either side of a success is not a stall
    expect(ep.stalled).toBe(false)
    await p.close()
  }, 60000)
})

describe('the ledger', () => {
  it('records what was declared, what happened, and the verdict', async () => {
    const p = await open()
    const ep = p.episode({ goal: 'pay the invoice', maxSteps: 5 })
    await ep.observe()
    await ep.act({ do: 'click', selector: '#step1', expect: { textAppears: 'one done' } })
    ep.note('checked the total by hand')

    const entries = ep.ledger
    expect(entries.map((e) => e.kind)).toEqual(['observation', 'action', 'note'])
    const action = entries[1]
    expect(action.declared).toEqual({ textAppears: 'one done' })
    expect(action.expectations?.every((x) => x.met)).toBe(true)
    expect(action.precondition?.met).toBe(true)
    expect(action.verdict).toBe('confirmed')
    expect(action.target).toMatch(/step1|Step one/)
    expect(typeof action.durationMs).toBe('number')
    await p.close()
  }, 60000)

  it('records an undeclared side effect against the step that caused it', async () => {
    const p = await open()
    const ep = p.episode({ goal: 'step one', maxSteps: 5 })
    await ep.act({ do: 'click', selector: '#leaky', expect: { textAppears: 'one done' } })
    const action = ep.ledger.find((e) => e.kind === 'action')!
    expect(action.verdict).toBe('side-effects')
    expect(action.undeclared?.some((u) => /POST .*\/charge/.test(u.detail))).toBe(true)
    // and the report surfaces it without the reader parsing the ledger
    expect(ep.report()).toMatch(/side effect at step 1/)
    await p.close()
  }, 60000)

  it('writes an auditable file', async () => {
    const p = await open()
    const ep = p.episode({ goal: 'pay the invoice', maxSteps: 5 })
    await ep.act({ do: 'click', selector: '#step1', expect: { textAppears: 'one done' } })
    const out = await ep.save(path.join(tmp, 'runs', 'episode.json'))

    // the directory did not exist; a ledger that cannot create its own path is a ledger that
    // fails on the first real run
    const saved = JSON.parse(fs.readFileSync(out, 'utf8'))
    expect(saved.goal).toBe('pay the invoice')
    expect(saved.stepsTaken).toBe(1)
    expect(saved.entries[0].verdict).toBe('confirmed')
    expect(saved.entries[0].declared).toEqual({ textAppears: 'one done' })
    expect(typeof saved.durationMs).toBe('number')
    await p.close()
  }, 60000)

  it('reports the environment verdict per step, not the agent own account', async () => {
    const p = await open()
    const ep = p.episode({ goal: 'mixed run', maxSteps: 5 })
    await ep.act({ do: 'click', selector: '#step1', expect: { textAppears: 'one done' } })
    await ep.act({ do: 'click', selector: '#dead' })
    const report = ep.report()
    expect(report).toMatch(/goal: mixed run/)
    expect(report).toMatch(/confirmed: 1, no-effect: 1/)
    expect(report).toMatch(/\[confirmed\]/)
    expect(report).toMatch(/\[no-effect\]/)
    await p.close()
  }, 60000)
})

describe('an episode ends', () => {
  it('refuses steps after close', async () => {
    const p = await open()
    const ep = p.episode({ goal: 'short', maxSteps: 5 })
    ep.close()
    await expect(ep.act({ do: 'click', selector: '#step1' })).rejects.toThrow(/is closed/)
    await p.close()
  }, 60000)
})
