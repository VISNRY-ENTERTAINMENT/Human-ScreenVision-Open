import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'http'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import screenvision from '../../src/index'
import type { Browser } from '../../src/core/Browser'

/**
 * File upload, downloads, network waits and drag and drop.
 *
 * These are not exotic capabilities. A team hits all four in an ordinary week, and an agent
 * asked to "upload the invoice" or "export the report" cannot begin without two of them. They
 * had no implementation at all, which is why they are grouped here.
 */
const PORT = 9959

const PAGES: Record<string, string> = {
  '/upload': `<!doctype html><html><head><meta charset="utf-8"><title>Upload</title></head><body>
<main>
 <input type="file" id="file" multiple>
 <div id="names"></div>
 <div id="wrapper">not a file input</div>
 <script>
  document.getElementById('file').addEventListener('change', (e) => {
    document.getElementById('names').textContent =
      Array.from(e.target.files).map((f) => f.name + ':' + f.size).join(',')
  })
 </script></main></body></html>`,

  '/network': `<!doctype html><html><head><meta charset="utf-8"><title>Network</title></head><body>
<main>
 <button id="load" onclick="fetch('/api/items?q=widgets').then(r => r.json()).then(d => { document.getElementById('out').textContent = d.count })">Load</button>
 <div id="out"></div>
</main></body></html>`,

  '/download': `<!doctype html><html><head><meta charset="utf-8"><title>Download</title></head><body>
<main><a id="get" href="/file.csv" download="report.csv">Export</a></main></body></html>`,

  '/drag5': `<!doctype html><html><head><meta charset="utf-8"><title>HTML5 drag</title>
<style>#card,#zone{width:120px;height:80px;border:1px solid #333;display:inline-block}</style></head><body>
<main>
 <div id="card" draggable="true">card</div><div id="zone">drop zone</div><div id="out"></div>
 <script>
  const card = document.getElementById('card'), zone = document.getElementById('zone')
  card.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/plain', 'card'))
  zone.addEventListener('dragover', (e) => e.preventDefault())
  zone.addEventListener('drop', (e) => {
    e.preventDefault()
    document.getElementById('out').textContent = 'dropped ' + e.dataTransfer.getData('text/plain')
  })
 </script></main></body></html>`,

  '/inert-drag': `<!doctype html><html><head><meta charset="utf-8"><title>Inert drag</title>
<style>#card,#zone{width:120px;height:80px;border:1px solid #333;display:inline-block}</style></head><body>
<main><div id="card" draggable="true">card</div><div id="zone">nothing listens</div></main></body></html>`,

  '/drag': `<!doctype html><html><head><meta charset="utf-8"><title>Drag</title>
<style>#src,#dst{width:120px;height:80px;border:1px solid #333;display:inline-block}</style></head><body>
<main>
 <div id="src">card</div><div id="dst">drop here</div><div id="out"></div>
 <script>
  const src = document.getElementById('src'), dst = document.getElementById('dst')
  let dragging = false
  src.addEventListener('mousedown', () => { dragging = true })
  document.addEventListener('mouseup', (e) => {
    if (!dragging) return
    dragging = false
    const hit = document.elementFromPoint(e.clientX, e.clientY)
    if (hit === dst || dst.contains(hit)) document.getElementById('out').textContent = 'dropped'
  })
 </script></main></body></html>`,
}

let server: http.Server
let browser: Browser
let tmp: string

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const route = (req.url ?? '/').split('?')[0]
    if (route === '/api/items') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ count: 42 }))
      return
    }
    if (route === '/file.csv') {
      res.writeHead(200, { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="report.csv"' })
      res.end('id,name\n1,widget\n')
      return
    }
    const body = PAGES[route]
    res.writeHead(body ? 200 : 404, { 'content-type': 'text/html' })
    res.end(body ?? '<h1>404</h1>')
  })
  await new Promise<void>((r) => server.listen(PORT, r))
  browser = await screenvision.launch({ headless: true })
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sv-files-'))
}, 60000)

afterAll(async () => {
  if (browser) await browser.close()
  if (server) server.close()
  if (tmp) await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined)
})

async function open(route: string) {
  const ctx = await browser.newContext({ device: 'Desktop 1440x900' })
  const p = await ctx.newPage()
  await p.goto(`http://127.0.0.1:${PORT}${route}`)
  return p
}

describe('file upload', () => {
  it('attaches a file and the page sees it', async () => {
    const file = path.join(tmp, 'invoice.txt')
    await fs.writeFile(file, 'hello invoice')
    const p = await open('/upload')
    const input = await p.$('#file')
    await input!.setInputFiles(file)
    expect(await p.evaluate<string>(`document.getElementById('names').textContent`)).toBe('invoice.txt:13')
    await p.close()
  }, 60000)

  it('attaches several files at once', async () => {
    const a = path.join(tmp, 'a.txt')
    const b = path.join(tmp, 'b.txt')
    await fs.writeFile(a, 'aa')
    await fs.writeFile(b, 'bbb')
    const p = await open('/upload')
    const input = await p.$('#file')
    await input!.setInputFiles([a, b])
    expect(await p.evaluate<string>(`document.getElementById('names').textContent`)).toBe('a.txt:2,b.txt:3')
    await p.close()
  }, 60000)

  it('refuses an element that is not a file input, and says what it got', async () => {
    const p = await open('/upload')
    const div = await p.$('#wrapper')
    await expect(div!.setInputFiles(path.join(tmp, 'a.txt'))).rejects.toThrow(/is a <div>, not a file input/)
    await p.close()
  }, 60000)

  it('refuses a path that does not exist', async () => {
    const p = await open('/upload')
    const input = await p.$('#file')
    await expect(input!.setInputFiles(path.join(tmp, 'nope.txt'))).rejects.toThrow(/no such file/)
    await p.close()
  }, 60000)
})

