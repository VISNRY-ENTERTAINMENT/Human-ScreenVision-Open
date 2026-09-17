import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import path from 'path'
import type http from 'http'
import screenvision from '../../src/index'
import { Browser } from '../../src/core/Browser'
import { startFixtureServer, stopFixtureServer } from './fixture-server'

const PORT = 9996
const FIXTURE_URL = `http://localhost:${PORT}/`
const CODEBASE_PATH = path.join(__dirname, '../fixtures/react-app')

describe('Verification', () => {
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

  it('passes for navigation bar, hero section and footer', async () => {
    const page = await browser.newPage()
    await page.goto(FIXTURE_URL)
    const result = await page.verify({ contains: ['navigation bar', 'hero section', 'footer'] })
    expect(result.issues.filter((i) => i.severity === 'error')).toEqual([])
    expect(result.pass).toBe(true)
    expect(result.score).toBe(1)
    expect(result.checkedElements.map((c) => c.found)).toEqual([true, true, true])
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
    await page.close()
  })

  it('fails with an issue for a non-existent element and attaches an annotated screenshot', async () => {
    const page = await browser.newPage()
    await page.goto(FIXTURE_URL)
    const result = await page.verify({ contains: ['purple elephant'], timeout: 1000, screenshot: true })
    expect(result.pass).toBe(false)
    expect(result.score).toBe(0)
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0].severity).toBe('error')
    expect(result.issues[0].element).toBe('purple elephant')
    expect(Buffer.isBuffer(result.screenshotBuffer)).toBe(true)
    await page.close()
  })

  it('notContains and verifyElement behave as expected', async () => {
    const page = await browser.newPage()
    await page.goto(FIXTURE_URL)
    const result = await page.verify({ notContains: ['modal'], timeout: 500 })
    expect(result.pass).toBe(true)
    expect(await page.verifyElement('login button')).toBe(true)
    expect(await page.verifyElement('hamburger menu')).toBe(false) // display:none in the fixture
    await page.close()
  })

  it('desktop device checks pass and report visible nav links', async () => {
    const page = await browser.newPage()
    await page.goto(FIXTURE_URL)
    const result = await page.verify({
      contains: ['navigation bar'],
      device: 'Desktop 1440x900',
      layout: { navigationVisible: true, mobileMenuVisible: false, columns: 3 },
    })
    expect(result.issues.filter((i) => i.severity === 'error')).toEqual([])
    expect(result.pass).toBe(true)
    await page.close()
  })

  it('mobile device checks flag the missing hamburger menu', async () => {
    const context = await browser.newContext({ device: 'iPhone 15' })
    const page = await context.newPage()
    await page.goto(FIXTURE_URL)
    const result = await page.verify({ contains: ['navigation bar'] })
    expect(result.pass).toBe(false)
    expect(result.issues.some((i) => i.element === 'hamburger menu' && i.severity === 'error')).toBe(true)
    await context.close()
  })

  it('element-scoped verify searches within the element', async () => {
    const page = await browser.newPage()
    await page.goto(FIXTURE_URL)
    const nav = await page.find('navigation bar')
    const inside = await nav.verify({ contains: ['login button'], timeout: 1000 })
    expect(inside.pass).toBe(true)
    const outside = await nav.verify({ contains: ['hero section'], timeout: 500 })
    expect(outside.pass).toBe(false)
    await page.close()
  })
})
