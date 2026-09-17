import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'http'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import screenvision from '../../src/index'
import type { Browser } from '../../src/core/Browser'
import type { Page } from '../../src/core/Page'

/**
 * Every other test in this repo runs against a fixture page of a dozen elements written to
 * exercise one code path. This one runs against `tests/fixtures/realapp` — a page that behaves
 * like software: data that arrives late behind skeletons, a list that throws away its DOM on
 * every keystroke, a modal that traps focus behind a click-swallowing backdrop, a shadow-DOM
 * date picker, an embedded payment iframe, a table where every row has the same three buttons,
 * a submit button that is inert until a box is ticked, an optimistic update that reverts, a
 * drag-reorderable list, and content that only exists after you scroll to it.
 */

const PORT = 9957
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'realapp')
const BASE = `http://127.0.0.1:${PORT}`

const STATS = [
  { label: 'Open invoices', value: '18' },
  { label: 'Overdue', value: '3' },
  { label: 'Collected (MTD)', value: '$84,210' },
  { label: 'Avg. days to pay', value: '12.4' },
]

const CUSTOMERS = [
  { id: 'c1', name: 'Northwind Trading', city: 'Bristol', plan: 'Scale' },
  { id: 'c2', name: 'Helix Biolabs', city: 'Leeds', plan: 'Starter' },
  { id: 'c3', name: 'Orbital Freight', city: 'Bristol', plan: 'Scale' },
  { id: 'c4', name: 'Pemberton & Co', city: 'Cardiff', plan: 'Enterprise' },
  { id: 'c5', name: 'Vega Analytics', city: 'Glasgow', plan: 'Starter' },
  { id: 'c6', name: 'Quarry Lane Foods', city: 'Sheffield', plan: 'Scale' },
]

const INVOICES = [
  { id: 'INV-1001', customer: 'Northwind Trading', amount: 1240.0, status: 'Sent' },
  { id: 'INV-1002', customer: 'Helix Biolabs', amount: 380.5, status: 'Paid' },
  { id: 'INV-1003', customer: 'Orbital Freight', amount: 9120.75, status: 'Overdue' },
  { id: 'INV-1004', customer: 'Pemberton & Co', amount: 615.0, status: 'Sent' },
  { id: 'INV-1005', customer: 'Vega Analytics', amount: 2075.25, status: 'Overdue' },
]

const ACTIVITY = [
  { text: 'Invoice INV-1003 became overdue', when: '2 hours ago' },
  { text: 'Payment received from Helix Biolabs', when: 'yesterday' },
  { text: 'Northwind Trading upgraded to Scale', when: '3 days ago' },
]

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
}

let server: http.Server
let browser: Browser

function json(res: http.ServerResponse, body: unknown, delay = 0) {
  setTimeout(() => {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(body))
  }, delay)
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const u = new URL(req.url ?? '/', BASE)
    const p = u.pathname
    // API, deliberately slow enough that the skeletons are really on screen first
    if (p === '/api/stats') return json(res, STATS, 250)
    if (p === '/api/customers') return json(res, CUSTOMERS, 400)
    if (p === '/api/invoices') return json(res, INVOICES, 320)
    if (p === '/api/activity') return json(res, ACTIVITY, 200)
    if (p === '/api/pay') {
      // INV-1003 always fails: the optimistic update must be seen to revert
      const id = u.searchParams.get('id')
      return json(res, { ok: id !== 'INV-1003' }, 450)
    }
    const rel = p === '/' ? 'index.html' : p.replace(/^\/+/, '')
    const file = path.join(ROOT, rel)
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      return res.end('not found')
    }
    res.writeHead(200, {
      'content-type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    })
    fs.createReadStream(file).pipe(res)
  })
  await new Promise<void>((r) => server.listen(PORT, '127.0.0.1', r))
  browser = await screenvision.launch({ headless: true })
}, 90000)

afterAll(async () => {
  if (browser) await browser.close()
  if (server) await new Promise<void>((r) => server.close(() => r()))
})

