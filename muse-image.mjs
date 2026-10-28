/**
 * muse-image.mjs — transparent images flattened onto a plain background before they go to Muse.
 *
 * Muse's image viewer draws a transparent pixel as BLACK, so a figure with dark strokes on a transparent background
 * (PNG with an alpha channel or a palette + tRNS, GIF with a transparent colour, WebP with alpha — common for exam
 * diagrams and for images pasted into chat) reaches the model as a black square. Measured 28/10/2026 on question images:
 * the model wrote "image is black / unreadable" in 13/18 runs; the same images composited on white, 0/6. So a PNG, GIF or
 * still WebP that has transparent pixels is composited onto white (black only when the visible content is light AND
 * almost none of it is dark, so white-on-transparent art does not vanish) and re-encoded as an opaque PNG. Anything else
 * — JPEG, SVG, PDF, video, an opaque or animated image, a file that does not decode, an image over MAX_PIXELS — passes
 * through byte for byte. No native module: pngjs and omggif are plain JS, the WebP decoder is libwebp compiled to
 * WebAssembly (@jsquash/webp), set up once at import.
 *
 * Guards: a GIF's first frame may claim more than the logical screen (omggif then wraps its rows, and a 43-byte GIF
 * claiming a 60000×60000 frame kept the event loop busy for over a minute) — the screen grows to hold the frame, as
 * PIL and browsers do, and MAX_PIXELS applies to that; an interlaced PNG is inflated first under the size its IHDR
 * implies (pngjs caps only the non-interlaced path: a 2 MB file claiming 64×64 took 4.2 GB); an image over MAX_ROWS rows
 * passes through (pngjs spends ~0.6 µs and ~125 B per row on top of the pixels: an 85 KB PNG of 1×4 000 000 took 2.3 s
 * and 760 MB, a 767 KB one of 1×36 000 000 25 s and 4.5 GB — both under MAX_PIXELS); a PNG with more than one IHDR
 * passes through (pngjs keeps the last, the guards read the first); a GIF whose LZW codes would send omggif's decoder
 * round a loop forever passes through (gifCodesOk); omggif's console.log warnings are silenced (stdout is the MCP stdio
 * channel of muse-server.mjs).
 */
import fs from 'node:fs'
import { createRequire } from 'node:module'
import zlib from 'node:zlib'
import { PNG } from 'pngjs'
import omggif from 'omggif'

const { GifReader } = omggif
const MAX_PIXELS = 40e6
const MAX_ROWS = 32768 // real question images: 2430 rows at most (2881 PNG / GIF)
// WebAssembly memory grows to the largest image decoded and never shrinks back: a lower cap for WebP (109 real question
// WebP: 4.2 MP at most)
const WEBP_MAX_PIXELS = 16e6

// libwebp's still-image decoder (WebPDecodeRGBA), synchronous once set up. If it cannot load, WebP passes through as it is.
let webpDecoder = null
try {
  const require = createRequire(import.meta.url)
  const { default: factory } = await import('@jsquash/webp/codec/dec/webp_dec.js')
  const wasm = await WebAssembly.compile(fs.readFileSync(require.resolve('@jsquash/webp/codec/dec/webp_dec.wasm')))
  webpDecoder = await factory({
    noInitialRun: true,
    instantiateWasm: (imports, done) => { const inst = new WebAssembly.Instance(wasm, imports); done(inst); return inst.exports },
  })
} catch (e) {
  console.error(`[muse-image] no WebP decoder, transparent WebP goes to Muse as it is: ${e?.message || e}`)
}
// alpha-weighted mean luminance (0–255) of the visible pixels above which the content is "light" → black background…
export const LIGHT_CONTENT = 160
// …unless more than DARK_MAX of the visible pixels (alpha ≥ 128) are darker than DARK_LUM. Exam figures are drawn for a
// white page: on 2881 real PNG / GIF question images the mean alone picked black for 9 images that are ≥ 19 % transparent,
// and 8 of them lost axis labels, legends or a formula drawn in black next to a light box / photo / shaded bar (their
// dark share: 2–26 %); white kept all 9 readable. The share of all visible pixels shrinks as the light area grows (a pale
// chart panel with its axis titles on the transparent margin: 0.4 %), so the same DARK_MAX also applies to the visible
// pixels that touch transparency — the only ones the background shows next to (those 8 images: 38–94 % dark).
export const DARK_LUM = 100
export const DARK_MAX = 0.01

