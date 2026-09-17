import { describe, it, expect, afterAll } from 'vitest'
import screenvision from '../../src/index'
import { Browser } from '../../src/core/Browser'

describe('Browser Launch', () => {

  let browser: Browser

  afterAll(async () => {
    if (browser) await browser.close()
  })

  it('launches chromium in headless mode', async () => {
    browser = await screenvision.launch({ headless: true })
    expect(browser).toBeDefined()
  }, 30000)

  it('can open a new page', async () => {
    const page = await browser.newPage()
    expect(page).toBeDefined()
    await page.close()
  })

  it('can navigate to a URL', async () => {
    const page = await browser.newPage()
    await page.goto('about:blank')
    expect(page.url()).toBe('about:blank')
    await page.close()
  })

  it('can get page title', async () => {
    const page = await browser.newPage()
    await page.goto('about:blank')
    const title = await page.title()
    expect(typeof title).toBe('string')
    await page.close()
  })
})
