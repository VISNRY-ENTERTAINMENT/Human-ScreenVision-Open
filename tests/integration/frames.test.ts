import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'http'
import screenvision from '../../src/index'
import type { Browser } from '../../src/core/Browser'

/**
 * Frames, same-origin and cross-origin.
 *
 * This was the one task Playwright passed and ScreenVision failed in the head-to-head. It
 * matters because the things worth automating are usually in a frame: a payment form, an
 * embedded editor, an OAuth consent screen. The cross-origin case is the real one, since a
 * checkout iframe is by definition another origin, and it needs an entirely different
 * mechanism from the same-origin case.
 */
const HOST_PORT = 9943
const OTHER_PORT = 9944

const CHILD = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<p id="inner">inside the frame</p>
<input id="card" aria-label="card number">
<button id="pay" onclick="document.getElementById('state').textContent='paid'">Pay</button>
<div id="state">unpaid</div>
<p class="row">one</p><p class="row">two</p>
</body></html>`

const HOST = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<h1 id="title">host page</h1>
<iframe id="same" name="sameframe" src="/child" width="400" height="220"></iframe>
<iframe id="cross" name="crossframe" src="http://localhost:${OTHER_PORT}/child" width="400" height="220"></iframe>
</body></html>`

let hostServer: http.Server
let otherServer: http.Server
let browser: Browser

beforeAll(async () => {
  hostServer = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end((req.url ?? '').includes('child') ? CHILD : HOST)
  })
  otherServer = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(CHILD)
  })
  await new Promise<void>((r) => hostServer.listen(HOST_PORT, r))
  await new Promise<void>((r) => otherServer.listen(OTHER_PORT, r))
  browser = await screenvision.launch({ headless: true })
}, 60000)

afterAll(async () => {
  if (browser) await browser.close()
  if (hostServer) hostServer.close()
  if (otherServer) otherServer.close()
})

async function open() {
  const ctx = await browser.newContext({ device: 'Desktop 1440x900' })
  const p = await ctx.newPage()
  await p.goto(`http://127.0.0.1:${HOST_PORT}/`)
  return p
}

describe('same-origin frames', () => {
  it('reads text inside the frame', async () => {
    const p = await open()
    const frame = await p.frame('#same')
    expect(await frame.textContent('#inner')).toBe('inside the frame')
    await p.close()
  }, 60000)

  it('fills and clicks inside the frame', async () => {
    const p = await open()
    const frame = await p.frame('#same')
    await frame.fill('#card', '4242')
    await frame.click('#pay')
    expect(await frame.textContent('#state')).toBe('paid')
    expect(await frame.evaluate<string>(`document.getElementById('card').value`)).toBe('4242')
    await p.close()
  }, 60000)

  it('finds a frame by name and by URL fragment', async () => {
    const p = await open()
    expect(await (await p.frame('sameframe')).textContent('#inner')).toBe('inside the frame')
    expect(await (await p.frame('/child')).textContent('#inner')).toBe('inside the frame')
    await p.close()
  }, 60000)

  it('queries all matching elements in the frame', async () => {
    const p = await open()
    const frame = await p.frame('#same')
    const rows = await frame.$$('.row')
    expect(rows).toHaveLength(2)
    expect(await rows[1].textContent()).toBe('two')
    await p.close()
  }, 60000)
})

describe('cross-origin frames', () => {
  it('reads text inside an out-of-process frame', async () => {
    const p = await open()
    const frame = await p.frame('#cross')
    expect(frame.isolated).toBe(true)
    expect(await frame.textContent('#inner')).toBe('inside the frame')
    await p.close()
  }, 60000)

  it('fills and clicks inside an out-of-process frame', async () => {
    const p = await open()
    const frame = await p.frame('#cross')
    await frame.fill('#card', '4242424242424242')
    await frame.click('#pay')
    expect(await frame.textContent('#state')).toBe('paid')
    await p.close()
  }, 60000)

  it('keeps the two frames separate', async () => {
    const p = await open()
    const same = await p.frame('#same')
    const cross = await p.frame('#cross')
    await same.fill('#card', 'aaa')
    expect(await cross.evaluate<string>(`document.getElementById('card').value`)).toBe('')
    expect(same.frameId).not.toBe(cross.frameId)
    await p.close()
  }, 60000)
})

describe('frame discovery', () => {
  it('lists the main frame and both children', async () => {
    const p = await open()
    const frames = await p.frames()
    expect(frames.length).toBeGreaterThanOrEqual(3)
    expect(frames[0].url).toContain(`:${HOST_PORT}/`)
    expect(frames.some((f) => f.isolated)).toBe(true)
    await p.close()
  }, 60000)

  it('names the frames that do exist when one is not found', async () => {
    const p = await open()
    await expect(p.frame('#nope', { timeout: 800 })).rejects.toThrow(/The page has these frames:/)
    await p.close()
  }, 60000)

  it('the main frame still answers ordinary queries', async () => {
    const p = await open()
    const main = await p.mainFrame()
    expect(await main.textContent('#title')).toBe('host page')
    await p.close()
  }, 60000)
})
