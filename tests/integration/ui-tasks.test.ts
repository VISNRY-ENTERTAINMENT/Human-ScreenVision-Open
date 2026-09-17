import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'http'
import fs from 'fs'
import path from 'path'
import screenvision from '../../src/index'
import { runUiTask, type UiTask, type UiPlanStep } from '../../src/testing/UiTask'
import type { Browser } from '../../src/core/Browser'

/**
 * A third verifiable domain for the harness.
 *
 * The harness's confirmed finding is that gains come from executable checks written before
 * the candidates exist, and its measured limit is that those gains exist only where such a
 * check exists — arithmetic and code. That limit is now the binding one, because MATH-500,
 * MBPP+ and HumanEval+ are all at or near ceiling for the 27B, so "+5 plain" cannot be
 * measured on any of them.
 *
 * What these tests have to establish is not that a UI task can be run — that was already
 * true — but that the SCORING IS HONEST. A grader is only worth training against if it fails
 * the plausible wrong answers, so most of what follows feeds it plans that look right and
 * checks that it says no.
 */
const PORT = 9953
const ROOT = path.resolve(__dirname, '../fixtures/realapp')
const TASKS: { tasks: UiTask[] } = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../fixtures/uitasks/tasks.json'), 'utf8')
)

const CUSTOMERS = [
  { id: 'c1', name: 'Northwind Trading', city: 'Bristol', plan: 'Scale' },
  { id: 'c2', name: 'Helix Biolabs', city: 'Leeds', plan: 'Starter' },
  { id: 'c3', name: 'Orbital Freight', city: 'Bristol', plan: 'Scale' },
  { id: 'c4', name: 'Pemberton & Co', city: 'Cardiff', plan: 'Enterprise' },
  { id: 'c5', name: 'Vega Analytics', city: 'Glasgow', plan: 'Starter' },
  { id: 'c6', name: 'Quarry Lane Foods', city: 'Sheffield', plan: 'Scale' },
]
const INVOICES = [
  { id: 'INV-1001', customer: 'Northwind Trading', amount: 1240.0, status: 'Sent' },
  { id: 'INV-1002', customer: 'Helix Biolabs', amount: 380.5, status: 'Paid' },
  { id: 'INV-1003', customer: 'Orbital Freight', amount: 9120.75, status: 'Overdue' },
  { id: 'INV-1004', customer: 'Pemberton & Co', amount: 615.0, status: 'Sent' },
  { id: 'INV-1005', customer: 'Vega Analytics', amount: 2075.25, status: 'Overdue' },
]
const STATS = [{ label: 'Outstanding', value: '$13,431.50' }]
const ACTIVITY = [{ text: 'Invoice INV-1003 became overdue', when: '2 hours ago' }]

let server: http.Server
let browser: Browser

function json(res: http.ServerResponse, body: unknown, delay = 0): void {
  setTimeout(() => {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(body))
  }, delay)
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`)
    const p = u.pathname
    if (p === '/api/stats') return json(res, STATS, 60)
    if (p === '/api/customers') return json(res, CUSTOMERS, 80)
    if (p === '/api/invoices') return json(res, INVOICES, 70)
    if (p === '/api/activity') return json(res, ACTIVITY, 50)
    if (p === '/api/pay') return json(res, { ok: u.searchParams.get('id') !== 'INV-1003' }, 80)
    const rel = p === '/' ? 'index.html' : p.replace(/^\/+/, '')
    const file = path.join(ROOT, rel)
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      return res.end('not found')
    }
    const type = file.endsWith('.css')
      ? 'text/css'
      : file.endsWith('.js')
        ? 'application/javascript'
        : 'text/html'
    res.writeHead(200, { 'content-type': `${type}; charset=utf-8` })
    res.end(fs.readFileSync(file))
  })
  await new Promise<void>((r) => server.listen(PORT, r))
  browser = await screenvision.launch({ headless: true })
}, 60000)

afterAll(async () => {
  if (browser) await browser.close()
  if (server) server.close()
})

function task(id: string): UiTask {
  const t = TASKS.tasks.find((x) => x.id === id)
  if (!t) throw new Error(`no such task: ${id}`)
  return t
}

async function attempt(t: UiTask, plan: UiPlanStep[]) {
  const ctx = await browser.newContext({ device: 'Desktop 1440x900' })
  const page = await ctx.newPage()
  await page.goto(`http://127.0.0.1:${PORT}${t.route ?? '/'}`)
  // The task begins once the application has loaded. Racing the loader would measure the
  // fixture's timing rather than the plan, and every task would be flaky for the same
  // uninteresting reason.
  await page.waitForSelector('#inv-body tr', { timeout: 8000 }).catch(() => undefined)
  await page.waitForSelector('#cust-list li', { timeout: 8000 }).catch(() => undefined)
  await page.waitForFunction(`document.querySelectorAll('.sk').length === 0`, { timeout: 8000 }).catch(() => undefined)
  const result = await runUiTask(page, t, plan)
  await ctx.close()
  return result
}

