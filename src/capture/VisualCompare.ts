import fs from 'fs/promises'
import path from 'path'
import sharp from 'sharp'

/** How a screenshot comparison may be configured. */
export interface ScreenshotCompareOptions {
  /** Where baselines live. Default `__screenshots__` beside the working directory. */
  baselineDir?: string
  /**
   * Fraction of pixels allowed to differ, 0 to 1. Default 0.002, which tolerates antialiasing
   * without tolerating a moved button.
   */
  maxDiffRatio?: number
  /** How different two pixels must be to count, 0 to 255 per channel. Default 24. */
  threshold?: number
  /** Write the baseline and pass when it does not exist yet. Default true. */
  createMissing?: boolean
}

/** What a comparison found. */
export interface ScreenshotComparison {
  matched: boolean
  /** True when this run wrote the baseline rather than comparing against one. */
  created: boolean
  diffRatio: number
  diffPixels: number
  totalPixels: number
  baselinePath: string
  /** Written only on a mismatch: the actual image and a highlighted difference. */
  actualPath?: string
  diffPath?: string
  /** Set when the images cannot be compared at all. */
  sizeMismatch?: { baseline: string; actual: string }
}

/**
 * Compare a screenshot against a stored baseline.
 *
 * Visual comparison earns its keep on the things assertions cannot express: a layout that
 * collapses, a font that fails to load, a control that moves behind another. It is also the
 * assertion most likely to cry wolf, so the defaults matter. A small per-pixel threshold
 * absorbs antialiasing, and a small ratio allowance absorbs a few stray pixels, while a
 * genuinely moved element fails both.
 *
 * On a mismatch it writes the actual image and a diff with the changed pixels picked out in
 * red, because a bare "images differ" tells you nothing you can act on.
 *
 * @param actual - The freshly captured PNG
 * @param name - Baseline name, e.g. `'checkout-page'`
 * @param options - Baseline directory and tolerances
 * @returns What the comparison found
 */
export async function compareScreenshot(
  actual: Buffer,
  name: string,
  options?: ScreenshotCompareOptions
): Promise<ScreenshotComparison> {
  const dir = path.resolve(options?.baselineDir ?? '__screenshots__')
  const safe = name.replace(/[^a-z0-9._-]+/gi, '-')
  const baselinePath = path.join(dir, `${safe}.png`)
  const maxDiffRatio = options?.maxDiffRatio ?? 0.002
  const threshold = options?.threshold ?? 24

  await fs.mkdir(dir, { recursive: true })
  const existing = await fs.readFile(baselinePath).catch(() => null)

  if (existing === null) {
    if (options?.createMissing === false) {
      throw new Error(
        `no baseline for ${JSON.stringify(name)} at ${baselinePath}. ` +
          `Run once with createMissing, or commit a baseline.`
      )
    }
    await fs.writeFile(baselinePath, actual)
    return {
      matched: true,
      created: true,
      diffRatio: 0,
      diffPixels: 0,
      totalPixels: 0,
      baselinePath,
    }
  }

  const [baseImage, actualImage] = [sharp(existing), sharp(actual)]
  const [baseMeta, actualMeta] = await Promise.all([baseImage.metadata(), actualImage.metadata()])
  const size = `${baseMeta.width}x${baseMeta.height}`
  const actualSize = `${actualMeta.width}x${actualMeta.height}`

  if (size !== actualSize) {
    // Different dimensions cannot be compared pixel by pixel, and quietly resizing would hide
    // exactly the kind of layout change worth catching.
    const actualPath = path.join(dir, `${safe}.actual.png`)
    await fs.writeFile(actualPath, actual)
    return {
      matched: false,
      created: false,
      diffRatio: 1,
      diffPixels: 0,
      totalPixels: 0,
      baselinePath,
      actualPath,
      sizeMismatch: { baseline: size, actual: actualSize },
    }
  }

  const [baseRaw, actualRaw] = await Promise.all([
    baseImage.raw().toBuffer({ resolveWithObject: true }),
    actualImage.raw().toBuffer({ resolveWithObject: true }),
  ])
  const channels = baseRaw.info.channels
  const totalPixels = baseRaw.info.width * baseRaw.info.height
  const diff = Buffer.alloc(totalPixels * 3)
  let diffPixels = 0

  for (let pixel = 0; pixel < totalPixels; pixel++) {
    const offset = pixel * channels
    const dr = Math.abs(baseRaw.data[offset] - actualRaw.data[offset])
    const dg = Math.abs(baseRaw.data[offset + 1] - actualRaw.data[offset + 1])
    const db = Math.abs(baseRaw.data[offset + 2] - actualRaw.data[offset + 2])
    const changed = dr > threshold || dg > threshold || db > threshold
    const out = pixel * 3
    if (changed) {
      diffPixels++
      diff[out] = 255
      diff[out + 1] = 0
      diff[out + 2] = 0
    } else {
      // keep the unchanged picture faintly visible so the red marks have context
      const grey = Math.round((baseRaw.data[offset] + baseRaw.data[offset + 1] + baseRaw.data[offset + 2]) / 3)
      const faded = Math.round(255 - (255 - grey) * 0.25)
      diff[out] = faded
      diff[out + 1] = faded
      diff[out + 2] = faded
    }
  }

  const diffRatio = totalPixels === 0 ? 0 : diffPixels / totalPixels
  const matched = diffRatio <= maxDiffRatio
  const result: ScreenshotComparison = {
    matched,
    created: false,
    diffRatio,
    diffPixels,
    totalPixels,
    baselinePath,
  }

  if (!matched) {
    const actualPath = path.join(dir, `${safe}.actual.png`)
    const diffPath = path.join(dir, `${safe}.diff.png`)
    await fs.writeFile(actualPath, actual)
    await sharp(diff, { raw: { width: baseRaw.info.width, height: baseRaw.info.height, channels: 3 } })
      .png()
      .toFile(diffPath)
    result.actualPath = actualPath
    result.diffPath = diffPath
  }
  return result
}

/**
 * Turn a comparison into the sentence a caller should read.
 * @param name - Baseline name
 * @param comparison - What the comparison found
 * @returns The failure message
 */
export function describeComparison(name: string, comparison: ScreenshotComparison): string {
  if (comparison.sizeMismatch) {
    return (
      `screenshot ${JSON.stringify(name)} is a different size: the baseline is ` +
      `${comparison.sizeMismatch.baseline} and this run produced ${comparison.sizeMismatch.actual}. ` +
      `Saved to ${comparison.actualPath}.`
    )
  }
  return (
    `screenshot ${JSON.stringify(name)} differs from its baseline: ` +
    `${comparison.diffPixels} of ${comparison.totalPixels} pixels ` +
    `(${(comparison.diffRatio * 100).toFixed(2)}%). ` +
    `Baseline ${comparison.baselinePath}, actual ${comparison.actualPath}, difference ${comparison.diffPath}.`
  )
}
