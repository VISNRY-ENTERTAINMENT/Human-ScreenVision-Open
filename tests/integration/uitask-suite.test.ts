import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'http'
import fs from 'fs'
import path from 'path'
import screenvision from '../../src/index'
import { runUiTask, type UiTask, type UiPlanStep } from '../../src/testing/UiTask'
import type { Browser } from '../../src/core/Browser'

/**
 * The two properties that decide whether a task set is a benchmark or a pile of JSON.
 *
 * **Solvable.** Every task must be passed by its reference plan. A benchmark containing an
 * impossible task measures nothing, and you cannot tell an impossible task from a merely hard
 * one by reading it — the model fails both and the score looks the same. Every task here is
 * proven reachable before anyone is asked to reach it.
 *
 * **Not trivially solvable.** Every task must be FAILED by the empty plan. A postcondition
 * that already holds on the loaded page is not a task, it is a description, and a set full of
 * them would report a healthy score for a model that does nothing at all. This is the check
 * that would have caught the mistake most likely to be made while writing forty of these.
 *
 * The two together bound the set from both sides: nothing impossible, nothing free.
 */
const PORT = 9945
const FIXTURES = path.resolve(__dirname, '../fixtures')
const TASKS: { tasks: UiTask[] } = JSON.parse(
  fs.readFileSync(path.join(FIXTURES, 'uitasks/tasks.json'), 'utf8')
)
const REFERENCE: { plans: Record<string, UiPlanStep[]> } = JSON.parse(
  fs.readFileSync(path.join(FIXTURES, 'uitasks/reference_plans.json'), 'utf8')
)

/**
 * One server per application, each serving that application at its own root.
 *
 * Serving several apps under path prefixes does not work and the failure is invisible: the
 * pages fetch `/api/...` from the root, so under `/catalogapp/` every data call 404s, every
 * list renders empty, and each task fails on its postcondition as though the plan were wrong.
 * A port per app reproduces exactly what `bin/sv-uitask.mjs` does in production.
 */
const APPS = ['realapp', 'settingsapp', 'catalogapp', 'chartapp']
const servers = new Map<string, { server: http.Server; port: number }>()

/**
 * Serve one fixture directory at the root of its own port.
 * @param app - Fixture directory name
 * @param port - Port to listen on
 * @returns The listening server
 */
async function serveApp(app: string, port: number): Promise<http.Server> {
  const dir = path.join(FIXTURES, app)
  const apiFile = path.join(dir, 'api.json')
  const api = fs.existsSync(apiFile) ? JSON.parse(fs.readFileSync(apiFile, 'utf8')) : {}
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
    const p = u.pathname
    if (Object.prototype.hasOwnProperty.call(api, p)) {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      return res.end(JSON.stringify(api[p]))
    }
    if (p.startsWith('/api/')) {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      return res.end('{}')
    }
    const rel = p === '/' ? 'index.html' : p.replace(/^\/+/, '')
    const file = path.join(dir, rel)
    if (!file.startsWith(dir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { 'content-type': 'text/plain' })
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
  await new Promise<void>((r) => server.listen(port, r))
  return server
}

let browser: Browser

beforeAll(async () => {
  for (let i = 0; i < APPS.length; i++) {
    const port = PORT + i
    servers.set(APPS[i], { server: await serveApp(APPS[i], port), port })
  }
  browser = await screenvision.launch({ headless: true })
}, 120000)

afterAll(async () => {
  if (browser) await browser.close()
  for (const { server } of servers.values()) server.close()
})

/**
 * Run one plan against one task on a fresh page.
 * @param task - The task
 * @param plan - Steps to run
 * @returns The scored result
 */
async function attempt(task: UiTask, plan: UiPlanStep[]) {
  const ctx = await browser.newContext({ device: 'Desktop 1440x900' })
  const page = await ctx.newPage()
  const entry = servers.get(task.page)
  if (!entry) throw new Error(`no server for app "${task.page}"`)
  await page.goto(`http://127.0.0.1:${entry.port}${task.route ?? '/'}`)
  for (const sel of (task as UiTask & { readyWhen?: string[] }).readyWhen ?? []) {
    await page.waitForSelector(sel, { timeout: 10000 }).catch(() => undefined)
  }
  const result = await runUiTask(page, task, plan)
  await ctx.close()
  return result
}

describe('the task set is well formed', () => {
  it('has a reference plan for every task and no orphans', () => {
    const ids = TASKS.tasks.map((t) => t.id)
    const planned = Object.keys(REFERENCE.plans)
    expect(ids.filter((id) => !planned.includes(id)), 'tasks with no reference plan').toEqual([])
    expect(planned.filter((id) => !ids.includes(id)), 'plans for tasks that do not exist').toEqual([])
  })

  it('has unique ids and a postcondition on every task', () => {
    const ids = TASKS.tasks.map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const t of TASKS.tasks) {
      expect(t.postcondition.length, `${t.id} has no postcondition`).toBeGreaterThan(0)
      expect(typeof t.goal, `${t.id} has no goal`).toBe('string')
      expect(t.goal.length, `${t.id} goal is too short to act on`).toBeGreaterThan(20)
    }
  })

  it('spans more than one application', () => {
    // a set drawn from one app measures that app, not the capability
    const apps = new Set(TASKS.tasks.map((t) => t.page))
    expect(apps.size).toBeGreaterThanOrEqual(4)
    expect(TASKS.tasks.length).toBeGreaterThanOrEqual(30)
  })
})

describe('every task is solvable by its reference plan', () => {
  for (const task of TASKS.tasks) {
    it(`${task.id}`, async () => {
      const plan = REFERENCE.plans[task.id]
      const r = await attempt(task, plan)
      expect(r.reason, `${task.id}: ${r.reason}`).toBe('')
      expect(r.passed).toBe(true)
    }, 120000)
  }
})

describe('no task is solved by doing nothing', () => {
  for (const task of TASKS.tasks) {
    // the one task whose reference plan IS empty: it asserts the untouched initial state on
    // purpose, so it is exempt by design rather than by accident
    if ((REFERENCE.plans[task.id] ?? []).length === 0) continue
    it(`${task.id}`, async () => {
      const r = await attempt(task, [])
      expect(r.passed, `${task.id} passes with an empty plan, so it is a description not a task`).toBe(
        false
      )
    }, 120000)
  }
})