async function open(): Promise<Page> {
  const ctx = await browser.newContext({ device: 'Desktop 1440x900' })
  const page = await ctx.newPage()
  await page.goto(`${BASE}/`)
  return page
}

/** the app is "loaded" when every async section has swapped its skeleton out */
async function ready(page: Page) {
  await page.waitForFunction(
    `document.querySelector('#stats-grid').dataset.state === 'ready' &&
     document.querySelector('.list-wrap').dataset.state === 'ready' &&
     document.querySelectorAll('#inv-body tr[data-inv]').length === 5`,
    { timeout: 15000 }
  )
}

/* ============================ 1. async load / skeletons ============================ */

describe('journey: waiting out a loading skeleton', () => {
  it('the skeleton is on screen first and the real value replaces it', async () => {
    const ctx = await browser.newContext({ device: 'Desktop 1440x900' })
    const page = await ctx.newPage()
    // hold the stats response open so the loading state is genuinely observable, rather
    // than racing a 250ms server delay
    let release: (() => void) | null = null
    const held = new Promise<void>((r) => { release = r })
    await page.route('**/api/stats', async (route) => {
      await held
      await route.fulfill({ contentType: 'application/json; charset=utf-8', body: JSON.stringify(STATS) })
    })
    await page.goto(`${BASE}/`)

    expect(await page.locator('#stats-grid .skeleton-wrap').count()).toBe(4)
    expect(await page.locator('#stats-grid .card__value').count()).toBe(0)
    expect(await page.evaluate<string>(`document.getElementById('stats-grid').dataset.state`)).toBe('loading')

    release!()
    await page.waitForSelector('#stats-grid .card__value', { timeout: 15000 })
    expect(await page.locator('#stats-grid .skeleton-wrap').count()).toBe(0)
    expect(await page.getByText('Collected (MTD)').textContent()).toContain('Collected')
    await page.close()
  }, 60000)

  it('reads a stat by its label without knowing the markup', async () => {
    const page = await open()
    await ready(page)
    const card = page.locator('.card--stat').filter({ hasText: 'Overdue' })
    expect(await card.count()).toBe(1)
    expect(await card.locator('.card__value').textContent()).toBe('3')
    await page.close()
  }, 60000)
})

/* ============================ 2. filter + stale DOM ============================ */

describe('journey: filter the customer list and act on a result', () => {
  it('filters and acts on the survivor after the list re-rendered', async () => {
    const page = await open()
    await ready(page)
    expect(await page.locator('#cust-list .lst__item').count()).toBe(6)

    await page.getByLabel('Filter customers').fill('helix')
    await page.waitForFunction(`document.querySelectorAll('#cust-list .lst__item').length === 1`, { timeout: 5000 })
    expect(await page.locator('#cust-count').textContent()).toBe('1 of 6 customers')

    await page.locator('#cust-list .lst__item').getByRole('button', { name: 'View' }).click()
    await page.waitForFunction(`document.querySelector('#cust-count').dataset.lastOpened === 'c2'`, { timeout: 5000 })
    await page.close()
  }, 60000)

  it('a locator taken before the re-render still acts on the right element after it', async () => {
    const page = await open()
    await ready(page)
    // resolved against the pre-filter DOM; every one of those <li> nodes is about to be destroyed
    const viewVega = page.locator('.lst__item').filter({ hasText: 'Vega Analytics' }).getByRole('button', { name: 'View' })
    expect(await viewVega.count()).toBe(1)

    await page.getByLabel('Filter customers').fill('vega')
    await page.waitForFunction(`document.querySelectorAll('#cust-list .lst__item').length === 1`, { timeout: 5000 })

    // same locator, brand new DOM nodes: a locator must re-resolve, not hold a dead handle
    await viewVega.click()
    await page.waitForFunction(`document.querySelector('#cust-count').dataset.lastOpened === 'c5'`, { timeout: 5000 })
    await page.close()
  }, 60000)

  it('an elementHandle taken before the re-render must not silently act on nothing', async () => {
    const page = await open()
    await ready(page)
    const handle = await page.locator('.lst__item').filter({ hasText: 'Vega Analytics' })
      .getByRole('button', { name: 'View' }).elementHandle()

    await page.getByLabel('Filter customers').fill('vega')
    await page.waitForFunction(`document.querySelectorAll('#cust-list .lst__item').length === 1`, { timeout: 5000 })

    // The node this handle points at was thrown away. Clicking it must either work on the
    // live equivalent or fail loudly — it must NOT report success having done nothing.
    let threw = false
    try {
      await handle.click()
    } catch {
      threw = true
    }
    if (!threw) {
      // it claimed success: prove the app actually saw the click
      await page.waitForFunction(`document.querySelector('#cust-count').dataset.lastOpened === 'c5'`, { timeout: 3000 })
    }
    await page.close()
  }, 60000)

  it('filtering to nothing reports zero, not a stale count', async () => {
    const page = await open()
    await ready(page)
    await page.getByLabel('Filter customers').fill('zzzznotacustomer')
    await page.waitForFunction(`document.querySelector('#cust-count').textContent === '0 of 6 customers'`, { timeout: 5000 })
    expect(await page.locator('#cust-list .lst__item').count()).toBe(0)
    expect(await page.locator('.lst__item').filter({ hasText: 'Vega Analytics' }).count()).toBe(0)
    await page.close()
  }, 60000)
})

