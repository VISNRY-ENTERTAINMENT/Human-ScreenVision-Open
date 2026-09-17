import fs from 'fs/promises'
import path from 'path'
import zlib from 'zlib'
import sharp from 'sharp'
import type { Page } from '../core/Page'
import type { ActionResult, NetworkRecord, TraceEntry, TraceOptions } from '../core/types'

/** Screenshots are downscaled to this width; a trace is for reading, not for pixel diffing. */
const SHOT_WIDTH = 900
const SHOT_QUALITY = 45

/**
 * Records what happened during a run, so a failure can be understood after the fact.
 *
 * A CI failure is otherwise a stack trace with no context. This records the spine of a run —
 * every action, a screenshot, the DOM at that moment, the network, the console — and adds the
 * thing specific to this library: the verdict for each action. A conventional trace shows
 * that a click happened. This shows whether the application responded to it, which is usually
 * the actual question.
 *
 * The output is a single self-contained HTML file. Three things keep that from being
 * ruinously large: screenshots are downscaled and deduplicated, since consecutive steps on a
 * static page are usually the same image; DOM snapshots are stored once each and referenced;
 * and the whole payload is gzipped and inflated in the browser. Being one file that opens
 * anywhere is worth a lot when the artifact has to survive a CI system, and it should not
 * cost a lot to have.
 */
export class TraceRecorder {
  private entries: TraceEntry[] = []
  private shots: string[] = []
  private snapshots: string[] = []
  private network: NetworkRecord[] = []
  private consoleLines: string[] = []
  private started = 0
  private recording = false
  private listeners: Array<[string, (p: Record<string, unknown>) => void]> = []
  private inflight = new Map<string, { url: string; method: string; at: number }>()
  private options: Required<Pick<TraceOptions, 'screenshots' | 'snapshots' | 'title'>> = {
    screenshots: true,
    snapshots: true,
    title: 'ScreenVision trace',
  }

  /**
   * @param page - Page to record
   */
  constructor(private page: Page) {}

  /**
   * Begin recording.
   * @param options - What to capture and a title for the report
   */
  async start(options?: TraceOptions): Promise<void> {
    if (this.recording) return
    this.recording = true
    this.started = Date.now()
    this.entries = []
    this.shots = []
    this.snapshots = []
    this.network = []
    this.consoleLines = []
    this.options = {
      screenshots: options?.screenshots !== false,
      snapshots: options?.snapshots !== false,
      title: options?.title ?? 'ScreenVision trace',
    }
    this.subscribe()
    await this.step('start', `opened ${this.page.url()}`, null)
  }

  /** Whether a trace is currently being recorded. */
  get active(): boolean {
    return this.recording
  }

  /** Listen for the network and console traffic that gives a step its context. */
  private subscribe(): void {
    const session = this.page.mapperRef().cdpSession
    const on = (event: string, handler: (p: Record<string, unknown>) => void): void => {
      this.listeners.push([event, handler])
      session.on(event, handler)
    }

    on('Network.requestWillBeSent', (p) => {
      const request = p.request as { url?: string; method?: string } | undefined
      const id = p.requestId as string
      if (id && request?.url) {
        this.inflight.set(id, { url: request.url, method: request.method ?? 'GET', at: Date.now() })
      }
    })
    on('Network.responseReceived', (p) => {
      const id = p.requestId as string
      const response = p.response as { status?: number; mimeType?: string } | undefined
      const started = this.inflight.get(id)
      if (!started || this.network.length > 400) return
      this.inflight.delete(id)
      this.network.push({
        url: started.url,
        method: started.method,
        status: response?.status ?? 0,
        mimeType: response?.mimeType ?? '',
        ms: Date.now() - started.at,
        atMs: started.at - this.started,
      })
    })
    on('Network.loadingFailed', (p) => {
      const id = p.requestId as string
      const started = this.inflight.get(id)
      if (!started || this.network.length > 400) return
      this.inflight.delete(id)
      this.network.push({
        url: started.url,
        method: started.method,
        status: 0,
        mimeType: String(p.errorText ?? 'failed'),
        ms: Date.now() - started.at,
        atMs: started.at - this.started,
      })
    })
    on('Runtime.consoleAPICalled', (p) => {
      if (this.consoleLines.length > 200) return
      const args = (p.args as Array<{ value?: unknown; description?: string }>) ?? []
      const text = args.map((a) => String(a.value ?? a.description ?? '')).join(' ')
      if (text) this.consoleLines.push(`${String(p.type ?? 'log')}: ${text}`.slice(0, 300))
    })
    on('Runtime.exceptionThrown', (p) => {
      if (this.consoleLines.length > 200) return
      const details = p.exceptionDetails as { exception?: { description?: string }; text?: string } | undefined
      const text = details?.exception?.description ?? details?.text
      if (text) this.consoleLines.push(`exception: ${text.split('\n')[0]}`.slice(0, 300))
    })
  }

