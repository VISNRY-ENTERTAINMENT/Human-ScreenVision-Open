import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'http'
import screenvision from '../../src/index'
import type { Browser } from '../../src/core/Browser'

/**
 * Locators: lazy references that re-resolve on every use.
 *
 * The case that motivates them is the one a practitioner reproduced against this library: a
 * handle to a table row, held across a re-render, acting on a different row. A locator cannot
 * have that bug, because it never holds an element — it holds a description and resolves it
 * again each time.
 *
 * The chaining matters as much as the laziness. `getByRole('row').filter({ hasText: 'Carol' })`
 * says what a person means, where `tr:nth-child(2)` says where the row happened to be.
 */
const PORT = 9965

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Staff</title>
<meta name="viewport" content="width=device-width, initial-scale=1"></head><body>
<main>
 <h1>Staff</h1>
 <label for="q">Search staff</label><input id="q" placeholder="Filter by name">
 <table id="grid"><tbody id="rows">
  <tr><td>Carol</td><td>Engineering</td><td><button>Edit</button><button>Remove</button></td></tr>
  <tr><td>Dave</td><td>Operations</td><td><button>Edit</button><button>Remove</button></td></tr>
  <tr><td>Erin</td><td>Design</td><td><button>Edit</button><button>Remove</button></td></tr>
 </tbody></table>
 <img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="team photo">
 <button title="Add a new member">New</button>
 <div id="out"></div>
 <script>
  document.getElementById('rows').addEventListener('click', (e) => {
    if (e.target.tagName !== 'BUTTON') return
    const name = e.target.closest('tr').children[0].textContent
    document.getElementById('out').textContent = e.target.textContent + ':' + name
  })
  window.reorder = () => {
    const rows = document.getElementById('rows')
    rows.insertBefore(rows.children[2], rows.children[0])
  }
 </script>
</main></body></html>`

let server: http.Server
let browser: Browser

beforeAll(async () => {
  server = http.createServer((_q, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(PAGE)
  })
  await new Promise<void>((r) => server.listen(PORT, r))
  browser = await screenvision.launch({ headless: true })
}, 60000)

afterAll(async () => {
  if (browser) await browser.close()
  if (server) server.close()
})

async function open() {
  const ctx = await browser.newContext({ device: 'Desktop 1440x900' })
  const p = await ctx.newPage()
  await p.goto(`http://127.0.0.1:${PORT}/`)
  return p
}

describe('finding by role, text and label', () => {
  it('counts rows by role', async () => {
    const p = await open()
    expect(await p.getByRole('row').count()).toBe(3)
    await p.close()
  }, 60000)

  it('finds a button by its accessible name', async () => {
    const p = await open()
    expect(await p.getByRole('button', { name: 'New' }).count()).toBe(1)
    await p.close()
  }, 60000)

  it('finds a field by its label and by its placeholder', async () => {
    const p = await open()
    await p.getByLabel('Search staff').fill('carol')
    expect(await p.getByPlaceholder('Filter by name').inputValue()).toBe('carol')
    await p.close()
  }, 60000)

  it('finds by title and by alt text', async () => {
    const p = await open()
    expect(await p.getByTitle('Add a new member').count()).toBe(1)
    expect(await p.getByAltText('team photo').count()).toBe(1)
    await p.close()
  }, 60000)
})

describe('chaining narrows to the thing you mean', () => {
  it('acts on the button inside a particular row', async () => {
    const p = await open()
    await p.getByRole('row').filter({ hasText: 'Dave' }).getByRole('button', { name: 'Edit' }).click()
    expect(await p.evaluate<string>(`document.getElementById('out').textContent`)).toBe('Edit:Dave')
    await p.close()
  }, 60000)

  it('excludes with hasNotText', async () => {
    const p = await open()
    const rows = p.getByRole('row').filter({ hasNotText: 'Carol' })
    expect(await rows.count()).toBe(2)
    await p.close()
  }, 60000)

  it('addresses first, last and nth', async () => {
    const p = await open()
    expect(await p.getByRole('row').first().textContent()).toContain('Carol')
    expect(await p.getByRole('row').last().textContent()).toContain('Erin')
    expect(await p.getByRole('row').nth(1).textContent()).toContain('Dave')
    await p.close()
  }, 60000)

  it('lists every match', async () => {
    const p = await open()
    const rows = await p.getByRole('row').all()
    const texts = await Promise.all(rows.map((r) => r.textContent()))
    expect(texts.join(' ')).toContain('Carol')
    expect(texts.join(' ')).toContain('Erin')
    await p.close()
  }, 60000)
})

describe('a locator survives what breaks a handle', () => {
  it('still acts on the right row after the table is reordered', async () => {
    const p = await open()
    const carolEdit = p.getByRole('row').filter({ hasText: 'Carol' }).getByRole('button', { name: 'Edit' })

    // Erin moves to the top: a positional selector would now point at the wrong row
    await p.evaluate(`window.reorder()`)
    await carolEdit.click()

    // the locator re-resolved by description, so it is still Carol's row
    expect(await p.evaluate<string>(`document.getElementById('out').textContent`)).toBe('Edit:Carol')
    await p.close()
  }, 60000)

  it('survives a full re-render of the table', async () => {
    const p = await open()
    const daveRemove = p.getByRole('row').filter({ hasText: 'Dave' }).getByRole('button', { name: 'Remove' })
    await p.evaluate(`document.getElementById('rows').innerHTML = document.getElementById('rows').innerHTML`)
    await daveRemove.click()
    expect(await p.evaluate<string>(`document.getElementById('out').textContent`)).toBe('Remove:Dave')
    await p.close()
  }, 60000)
})

describe('failures explain themselves', () => {
  it('says how many it matched when it cannot pick one', async () => {
    const p = await open()
    await expect(p.getByText('nothing here at all').click({ timeout: 900 })).rejects.toThrow(
      /matched 0 elements/
    )
    await p.close()
  }, 60000)

  it('reports not visible rather than throwing for an absent element', async () => {
    const p = await open()
    expect(await p.getByTestId('does-not-exist').isVisible()).toBe(false)
    await p.close()
  }, 60000)
})