describe('a correct plan passes', () => {
  it('edits the right invoice', async () => {
    const r = await attempt(task('ui-edit-amount'), [
      { do: 'click', selector: "[data-edit='INV-1001']" },
      { do: 'fill', selector: '#dlg-amount', value: '250' },
      { do: 'click', selector: '#dlg-save' },
    ])
    expect(r.reason).toBe('')
    expect(r.passed).toBe(true)
    expect(r.clauses.every((c) => c.met)).toBe(true)
  }, 90000)

  it('filters the customer list', async () => {
    const r = await attempt(task('ui-filter-then-count'), [
      { do: 'fill', selector: '#cust-filter', value: 'Orbital' },
    ])
    expect(r.reason).toBe('')
    expect(r.passed).toBe(true)
  }, 90000)

  it('fills the gated form', async () => {
    const r = await attempt(task('ui-form-gate'), [
      { do: 'fill', selector: '#f-name', value: 'Acme Ltd' },
      { do: 'fill', selector: '#f-email', value: 'ops@acme.test' },
      { do: 'fill', selector: '#f-amount', value: '99' },
      { do: 'check', selector: '#f-terms' },
    ])
    expect(r.reason).toBe('')
    expect(r.passed).toBe(true)
  }, 90000)

  it('deletes the named row', async () => {
    const r = await attempt(task('ui-delete-the-right-row'), [
      { do: 'click', selector: "[data-del='INV-1002']", confirmed: true },
    ])
    expect(r.reason).toBe('')
    expect(r.passed).toBe(true)
  }, 90000)
})

describe('the grader fails plausible wrong answers', () => {
  it('fails a plan that edits the wrong invoice', async () => {
    // the dialog opens, the amount is set, save is pressed: every step "works"
    const r = await attempt(task('ui-edit-amount'), [
      { do: 'click', selector: "[data-edit='INV-1004']" },
      { do: 'fill', selector: '#dlg-amount', value: '250' },
      { do: 'click', selector: '#dlg-save' },
    ])
    expect(r.passed).toBe(false)
    expect(r.reason).toMatch(/Updated INV-1001/)
  }, 90000)

  it('fails a plan that reaches the value but never saves', async () => {
    const r = await attempt(task('ui-edit-amount'), [
      { do: 'click', selector: "[data-edit='INV-1001']" },
      { do: 'fill', selector: '#dlg-amount', value: '250' },
    ])
    // the dialog still shows 250, which is exactly the state a screenshot would call success
    expect(r.passed).toBe(false)
    expect(r.reason).toMatch(/inv-log|modal-backdrop/)
  }, 90000)

  it('fails a plan that deletes the wrong row, even though a row was deleted', async () => {
    const r = await attempt(task('ui-delete-the-right-row'), [
      { do: 'click', selector: "[data-del='INV-1003']", confirmed: true },
    ])
    expect(r.passed).toBe(false)
    expect(r.reason).toMatch(/INV-1002|Deleted/)
  }, 90000)

  it('fails a plan that reaches the end state but damages something else on the way', async () => {
    // deletes an extra invoice first, then the right one. The postcondition for INV-1002
    // holds; the side condition does not. Arithmetic has no equivalent of this failure.
    const r = await attempt(task('ui-delete-the-right-row'), [
      { do: 'click', selector: "[data-del='INV-1001']", confirmed: true },
      { do: 'click', selector: "[data-del='INV-1002']", confirmed: true },
    ])
    expect(r.passed).toBe(false)
    expect(r.reason).toMatch(/INV-1001/)
  }, 90000)

  it('fails an empty plan rather than defaulting to success', async () => {
    const r = await attempt(task('ui-form-gate'), [])
    expect(r.passed).toBe(false)
    expect(r.stepsTaken).toBe(0)
  }, 90000)

  it('ignores a candidate declaring its own success', async () => {
    // the plan asserts the outcome it wants; the environment checks what actually happened
    const r = await attempt(task('ui-edit-amount'), [
      {
        do: 'click',
        selector: '#theme-toggle',
        expect: { textAppears: 'Updated INV-1001' },
      },
    ])
    expect(r.passed).toBe(false)
    expect(r.reason).toMatch(/Updated INV-1001/)
  }, 90000)
})

describe('the budget and the gate bind inside a scored task', () => {
  it('stops a plan that wanders, and reports how far it got', async () => {
    const t = task('ui-filter-then-count')
    const wander: UiPlanStep[] = Array.from({ length: 20 }, () => ({
      do: 'click' as const,
      selector: '#theme-toggle',
    }))
    const r = await attempt(t, wander)
    expect(r.passed).toBe(false)
    expect(r.stepsTaken).toBeLessThanOrEqual(r.stepsAllowed)
    expect(r.stoppedBecause === 'budget' || r.stoppedBecause === 'stalled').toBe(true)
  }, 90000)

  it('records a refusal when a consequential action is not confirmed', async () => {
    const r = await attempt(task('ui-delete-the-right-row'), [
      { do: 'click', target: 'Delete on the Helix Biolabs row' },
    ])
    expect(r.passed).toBe(false)
    await Promise.resolve()
  }, 90000)
})