  /** Stop listening. */
  private unsubscribe(): void {
    const session = this.page.mapperRef().cdpSession
    for (const [event, handler] of this.listeners) session.off(event, handler)
    this.listeners = []
  }

  /**
   * Record one step.
   * @param kind - What kind of step this is
   * @param label - One line describing it
   * @param action - The action result, when this step was an action
   */
  async step(kind: TraceEntry['kind'], label: string, action: ActionResult | null): Promise<void> {
    if (!this.recording) return
    const shot = this.options.screenshots ? await this.captureShot() : -1
    const snapshot = this.options.snapshots ? await this.captureSnapshot() : -1
    const consoleSince = this.consoleLines.splice(0)

    this.entries.push({
      index: this.entries.length,
      atMs: Date.now() - this.started,
      kind,
      label,
      url: this.page.url(),
      verdict: action?.verdict,
      summary: action?.summary,
      evidence: {
        mutations: action?.effects.mutations.total ?? 0,
        requests: action?.effects.requests.slice(0, 8) ?? [],
        consoleErrors: action?.effects.consoleErrors.slice(0, 5) ?? consoleSince.slice(0, 5),
        urlChanged: action?.effects.urlChanged?.to ?? null,
        valueSet: action?.effects.valueSet ?? null,
        inert: action?.inert?.reason ?? null,
      },
      shotRef: shot,
      snapshotRef: snapshot,
    })
  }

  /**
   * Take a downscaled screenshot, reusing an identical earlier one.
   * @returns Index into the shot table, or -1 when unavailable
   */
  private async captureShot(): Promise<number> {
    const raw = await this.page.screenshot({ type: 'png' }).catch(() => null)
    if (!raw) return -1
    const jpeg = await sharp(raw)
      .resize({ width: SHOT_WIDTH, withoutEnlargement: true })
      .jpeg({ quality: SHOT_QUALITY })
      .toBuffer()
      .catch(() => null)
    if (!jpeg) return -1
    const encoded = jpeg.toString('base64')
    // consecutive steps on a page that did not visibly change produce the same image, and
    // storing it once is most of the reason a long trace stays a reasonable size
    const existing = this.shots.indexOf(encoded)
    if (existing >= 0) return existing
    this.shots.push(encoded)
    return this.shots.length - 1
  }

  /**
   * Capture the DOM as it stands, with stylesheets inlined so it renders on its own.
   * @returns Index into the snapshot table, or -1 when unavailable
   */
  private async captureSnapshot(): Promise<number> {
    const html = await this.page.evaluate<string>(SNAPSHOT_SOURCE).catch(() => '')
    if (!html) return -1
    const existing = this.snapshots.indexOf(html)
    if (existing >= 0) return existing
    this.snapshots.push(html)
    return this.snapshots.length - 1
  }