const toBuf = (b) => (Buffer.isBuffer(b) ? b : Buffer.from(b.buffer, b.byteOffset, b.byteLength))
const isPng = (b) => b.length > 33 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47
const isGif = (b) => b.length > 13 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38
const isWebp = (b) => b.length > 30 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP'

// Canvas size of a WebP and whether it can hold alpha, from its first chunk, before anything is decoded: 'VP8 ' (simple
// lossy) never has alpha, 'VP8L' (lossless) may, 'VP8X' (extended) says so in its flags along with "animated". On the
// 109 real question WebP (pasted into chat, named .jpg) every transparent one had the flag (57), and the size read here
// was the decoded size. → { width, height, mayAlpha, animated }, or null for any other first chunk.
function webpInfo(b) {
  const type = b.toString('latin1', 12, 16)
  if (type === 'VP8 ' && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) {
    return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff, mayAlpha: false, animated: false }
  }
  if (type === 'VP8L' && b[20] === 0x2f) {
    const bits = b.readUInt32LE(21)
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1, mayAlpha: true, animated: false }
  }
  if (type === 'VP8X') {
    return { width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1, mayAlpha: Boolean(b[20] & 0x10), animated: Boolean(b[20] & 0x02) }
  }
  return null
}

// The chunks of a PNG up to IEND: how many IHDR, a tRNS before the first IDAT, the IDAT data. pngjs keeps the LAST IHDR it
// meets while the guards here read the first (bytes 16–28): a second IHDR claiming 20000×20000, interlace or 1×8000000 rows
// walked past every guard (29 s / 6 GB; 0.6 s / 2 GB; 3.7 s / 1.2 GB). No decoder takes such a file (libpng: "out of place").
function pngChunks(b) {
  let ihdr = 0, trns = false, idatSeen = false
  const idat = []
  for (let p = 8; p + 8 <= b.length;) {
    const len = b.readUInt32BE(p)
    const type = b.toString('latin1', p + 4, p + 8)
    if (type === 'IHDR') ihdr++
    else if (type === 'tRNS' && !idatSeen) trns = true
    else if (type === 'IDAT') { idatSeen = true; idat.push(b.subarray(p + 8, p + 8 + len)) }
    else if (type === 'IEND') break
    p += 12 + len
  }
  return { ihdr, trns, idat }
}

// colour type → [samples per pixel, allowed bit depths]
const PNG_TYPES = { 0: [1, [1, 2, 4, 8, 16]], 2: [3, [8, 16]], 3: [1, [1, 2, 4, 8]], 4: [2, [8, 16]], 6: [4, [8, 16]] }
const ADAM7 = [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]]
// pngjs inflates an interlaced image with no cap (its non-interlaced path stops at the size IHDR implies): inflate the
// IDAT data here under the Adam7 size IHDR implies (+1 KiB) first — over it, zlib throws and the file passes through.
// The 116 interlaced PNGs among 2869 real question PNGs inflate to exactly that size (0.5 ms each).
function checkInterlacedSize(b, idat) {
  const [channels, depths] = PNG_TYPES[b[25]] || [0, []]
  // checked here, before pngjs sees the IHDR: a bad colour type made the cap NaN (= no cap for zlib), a bad depth a huge one
  if (!depths.includes(b[24])) throw new Error('bad IHDR')
  const w = b.readUInt32BE(16), h = b.readUInt32BE(20), bpp = channels * b[24]
  let size = 0
  for (const [x0, y0, dx, dy] of ADAM7) {
    const pw = Math.ceil((w - x0) / dx), ph = Math.ceil((h - y0) / dy)
    if (pw > 0 && ph > 0) size += ph * (1 + Math.ceil((pw * bpp) / 8))
  }
  zlib.inflateSync(Buffer.concat(idat), { maxOutputLength: size + 1024 }) // RangeError over the cap (or a bad IHDR)
}

