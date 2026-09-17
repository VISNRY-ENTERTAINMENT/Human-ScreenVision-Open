import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'http'
import fs from 'fs'
import os from 'os'
import path from 'path'
import screenvision from '../../src/index'
import type { Browser } from '../../src/core/Browser'

/**
 * The native file dialog, intercepted.
 *
 * This is the hardest dead end in an automated run: the dialog is not part of the page, so
 * nothing in the DOM can dismiss it and the run simply stops. `setInputFiles` handles the
 * case where the `<input type="file">` can be found; plenty of applications hide it entirely
 * and open the picker from a button, and then the request for a dialog is the only thing
 * there is to observe.
 */
const PORT = 9963

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Upload</title></head><body>
<main>
 <input id="hidden-input" type="file" style="display:none">
 <input id="multi-input" type="file" multiple style="display:none">
 <button id="pick" onclick="document.getElementById('hidden-input').click()">Choose a file</button>
 <button id="pick-many" onclick="document.getElementById('multi-input').click()">Choose files</button>
 <div id="out">none</div>
 <script>
  for (const id of ['hidden-input','multi-input']) {
    document.getElementById(id).addEventListener('change', (e) => {
      const names = Array.from(e.target.files).map(f => f.name + ':' + f.size)
      document.getElementById('out').textContent = names.join(',') || 'empty'
    })
  }
 </script>
</main></body></html>`

let server: http.Server
let browser: Browser
let tmpDir: string
let fileA: string
let fileB: string

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sv-filechooser-'))
  fileA = path.join(tmpDir, 'alpha.txt')
  fileB = path.join(tmpDir, 'beta.txt')
  fs.writeFileSync(fileA, 'alpha contents')
  fs.writeFileSync(fileB, 'beta')

  server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(PAGE)
  })
  await new Promise<void>((r) => server.listen(PORT, r))
  browser = await screenvision.launch({ headless: true })
}, 60000)

afterAll(async () => {
  if (browser) await browser.close()
  if (server) server.close()
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true })
})

async function open() {
  const ctx = await browser.newContext({ device: 'Desktop 1440x900' })
  const p = await ctx.newPage()
  await p.goto(`http://127.0.0.1:${PORT}/`)
  return p
}

describe('a file picker opened from a button', () => {
  it('is intercepted and answered without a dialog appearing', async () => {
    const p = await open()
    const [chooser] = await Promise.all([p.waitForFileChooser({ timeout: 10000 }), p.click('#pick')])
    expect(chooser.isMultiple()).toBe(false)
    await chooser.setFiles(fileA)
    await p.waitForFunction(`document.getElementById('out').textContent !== 'none'`, { timeout: 5000 })
    expect(await p.locator('#out').textContent()).toBe('alpha.txt:14')
    await p.close()
  }, 60000)

  it('reports when the page asked for several files, and delivers them', async () => {
    const p = await open()
    const [chooser] = await Promise.all([
      p.waitForFileChooser({ timeout: 10000 }),
      p.click('#pick-many'),
    ])
    expect(chooser.isMultiple()).toBe(true)
    await chooser.setFiles([fileA, fileB])
    await p.waitForFunction(`document.getElementById('out').textContent !== 'none'`, { timeout: 5000 })
    expect(await p.locator('#out').textContent()).toBe('alpha.txt:14,beta.txt:4')
    await p.close()
  }, 60000)

  it('refuses a path that does not exist instead of delivering nothing', async () => {
    const p = await open()
    const [chooser] = await Promise.all([p.waitForFileChooser({ timeout: 10000 }), p.click('#pick')])
    // the protocol accepts a missing path without complaint and the page gets an empty
    // selection, which is the silent wrong answer this library exists to avoid
    await expect(chooser.setFiles(path.join(tmpDir, 'nope.txt'))).rejects.toThrow(/does not exist/)
    expect(await p.locator('#out').textContent()).toBe('none')
    await p.close()
  }, 60000)

  it('refuses several files when the page asked for one', async () => {
    const p = await open()
    const [chooser] = await Promise.all([p.waitForFileChooser({ timeout: 10000 }), p.click('#pick')])
    await expect(chooser.setFiles([fileA, fileB])).rejects.toThrow(/asked for a single file/)
    await p.close()
  }, 60000)

  it('says so plainly when no picker opens', async () => {
    const p = await open()
    await expect(p.waitForFileChooser({ timeout: 1200 })).rejects.toThrow(/waitForFileChooser/)
    await p.close()
  }, 60000)

  it('leaves later dialogs interceptable rather than swallowing them', async () => {
    const p = await open()
    const [first] = await Promise.all([p.waitForFileChooser({ timeout: 10000 }), p.click('#pick')])
    await first.setFiles(fileA)
    // a second picker on the same page must still be catchable: interception left switched
    // on would consume it invisibly, and left switched off would open a real dialog
    const [second] = await Promise.all([p.waitForFileChooser({ timeout: 10000 }), p.click('#pick')])
    await second.setFiles(fileB)
    await p.waitForFunction(`document.getElementById('out').textContent.startsWith('beta')`, {
      timeout: 5000,
    })
    expect(await p.locator('#out').textContent()).toBe('beta.txt:4')
    await p.close()
  }, 60000)
})