  /**
   * Stop recording and write the report.
   * @param filePath - Where to write the HTML file
   * @returns The path written
   */
  async stop(filePath: string): Promise<string> {
    if (!this.recording) throw new Error('TraceRecorder.stop: no trace is being recorded')
    await this.step('stop', 'trace stopped', null)
    this.recording = false
    this.unsubscribe()

    const payload = {
      title: this.options.title,
      entries: this.entries,
      shots: this.shots,
      snapshots: this.snapshots,
      network: this.network,
    }
    const packed = zlib.gzipSync(Buffer.from(JSON.stringify(payload), 'utf8'), { level: 9 }).toString('base64')

    const target = path.resolve(filePath)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, renderViewer(this.options.title, packed, this.entries.length), 'utf8')
    return target
  }

  /**
   * Stop recording and throw the recording away.
   *
   * Used when a trace was captured speculatively — because a job might fail — and the job
   * then passed, so the recording is not wanted.
   */
  discard(): void {
    if (!this.recording) return
    this.recording = false
    this.unsubscribe()
    this.entries = []
    this.shots = []
    this.snapshots = []
    this.network = []
  }

  /** The recorded entries, for programmatic use. */
  toJSON(): TraceEntry[] {
    return this.entries
  }

  /** The recorded network activity. */
  networkLog(): NetworkRecord[] {
    return [...this.network]
  }
}

/**
 * Serialise the document with its stylesheets inlined.
 *
 * Without the stylesheets a snapshot renders as unstyled text, which is not much use for
 * seeing what the user saw. Same-origin rules are read out of the CSSOM; cross-origin ones
 * cannot be read and are left as links, which is noted in the viewer.
 */
const SNAPSHOT_SOURCE = `(() => {
  try {
    const parts = []
    for (const sheet of Array.from(document.styleSheets)) {
      try {
        const rules = sheet.cssRules
        if (!rules) continue
        for (const rule of Array.from(rules)) parts.push(rule.cssText)
      } catch (e) {
        // cross-origin stylesheet: unreadable by design
      }
    }
    const clone = document.documentElement.cloneNode(true)
    for (const el of Array.from(clone.querySelectorAll('script'))) el.remove()
    // inputs carry their value as a property, not an attribute, so a naive clone loses it
    const live = document.querySelectorAll('input, textarea, select')
    const copies = clone.querySelectorAll('input, textarea, select')
    for (let i = 0; i < live.length && i < copies.length; i++) {
      const l = live[i], c = copies[i]
      if (l.type === 'checkbox' || l.type === 'radio') {
        if (l.checked) c.setAttribute('checked', '')
        else c.removeAttribute('checked')
      } else if (typeof l.value === 'string') {
        c.setAttribute('value', l.value)
      }
    }
    if (parts.length) {
      const style = document.createElement('style')
      style.textContent = parts.join('\\n')
      const head = clone.querySelector('head')
      if (head) head.appendChild(style)
    }
    return '<!doctype html>' + clone.outerHTML
  } catch (e) {
    return ''
  }
})()`

/**
 * Render the viewer: one HTML file that inflates its own payload and lets you step through.
 * @param title - Report title
 * @param packed - Gzipped, base64-encoded payload
 * @param stepCount - Number of steps, shown before the payload inflates
 * @returns HTML source
 */
