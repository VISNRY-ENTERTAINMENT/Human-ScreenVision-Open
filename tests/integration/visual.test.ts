import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'http'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import screenvision from '../../src/index'
import type { Browser } from '../../src/core/Browser'

/**
 * Visual comparison.
 *
 * It earns its keep on what assertions cannot express: a layout that collapses, a font that
 * fails to load, a control that slides behind another. It is also the assertion most likely
 * to cry wolf, so these check both directions — that a genuine change fails, and that a
 * trivial one does not.
 */
const PORT = 9969

const page = (colour: string, extra = ''): string =>
  `<!doctype html><html><head><meta charset="utf-8"><title>Visual</title>
<style>body{margin:0;font-family:monospace}
 #box{width:300px;height:120px;background:${colour};margin:20px}
 ${extra}</style></head><body>
<main><div id="box">a box</div></main></body></html>`

const PAGES: Record<string, string> = {
  '/base': page('#3366cc'),
  // the same page again: nothing has changed
  '/same': page('#3366cc'),
  // a colour change large enough that a person would call it a regression
  '/changed': page('#cc3333'),
  // one pixel of text difference, which should not trip the tolerance
  '/nearly': page('#3366cc', '#box::after{content:"";display:inline-block;width:1px;height:1px}'),
  // a layout change of a different size entirely
  '/resized': page('#3366cc', '#box{width:500px;height:260px}'),
}

let server: http.Server
let browser: Browser
let baselineDir: string

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const body = PAGES[(req.url ?? '/base').split('?')[0]] ?? PAGES['/base']
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(body)
  })
  await new Promise<void>((r) => server.listen(PORT, r))
  browser = await screenvision.launch({ headless: true })
  baselineDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sv-visual-'))
}, 60000)

afterAll(async () => {
  if (browser) await browser.close()
  if (server) server.close()
  if (baselineDir) await fs.rm(baselineDir, { recursive: true, force: true }).catch(() => undefined)
})

async function open(route: string) {
  const ctx = await browser.newContext({ device: 'Desktop 1440x900' })
  const p = await ctx.newPage()
  await p.goto(`http://127.0.0.1:${PORT}${route}`)
  return p
}

describe('page screenshots', () => {
  it('writes the baseline on the first run and passes', async () => {
    const p = await open('/base')
    await p.expectScreenshot('page-shot', { baselineDir })
    const written = await fs.readFile(path.join(baselineDir, 'page-shot.png')).catch(() => null)
    expect(written).not.toBeNull()
    await p.close()
  }, 60000)

  it('passes when nothing has changed', async () => {
    const p = await open('/same')
    await p.expectScreenshot('page-shot', { baselineDir })
    await p.close()
  }, 60000)

  it('fails on a real change, and says how much changed and where to look', async () => {
    const p = await open('/changed')
    await expect(p.expectScreenshot('page-shot', { baselineDir })).rejects.toThrow(
      /differs from its baseline: \d+ of \d+ pixels/
    )
    const diff = await fs.readFile(path.join(baselineDir, 'page-shot.diff.png')).catch(() => null)
    const actual = await fs.readFile(path.join(baselineDir, 'page-shot.actual.png')).catch(() => null)
    expect(diff).not.toBeNull()
    expect(actual).not.toBeNull()
    await p.close()
  }, 60000)

  it('tolerates a trivial difference', async () => {
    const p = await open('/nearly')
    await p.expectScreenshot('page-shot', { baselineDir })
    await p.close()
  }, 60000)

  it('reports a size change as a size change rather than a pixel count', async () => {
    const first = await open('/base')
    await first.expectScreenshot('sized', { baselineDir })
    await first.close()

    const p = await open('/resized')
    // the element screenshot is what changes size; the page shot stays the viewport size,
    // so this checks the element path
    const box = await p.$('#box')
    await expect(p.expect(p.locator('#box')).toHaveScreenshot('box-shot', { baselineDir })).resolves.toBeUndefined()
    await box!.evaluate((el: Element) => ((el as HTMLElement).style.width = '900px'))
    await expect(p.expect(p.locator('#box')).toHaveScreenshot('box-shot', { baselineDir })).rejects.toThrow(
      /is a different size/
    )
    await p.close()
  }, 90000)
})

describe('element screenshots', () => {
  it('compares just the element', async () => {
    const p = await open('/base')
    await p.expect(p.locator('#box')).toHaveScreenshot('element-shot', { baselineDir })
    await p.close()
  }, 60000)

  it('fails when the element itself changed', async () => {
    const first = await open('/base')
    await first.expect(first.locator('#box')).toHaveScreenshot('element-colour', { baselineDir })
    await first.close()

    const p = await open('/changed')
    await expect(p.expect(p.locator('#box')).toHaveScreenshot('element-colour', { baselineDir })).rejects.toThrow(
      /differs from its baseline/
    )
    await p.close()
  }, 90000)

  it('refuses to invent a baseline when told not to', async () => {
    const p = await open('/base')
    await expect(
      p.expect(p.locator('#box')).toHaveScreenshot('never-seen', { baselineDir, createMissing: false })
    ).rejects.toThrow(/no baseline for "never-seen"/)
    await p.close()
  }, 60000)
})
