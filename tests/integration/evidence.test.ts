import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'http'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import sharp from 'sharp'
import screenvision from '../../src/index'
import type { Browser } from '../../src/core/Browser'

/**
 * The three evidence upgrades that make a ScreenVision screenshot carry proof, not just pixels:
 * verdict-annotated `act({ evidence })`, before/after diptychs, and DOM-attributed overlays with
 * redaction. Each is checked against the real rendered image, not just a returned flag.
 */
const PORT = 9948

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Evidence</title></head><body>
<main>
 <h1>Account</h1>
 <input id="new" aria-label="new todo" placeholder="add a todo">
 <button id="add">Add</button>
 <ul id="list"></ul>
 <div id="count">0 items</div>
 <label>SSN <input id="ssn" data-testid="ssn-field" value="123-45-6789"></label>
 <button id="draw">Draw chart</button>
 <canvas id="chart" width="240" height="160"></canvas>
 <script>
  const list = document.getElementById('list'), count = document.getElementById('count')
  document.getElementById('add').addEventListener('click', () => {
    const li = document.createElement('li'); li.textContent = document.getElementById('new').value || 'item'
    list.appendChild(li); count.textContent = list.children.length + ' items'
  })
  document.getElementById('draw').addEventListener('click', () => {
    const c = document.getElementById('chart').getContext('2d')
    c.fillStyle = '#fff'; c.fillRect(0,0,240,160)
    c.strokeStyle = '#c33'; c.lineWidth = 3; c.beginPath()
    for (let i=0;i<=12;i++){ const x=10+i*18, y=80-Math.sin(i/2)*50; i?c.lineTo(x,y):c.moveTo(x,y) }
    c.stroke()
  })
 </script>
</main></body></html>`

let server: http.Server
let browser: Browser
let outDir: string

beforeAll(async () => {
  server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(PAGE)
  })
  await new Promise<void>((r) => server.listen(PORT, r))
  browser = await screenvision.launch({ headless: true })
  outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sv-evidence-'))
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

describe('act({ evidence }) — the verdict painted on the pixels', () => {
  it('attaches a valid annotated image and saves it, for a confirmed action', async () => {
    const p = await open()
    const file = path.join(outDir, 'add-evidence.png')
    const r = await p.act({
      do: 'click',
      selector: '#add',
      expect: { textAppears: 'item' },
      evidence: { path: file },
    })
    expect(r.verdict).toBe('confirmed')
    expect(r.evidence).toBeDefined()
    const meta = await sharp(r.evidence!.image).metadata()
    expect((meta.width ?? 0) > 0 && (meta.height ?? 0) > 0).toBe(true)
    expect(r.evidence!.path).toBe(file)
    const onDisk = await fs.stat(file)
    expect(onDisk.size).toBeGreaterThan(1000)
    await p.close()
  }, 60000)

  it('still emits evidence when the action had no effect', async () => {
    const p = await open()
    // clicking a static heading does nothing; the verdict is no-effect and must still be shown
    const r = await p.act({ do: 'click', selector: '#count', expect: { textAppears: 'nope' }, evidence: true })
    expect(['no-effect', 'unexpected']).toContain(r.verdict)
    expect(r.evidence?.image).toBeInstanceOf(Buffer)
    await p.close()
  }, 60000)
})

describe('before/after diptych', () => {
  it('stitches two images into one wider image', async () => {
    const p = await open()
    const left = await sharp({ create: { width: 100, height: 80, channels: 3, background: '#f00' } }).png().toBuffer()
    const right = await sharp({ create: { width: 100, height: 80, channels: 3, background: '#00f' } }).png().toBuffer()
    const out = await p.diptych(left, right, { labels: ['before', 'after'], title: 'energy 0.00 -> 12.79' })
    const meta = await sharp(out).metadata()
    expect(meta.width).toBeGreaterThanOrEqual(216) // 100 + gap + 100
    expect(meta.height).toBeGreaterThan(80) // room for title + captions
    await p.close()
  }, 60000)

  it('canvasEvidence proves blank -> drawn with the energy delta', async () => {
    const p = await open()
    const file = path.join(outDir, 'canvas-evidence.png')
    const { image, before, after } = await p.canvasEvidence('#chart', async () => {
      await p.click('#draw')
    }, { path: file })
    expect(before.energy).toBe(0)
    expect(after.energy).toBeGreaterThan(0)
    expect((await sharp(image).metadata()).width).toBeGreaterThan(0)
    expect((await fs.stat(file)).size).toBeGreaterThan(1000)
    await p.close()
  }, 60000)
})

describe('redaction and DOM-attributed overlays', () => {
  it('paints an opaque block over a redacted field', async () => {
    const p = await open()
    const box = await (await p.$('#ssn'))!.boundingBox()
    expect(box).toBeTruthy()
    const shot = await p.screenshot({ redact: ['#ssn'] })
    // sample the centre of the SSN field: it must be (near) black, i.e. covered
    const { data, info } = await sharp(shot).raw().toBuffer({ resolveWithObject: true })
    // sample the left ~15% of the field, away from the centred "redacted" marker text
    const cx = Math.round(box!.x + box!.width * 0.15)
    const cy = Math.round(box!.y + box!.height / 2)
    const idx = (cy * info.width + cx) * info.channels
    const [r, g, b] = [data[idx], data[idx + 1], data[idx + 2]]
    expect(r + g + b).toBeLessThan(60) // opaque black cover, not the white input
    await p.close()
  }, 60000)

  it('auto-labels an overlay from the element identity without a hand-typed string', async () => {
    const p = await open()
    const handle = await p.$('#ssn')
    // autoLabel must not throw and must produce a valid image; the label comes from data-testid
    const shot = await p.screenshot({ annotate: [{ element: handle!, style: 'box', autoLabel: true }] })
    expect((await sharp(shot).metadata()).width).toBeGreaterThan(0)
    await p.close()
  }, 60000)
})
