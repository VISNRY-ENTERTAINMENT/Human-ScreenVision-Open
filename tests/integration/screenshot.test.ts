import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import sharp from 'sharp'
import path from 'path'
import type http from 'http'
import screenvision from '../../src/index'
import { Browser } from '../../src/core/Browser'
import { startFixtureServer, stopFixtureServer } from './fixture-server'

const PORT = 9997
const FIXTURE_URL = `http://localhost:${PORT}/`
const CODEBASE_PATH = path.join(__dirname, '../fixtures/react-app')

describe('Screenshots', () => {
  let browser: Browser
  let server: http.Server

  beforeAll(async () => {
    server = await startFixtureServer(path.join(CODEBASE_PATH, 'dist'), PORT)
    browser = await screenvision.launch({ headless: true, codebase: CODEBASE_PATH, framework: 'react' })
  }, 30000)

  afterAll(async () => {
    await browser.close()
    await stopFixtureServer(server)
  })

  it('viewport screenshot matches the emulated viewport', async () => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } })
    const page = await context.newPage()
    await page.goto(FIXTURE_URL)
    const png = await page.screenshot()
    const meta = await sharp(png).metadata()
    expect(meta.width).toBe(1280)
    expect(meta.height).toBe(720)
    await context.close()
  })

  it('element screenshot has positive dimensions close to the element box', async () => {
    const page = await browser.newPage()
    await page.goto(FIXTURE_URL)
    const nav = await page.find('navigation bar')
    const bbox = (await nav.boundingBox())!
    const png = await nav.screenshot()
    const meta = await sharp(png).metadata()
    expect(meta.width!).toBeGreaterThan(0)
    expect(meta.height!).toBeGreaterThan(0)
    // 8px padding on each side (clamped at the page edge)
    expect(meta.height!).toBeGreaterThanOrEqual(Math.floor(bbox.height))
    expect(meta.height!).toBeLessThanOrEqual(Math.ceil(bbox.height) + 17)
    await page.close()
  })

  it('screenshotElement by description and full page are taller than viewport when content overflows', async () => {
    const context = await browser.newContext({ viewport: { width: 800, height: 300 } })
    const page = await context.newPage()
    await page.goto(FIXTURE_URL)
    const hero = await page.screenshotElement('hero section')
    expect((await sharp(hero).metadata()).width!).toBeGreaterThan(0)
    const full = await page.screenshot({ fullPage: true })
    expect((await sharp(full).metadata()).height!).toBeGreaterThan(300)
    await context.close()
  })

  it('annotated screenshot keeps dimensions and supports jpeg output', async () => {
    const context = await browser.newContext({ viewport: { width: 1000, height: 600 } })
    const page = await context.newPage()
    await page.goto(FIXTURE_URL)
    const nav = await page.find('navigation bar')
    const hero = await page.find('hero section')
    const png = await page.screenshot({
      annotate: [
        { element: nav, style: 'highlight', label: 'Navigation' },
        { element: hero, style: 'box', label: 'Hero' },
        { bbox: { x: 10, y: 10, width: 50, height: 20 }, style: 'arrow', label: 'Arrow' },
      ],
    })
    const meta = await sharp(png).metadata()
    expect(meta.width).toBe(1000)
    expect(meta.height).toBe(600)
    expect(meta.format).toBe('png')
    const jpeg = await page.screenshot({ type: 'jpeg', quality: 70 })
    expect((await sharp(jpeg).metadata()).format).toBe('jpeg')
    await context.close()
  })
})
