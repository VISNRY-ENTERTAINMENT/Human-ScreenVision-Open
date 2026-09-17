#!/usr/bin/env node
/**
 * The `screenvision` command.
 *
 * One subcommand so far, `test`, because that is what turns the library into something a CI
 * job can invoke directly.
 *
 * TypeScript test files need a loader, exactly as they do for every other JavaScript test
 * runner. Run `npx tsx screenvision test ...` for those, or point this at compiled `.js`.
 *
 * Usage:
 *   screenvision test <files-or-dirs> [--workers 4] [--timeout 30000]
 *                                     [--trace-dir traces] [--reporter junit.xml]
 *                                     [--grep text] [--headed]
 */
import path from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

const HELP = `screenvision test <files-or-dirs> [options]

  --workers <n>       tests to run at once (default 4)
  --timeout <ms>      per-test timeout (default 30000)
  --trace-dir <dir>   write a trace for each failing test
  --reporter <file>   write a JUnit XML report
  --grep <text>       only run tests whose name contains this
  --headed            show the browser
  -h, --help          this message

TypeScript test files need a loader: run "npx tsx screenvision test ..." for those.
`

/**
 * Read a flag's value from the argument list.
 * @param args - Arguments
 * @param name - Flag name including dashes
 * @returns The value, or undefined
 */
function flag(args, name) {
  const i = args.indexOf(name)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined
}

const argv = process.argv.slice(2)
if (argv.length === 0 || argv.includes('-h') || argv.includes('--help')) {
  process.stdout.write(HELP)
  process.exit(0)
}

const [command, ...rest] = argv
if (command !== 'test') {
  process.stderr.write(`unknown command "${command}".\n\n${HELP}`)
  process.exit(2)
}

const flagNames = ['--workers', '--timeout', '--trace-dir', '--reporter', '--grep']
const inputs = []
for (let i = 0; i < rest.length; i++) {
  const arg = rest[i]
  if (flagNames.includes(arg)) {
    i++
    continue
  }
  if (arg.startsWith('--')) continue
  inputs.push(arg)
}

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')

/**
 * Load the library, preferring source when a TypeScript loader is active.
 *
 * Under `tsx` the source imports work and match the test files a user writes; under plain
 * node only the compiled output will load.
 * @returns The library's exports
 */
async function loadLibrary() {
  const candidates = [path.join(root, 'src', 'index.ts'), path.join(root, 'dist', 'index.js')]
  const problems = []
  for (const candidate of candidates) {
    try {
      const mod = await import(pathToFileURL(candidate).href)
      if (typeof mod.runTests === 'function') return mod
      problems.push(`${candidate}: loaded but has no runTests export (stale build?)`)
    } catch (err) {
      problems.push(`${candidate}: ${err.message.split('\n')[0]}`)
    }
  }
  process.stderr.write(`could not load screenvision:\n  ${problems.join('\n  ')}\n\nRun "npm run build" first, or use "npx tsx".\n`)
  process.exit(2)
}

const lib = await loadLibrary()
const files = await lib.collectTestFiles(inputs.length ? inputs : ['tests'])
if (files.length === 0) {
  process.stderr.write('no test files found (looked for *.spec.ts, *.test.ts and the .js forms)\n')
  process.exit(2)
}

// a .ts test file cannot be imported without a loader; say so rather than failing obscurely
if (files.some((f) => f.endsWith('.ts')) && !process.execArgv.join(' ').includes('tsx')) {
  try {
    await import('tsx')
  } catch {
    process.stderr.write(
      'these test files are TypeScript, which node cannot import on its own.\n' +
        'Run "npx tsx screenvision test ..." or compile them to .js first.\n'
    )
    process.exit(2)
  }
}

const summary = await lib.runTests({
  files,
  workers: Number(flag(rest, '--workers') ?? 4),
  timeoutMs: Number(flag(rest, '--timeout') ?? 30000),
  traceDir: flag(rest, '--trace-dir'),
  reporter: flag(rest, '--reporter'),
  grep: flag(rest, '--grep'),
  headless: !rest.includes('--headed'),
})

process.exit(summary.failed > 0 ? 1 : 0)
