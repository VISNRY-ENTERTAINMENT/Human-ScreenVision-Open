/**
 * Write captured frames as a real video file, with no encoder and no dependency.
 *
 * The first version of recording wrote an HTML page and justified it on the grounds that
 * encoding needs ffmpeg. That was a substitution dressed as a decision: the frames the
 * browser hands back are already JPEG, and AVI can carry JPEG frames directly as MJPEG. No
 * compression work is required — only a container — so the honest answer was always a real
 * `.avi` that VLC, mpv, QuickTime and Windows Media Player open.
 *
 * AVI is chosen over MP4 or WebM for one reason: its index is a flat list of chunk offsets,
 * so the whole file can be assembled in a single pass with no bit-level muxing. MP4 would
 * need a sample table and WebM a full EBML tree, both of which are real encoders' work.
 *
 * Layout written here (little-endian throughout):
 *
 *     RIFF 'AVI '
 *       LIST 'hdrl'
 *         'avih'            main header
 *         LIST 'strl'
 *           'strh'          stream header, vids/MJPG
 *           'strf'          BITMAPINFOHEADER
 *       LIST 'movi'
 *         '00dc' + frame    one per frame, padded to even length
 *       'idx1'              offset/length index
 */

/** Four-character code as bytes. */
function fourcc(tag: string): Buffer {
  return Buffer.from(tag.padEnd(4, ' ').slice(0, 4), 'ascii')
}

/** A little-endian 32-bit unsigned value. */
function u32(value: number): Buffer {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(value >>> 0, 0)
  return b
}

/** A little-endian 16-bit unsigned value. */
function u16(value: number): Buffer {
  const b = Buffer.alloc(2)
  b.writeUInt16LE(value & 0xffff, 0)
  return b
}

/**
 * Read a JPEG's pixel dimensions from its SOF marker.
 *
 * The AVI header has to state the frame size, and a wrong size makes players letterbox or
 * refuse the file. Reading it from the first frame avoids trusting a viewport figure that may
 * not match what the browser actually captured.
 * @param jpeg - A complete JPEG image
 * @returns Width and height, or null when no frame header is found
 */
export function jpegSize(jpeg: Buffer): { width: number; height: number } | null {
  let offset = 2 // skip SOI
  while (offset + 9 < jpeg.length) {
    if (jpeg[offset] !== 0xff) {
      offset += 1
      continue
    }
    const marker = jpeg[offset + 1]
    // SOF0..SOF15, excluding DHT (c4), JPG (c8) and DAC (cc), carry the frame dimensions
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: jpeg.readUInt16BE(offset + 5), width: jpeg.readUInt16BE(offset + 7) }
    }
    const length = jpeg.readUInt16BE(offset + 2)
    if (length < 2) return null
    offset += 2 + length
  }
  return null
}

/**
 * Build an MJPEG AVI from JPEG frames.
 *
 * @param frames - JPEG images, in order
 * @param fps - Playback rate to declare in the header
 * @returns The complete file
 * @throws Error when there are no frames, or the first is not a readable JPEG
 */
export function buildMjpegAvi(frames: Buffer[], fps: number): Buffer {
  if (frames.length === 0) {
    throw new Error(
      'recordVideo: no frames were captured, so there is no video to write. The screencast ' +
        'produces frames only while something changes on screen.'
    )
  }
  const size = jpegSize(frames[0])
  if (size === null) {
    throw new Error('recordVideo: the captured frames are not readable JPEG data')
  }
  const { width, height } = size
  const rate = Math.max(1, Math.round(fps))
  const microsecPerFrame = Math.round(1_000_000 / rate)

  // ── movi chunks, and the index entries that point at them ────────────────────
  const movi: Buffer[] = [fourcc('movi')]
  const index: Buffer[] = []
  let offset = 4 // 'movi' itself, offsets in idx1 are relative to it
  let largest = 0
  for (const frame of frames) {
    const padded = frame.length % 2 === 1 ? Buffer.concat([frame, Buffer.alloc(1)]) : frame
    movi.push(fourcc('00dc'), u32(frame.length), padded)
    index.push(
      fourcc('00dc'),
      u32(0x10), // AVIIF_KEYFRAME: every MJPEG frame stands alone
      u32(offset),
      u32(frame.length)
    )
    offset += 8 + padded.length
    largest = Math.max(largest, frame.length)
  }
  const moviBody = Buffer.concat(movi)
  const idx1 = Buffer.concat([fourcc('idx1'), u32(index.length * 4), ...index])

  // ── headers ──────────────────────────────────────────────────────────────────
  const avih = Buffer.concat([
    fourcc('avih'),
    u32(56),
    u32(microsecPerFrame),
    u32(Math.round((largest * rate) / 1)), // max bytes per second, approximate
    u32(0), // padding granularity
    u32(0x10), // AVIF_HASINDEX
    u32(frames.length),
    u32(0), // initial frames
    u32(1), // streams
    u32(largest),
    u32(width),
    u32(height),
    Buffer.alloc(16),
  ])

  const strh = Buffer.concat([
    fourcc('strh'),
    u32(56),
    fourcc('vids'),
    fourcc('MJPG'),
    u32(0), // flags
    u16(0), // priority
    u16(0), // language
    u32(0), // initial frames
    u32(1), // scale
    u32(rate), // rate: scale/rate = seconds per frame
    u32(0), // start
    u32(frames.length),
    u32(largest),
    u32(0xffffffff), // quality: default
    u32(0), // sample size: 0 = variable, which MJPEG is
    u16(0),
    u16(0),
    u16(width),
    u16(height),
  ])

  const strf = Buffer.concat([
    fourcc('strf'),
    u32(40),
    u32(40), // biSize
    u32(width),
    u32(height),
    u16(1), // planes
    u16(24), // bit count
    fourcc('MJPG'), // compression
    u32(width * height * 3), // image size
    u32(0),
    u32(0),
    u32(0),
    u32(0),
  ])

  const strl = Buffer.concat([
    fourcc('LIST'),
    u32(4 + strh.length + strf.length),
    fourcc('strl'),
    strh,
    strf,
  ])
  const hdrl = Buffer.concat([
    fourcc('LIST'),
    u32(4 + avih.length + strl.length),
    fourcc('hdrl'),
    avih,
    strl,
  ])
  const moviList = Buffer.concat([fourcc('LIST'), u32(moviBody.length), moviBody])

  const body = Buffer.concat([fourcc('AVI '), hdrl, moviList, idx1])
  return Buffer.concat([fourcc('RIFF'), u32(body.length), body])
}