function renderViewer(title: string, packed: string, stepCount: number): string {
  const escaped = title.replace(/</g, '&lt;').replace(/&/g, '&amp;')
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escaped}</title>
<style>
 :root { color-scheme: light dark; --bg:#fff; --fg:#111; --muted:#666; --line:#e2e2e2; --card:#fafafa; --accent:#2563eb; }
 @media (prefers-color-scheme: dark) {
   :root { --bg:#12141a; --fg:#e8e8ea; --muted:#9aa0aa; --line:#2a2e37; --card:#1a1d24; --accent:#60a5fa; }
 }
 * { box-sizing:border-box }
 body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.5 system-ui,sans-serif; }
 header { padding:14px 18px; border-bottom:1px solid var(--line); display:flex; gap:16px; align-items:baseline; flex-wrap:wrap }
 h1 { margin:0; font-size:16px }
 .sub { color:var(--muted); font-size:13px }
 .layout { display:grid; grid-template-columns:320px 1fr; height:calc(100vh - 52px) }
 @media (max-width:820px) { .layout { grid-template-columns:1fr; height:auto } }
 .steps { overflow-y:auto; border-right:1px solid var(--line) }
 .step { padding:10px 14px; border-bottom:1px solid var(--line); cursor:pointer; display:flex; gap:8px; align-items:baseline }
 .step:hover { background:var(--card) }
 .step[aria-current="true"] { background:var(--card); box-shadow:inset 3px 0 0 var(--accent) }
 .t { color:var(--muted); font-variant-numeric:tabular-nums; font-size:12px; min-width:46px }
 .badge { font-size:10px; text-transform:uppercase; letter-spacing:.04em; padding:1px 6px; border-radius:99px; border:1px solid var(--line); white-space:nowrap }
 .badge.confirmed { background:#dcfce7; color:#14532d; border-color:#86efac }
 .badge.no-effect, .badge.blocked { background:#ffedd5; color:#7c2d12; border-color:#fdba74 }
 .badge.unexpected { background:#fee2e2; color:#7f1d1d; border-color:#fca5a5 }
 .detail { overflow-y:auto; padding:16px 20px }
 .tabs { display:flex; gap:4px; margin:12px 0 }
 .tabs button { border:1px solid var(--line); background:var(--bg); color:var(--fg); padding:6px 12px; border-radius:6px; cursor:pointer }
 .tabs button[aria-selected="true"] { background:var(--accent); color:#fff; border-color:var(--accent) }
 .pane { display:none } .pane.on { display:block }
 img, iframe { max-width:100%; border:1px solid var(--line); border-radius:6px; background:#fff }
 iframe { width:100%; height:70vh }
 table { border-collapse:collapse; width:100%; font-size:13px }
 td, th { text-align:left; padding:5px 8px; border-bottom:1px solid var(--line); vertical-align:top }
 .bad { color:#b91c1c }
 code { font-family:ui-monospace,Menlo,Consolas,monospace; font-size:12px; word-break:break-all }
 ul.evidence { padding-left:18px; color:var(--muted) }
 .empty { color:var(--muted); font-style:italic }
</style></head>
<body>
<header><h1>${escaped}</h1><div class="sub" id="sub">${stepCount} steps · inflating…</div></header>
<div class="layout"><div class="steps" id="steps"></div><div class="detail" id="detail"></div></div>
<script id="payload" type="application/gzip-base64">${packed}</script>
<script>
(async () => {
  const raw = document.getElementById('payload').textContent.trim()
  const bytes = Uint8Array.from(atob(raw), (c) => c.charCodeAt(0))
  let json
  if ('DecompressionStream' in window) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))
    json = await new Response(stream).text()
  } else {
    document.getElementById('sub').textContent = 'this browser cannot inflate the payload'
    return
  }
  const data = JSON.parse(json)
  const esc = (s) => String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
  const failed = data.entries.filter((e) => e.verdict && e.verdict !== 'confirmed').length
  document.getElementById('sub').textContent =
    data.entries.length + ' steps · ' + failed + ' action' + (failed === 1 ? '' : 's') +
    ' that did not confirm · ' + data.network.length + ' requests'

  const stepsEl = document.getElementById('steps')
  stepsEl.innerHTML = data.entries.map((e) =>
    '<div class="step" role="button" tabindex="0" data-i="' + e.index + '">' +
    '<span class="t">' + (e.atMs / 1000).toFixed(2) + 's</span>' +
    '<span class="badge ' + (e.verdict || e.kind) + '">' + esc(e.verdict || e.kind) + '</span>' +
    '<span>' + esc(e.label) + '</span></div>').join('')

  let current = 0
  const detail = document.getElementById('detail')

  function requestsFor(e, prev) {
    const from = prev ? prev.atMs : 0
    return data.network.filter((n) => n.atMs >= from && n.atMs <= e.atMs)
  }

  function render(i) {
    current = i
    const e = data.entries[i]
    const prev = i > 0 ? data.entries[i - 1] : null
    for (const node of stepsEl.children) node.setAttribute('aria-current', String(Number(node.dataset.i) === i))
    const reqs = requestsFor(e, prev)
    const ev = []
    if (e.evidence.urlChanged) ev.push('navigated to <code>' + esc(e.evidence.urlChanged) + '</code>')
    if (e.evidence.mutations) ev.push(e.evidence.mutations + ' DOM mutation(s)')
    if (e.evidence.valueSet) ev.push('value ' + (e.evidence.valueSet.matched ? 'set to' : 'REJECTED, holds') +
      ' <code>' + esc(e.evidence.valueSet.actual) + '</code>')
    if (e.evidence.inert) ev.push('<span class="bad">inert: ' + esc(e.evidence.inert) + '</span>')
    for (const c of e.evidence.consoleErrors) ev.push('<span class="bad">console: ' + esc(c) + '</span>')

    detail.innerHTML =
      '<h2 style="margin:0;font-size:15px">' + esc(e.label) + '</h2>' +
      '<div class="sub"><code>' + esc(e.url) + '</code></div>' +
      (e.summary ? '<p>' + esc(e.summary) + '</p>' : '') +
      (ev.length ? '<ul class="evidence">' + ev.map((x) => '<li>' + x + '</li>').join('') + '</ul>' : '') +
      '<div class="tabs">' +
        '<button data-p="shot" aria-selected="true">Screenshot</button>' +
        '<button data-p="dom" aria-selected="false">DOM snapshot</button>' +
        '<button data-p="net" aria-selected="false">Network (' + reqs.length + ')</button>' +
      '</div>' +
      '<div class="pane on" id="p-shot">' +
        (e.shotRef >= 0 ? '<img alt="step ' + i + '" src="data:image/jpeg;base64,' + data.shots[e.shotRef] + '">'
                        : '<div class="empty">no screenshot recorded</div>') + '</div>' +
      '<div class="pane" id="p-dom">' +
        (e.snapshotRef >= 0 ? '<iframe sandbox="" title="DOM at step ' + i + '"></iframe>'
                            : '<div class="empty">no DOM snapshot recorded</div>') + '</div>' +
      '<div class="pane" id="p-net">' + (reqs.length
        ? '<table><tr><th>status</th><th>method</th><th>url</th><th>ms</th></tr>' +
          reqs.map((n) => '<tr><td class="' + (n.status >= 400 || n.status === 0 ? 'bad' : '') + '">' +
            (n.status || esc(n.mimeType)) + '</td><td>' + esc(n.method) + '</td><td><code>' + esc(n.url) +
            '</code></td><td>' + n.ms + '</td></tr>').join('') + '</table>'
        : '<div class="empty">no requests in this step</div>') + '</div>'

    if (e.snapshotRef >= 0) {
      // srcdoc in a sandboxed frame: the recorded page renders but cannot run or navigate
      detail.querySelector('#p-dom iframe').srcdoc = data.snapshots[e.snapshotRef]
    }
    for (const b of detail.querySelectorAll('.tabs button')) {
      b.onclick = () => {
        for (const other of detail.querySelectorAll('.tabs button')) other.setAttribute('aria-selected', String(other === b))
        for (const pane of detail.querySelectorAll('.pane')) pane.classList.toggle('on', pane.id === 'p-' + b.dataset.p)
      }
    }
  }

  stepsEl.onclick = (ev) => {
    const node = ev.target.closest('.step')
    if (node) render(Number(node.dataset.i))
  }
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowDown' || ev.key === 'j') { if (current < data.entries.length - 1) render(current + 1) }
    if (ev.key === 'ArrowUp' || ev.key === 'k') { if (current > 0) render(current - 1) }
  })
  render(0)
})()
</script>
</body></html>`
}