// omggif's LZW decoder follows prefix links with no bound: a code past the table end (or a non-root code right after a
// clear) becomes the prefix of the next entry, the links form a loop, and decodeAndBlitFrameRGBA never returns — a
// 43-byte GIF (codes 0, 7, 6, 7) or a real question GIF with a few flipped bytes hung the event loop for good. Read the
// codes the way omggif does (same bit reader, same stops: end of data, EOI, frame full) and refuse such a stream. With a
// minimum code size ≤ 8 (the GIF maximum) every entry then points to an older one, so each chase ends.
function gifCodesOk(buf, p, outputLength) {
  const minCodeSize = buf[p++]
  if (!(minCodeSize <= 8)) return false // above 8 omggif's `prefix << 8 | k` mixes k into the prefix
  const clearCode = 1 << minCodeSize, eoiCode = clearCode + 1
  let nextCode = eoiCode + 1, codeSize = minCodeSize + 1, codeMask = (1 << codeSize) - 1
  let cur = 0, shift = 0, op = 0, sub = buf[p++], prev = null
  const depth = new Int32Array(4096) // prefix links behind each entry = omggif's chase_length
  for (;;) {
    while (shift < 16) {
      if (sub === 0) break
      cur |= buf[p++] << shift
      shift += 8
      if (sub === 1) sub = buf[p++]
      else --sub
    }
    if (shift < codeSize) return true
    const code = cur & codeMask
    cur >>= codeSize
    shift -= codeSize
    if (code === clearCode) { nextCode = eoiCode + 1; codeSize = minCodeSize + 1; codeMask = (1 << codeSize) - 1; prev = null; continue }
    if (code === eoiCode) return true
    if (prev === null ? code >= clearCode : code > nextCode) return false
    const chase = code < nextCode ? code : prev
    const opEnd = op + (chase > clearCode ? depth[chase] : 0) + (chase !== code ? 1 : 0)
    if (opEnd > outputLength) return true
    op = opEnd + 1
    if (prev !== null && nextCode < 4096) {
      depth[nextCode++] = (prev > clearCode ? depth[prev] : 0) + 1
      if (nextCode >= codeMask + 1 && codeSize < 12) { codeSize++; codeMask = codeMask << 1 | 1 }
    }
    prev = code
  }
}

// omggif reports a short / long LZW stream with console.log, i.e. on stdout — the MCP stdio channel of muse-server.mjs
function quiet(fn) {
  const log = console.log
  console.log = () => {}
  try { return fn() } finally { console.log = log }
}

// RGBA pixels (8-bit) → { transparent: pixels with alpha < 255, meanLum: alpha-weighted luminance of what is visible,
// dark: share of the visible pixels (alpha ≥ 128) with luminance < DARK_LUM }
function alphaStats(px) {
  let transparent = 0, sumA = 0, sumAL = 0, visible = 0, dark = 0
  for (let i = 0; i < px.length; i += 4) {
    const a = px[i + 3]
    if (a < 255) transparent++
    if (a) {
      const lum = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]
      sumA += a
      sumAL += a * lum
      if (a >= 128) { visible++; if (lum < DARK_LUM) dark++ }
    }
  }
  return { transparent, meanLum: sumA ? sumAL / sumA : 0, dark: visible ? dark / visible : 0 }
}

// share of the visible pixels (alpha ≥ 128) next to a mostly transparent one (alpha < 128, 4-neighbourhood) that are
// darker than DARK_LUM: the strokes a black background would swallow. Only computed when the cheaper tests point to black.
function darkEdgeShare(px, width) {
  const row = width * 4
  let edge = 0, dark = 0
  for (let i = 0, x = 0; i < px.length; i += 4, x = x + 1 === width ? 0 : x + 1) {
    if (px[i + 3] < 128) continue
    if ((x > 0 && px[i - 1] < 128) || (x + 1 < width && px[i + 7] < 128) || (i >= row && px[i + 3 - row] < 128) ||
        (i + row < px.length && px[i + 3 + row] < 128)) {
      edge++
      if (0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2] < DARK_LUM) dark++
    }
  }
  return edge ? dark / edge : 0
}