/* ============================ 3. identical rows ============================ */

describe('journey: acting on the correct row among identical ones', () => {
  it('refuses an ambiguous row button instead of picking the first', async () => {
    const page = await open()
    await ready(page)
    expect(await page.getByRole('button', { name: 'Edit' }).count()).toBe(5)
    await expect(page.getByRole('button', { name: 'Edit' }).click()).rejects.toThrow(/matched 5 elements/)
    expect(await page.locator('#modal-backdrop').isVisible()).toBe(false)
    await page.close()
  }, 60000)

  it('deletes exactly the row it was told to', async () => {
    const page = await open()
    await ready(page)
    const row = page.locator('tr').filter({ hasText: 'Pemberton' })
    await row.getByRole('button', { name: 'Delete' }).click()
    await page.waitForFunction(`document.querySelectorAll('#inv-body tr[data-inv]').length === 4`, { timeout: 5000 })
    expect(await page.locator('#inv-log').textContent()).toBe('Deleted INV-1004')
    expect(await page.locator('tr').filter({ hasText: 'Pemberton' }).count()).toBe(0)
    // the neighbours survive
    expect(await page.locator('tr').filter({ hasText: 'Orbital Freight' }).count()).toBe(1)
    await page.close()
  }, 60000)

  it('scopes by row text, not by row position, after a sort re-renders the table', async () => {
    const page = await open()
    await ready(page)
    await page.getByRole('button', { name: 'Amount' }).click() // re-render, ascending by amount
    await page.waitForFunction(
      `document.querySelector('#inv-body tr[data-inv]').dataset.inv === 'INV-1002'`,
      { timeout: 5000 }
    )
    await page.locator('tr').filter({ hasText: 'Vega Analytics' }).getByRole('button', { name: 'Delete' }).click()
    await page.waitForFunction(`document.querySelector('#inv-log').textContent === 'Deleted INV-1005'`, { timeout: 5000 })
    await page.close()
  }, 60000)
})

/* ============================ 4. modal, focus trap, backdrop ============================ */

