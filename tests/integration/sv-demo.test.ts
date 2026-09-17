import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'http'
import fs from 'fs'
import path from 'path'
import screenvision from '../../src/index'
import { AnnotationEngine } from '../../src/capture/AnnotationEngine'
import { describeCanvas } from '../../src/capture/CanvasProbe'
import type { Browser } from '../../src/core/Browser'

// ── Output directory for screenshot artifacts ─────────────────────────────────
const OUT =
  'C:/Users/User/AppData/Local/Temp/claude/C--Users-User/f8dac763-94da-4d63-a739-57958eddf7d3/scratchpad/sv_demo'
const PORT = 9970

// ── A small but real single-file frontend: to-do app + canvas chart ───────────
const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SV Demo - Todos & Chart</title>
<style>
 :root { color-scheme: light; }
 * { box-sizing: border-box; }
 body { font: 15px/1.4 system-ui, Arial, sans-serif; margin: 0; background: #f5f6f8; color: #1c1e21; }
 header { background: #007AFF; color: #fff; padding: 18px 24px; }
 header h1 { margin: 0; font-size: 20px; }
 main { max-width: 720px; margin: 24px auto; padding: 0 16px; display: grid; gap: 24px; }
 .card { background: #fff; border: 1px solid #e3e5e8; border-radius: 10px; padding: 20px; }
 .row { display: flex; gap: 8px; }
 #todo-input { flex: 1; padding: 10px 12px; border: 1px solid #ccd0d5; border-radius: 8px; font-size: 15px; }
 button { cursor: pointer; border: none; border-radius: 8px; font-size: 14px; font-weight: 600; padding: 10px 16px; }
 #add-btn, #draw-btn { background: #007AFF; color: #fff; }
 #add-btn:hover, #draw-btn:hover { background: #0062cc; }
 ul#todo-list { list-style: none; margin: 16px 0 0; padding: 0; display: grid; gap: 8px; }
 li.todo { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border: 1px solid #edeff2; border-radius: 8px; }
 li.todo.done .label { text-decoration: line-through; color: #8a8d91; }
 li.todo .label { flex: 1; }
 .delete { background: #ffe5e5; color: #d70015; padding: 6px 10px; }
 #counter { margin-top: 14px; font-weight: 700; color: #007AFF; }
 canvas { border: 1px solid #e3e5e8; border-radius: 8px; background: #fff; display: block; margin-top: 12px; }
 h2 { font-size: 16px; margin: 0 0 4px; }
</style></head><body>
<header><h1>ScreenVision Demo</h1></header>
<main>
 <section class="card">
  <h2>To-do list</h2>
  <div class="row">
   <input id="todo-input" placeholder="What needs doing?" aria-label="New todo">
   <button id="add-btn">Add</button>
  </div>
  <ul id="todo-list"></ul>
  <div id="counter">0 items / 0 done</div>
 </section>
 <section class="card">
  <h2>Weekly chart</h2>
  <button id="draw-btn">Draw chart</button>
  <canvas id="chart" width="400" height="220"></canvas>
 </section>
</main>
<script>
 const listEl = document.getElementById('todo-list')
 const inputEl = document.getElementById('todo-input')
 const counterEl = document.getElementById('counter')

 function render() {
   const items = [...listEl.querySelectorAll('li.todo')]
   const done = items.filter(li => li.classList.contains('done')).length
   counterEl.textContent = items.length + ' items / ' + done + ' done'
 }
 function addTodo(text) {
   if (!text.trim()) return
   const li = document.createElement('li')
   li.className = 'todo'
   const cb = document.createElement('input')
   cb.type = 'checkbox'; cb.className = 'done-box'
   cb.addEventListener('change', () => { li.classList.toggle('done', cb.checked); render() })
   const span = document.createElement('span')
   span.className = 'label'; span.textContent = text
   const del = document.createElement('button')
   del.className = 'delete'; del.textContent = 'Delete'
   del.addEventListener('click', () => { li.remove(); render() })
   li.append(cb, span, del)
   listEl.appendChild(li)
   render()
 }
 document.getElementById('add-btn').addEventListener('click', () => { addTodo(inputEl.value); inputEl.value = ''; inputEl.focus() })
 inputEl.addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('add-btn').click() })

 // canvas chart: blank until the button is pressed
 document.getElementById('draw-btn').addEventListener('click', () => {
   const ctx = document.getElementById('chart').getContext('2d')
   ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 400, 220)
   // axes
   ctx.strokeStyle = '#333'; ctx.lineWidth = 2
   ctx.beginPath(); ctx.moveTo(40, 10); ctx.lineTo(40, 190); ctx.lineTo(390, 190); ctx.stroke()
   // bars
   const data = [40, 90, 60, 130, 80, 150, 110]
   const bw = 40
   data.forEach((v, i) => {
     const x = 55 + i * 48, y = 190 - v
     ctx.fillStyle = '#007AFF'
     ctx.fillRect(x, y, bw, v)
   })
   // trend line
   ctx.strokeStyle = '#d70015'; ctx.lineWidth = 3; ctx.beginPath()
   data.forEach((v, i) => { const x = 55 + i * 48 + bw / 2, y = 190 - v; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y) })
   ctx.stroke()
 })
</script>
</body></html>`

let server: http.Server
let browser: Browser

beforeAll(async () => {
  fs.mkdirSync(OUT, { recursive: true })
  server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(PAGE)
  })
  await new Promise<void>((r) => server.listen(PORT, r))
  browser = await screenvision.launch({ headless: true })
}, 60000)

afterAll(async () => {
  if (browser) await browser.close()
  if (server) server.close()
})

const p = (f: string) => path.join(OUT, f)

describe('ScreenVision drives a real frontend and proves the actions worked', () => {
  it('adds todos, toggles, deletes, draws a chart, and produces evidence screenshots', async () => {
    const ctx = await browser.newContext({ device: 'Desktop 1440x900' })
    const page = await ctx.newPage()
    await page.goto(`http://127.0.0.1:${PORT}/`)

    // ── Step 1: initial state ────────────────────────────────────────────────
    await page.screenshot({ path: p('01-initial.png') })
    expect(await page.locator('#counter').textContent()).toBe('0 items / 0 done')
    const before = await page.evaluate<number>(`document.querySelectorAll('#todo-list li').length`)
    expect(before).toBe(0)

    // ── Step 2: add three todos (fill + click), read the list back ───────────
    for (const t of ['Buy milk', 'Write report', 'Call dentist']) {
      await page.fill('#todo-input', t)
      await page.click('#add-btn')
    }
    await page.screenshot({ path: p('02-after-add-todos.png') })
    const afterAdd = await page.evaluate<number>(`document.querySelectorAll('#todo-list li').length`)
    expect(afterAdd).toBe(3)
    expect(await page.locator('#counter').textContent()).toBe('3 items / 0 done')
    // prove the text we typed actually landed in the DOM
    expect(await page.locator('#todo-list li:nth-child(2) .label').textContent()).toBe('Write report')

    // ── Step 3: tick one done → counter updates ──────────────────────────────
    await page.check('#todo-list li:first-child .done-box')
    expect(await page.locator('#counter').textContent()).toBe('3 items / 1 done')
    await page.screenshot({ path: p('03-after-check-done.png') })

    // ── Step 4: delete one → counter shrinks ─────────────────────────────────
    await page.click('#todo-list li:last-child .delete')
    const afterDel = await page.evaluate<number>(`document.querySelectorAll('#todo-list li').length`)
    expect(afterDel).toBe(2)
    expect(await page.locator('#counter').textContent()).toBe('2 items / 1 done')
    await page.screenshot({ path: p('04-after-delete.png') })

    // ── Step 5: canvas blank → drawn, proven via canvasContent ───────────────
    const blank = await page.canvasContent('#chart')
    expect(blank.readable).toBe(true)
    expect(blank.energy).toBe(0) // nothing drawn yet
    const blankDesc = describeCanvas('#chart', blank, 0.5)

    await page.click('#draw-btn')
    const drawn = await page.canvasContent('#chart')
    expect(drawn.energy).toBeGreaterThan(0.5) // real structure now
    expect(drawn.inkCoverage).toBeGreaterThan(0)
    const drawnDesc = describeCanvas('#chart', drawn, 0.5)
    await page.screenshot({ path: p('05-after-draw-chart.png') })

    // ── Step 6: EVIDENCE screenshots ─────────────────────────────────────────
    // 6a. Annotate the acted-on element (the counter) with a verified verdict,
    //     using its real boundingBox() and the annotate option on screenshot().
    const counter = await page.locator('#counter').elementHandle()
    const counterBox = (await counter!.boundingBox())!
    const addBtn = await page.locator('#add-btn').elementHandle()
    const addBox = (await addBtn!.boundingBox())!
    const listBox = (await (await page.locator('#todo-list').elementHandle())!.boundingBox())!

    await page.screenshot({
      path: p('06-evidence-annotated.png'),
      annotate: [
        { bbox: addBox, style: 'circle', color: '#FF3B30', label: 'click Add x3' },
        { bbox: listBox, style: 'box', color: '#34C759', label: 'list grew 0 -> 3 -> 2 (1 done, 1 deleted): PASS' },
        { bbox: counterBox, style: 'highlight', color: '#FFD60A', label: 'counter reads "2 items / 1 done": VERIFIED' },
      ],
    })

    // 6b. Canvas before/after evidence: annotate the chart region with the
    //     canvasContent verdict that the DOM alone could never produce.
    const chartBox = (await (await page.locator('#chart').elementHandle())!.boundingBox())!
    const engine = new AnnotationEngine()
    const raw = await page.screenshot() // current viewport (chart drawn)
    const annotated = await engine.annotate(raw, [
      {
        bbox: chartBox,
        style: 'box',
        color: '#007AFF',
        label: `canvasContent: blank(energy=${blank.energy.toFixed(2)}) -> drawn(energy=${drawn.energy.toFixed(2)}): PASS`,
      },
    ])
    fs.writeFileSync(p('07-canvas-evidence-annotated.png'), annotated)

    // stash the human-readable canvas verdicts for the report
    fs.writeFileSync(
      p('canvas-verdicts.txt'),
      `BEFORE: ${blankDesc}\nAFTER:  ${drawnDesc}\n`
    )

    await ctx.close()
  }, 120000)
})
