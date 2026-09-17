/**
 * What is inside a `<canvas>`, when the DOM cannot say.
 *
 * Everywhere else in this library the rule is that structure beats pixels: the DOM gives an
 * answer attributable to a node, and reaching for an image measure would be a regression
 * toward the screenshot-and-guess approach the whole design inverts. Canvas, WebGL and video
 * are the exception, and the only one — to `observe()` and `ariaSnapshot()` a charting
 * library, a map or a floor-plan editor is **one element with no children**.
 *
 * The question worth answering first is not similarity, it is the dumb one the DOM cannot
 * answer: *did this actually render?* A chart that silently failed to draw is a blank canvas
 * with a healthy DOM node, correct dimensions and no console error — and today the page reads
 * as fine. That is a silent wrong answer, which is the failure class this library exists to
 * eliminate, and no amount of accessibility-tree work can reach it.
 *
 * The measure is gradient energy: the mean absolute difference between neighbouring pixels.
 * Deterministic arithmetic, no model in the loop — which is what makes it admissible at all,
 * and why a predicted depth map or a learned "does this look right" scorer is not. It also
 * answers a second question cheaply: *where* the content is, so "the axes drew but no series
 * did" is distinguishable from "nothing drew".
 */

/** What a canvas turned out to contain. */
export interface CanvasContent {
  /** Whether the element was found and could be read at all. */
  readable: boolean
  width: number
  height: number
  /**
   * Mean absolute neighbour difference, 0–255. Zero means every pixel is identical to its
   * neighbours: a uniform fill, which is what "never drew" looks like.
   */
  energy: number
  /** Fraction of pixels differing from the canvas's most common colour, 0–1. */
  inkCoverage: number
  /** Which thirds of the canvas hold ink, row-major, for "axes but no series". */
  quadrants: Array<{ region: string; energy: number }>
  /** Set when the canvas could not be read, saying why. */
  reason?: string
  /** How the pixels were obtained: '2d' (direct, reliable), 'drawImage' (composited copy). */
  source?: '2d' | 'drawImage'
  /** The element kind actually measured: 'canvas' | 'video' | 'img'. */
  kind?: 'canvas' | 'video' | 'img'
  /**
   * True only for a WebGL/WebGPU canvas read by copying, where a zero result is ambiguous: the
   * context may have been created without `preserveDrawingBuffer`, so the compositor can clear
   * the buffer before the copy. A blank reading here means "blank OR unreadable", never a
   * confident "blank" -- collapsing the two would be the silent wrong answer this library bans.
   */
  bufferMayBeCleared?: boolean
}

/**
 * In-page source measuring one opaque visual element: a canvas, a `<video>` frame, or an
 * `<img>`.
 *
 * All three are single elements the DOM sees as one box, so the same pixel measure applies.
 * A 2D canvas is read directly through `getImageData` (reliable, a zero is a confident zero).
 * A WebGL canvas, a video or an image is copied onto a scratch 2D canvas with `drawImage` and
 * read from there, which captures the composited result the DOM cannot describe. The WebGL
 * copy is best-effort and says so: without `preserveDrawingBuffer` the buffer may be cleared
 * before the copy, so a blank WebGL reading is flagged `bufferMayBeCleared` and never asserted
 * as a confident blank. Cross-origin taint makes `getImageData` throw; that is reported rather
 * than swallowed, because "cannot read" and "read it and it was blank" are different facts.
 * @param selector - CSS selector for the canvas, video or image
 * @param sampleStep - Read every Nth pixel; 1 reads all of them
 * @returns JavaScript source producing a JSON string
 */