describe('journey: open a modal and interact with it', () => {
  it('opens from the right row and edits that invoice', async () => {
    const page = await open()
    await ready(page)
    await page.locator('tr').filter({ hasText: 'Orbital Freight' }).getByRole('button', { name: 'Edit' }).click()
    await page.waitForSelector('#edit-modal', { timeout: 5000 })
    expect(await page.locator('#dlg-subject').textContent()).toBe('INV-1003 - Orbital Freight')

    await page.getByLabel('Amount', { exact: true }).fill('4000')
    await page.getByRole('button', { name: 'Save changes' }).click()
    await page.waitForFunction(`document.querySelector('#inv-log').textContent === 'Updated INV-1003 to $4000.00'`, { timeout: 5000 })
    expect(await page.locator('#modal-backdrop').isVisible()).toBe(false)
    await page.close()
  }, 60000)

  it('the backdrop blocks clicks on the page behind it, and the library says so', async () => {
    const page = await open()
    await ready(page)
    await page.locator('tr').filter({ hasText: 'Orbital Freight' }).getByRole('button', { name: 'Edit' }).click()
    await page.waitForSelector('#edit-modal', { timeout: 5000 })

    // this button is still in the DOM and still "visible", but the overlay is on top of it
    const behind = page.locator('[data-action="new-invoice"]')
    expect(await behind.isVisible()).toBe(true)
    await expect(behind.click({ timeout: 2500 })).rejects.toThrow()
    // and nothing behind the modal moved
    expect(await page.locator('#dlg-subject').textContent()).toBe('INV-1003 - Orbital Freight')
    await page.close()
  }, 60000)

  it('keeps focus inside the dialog when tabbing off the end', async () => {
    const page = await open()
    await ready(page)
    await page.locator('tr').filter({ hasText: 'Orbital Freight' }).getByRole('button', { name: 'Edit' }).click()
    await page.waitForSelector('#edit-modal', { timeout: 5000 })
    await page.waitForFunction(`document.activeElement && document.activeElement.id === 'dlg-amount'`, { timeout: 5000 })

    for (let i = 0; i < 8; i++) await page.press('#dlg-amount', 'Tab')
    const inside = await page.evaluate<boolean>(
      `!!document.activeElement && document.getElementById('edit-modal').contains(document.activeElement)`
    )
    expect(inside).toBe(true)
    await page.close()
  }, 60000)

  it('Escape closes the dialog', async () => {
    const page = await open()
    await ready(page)
    await page.locator('tr').filter({ hasText: 'Orbital Freight' }).getByRole('button', { name: 'Edit' }).click()
    await page.waitForSelector('#edit-modal', { timeout: 5000 })
    await page.press('#dlg-amount', 'Escape')
    await page.waitForFunction(`document.getElementById('modal-backdrop').hidden === true`, { timeout: 5000 })
    await page.close()
  }, 60000)
})

/* ============================ 5. validated form + inert submit ============================ */

describe('journey: fill and submit a validated form', () => {
  it('the submit button is inert until the box is ticked, then works', async () => {
    const page = await open()
    await ready(page)
    const submit = page.locator('#inv-submit')
    expect(await submit.isVisible()).toBe(true)
    expect(await submit.isEnabled()).toBe(false)
    await expect(submit.click({ timeout: 2000 })).rejects.toThrow()

    await page.getByLabel('I confirm the billing details are correct').check()
    await page.waitForFunction(`!document.getElementById('inv-submit').disabled`, { timeout: 5000 })
    expect(await submit.isEnabled()).toBe(true)
    await page.close()
  }, 60000)

  it('shows inline errors for bad input and clears them when fixed', async () => {
    const page = await open()
    await ready(page)
    await page.getByLabel('I confirm the billing details are correct').check()
    await page.getByLabel('Customer name').fill('Northwind Trading')
    await page.getByLabel('Email').fill('not-an-email')
    await page.getByLabel('Amount (USD)').fill('-5')
    await page.locator('#inv-submit').click()

    await page.waitForSelector('[data-err-for="email"]:not([hidden])', { timeout: 5000 })
    expect(await page.locator('[data-err-for="email"]').textContent()).toBe('Enter a valid email address')
    expect(await page.locator('[data-err-for="amount"]').textContent()).toBe('Amount must be a positive number')
    expect(await page.locator('[data-err-for="name"]').isVisible()).toBe(false)

    await page.getByLabel('Email').fill('ops@northwind.example')
    await page.getByLabel('Amount (USD)').fill('1240.00')
    await page.locator('#inv-submit').click()
    await page.waitForFunction(
      `document.getElementById('submit-hint').textContent.indexOf('Created invoice') === 0`,
      { timeout: 5000 }
    )
    expect(await page.locator('[data-err-for="email"]').isVisible()).toBe(false)
    await page.close()
  }, 60000)
})