// Composite RGBA onto a grey level `bg` and encode an opaque PNG (greyscale when every pixel ends up grey).
function opaquePng(px, width, height, bg) {
  const out = new PNG({ width, height })
  let grey = true
  for (let i = 0; i < px.length; i += 4) {
    const a = px[i + 3] / 255
    for (let c = 0; c < 3; c++) out.data[i + c] = Math.round(px[i + c] * a + bg * (1 - a))
    out.data[i + 3] = 255
    if (grey && (out.data[i] !== out.data[i + 1] || out.data[i] !== out.data[i + 2])) grey = false
  }
  return PNG.sync.write(out, { colorType: grey ? 0 : 2 })
}

const pngName = (name) => {
  const s = String(name || 'image')
  const dot = s.lastIndexOf('.')
  return `${dot > 0 ? s.slice(0, dot) : s}.png`
}

/**
 * bytes (Uint8Array / Buffer) of one attachment → { bytes, mime, name, flattened, background?, transparent? }.
 * `flattened: false` → the input unchanged (same object).
 */
export function flattenTransparent(bytes, mime, name) {
  const same = { bytes, mime, name, flattened: false }
  try {
    const b = toBuf(bytes)
    let width, height, px
    if (isPng(b)) {
      const c = pngChunks(b)
      if (c.ihdr !== 1 || b.toString('latin1', 12, 16) !== 'IHDR') return same // the IHDR the guards read = the one pngjs uses
      // can it hold transparency at all? colour type 4 / 6 carry alpha; 0 / 2 / 3 only with a tRNS chunk (before IDAT)
      if (b[25] !== 4 && b[25] !== 6 && !c.trns) return same
      if (b.readUInt32BE(16) * b.readUInt32BE(20) > MAX_PIXELS || b.readUInt32BE(20) > MAX_ROWS) return same
      if (b[28] === 1) checkInterlacedSize(b, c.idat)
      const png = PNG.sync.read(b)                       // any colour type / bit depth / interlace → RGBA 8-bit
      ;({ width, height } = png)
      px = png.data
    } else if (isGif(b)) {
      let gif = new GifReader(new Uint8Array(b))
      const f = gif.frameInfo(0)
      // a first frame that sticks out of the logical screen grows the screen to hold it (as PIL and browsers do)
      width = Math.max(gif.width, f.x + f.width)
      height = Math.max(gif.height, f.y + f.height)
      if (width * height > MAX_PIXELS || height > MAX_ROWS) return same
      if (width !== gif.width || height !== gif.height) {
        const grown = Buffer.from(b)
        grown.writeUInt16LE(width, 6)                    // > 65535 throws → passes through
        grown.writeUInt16LE(height, 8)
        gif = new GifReader(grown)
      }
      const covers = f.x === 0 && f.y === 0 && f.width === width && f.height === height
      if (f.transparent_index === null && covers) return same
      if (!gifCodesOk(b, f.data_offset, f.width * f.height)) return same // would never return (see gifCodesOk)
      px = new Uint8Array(width * height * 4)              // untouched pixels stay alpha 0 = transparent
      quiet(() => gif.decodeAndBlitFrameRGBA(0, px))       // first frame only (Muse shows one frame anyway)
    } else if (isWebp(b) && webpDecoder) {
      const info = webpInfo(b)
      if (!info || !info.mayAlpha || info.animated || info.width * info.height > WEBP_MAX_PIXELS) return same
      const img = webpDecoder.decode(b)                    // RGBA 8-bit, not premultiplied; null for a damaged file
      if (!img) return same
      ;({ width, height } = img)
      px = img.data
    } else return same
    const { transparent, meanLum, dark } = alphaStats(px)
    if (!transparent) return same
    const bg = meanLum > LIGHT_CONTENT && dark <= DARK_MAX && darkEdgeShare(px, width) <= DARK_MAX ? 0 : 255
    return {
      bytes: new Uint8Array(opaquePng(px, width, height, bg)),
      mime: 'image/png',
      name: pngName(name),
      flattened: true,
      background: bg ? 'white' : 'black',
      transparent: transparent / (width * height),
    }
  } catch {
    return same                                            // never block an upload over a file that does not decode
  }
}
