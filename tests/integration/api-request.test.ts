import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import http from 'http'
import screenvision from '../../src/index'
import type { Browser } from '../../src/core/Browser'

/**
 * Calling the API outside the browser, sharing the browser's cookies.
 *
 * Two things need this. Setting a test up through the API is far faster and less brittle than
 * driving the interface to do it, and only works if the session it establishes carries into
 * the pages that follow. And confirming an effect the interface never shows — did the click
 * really create the record — means asking the server directly.
 */
const PORT = 9968

let sessions = new Set<string>()
let records: string[] = []

let server: http.Server
let browser: Browser

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`)
    const cookie = req.headers.cookie ?? ''
    const token = /session=([^;]+)/.exec(cookie)?.[1]
    const signedIn = token !== undefined && sessions.has(token)

    if (url.pathname === '/api/login' && req.method === 'POST') {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        const parsed = JSON.parse(body || '{}') as { user?: string }
        if (parsed.user !== 'dana') {
          res.writeHead(401, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: 'unknown user' }))
          return
        }
        sessions.add('tok-1')
        res.writeHead(200, {
          'content-type': 'application/json',
          'set-cookie': 'session=tok-1; Path=/',
        })
        res.end(JSON.stringify({ ok: true }))
      })
      return
    }

    if (url.pathname === '/api/records') {
      if (req.method === 'POST') {
        let body = ''
        req.on('data', (c) => (body += c))
        req.on('end', () => {
          records.push(JSON.parse(body || '{}').title ?? '')
          res.writeHead(201, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ created: true }))
        })
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ records }))
      return
    }

    if (url.pathname === '/api/echo') {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end(url.searchParams.get('q') ?? '')
      return
    }

    if (url.pathname === '/api/broken') {
      res.writeHead(500, { 'content-type': 'text/html' })
      res.end('<h1>server on fire</h1>')
      return
    }

    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(`<!doctype html><html><head><meta charset="utf-8"><title>App</title></head><body>
<main><div id="who">${signedIn ? 'signed in as dana' : 'signed out'}</div></main></body></html>`)
  })
  await new Promise<void>((r) => server.listen(PORT, r))
  browser = await screenvision.launch({ headless: true })
}, 60000)

afterAll(async () => {
  if (browser) await browser.close()
  if (server) server.close()
})

const base = () => `http://127.0.0.1:${PORT}`

describe('making calls', () => {
  it('sends JSON and reads JSON back', async () => {
    const ctx = await browser.newContext({ device: 'Desktop 1440x900' })
    const response = await ctx.request.post(`${base()}/api/login`, { data: { user: 'dana' } })
    expect(response.status).toBe(200)
    expect(response.ok).toBe(true)
    expect(await response.json<{ ok: boolean }>()).toEqual({ ok: true })
    await ctx.close()
  }, 60000)

  it('sends query parameters', async () => {
    const ctx = await browser.newContext({ device: 'Desktop 1440x900' })
    const response = await ctx.request.get(`${base()}/api/echo`, { params: { q: 'widgets' } })
    expect(await response.text()).toBe('widgets')
    await ctx.close()
  }, 60000)

  it('reports a failure status without throwing', async () => {
    const ctx = await browser.newContext({ device: 'Desktop 1440x900' })
    const response = await ctx.request.get(`${base()}/api/broken`)
    expect(response.status).toBe(500)
    expect(response.ok).toBe(false)
    await ctx.close()
  }, 60000)

  it('explains a body that is not JSON rather than throwing a parse error', async () => {
    const ctx = await browser.newContext({ device: 'Desktop 1440x900' })
    const response = await ctx.request.get(`${base()}/api/broken`)
    await expect(response.json()).rejects.toThrow(/not JSON: <h1>server on fire/)
    await ctx.close()
  }, 60000)
})

describe('the session carries into the browser', () => {
  it('signs in through the API, and the page is already signed in', async () => {
    sessions = new Set()
    const ctx = await browser.newContext({ device: 'Desktop 1440x900' })
    await ctx.request.post(`${base()}/api/login`, { data: { user: 'dana' } })

    const page = await ctx.newPage()
    await page.goto(base())
    // the whole point: no sign-in form was ever driven
    expect(await page.evaluate<string>(`document.getElementById('who').textContent`)).toBe('signed in as dana')
    await ctx.close()
  }, 60000)

  it('does not leak the session into another context', async () => {
    sessions = new Set()
    const a = await browser.newContext({ device: 'Desktop 1440x900' })
    await a.request.post(`${base()}/api/login`, { data: { user: 'dana' } })
    const b = await browser.newContext({ device: 'Desktop 1440x900' })
    const page = await b.newPage()
    await page.goto(base())
    expect(await page.evaluate<string>(`document.getElementById('who').textContent`)).toBe('signed out')
    await a.close()
    await b.close()
  }, 60000)
})

describe('checking an effect the interface does not show', () => {
  it('confirms through the API that a record was really created', async () => {
    records = []
    const ctx = await browser.newContext({ device: 'Desktop 1440x900' })
    await ctx.request.post(`${base()}/api/records`, { data: { title: 'from the test' } })
    const after = await ctx.request.get(`${base()}/api/records`)
    expect((await after.json<{ records: string[] }>()).records).toContain('from the test')
    await ctx.close()
  }, 60000)
})