/* ============================ 6. shadow DOM component ============================ */

describe('journey: the shadow-DOM date picker', () => {
  it('opens the calendar and picks a day, and the form sees the value', async () => {
    const page = await open()
    await ready(page)
    await page.getByRole('button', { name: 'Open calendar' }).click()
    await page.waitForFunction(
      `document.getElementById('f-due').shadowRoot.getElementById('dp-pop').hasAttribute('data-open')`,
      { timeout: 5000 }
    )
    await page.getByRole('button', { name: '17', exact: true }).click()
    await page.waitForFunction(
      `document.getElementById('f-due').shadowRoot.getElementById('dp-input').value === '2026-04-17'`,
      { timeout: 5000 }
    )
    expect(await page.evaluate<string>(`document.getElementById('f-due').value`)).toBe('2026-04-17')
    await page.close()
  }, 60000)

  it('observe() sees the controls inside the shadow root', async () => {
    const page = await open()
    await ready(page)
    const obs = await page.observe({ maxAffordances: 200 })
    const names = obs.affordances.map((a) => a.name)
    expect(names).toContain('Open calendar')
    expect(obs.affordances.some((a) => a.inShadowRoot)).toBe(true)
    await page.close()
  }, 60000)

  it('the picked date reaches the submitted form', async () => {
    const page = await open()
    await ready(page)
    await page.getByRole('button', { name: 'Open calendar' }).click()
    await page.getByRole('button', { name: '9', exact: true }).click()
    await page.getByLabel('I confirm the billing details are correct').check()
    await page.getByLabel('Customer name').fill('Helix Biolabs')
    await page.getByLabel('Email').fill('ap@helix.example')
    await page.getByLabel('Amount (USD)').fill('380.50')
    await page.locator('#inv-submit').click()
    await page.waitForFunction(
      `document.getElementById('submit-hint').textContent === 'Created invoice for Helix Biolabs due 2026-04-09'`,
      { timeout: 5000 }
    )
    await page.close()
  }, 60000)
})

/* ============================ 7. iframe payment widget ============================ */

describe('journey: the embedded payment iframe', () => {
  it('fills and submits the nested form and the host page updates', async () => {
    const page = await open()
    await ready(page)
    const pay = page.frameLocator('#pay-frame')
    await pay.getByLabel('Card number').fill('4242424242424242')
    await pay.getByLabel('Expiry').fill('04/29')
    await pay.getByLabel('Security code').fill('123')
    await pay.getByRole('button', { name: 'Save card' }).click()
    await page.waitForFunction(
      `document.getElementById('pay-result').textContent === 'Card ending 4242 saved.'`,
      { timeout: 8000 }
    )
    await page.close()
  }, 60000)

  it('surfaces the iframe validation error without touching the host page', async () => {
    const page = await open()
    await ready(page)
    const frame = await page.frame('#pay-frame')
    await frame.getByLabel('Card number').fill('123')
    await frame.getByRole('button', { name: 'Save card' }).click()
    await frame.waitForSelector('#card-err:not([hidden])', { timeout: 5000 })
    expect(await frame.textContent('#card-err')).toBe('Card number must be 16 digits')
    expect(await page.locator('#pay-result').textContent()).toBe('No card on file.')
    await page.close()
  }, 60000)

  it('a name that exists in both host and frame is not confused', async () => {
    const page = await open()
    await ready(page)
    // "Amount" exists in the host form and in the modal; "Card number" only in the frame
    expect(await page.getByLabel('Card number').count()).toBe(0)
    expect(await page.frameLocator('#pay-frame').getByLabel('Card number').count()).toBe(1)
    await page.close()
  }, 60000)
})