export function canvasProbeSource(selector: string, sampleStep = 2): string {
  return `(() => {
  const fail = (extra) => JSON.stringify(Object.assign({ readable: false, width: 0, height: 0, energy: 0, inkCoverage: 0, quadrants: [] }, extra))
  const el = document.querySelector(${JSON.stringify(selector)})
  if (!el) return fail({ reason: 'no element matches ' + ${JSON.stringify(selector)} })

  // Canvas is the original target, but the same blind spot covers every element the DOM sees as
  // one opaque box: a WebGL canvas, a <video> frame, an <img>. All are read the same honest way.
  const tag = el.tagName
  let kind, natW, natH, drawable = true
  if (tag === 'CANVAS') { kind = 'canvas'; natW = el.width; natH = el.height }
  else if (tag === 'VIDEO') { kind = 'video'; natW = el.videoWidth; natH = el.videoHeight }
  else if (tag === 'IMG') { kind = 'img'; natW = el.naturalWidth; natH = el.naturalHeight }
  else return fail({ reason: tag.toLowerCase() + ' is not a canvas, video or image' })

  const w = natW, h = natH
  if (!w || !h) return fail({ width: w, height: h, kind, reason: kind === 'video' ? 'the video has no frame yet (' + w + 'x' + h + '); it may not have loaded or played' : (kind === 'img' ? 'the image has not loaded (' + w + 'x' + h + ')' : 'the canvas has no drawing surface (' + w + 'x' + h + ')') })

  // A 2D canvas is read directly -- reliable, and a zero is a confident zero. Everything else
  // (WebGL, video, img) is copied onto a scratch 2D canvas via drawImage, which captures the
  // COMPOSITED result. For WebGL that copy is best-effort: without preserveDrawingBuffer the
  // buffer may already be cleared, so a zero there is ambiguous and flagged, never asserted.
  let data, source = '2d', bufferMayBeCleared = false
  try {
    if (kind === 'canvas') {
      const twod = el.getContext('2d')
      if (twod) {
        data = twod.getImageData(0, 0, w, h).data
      } else {
        source = 'drawImage'; bufferMayBeCleared = true
        const scratch = document.createElement('canvas'); scratch.width = w; scratch.height = h
        const sctx = scratch.getContext('2d')
        sctx.drawImage(el, 0, 0, w, h)
        data = sctx.getImageData(0, 0, w, h).data
      }
    } else {
      source = 'drawImage'
      const scratch = document.createElement('canvas'); scratch.width = w; scratch.height = h
      const sctx = scratch.getContext('2d')
      sctx.drawImage(el, 0, 0, w, h)
      data = sctx.getImageData(0, 0, w, h).data
    }
  } catch (e) {
    // cross-origin taint (canvas or media) throws on getImageData; report it, do not guess
    return fail({ width: w, height: h, kind, source, reason: 'pixels are not readable: ' + (e && e.name ? e.name : 'error') })
  }

  const step = ${sampleStep}
  const lum = (i) => (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000
  const at = (x, y) => lum((y * w + x) * 4)

  let sum = 0, n = 0
  const counts = new Map()
  // three-by-three regions, so "the axes drew and the series did not" is visible
  const regions = []
  for (let ry = 0; ry < 3; ry++) for (let rx = 0; rx < 3; rx++) regions.push({ sum: 0, n: 0 })

  for (let y = 0; y < h - step; y += step) {
    for (let x = 0; x < w - step; x += step) {
      const here = at(x, y)
      const d = Math.abs(here - at(x + step, y)) + Math.abs(here - at(x, y + step))
      sum += d
      n++
      const r = Math.min(2, Math.floor((y / h) * 3)) * 3 + Math.min(2, Math.floor((x / w) * 3))
      regions[r].sum += d
      regions[r].n++
      const key = Math.round(here / 8)
      counts.set(key, (counts.get(key) || 0) + 1)
    }
  }

  let commonest = 0
  for (const c of counts.values()) if (c > commonest) commonest = c
  const names = ['top-left','top-centre','top-right','middle-left','centre','middle-right','bottom-left','bottom-centre','bottom-right']
  return JSON.stringify({
    readable: true,
    width: w,
    height: h,
    energy: n ? sum / n : 0,
    inkCoverage: n ? 1 - commonest / n : 0,
    quadrants: regions.map((r, i) => ({ region: names[i], energy: r.n ? r.sum / r.n : 0 })),
    source,
    kind,
    bufferMayBeCleared
  })
})()`
}

/**
 * Describe what a canvas contains, in one line an agent can act on.
 *
 * The wording matters as much as the number. "visual delta 0.07" is an unearned number wearing
 * a decimal point; "the canvas at #sales-chart is blank" names the element and the fact.
 * @param selector - The canvas that was measured
 * @param c - The measurement
 * @param blankBelow - Energy at or below which the canvas counts as blank
 * @returns A sentence
 */
export function describeCanvas(selector: string, c: CanvasContent, blankBelow: number): string {
  const what = c.kind && c.kind !== 'canvas' ? c.kind : 'canvas'
  if (!c.readable) return `the ${what} at ${selector} could not be measured: ${c.reason}`
  if (c.energy <= blankBelow) {
    // A WebGL/copied read that comes back blank is genuinely ambiguous: it may have drawn and
    // had its buffer cleared before the copy. Say so, rather than assert a blank it cannot prove.
    if (c.bufferMayBeCleared) {
      return (
        `the ${what} at ${selector} read as blank (gradient energy ${c.energy.toFixed(3)}), but this ` +
        `is a WebGL surface copied via drawImage — a cleared drawing buffer reads identically, so ` +
        `this is "blank or unreadable", not a confirmed blank. Re-check with preserveDrawingBuffer to be sure`
      )
    }
    return (
      `the ${what} at ${selector} is blank (gradient energy ${c.energy.toFixed(3)}, ` +
      `expected above ${blankBelow}) — its ${c.width}x${c.height} surface exists but nothing was drawn on it`
    )
  }
  const lit = c.quadrants.filter((q) => q.energy > blankBelow).map((q) => q.region)
  return (
    `the ${what} at ${selector} has content (gradient energy ${c.energy.toFixed(3)}, ` +
    `ink coverage ${(c.inkCoverage * 100).toFixed(1)}%) in ${lit.length} of 9 regions: ${lit.join(', ')}`
  )
}