describe('network waits', () => {
  it('waits for a matching response and reads its body', async () => {
    const p = await open('/network')
    const [response] = await Promise.all([p.waitForResponse('/api/items'), p.click('#load')])
    expect(response.status).toBe(200)
    expect(response.headers['content-type']).toContain('application/json')
    expect(await response.json<{ count: number }>()).toEqual({ count: 42 })
    await p.close()
  }, 60000)

  it('waits for a matching request and reports its method', async () => {
    const p = await open('/network')
    const [request] = await Promise.all([p.waitForRequest((r) => r.url.includes('q=widgets')), p.click('#load')])
    expect(request.method).toBe('GET')
    expect(request.url).toContain('/api/items')
    await p.close()
  }, 60000)

  it('accepts a predicate over url and status', async () => {
    const p = await open('/network')
    const [response] = await Promise.all([
      p.waitForResponse((r) => r.status === 200 && r.url.endsWith('widgets')),
      p.click('#load'),
    ])
    expect(response.url).toContain('widgets')
    await p.close()
  }, 60000)

  it('accepts a glob, which used to hang until the timeout', async () => {
    const p = await open('/network')
    const [response] = await Promise.all([p.waitForResponse('**/api/*'), p.click('#load')])
    expect(response.url).toContain('/api/items')
    await p.close()
  }, 60000)

  it('accepts a regular expression', async () => {
    const p = await open('/network')
    const [response] = await Promise.all([p.waitForResponse(/\/api\/items\?q=/), p.click('#load')])
    expect(response.status).toBe(200)
    await p.close()
  }, 60000)

  it('names the responses it did see when nothing matches', async () => {
    const p = await open('/network')
    await expect(p.waitForResponse('/api/never', { timeout: 1200 })).rejects.toThrow(/timed out after 1200ms/)
    await p.close()
  }, 60000)
})

describe('network events', () => {
  it('reports requests and responses as they happen', async () => {
    const p = await open('/network')
    const requests: string[] = []
    const responses: Array<{ url: string; status: number }> = []
    p.on('request', (r) => requests.push(`${r.method} ${r.url}`))
    p.on('response', (r) => responses.push({ url: r.url, status: r.status }))
    await p.click('#load')
    await p.waitForTimeout(600)
    expect(requests.some((r) => r.includes('/api/items'))).toBe(true)
    expect(responses.some((r) => r.url.includes('/api/items') && r.status === 200)).toBe(true)
    await p.close()
  }, 60000)

  it('lets a handler read the response body, which is how a failure gets diagnosed', async () => {
    const p = await open('/network')
    let body = ''
    p.on('response', (r) => {
      if (r.url.includes('/api/items')) void r.text().then((text) => { body = text })
    })
    await p.click('#load')
    await p.waitForTimeout(800)
    expect(body).toContain('42')
    await p.close()
  }, 60000)

  it('reports a request that never completed', async () => {
    const p = await open('/network')
    const failures: string[] = []
    p.on('requestfailed', (r) => failures.push(r.errorText))
    await p.evaluate(`fetch('http://127.0.0.1:1/nope').catch(() => {})`)
    await p.waitForTimeout(900)
    expect(failures.length).toBeGreaterThan(0)
    await p.close()
  }, 60000)

  it('still refuses an event it does not deliver', async () => {
    const p = await open('/network')
    expect(() => p.on('websocket' as never, () => undefined)).toThrow(/not a supported event/)
    await p.close()
  }, 60000)
})

describe('downloads', () => {
  it('receives a download and can save it', async () => {
    const p = await open('/download')
    const [download] = await Promise.all([p.waitForDownload({ timeout: 15000 }), p.click('#get')])
    expect(download.suggestedFilename).toBe('report.csv')
    const saved = await download.saveAs(path.join(tmp, 'saved', 'report.csv'))
    expect(await fs.readFile(saved, 'utf8')).toContain('id,name')
    await p.close()
  }, 90000)

  it('says nothing started when no download happens', async () => {
    const p = await open('/download')
    await expect(p.waitForDownload({ timeout: 1200 })).rejects.toThrow(/no download started/)
    await p.close()
  }, 60000)
})

describe('drag and drop', () => {
  it('completes a native HTML5 drag, which mouse events alone cannot do', async () => {
    const p = await open('/drag5')
    const card = await p.$('#card')
    const zone = await p.$('#zone')
    await card!.dragTo(zone!)
    expect(await p.evaluate<string>(`document.getElementById('out').textContent`)).toBe('dropped card')
    await p.close()
  }, 60000)

  it('refuses to report success when the drop changed nothing', async () => {
    const p = await open('/inert-drag')
    const card = await p.$('#card')
    const zone = await p.$('#zone')
    await expect(card!.dragTo(zone!)).rejects.toThrow(/nothing on the page changed/)
    await p.close()
  }, 60000)

  it('drags one element onto another', async () => {
    const p = await open('/drag')
    const source = await p.$('#src')
    const target = await p.$('#dst')
    await source!.dragTo(target!)
    expect(await p.evaluate<string>(`document.getElementById('out').textContent`)).toBe('dropped')
    await p.close()
  }, 60000)
})