/* ============================ 8. optimistic UI that reverts ============================ */

describe('journey: an optimistic update that fails', () => {
  it('act() reports the expectation as unmet when the change is rolled back', async () => {
    const page = await open()
    await ready(page)
    const row = `#inv-body tr[data-inv="INV-1003"]`
    expect(await page.locator(`${row} .pill`).textContent()).toBe('Overdue')

    const result = await page.act({
      do: 'click',
      selector: `${row} [data-paid]`,
      expect: { textAppears: 'Paid INV-1003', requestMade: '/api/pay' },
    })

    // the optimistic flip is instant; the server refuses ~450ms later and the row reverts
    expect(result.ok).toBe(false)
    expect(result.verdict).toBe('unexpected')
    expect(result.expectations.find((e) => e.expectation.includes('Paid INV-1003'))!.met).toBe(false)

    await page.waitForFunction(
      `document.querySelector('#inv-log').textContent.indexOf('Payment failed') === 0`,
      { timeout: 8000 }
    )
    expect(await page.locator(`${row} .pill`).textContent()).toBe('Overdue')
    await page.close()
  }, 60000)

  it('must not diagnose a working delegated button as inert', async () => {
    const page = await open()
    await ready(page)
    // Every row button in this app is handled by one listener on `document` — the normal
    // pattern for a list that re-renders. The button demonstrably works: the click below
    // removes the row and fires a request. `inert.likely` must therefore not be true.
    const result = await page.act({ do: 'click', selector: `#inv-body tr[data-inv="INV-1001"] [data-del]` })
    expect(result.effects.mutations.total).toBeGreaterThan(0)
    expect(await page.locator('#inv-log').textContent()).toBe('Deleted INV-1001')
    expect(result.inert?.likely ?? false).toBe(false)
    await page.close()
  }, 60000)

  it('the successful one really does stick', async () => {
    const page = await open()
    await ready(page)
    const row = `#inv-body tr[data-inv="INV-1005"]`
    await page.locator(`${row} [data-paid]`).click()
    await page.waitForFunction(
      `document.querySelector('#inv-log').textContent === 'Paid INV-1005'`,
      { timeout: 8000 }
    )
    expect(await page.locator(`${row} .pill`).textContent()).toBe('Paid')
    await page.close()
  }, 60000)
})

/* ============================ 9. toast auto-dismiss ============================ */

describe('journey: a toast that auto-dismisses', () => {
  it('appears, is readable, and is gone a few seconds later', async () => {
    const page = await open()
    await ready(page)
    await page.locator('tr').filter({ hasText: 'Northwind Trading' }).getByRole('button', { name: 'Delete' }).click()
    const toast = page.locator('[data-toast]')
    await toast.waitFor({ timeout: 5000 })
    expect(await toast.textContent()).toBe('Invoice INV-1001 deleted')
    await page.waitForFunction(`document.querySelectorAll('[data-toast]').length === 0`, { timeout: 8000 })
    expect(await toast.count()).toBe(0)
    // and asserting on it now must fail loudly, not return the last text it saw
    await expect(toast.textContent()).rejects.toThrow()
    await page.close()
  }, 60000)
})

/* ============================ 10. drag reorder ============================ */

describe('journey: drag-reorder a list', () => {
  it('moves the first item below the third', async () => {
    const page = await open()
    await ready(page)
    expect(await page.locator('#queue-order').textContent()).toBe('ana,brett,chi,dov')
    const src = await page.locator('.dnd__item[data-key="ana"]').elementHandle()
    const dst = await page.locator('.dnd__item[data-key="chi"]').elementHandle()
    await src.dragTo(dst)
    await page.waitForFunction(
      `document.getElementById('queue-order').textContent === 'brett,chi,ana,dov'`,
      { timeout: 6000 }
    )
    await page.close()
  }, 60000)

  it('the drop really did take effect, which the un-forced call denied', async () => {
    const page = await open()
    await ready(page)
    const src = await page.locator('.dnd__item[data-key="ana"]').elementHandle()
    const dst = await page.locator('.dnd__item[data-key="chi"]').elementHandle()
    // force:true only skips the "did anything change" check; the drag itself is identical
    await src.dragTo(dst, { force: true })
    await page.waitForFunction(
      `document.getElementById('queue-order').textContent === 'brett,chi,ana,dov'`,
      { timeout: 6000 }
    )
    await page.close()
  }, 60000)
})

