import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import screenvision from '../../src/index'
import { Browser } from '../../src/core/Browser'
import path from 'path'
import type http from 'http'
import { startFixtureServer, stopFixtureServer } from './fixture-server'

const PORT = 9998
const FIXTURE_URL = `http://localhost:${PORT}/`
const DIST = path.join(__dirname, '../fixtures/react-app/dist')

describe('Navigation', () => {
  let browser: Browser
  let server: http.Server

  beforeAll(async () => {
    server = await startFixtureServer(DIST, PORT)
    browser = await screenvision.launch({ headless: true })
  }, 30000)

  afterAll(async () => {
    await browser.close()
    await stopFixtureServer(server)
  })

  it('navigates to the fixture and reads the title', async () => {
    const page = await browser.newPage()
    await page.goto(FIXTURE_URL)
    expect(page.url()).toBe(FIXTURE_URL)
    expect(await page.title()).toBe('Acme - Build faster with AI')
    await page.close()
  })

  it('evaluates expressions and functions in the page', async () => {
    const page = await browser.newPage()
    await page.goto(FIXTURE_URL)
    const linkCount = await page.evaluate<number>('document.querySelectorAll(".nav-links a").length')
    expect(linkCount).toBe(3)
    const sum = await page.evaluate<number>((arg) => (arg as { a: number; b: number }).a + (arg as { a: number; b: number }).b, { a: 2, b: 3 })
    expect(sum).toBe(5)
    await page.close()
  })

  it('queries elements and reads attributes / text', async () => {
    const page = await browser.newPage()
    await page.goto(FIXTURE_URL)
    const login = await page.$('button.nav-login')
    expect(login).not.toBeNull()
    expect(await login!.getAttribute('aria-label')).toBe('login')
    expect((await login!.textContent())?.trim()).toBe('Login')
    expect(await login!.isVisible()).toBe(true)
    const hamburger = await page.$('.hamburger')
    expect(await hamburger!.isVisible()).toBe(false)
    const cards = await page.$$('.feature-card')
    expect(cards).toHaveLength(3)
    await page.close()
  })

  it('applies device emulation from the context', async () => {
    const context = await browser.newContext({ device: 'iPhone 15' })
    const page = await context.newPage()
    await page.goto(FIXTURE_URL)
    expect(page.viewportSize()).toEqual({ width: 390, height: 844 })
    // Note: innerWidth may exceed 390 here because the fixture nav overflows a
    // 390px viewport and mobile emulation zooms out; screen.width/DPR/UA are invariant.
    expect(await page.evaluate<number>('screen.width')).toBe(390)
    expect(await page.evaluate<number>('window.devicePixelRatio')).toBe(3)
    expect(await page.evaluate<string>('navigator.userAgent')).toContain('iPhone')
    expect(context.deviceExpectations?.layoutType).toBe('mobile')
    await context.close()
  })

  it('setContent + click + fill work through CDP input events', async () => {
    const page = await browser.newPage()
    await page.setContent('<input id="q"><button id="b" onclick="document.title=\'clicked\'">Go</button>')
    await page.fill('#q', 'hello')
    expect(await (await page.$('#q'))!.inputValue()).toBe('hello')
    await page.click('#b')
    expect(await page.title()).toBe('clicked')
    await page.close()
  })

  it('intercepts requests with route()', async () => {
    const page = await browser.newPage()
    await page.route('**/api/**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) })
    )
    await page.goto(FIXTURE_URL)
    const data = await page.evaluate<{ ok: boolean }>('fetch("/api/thing").then(r => r.json())')
    expect(data).toEqual({ ok: true })
    await page.close()
  })
})
