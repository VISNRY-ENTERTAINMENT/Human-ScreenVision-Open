#!/usr/bin/env node
/**
 * Score one candidate plan against one UI task, and print the verdict as JSON.
 *
 * This exists so any harness or agent runner can treat a UI episode the way it treats a math
 * answer or a program: a pre-committed check, run in a subprocess, returning a number nobody
 * argued about. A caller in another language talks to it over a process boundary and a JSON
 * document, so it drops into an existing evaluation loop without a language binding.
 *
 * Everything it prints on stdout is a single JSON object. Diagnostics go to stderr, so a
 * caller can parse stdout without filtering it.
 *
 * Usage:
 *   npx tsx bin/sv-uitask.mjs --tasks tasks.json --task ui-edit-amount \
 *                             --plan plan.json [--fixtures dir] [--port 9951] [--headed]
 *
 * The plan file is either a bare JSON array of steps, or an object with a `plan` array — the
 * second shape is what a model tends to emit, and rejecting it would make the harness's job
 * about JSON shape rather than about the task.
 */
import fs from 'fs'
import http from 'http'
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

const HELP = `sv-uitask --tasks <tasks.json> --task <id> --plan <plan.json> [options]

  --tasks <file>     task set containing the pre-committed postconditions
  --task <id>        which task in it to run
  --plan <file>      candidate plan: [steps] or {"plan":[steps]}
  --fixtures <dir>   directory holding fixture pages (default tests/fixtures)
  --port <n>         port to serve the fixture on (default 9951)
  --headed           show the browser
  -h, --help         this message

Prints one JSON object on stdout. Exit code is 0 whenever a verdict was reached, including a
failing one: a failed task is a result, not an error. Non-zero means no verdict exists.
`

/**
 * Parse argv into options.
 * @param {string[]} argv - Raw arguments
 * @returns {Record<string, string | boolean>} Parsed options
 */
function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '-h' || a === '--help') out.help = true
    else if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) out[key] = true
      else {
        out[key] = next
        i++
      }
    }
  }
  return out
}

/**
 * Fail with a JSON object rather than a stack trace.
 *
 * The caller is a grader loop, not a person: an unparseable crash makes every task in a batch
 * look identical, so even the failures are structured.
 * @param {string} message - What went wrong
 * @param {number} code - Process exit code
 */
function bail(message, code = 2) {
  process.stdout.write(JSON.stringify({ ok: false, error: message }) + '\n')
  process.exit(code)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    process.stdout.write(HELP)
    return
  }
  for (const required of ['tasks', 'task', 'plan']) {
    if (typeof args[required] !== 'string') bail(`missing --${required}`)
  }

  let taskSet
  try {
    taskSet = JSON.parse(fs.readFileSync(String(args.tasks), 'utf8'))
  } catch (err) {
    bail(`cannot read --tasks ${args.tasks}: ${err.message}`)
  }
  const task = (taskSet.tasks ?? taskSet).find((t) => t.id === args.task)
  if (!task) bail(`no task "${args.task}" in ${args.tasks}`)

  let plan
  try {
    const raw = JSON.parse(fs.readFileSync(String(args.plan), 'utf8'))
    plan = Array.isArray(raw) ? raw : raw.plan
  } catch (err) {
    bail(`cannot read --plan ${args.plan}: ${err.message}`)
  }
  if (!Array.isArray(plan)) {
    // An unparseable plan is a candidate failure, not a harness failure, so it scores zero
    // rather than aborting the batch.
    process.stdout.write(
      JSON.stringify({
        ok: true,
        taskId: task.id,
        passed: false,
        clauses: [],
        violations: ['the plan was not a JSON array of steps'],
        stepsTaken: 0,
        reason: 'the candidate did not produce a usable plan',
      }) + '\n'
    )
    return
  }

  const fixtures = path.resolve(String(args.fixtures ?? path.join(ROOT, 'tests/fixtures')))
  const pageDir = path.join(fixtures, task.page)
  if (!fs.existsSync(pageDir)) bail(`fixture directory not found: ${pageDir}`)
  const port = Number(args.port ?? 9951)

  // The fixture's own API stubs live beside it, so a task set is self-contained and a run
  // never depends on anything outside the directory it names.
  let api = {}
  const apiFile = path.join(pageDir, 'api.json')
  if (fs.existsSync(apiFile)) api = JSON.parse(fs.readFileSync(apiFile, 'utf8'))

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
    const file = path.join(pageDir, rel)
    if (!file.startsWith(pageDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      return res.end('not found')
    }
    const type = file.endsWith('.css')
      ? 'text/css'
      : file.endsWith('.js')
        ? 'application/javascript'
        : file.endsWith('.json')
          ? 'application/json'
          : 'text/html'
    res.writeHead(200, { 'content-type': `${type}; charset=utf-8` })
    res.end(fs.readFileSync(file))
  })
  await new Promise((r) => server.listen(port, r))

  const { default: screenvision } = await import(pathToFileURL(path.join(ROOT, 'src/index.ts')).href)
  const { runUiTask } = await import(
    pathToFileURL(path.join(ROOT, 'src/testing/UiTask.ts')).href
  )

  let browser
  try {
    browser = await screenvision.launch({ headless: args.headed !== true })
    const ctx = await browser.newContext({ device: 'Desktop 1440x900' })
    const page = await ctx.newPage()
    await page.goto(`http://127.0.0.1:${port}${task.route ?? '/'}`)

    // Let the application finish loading before the plan begins. Racing the loader would
    // measure the fixture's timing rather than the candidate's reasoning, and every task
    // would be flaky for the same uninteresting reason.
    for (const sel of task.readyWhen ?? []) {
      await page.waitForSelector(sel, { timeout: 10000 }).catch(() => undefined)
    }

    const result = await runUiTask(page, task, plan)
    process.stdout.write(JSON.stringify({ ok: true, ...result }) + '\n')
  } catch (err) {
    bail(`run failed: ${err.message}`, 3)
  } finally {
    if (browser) await browser.close().catch(() => undefined)
    server.close()
  }
}

main().catch((err) => bail(`unexpected: ${err.stack ?? err.message}`, 4))