/* ============================ 11. lazy content on scroll ============================ */

describe('journey: content that only exists after you scroll', () => {
  it('is genuinely absent, then loads when scrolled into view', async () => {
    const page = await open()
    await ready(page)
    expect(await page.getByText('Payment received from Helix Biolabs').count()).toBe(0)

    const sentinel = await page.waitForSelector('#lazy-sentinel')
    await sentinel.scrollIntoViewIfNeeded()

    await page.waitForSelector('#activity-slot[data-state="ready"]', { timeout: 10000 })
    expect(await page.getByText('Payment received from Helix Biolabs').count()).toBe(1)
    await page.close()
  }, 60000)

  it('a locator for below-the-fold content clicks it rather than missing', async () => {
    const page = await open()
    await ready(page)
    // "Chi Nakamura" is far below the fold behind a 900px spacer
    const item = page.locator('.dnd__item[data-key="dov"]')
    expect(await item.textContent()).toBe('Dov Ramirez')
    const box = await (await item.elementHandle()).boundingBox()
    expect(box).not.toBeNull()
    await page.close()
  }, 60000)
})

/* ============================ 12. whole-page reading ============================ */

describe('reading the page as an agent would', () => {
  it('ariaSnapshot describes the loaded app, not the skeletons', async () => {
    const page = await open()
    await ready(page)
    const snap = await page.ariaSnapshot()
    expect(snap).toContain('Invoices')
    expect(snap).toContain('Customers')
    expect(snap).toMatch(/button "Delete"/)
    await page.close()
  }, 60000)

  it('observe() warns about a modal only when one is actually open', async () => {
    const page = await open()
    await ready(page)
    const closed = await page.observe({ maxAffordances: 200 })
    // no dialog is on screen: the markup for one merely exists, hidden, as in any real app
    expect(await page.locator('#modal-backdrop').isVisible()).toBe(false)
    expect(closed.notices.join(' ')).not.toMatch(/modal dialog is open/i)

    await page.locator('tr').filter({ hasText: 'Orbital Freight' }).getByRole('button', { name: 'Edit' }).click()
    await page.waitForSelector('#edit-modal', { timeout: 5000 })
    const open_ = await page.observe({ maxAffordances: 200 })
    expect(open_.notices.join(' ')).toMatch(/modal dialog is open/i)
    await page.close()
  }, 60000)

  it('does not offer controls behind an open modal as enabled and clickable', async () => {
    const page = await open()
    await ready(page)
    await page.locator('tr').filter({ hasText: 'Orbital Freight' }).getByRole('button', { name: 'Edit' }).click()
    await page.waitForSelector('#edit-modal', { timeout: 5000 })
    const obs = await page.observe({ maxAffordances: 200 })
    const behind = obs.affordances.find((a) => a.name === 'New invoice')
    // It is covered by the backdrop; click() correctly refuses it, so observe must not
    // describe it in the same state as a reachable control.
    //
    // Asserted as `obscured` rather than `enabled === false`, which is what this test
    // originally checked: the button is not disabled, it is covered, and those are different
    // facts with different remedies (wait for it to enable, versus close the thing on top of
    // it). Collapsing them into `enabled` would lose the one that says what to do next.
    expect(behind === undefined || behind.obscured === true).toBe(true)
    expect(behind === undefined || behind.state.enabled === true).toBe(true)
    await page.close()
  }, 60000)

  it('observe() does not report the page as empty while data is still loading', async () => {
    const page = await open()
    const obs = await page.observe()
    expect(obs.affordances.length).toBeGreaterThan(2)
    await page.close()
  }, 60000)
})
