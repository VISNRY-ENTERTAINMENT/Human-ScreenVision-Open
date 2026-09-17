import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import screenvision from '../../src/index'
import { Browser } from '../../src/core/Browser'
import path from 'path'
import type http from 'http'
import { startFixtureServer, stopFixtureServer } from './fixture-server'

// The fixture React app is served as a static HTML build (tests/fixtures/react-app/dist)
// by a tiny built-in Node http server on port 9999 — no Vite build or `serve` needed.

const FIXTURE_URL = 'http://localhost:9999'
const CODEBASE_PATH = path.join(__dirname, '../fixtures/react-app')

describe('Semantic Element Finding', () => {

  let browser: Browser
  let server: http.Server

  beforeAll(async () => {
    server = await startFixtureServer(path.join(CODEBASE_PATH, 'dist'), 9999)
    browser = await screenvision.launch({
      headless: true,
      codebase: CODEBASE_PATH,
      framework: 'react'
    })
  }, 30000)

  afterAll(async () => {
    await browser.close()
    await stopFixtureServer(server)
  })

  it('finds navigation bar via code index', async () => {
    const page = await browser.newPage()
    await page.goto(FIXTURE_URL)
    const nav = await page.find('navigation bar')
    expect(nav).toBeDefined()
    const bbox = await nav.boundingBox()
    expect(bbox).not.toBeNull()
    await page.close()
  })

  it('finds hero section via code index', async () => {
    const page = await browser.newPage()
    await page.goto(FIXTURE_URL)
    const hero = await page.find('hero section')
    const bbox = await hero.boundingBox()
    expect(bbox!.y).toBeLessThan(400)  // hero is near top
    await page.close()
  })

  it('finds elements using aliases', async () => {
    const page = await browser.newPage()
    await page.goto(FIXTURE_URL)
    // 'navbar' should resolve same as 'navigation bar'
    const nav1 = await page.find('navbar')
    const nav2 = await page.find('navigation bar')
    const bbox1 = await nav1.boundingBox()
    const bbox2 = await nav2.boundingBox()
    expect(bbox1!.x).toBe(bbox2!.x)
    expect(bbox1!.y).toBe(bbox2!.y)
    await page.close()
  })

  it('findOrNull returns null for non-existent element', async () => {
    const page = await browser.newPage()
    await page.goto(FIXTURE_URL)
    const el = await page.findOrNull('purple elephant dancing', { timeout: 1000 })
    expect(el).toBeNull()
    await page.close()
  })
})
