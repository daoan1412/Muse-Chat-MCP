#!/usr/bin/env node
/**
 * muse-noise.mjs — Phase 2: headless Meta Muse client (no browser).
 *
 * Talks to the Hatch VM directly over the encrypted Noise WebSocket
 *   wss://hatch.metaaivm.com/v1/noise?vm_id=…&auth_token=…&notary_token=…
 * transport  Noise_XX_25519_AESGCM_SHA256  (X25519 + HKDF-SHA256 + AES-256-GCM)
 * framing    protobuf (hatch.noise.* + ingress_rev_proxy.NoiseTransportFrame),
 *            HTTP/2-style multiplexed requests carried inside the Noise tunnel.
 *
 * Everything below was reverse-engineered from the real client (see
 * tools/capture-noise.mjs + tools/decode-desc.mjs) and verified against it.
 *
 * Bootstrap (cookie-authed REST, from the logged-in session):
 *   POST /api/auth/check  -> {ok, access_token, viewer_id}
 *   GET  /api/session     -> {vm_id, endpoint_url}
 *   POST /api/hatch/vm/wake {vm_id}
 *   POST /api/hatch/token   {vmAddress, vmName} -> {token, notary_token}
 *
 * The client is pure Node (WebCrypto + `ws`); it only needs the login cookies.
 */
import { WebSocket } from 'ws'

const C = globalThis.crypto || globalThis.webcrypto
const LB_HOST = process.env.MUSE_NOISE_HOST || 'hatch.metaaivm.com'
const NOISE_PATH = '/v1/noise'
const APP_ID = 'hatch-web'
// Next.js RSC server-action id for fetchSubscriptionAction (the Usage/credits
// meter). Build-specific hash — override with MUSE_SUBSCRIPTION_ACTION_ID after a redeploy.
export const SUBSCRIPTION_ACTION_ID = process.env.MUSE_SUBSCRIPTION_ACTION_ID || '4029ac5c4bd03136487d91ebde5de39c64b35229b4'
const PROTONAME = 'Noise_XX_25519_AESGCM_SHA256'
const CHUNK_MAX = 65489
// Capabilities the real client sends in chat.subscribe (buildHatchChatCapabilities).
export const DEFAULT_CAPS = ['chat_cancel', 'delta_stream', 'custom_reactions', 'custom_reactions_facebook_thumbs_up_v1', 'voice_reply_captions', 'voice_user_live_transcript']
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ------------------------------------------------------------------ crypto
const sha256 = async (data) => new Uint8Array(await C.subtle.digest('SHA-256', data))
async function hmac(key, msg) {
  const k = await C.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return new Uint8Array(await C.subtle.sign('HMAC', k, msg))
}
// Noise HKDF: returns n 32-byte outputs.
async function hkdf(ck, ikm, n) {
  const tmpk = await hmac(ck, ikm)
  const a = await hmac(tmpk, new Uint8Array([1]))
  const b = await hmac(tmpk, concat(a, new Uint8Array([2])))
  if (n === 2) return [a, b]
  const c = await hmac(tmpk, concat(b, new Uint8Array([3])))
  return [a, b, c]
}
const concat = (...arrs) => {
  const out = new Uint8Array(arrs.reduce((s, a) => s + a.length, 0))
  let o = 0
  for (const a of arrs) { out.set(a, o); o += a.length }
  return out
}
// AES-256-GCM cipherstate; nonce = 4 zero bytes + 8-byte big-endian counter.
class CipherState {
  constructor(key) {
    this.key = key
    this._n = 0
    this.ready = C.subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt', 'decrypt'])
  }
  _iv() {
    const iv = new Uint8Array(12)
    const dv = new DataView(iv.buffer)
    dv.setUint32(4, Math.floor(this._n / 0x100000000), false)
    dv.setUint32(8, this._n >>> 0, false)
    this._n++
    return iv
  }
  async encrypt(ad, pt) {
    const k = await this.ready
    return new Uint8Array(await C.subtle.encrypt({ name: 'AES-GCM', iv: this._iv(), additionalData: ad }, k, pt))
  }
  async decrypt(ad, ct) {
    const k = await this.ready
    return new Uint8Array(await C.subtle.decrypt({ name: 'AES-GCM', iv: this._iv(), additionalData: ad }, k, ct))
  }
}
async function genX25519() {
  const kp = await C.subtle.generateKey('X25519', true, ['deriveBits', 'deriveKey'])
  const pub = new Uint8Array(await C.subtle.exportKey('raw', kp.publicKey))
  return { priv: kp.privateKey, pub }
}
async function dh(priv, pubBytes) {
  if (pubBytes.length !== 32) throw new Error('x25519: bad public key length')
  const pub = await C.subtle.importKey('raw', pubBytes, 'X25519', false, [])
  return new Uint8Array(await C.subtle.deriveBits({ name: 'X25519', public: pub }, priv, 256))
}

// ------------------------------------------------------------------ Noise_XX
class SymmetricState {
  constructor() { this.h = null; this.ck = null; this.cipher = null }
  async initialize() {
    // The real client pads the protocol name to 32 bytes and uses that as the
    // initial cipher key WITHOUT hashing it, and does not key the cipherstate
    // until the first MixKey — so the handshake msg1 payload travels in the clear.
    const name = new TextEncoder().encode(PROTONAME)
    const padded = new Uint8Array(32)
    padded.set(name.subarray(0, 32))
    this.ck = padded.slice()
    this.h = padded.slice()
    await this.mixHash(new Uint8Array(0)) // h = SHA256(padded)
    this.cipher = null
  }
  async mixHash(data) { this.h = await sha256(concat(this.h, data)) }
  async mixKey(dhOut) {
    const [ck2, key] = await hkdf(this.ck, dhOut, 2)
    this.ck = ck2
    this.cipher = new CipherState(key)
  }
  async encryptAndHash(pt) {
    const ct = this.cipher ? await this.cipher.encrypt(this.h, pt) : pt
    await this.mixHash(ct)
    return ct
  }
  async decryptAndHash(ct) {
    const pt = this.cipher ? await this.cipher.decrypt(this.h, ct) : ct
    await this.mixHash(ct)
    return pt
  }
  async split() {
    const [k1, k2] = await hkdf(this.ck, new Uint8Array(0), 2)
    return [new CipherState(k1), new CipherState(k2)]
  }
}

// msg1 payload: protobuf field 1 (tag 0x0A) = 32-byte client nonce.
function encodeClientNonce(nonce) { return concat(new Uint8Array([0x0a, 0x20]), nonce) }

class NoiseXX {
  async writeMessage1() {
    this.e = await genX25519()
    await this.s.mixHash(this.e.pub)
    const nonce = new Uint8Array(C.getRandomValues(new Uint8Array(32)))
    const payload = encodeClientNonce(nonce)
    const ct = await this.s.encryptAndHash(payload) // cipher null -> plaintext
    return concat(this.e.pub, ct)
  }
  async readMessage2(msg) {
    if (msg.length < 96) throw new Error(`noise msg2 too short (${msg.length})`)
    const e2 = msg.subarray(0, 32)
    this.remoteEphemeral = new Uint8Array(e2) // #m in the real client
    await this.s.mixHash(e2)
    await this.s.mixKey(await dh(this.e.priv, e2)) // ee
    this.remoteStatic = await this.s.decryptAndHash(msg.subarray(32, 80)) // #p
    await this.s.mixKey(await dh(this.e.priv, this.remoteStatic)) // es
    const payload = await this.s.decryptAndHash(msg.subarray(80))
    return payload
  }
  async writeMessage3() {
    this.s2 = await genX25519() // client static (#w)
    const encStatic = await this.s.encryptAndHash(this.s2.pub) // write s
    // "se" = DH(initiator static, responder EPHEMERAL) — matches the real client's
    // w(#w.privateKey, #m). Using remoteStatic here breaks the split key and the
    // server closes right after msg3.
    await this.s.mixKey(await dh(this.s2.priv, this.remoteEphemeral)) // se
    const ct = await this.s.encryptAndHash(new Uint8Array(0))
    return concat(encStatic, ct)
  }
  async split() { return this.s.split() }
}

// ------------------------------------------------------------------ protobuf
// Minimal encoder/decoder for the recovered hatch.noise.* schemas.
// field kinds: 'varint' (int32/int64/uint32/enum/bool), 'bytes' (string/bytes),
// 'msg' (embedded message). rep = repeated. of = sub-schema. oneof = group name.
const S_HEADER = [{ n: 'key', f: 1, k: 'bytes' }, { n: 'value', f: 2, k: 'bytes' }]
const S_AREQ = [
  { n: 'verb', f: 1, k: 'bytes' }, { n: 'path', f: 2, k: 'bytes' },
  { n: 'headers', f: 3, k: 'msg', of: S_HEADER, rep: true },
  { n: 'body', f: 4, k: 'bytes' }, { n: 'end_body', f: 5, k: 'varint' },
]
const S_ARESP = [
  { n: 'status', f: 1, k: 'varint' }, { n: 'headers', f: 2, k: 'msg', of: S_HEADER, rep: true },
  { n: 'body', f: 3, k: 'bytes' }, { n: 'end_body', f: 4, k: 'varint' },
]
const S_BCHUNK = [{ n: 'data', f: 1, k: 'bytes' }, { n: 'end_body', f: 2, k: 'varint' }]
const S_RESET = [{ n: 'code', f: 1, k: 'varint' }, { n: 'reason', f: 2, k: 'bytes' }]
const S_FRAME = [
  { n: 'stream_id', f: 1, k: 'varint' },
  { n: 'request', f: 2, k: 'msg', of: S_AREQ, oneof: 'kind' },
  { n: 'response', f: 3, k: 'msg', of: S_ARESP, oneof: 'kind' },
  { n: 'body_chunk', f: 4, k: 'msg', of: S_BCHUNK, oneof: 'kind' },
  { n: 'reset', f: 5, k: 'msg', of: S_RESET, oneof: 'kind' },
]
const S_SREQ = [{ n: 'service', f: 1, k: 'varint' }, { n: 'payload', f: 2, k: 'bytes' }]
const S_SRESP = [{ n: 'payload', f: 1, k: 'bytes' }]
const S_CHUNK = [
  { n: 'chunk_id', f: 1, k: 'varint' }, { n: 'chunk_index', f: 2, k: 'varint' },
  { n: 'total_chunks', f: 3, k: 'varint' }, { n: 'payload', f: 4, k: 'bytes' },
]

function varintBytes(val) {
  let v = typeof val === 'bigint' ? val : BigInt(val)
  v = BigInt.asUintN(64, v) // two's-complement for negatives
  const out = []
  do { let b = Number(v & 0x7fn); v >>= 7n; if (v) b |= 0x80; out.push(b) } while (v)
  return Uint8Array.from(out)
}
function utf8(s) { return new TextEncoder().encode(s) }
// Normalize a workspace path/URI to the gateway form "workspace/<...>".
function wsPath(p) {
  let s = String(p).trim()
  if (s.startsWith('sandbox://')) s = s.slice(10)
  s = s.replace(/^\/+/, '')
  if (!s.startsWith('workspace/')) s = 'workspace/' + s
  return s
}
function b64u8(b64) { const s = Buffer.from(b64, 'base64').toString('binary'); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u }

function encodeMessage(obj, schema) {
  const parts = []
  for (const fld of schema) {
    const val = obj[fld.n]
    if (val === undefined || val === null) continue
    const items = fld.rep ? val : [val]
    for (const it of items) {
      if (fld.k === 'varint') {
        const num = typeof it === 'boolean' ? (it ? 1 : 0) : it
        if (num === 0 || num === false || num === 0n) { /* proto3 default: skip */ }
        parts.push(varintBytes((fld.f << 3) | 0), varintBytes(num))
      } else if (fld.k === 'bytes') {
        const bytes = typeof it === 'string' ? utf8(it) : Uint8Array.from(it)
        if (bytes.length === 0 && !fld.rep) { /* empty default: still emit for required bytes? keep */ }
        parts.push(varintBytes((fld.f << 3) | 2), varintBytes(bytes.length), bytes)
      } else if (fld.k === 'msg') {
        const sub = encodeMessage(it, fld.of)
        parts.push(varintBytes((fld.f << 3) | 2), varintBytes(sub.length), sub)
      }
    }
  }
  return concat(...(parts.length ? parts : [new Uint8Array(0)]))
}

function decodeMessage(bytes, schema) {
  const obj = {}
  let i = 0
  const rdVarint = () => { let out = 0n, shift = 0n; while (true) { const b = bytes[i++]; out |= BigInt(b & 0x7f) << shift; if (!(b & 0x80)) break; shift += 7n } return out }
  while (i < bytes.length) {
    const key = Number(rdVarint())
    const fn = key >> 3, wt = key & 7
    let val
    if (wt === 0) val = rdVarint()
    else if (wt === 2) { const len = Number(rdVarint()); val = bytes.subarray(i, i + len); i += len }
    else if (wt === 5) { val = bytes.readUInt32LE(i); i += 4 }
    else if (wt === 1) { val = bytes.readBigUInt64LE(i); i += 8 }
    else { throw new Error(`protobuf wire type ${wt}`) }
    const fld = schema.find((s) => s.f === fn)
    if (!fld) continue
    if (fld.k === 'varint') obj[fld.n] = fld.n === 'end_body' ? Boolean(Number(BigInt.asIntN(64, val))) : BigInt.asIntN(64, val)
    else if (fld.k === 'bytes') obj[fld.n] = val
    else if (fld.k === 'msg') { const sub = decodeMessage(val, fld.of); if (fld.rep) (obj[fld.n] ||= []).push(sub); else obj[fld.n] = sub }
    if (fld.oneof) obj.kind = { case: fld.n, value: obj[fld.n] }
  }
  return obj
}

// ------------------------------------------------------------------ transport
function chunkMessage(bytes) {
  const chunkId = BigInt.asIntN(64, (BigInt(Math.floor(Math.random() * 0x100000000)) << 32n) | BigInt(Math.floor(Math.random() * 0x100000000)))
  const total = Math.max(1, Math.ceil(bytes.length / CHUNK_MAX))
  const out = []
  for (let idx = 0; idx < total; idx++) {
    const slice = bytes.subarray(idx * CHUNK_MAX, Math.min((idx + 1) * CHUNK_MAX, bytes.length))
    out.push(encodeMessage({ chunk_id: chunkId, chunk_index: idx, total_chunks: total, payload: slice }, S_CHUNK))
  }
  return out
}

class NoiseTransport {
  constructor(c1, c2) { this.c1 = c1; this.c2 = c2; this.nextStream = 1n; this.pending = new Map() }
  allocStream() { return this.nextStream++ }
  async sendRequest(streamId, service, appReq) {
    // Set the oneof member directly (encodeMessage has no oneof awareness):
    // ServiceFrame{stream_id, request=ApplicationRequest}.
    const frame = encodeMessage({ stream_id: streamId, request: appReq }, S_FRAME)
    const h = encodeMessage({ service, payload: frame }, S_SREQ)
    for (const c of chunkMessage(h)) {
      const ct = await this.c1.encrypt(new Uint8Array(0), c)
      this.ws.send(ct)
    }
    return streamId
  }
  // decrypt one wire frame -> NoiseTransportFrame, reassemble by chunk_id.
  async feedFrame(bytes) {
    const pt = await this.c2.decrypt(new Uint8Array(0), bytes)
    const f = decodeMessage(pt, S_CHUNK)
    const id = BigInt.asIntN(64, f.chunk_id)
    let entry = this.pending.get(id)
    if (!entry) { entry = { total: Number(f.total_chunks), got: new Map(), last: Date.now() }; this.pending.set(id, entry) }
    entry.got.set(Number(f.chunk_index), f.payload)
    entry.last = Date.now()
    if (entry.got.size < entry.total) return null
    const parts = []
    for (let i = 0; i < entry.total; i++) parts.push(entry.got.get(i) || new Uint8Array(0))
    this.pending.delete(id)
    const resp = decodeMessage(concat(...parts), S_SRESP)
    const dframe = decodeMessage(resp.payload, S_FRAME)
    return dframe // {stream_id, kind:{case,value}}
  }
}

// ------------------------------------------------------------------ client
// Parse a Next.js RSC "flight" action response into the returned value.
// The result object is referenced by the first line's `a` field (`$@N` -> line N).
export function parseFlightResult(txt) {
  const lines = String(txt).split('\n').filter(Boolean)
  if (!lines.length) throw new Error('empty flight response')
  let ref = '1'
  const m = lines[0].match(/^0:(\{.*\})\s*$/)
  if (m) { try { const a = (JSON.parse(m[1]).a || ''); const mm = a.match(/\$(\d+)/); if (mm) ref = mm[1] } catch {} }
  const line = lines.find((l) => l.startsWith(ref + ':'))
  if (!line) throw new Error('no result line ' + ref)
  return JSON.parse(line.slice(ref.length + 1))
}

export class MuseNoiseClient {
  constructor({ cookies, origin = 'https://muse.ai', ua = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', log = () => {} } = {}) {
    this.cookieHeader = Array.isArray(cookies) ? cookies.map((c) => `${c.name}=${c.value}`).join('; ') : (cookies || '')
    this.origin = origin
    this.ua = ua
    this.log = log
    this.ws = null
    this.transport = null
    this.handlers = new Map() // streamId(string) -> {onFrame, onEnd}
    this._settled = new Set() // streamIds whose handler already finished (ignore benign tails)
    this._pumping = false
  }
  async rest(method, path, body) {
    const res = await fetch(this.origin + path, {
      method,
      headers: {
        'content-type': 'application/json',
        cookie: this.cookieHeader,
        origin: this.origin,
        referer: this.origin + '/',
        accept: '*/*',
        'user-agent': this.ua,
        'sec-fetch-site': 'same-origin',
        'sec-fetch-mode': 'cors',
        'sec-fetch-dest': 'empty',
      },
      body: body ? JSON.stringify(body) : undefined,
    })
    const txt = await res.text()
    let json = null
    try { json = JSON.parse(txt) } catch {}
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${txt.slice(0, 200)}`)
    return json
  }
  // Usage/credits meter via the Next.js RSC server action fetchSubscriptionAction.
  // Plain HTTPS POST to the app origin (no noise WS needed) — only the login cookies.
  // Cloudflare bot-checks the request, so send full browser client-hint headers.
  async usage({ includeAgreement = true } = {}) {
    const res = await fetch(this.origin + '/', {
      method: 'POST',
      headers: {
        accept: 'text/x-component',
        'accept-encoding': 'gzip, deflate, br',
        'accept-language': 'en-US,en;q=0.9',
        'content-type': 'text/plain;charset=UTF-8',
        'next-action': SUBSCRIPTION_ACTION_ID,
        origin: this.origin,
        referer: this.origin + '/',
        'sec-ch-prefers-color-scheme': 'light',
        'sec-ch-ua': '"Chromium";v="152", "Not?A_Brand";v="24", "Google Chrome";v="152"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Linux"',
        'sec-fetch-dest': 'empty',
        'sec-fetch-mode': 'cors',
        'sec-fetch-site': 'same-origin',
        'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36',
        cookie: this.cookieHeader,
      },
      body: JSON.stringify([{ includeAgreement }]),
    })
    const txt = await res.text()
    if (!res.ok) throw new Error(`usage action -> ${res.status}: ${txt.slice(0, 200)}`)
    const r = parseFlightResult(txt)
    if (!r || !r.success) throw new Error('usage action failed: ' + JSON.stringify((r && r.error) || r).slice(0, 200))
    return r.subscription
  }
  async bootstrap() {
    const auth = await this.rest('POST', '/api/auth/check', {})
    if (!auth || !auth.ok) throw new Error('not logged in (auth/check not ok)')
    const sess = await this.rest('GET', '/api/session')
    const vmId = sess.vm_id
    const endpoint = sess.endpoint_url
    if (!vmId || !endpoint) throw new Error('no vm assigned: ' + JSON.stringify(sess).slice(0, 200))
    await this.rest('POST', '/api/hatch/vm/wake', { vm_id: vmId }).catch(() => {})
    const tok = await this.rest('POST', '/api/hatch/token', { vmAddress: endpoint, vmName: vmId })
    if (!tok || !tok.token) throw new Error('no token: ' + JSON.stringify(tok).slice(0, 200))
    const url = `wss://${LB_HOST}${NOISE_PATH}?vm_id=${encodeURIComponent(vmId)}&auth_token=${encodeURIComponent(tok.token)}&notary_token=${encodeURIComponent(tok.notary_token || '')}&app_id=${APP_ID}&request_id=${crypto.randomUUID()}`
    this.log(`bootstrap ok vm=${vmId} host=${LB_HOST}`)
    return { url, vmId }
  }
  async connect() {
    const { url } = await this.bootstrap()
    const ws = await new Promise((resolve, reject) => {
      const w = new WebSocket(url, { headers: { origin: this.origin, 'user-agent': this.ua, cookie: this.cookieHeader } })
      w.on('open', () => resolve(w))
      w.on('error', reject)
      setTimeout(() => reject(new Error('ws open timeout')), 15000)
    })
    this.ws = ws
    await this._handshake(ws)
    this._startPump()
    return true
  }
  async _handshake(ws) {
    const noise = new NoiseXX()
    noise.s = new SymmetricState()
    await noise.s.initialize()
    const msg1 = await noise.writeMessage1()
    const recv = _frameReader(ws, this.log)
    this.log('send msg1 len', msg1.length)
    ws.send(msg1)
    const msg2 = await recv.next()
    this.log('recv msg2 len', msg2 && msg2.length)
    const m2payload = await noise.readMessage2(msg2)
    this.log('msg2 payload len', m2payload.length, 'remote static', Buffer.from(noise.remoteStatic).toString('hex').slice(0, 24))
    const msg3 = await noise.writeMessage3()
    this.log('send msg3 len', msg3.length)
    ws.send(msg3)
    const [c1, c2] = await noise.split()
    this.transport = new NoiseTransport(c1, c2)
    this.transport.ws = ws
    this._recv = recv
    this.log('noise handshake complete')
  }
  // Central frame pump: decrypt each wire frame, reassemble chunks, dispatch by stream_id.
  _startPump() {
    this._pumping = true
    this._settled.clear() // fresh connection → stream ids restart; drop stale settled keys
    ;(async () => {
      while (this._pumping) {
        const raw = await this._recv.next(0)
        if (raw === null || !this._pumping || !this.transport) break
        let frame = null
        try { frame = await this.transport.feedFrame(raw) } catch (e) { this.log('feedFrame error:', e.message, 'len', raw.length); continue }
        if (!frame) continue
        const key = String(BigInt(frame.stream_id))
        const h = this.handlers.get(key)
        if (h) { try { h.onFrame(frame) } catch (e) { this.log('handler error:', e.message) } }
        else if (this._settled.has(key)) { /* stream already finished — ignore benign trailing body_chunk/response */ }
        else this.log('unhandled frame stream', key, 'kind', frame.kind && frame.kind.case)
      }
      for (const [, h] of this.handlers) { try { h.onEnd && h.onEnd() } catch {} }
    })()
  }
  // Allocate a stream, send the request frame (fire-and-forget), return the stream id.
  _send(method, path, bodyObj, { service = 0, headers = [] } = {}) {
    const streamId = this.transport.allocStream()
    const hasBody = !(bodyObj === undefined || bodyObj === null)
    const bodyBytes = hasBody ? (typeof bodyObj === 'string' ? utf8(bodyObj) : Buffer.from(JSON.stringify(bodyObj))) : new Uint8Array(0)
    // The gateway requires Content-Type on body-bearing requests (else 415).
    const hdrs = [...headers]
    if (hasBody && !hdrs.some((h) => Buffer.from(h.key).toString('utf8').toLowerCase() === 'content-type'))
      hdrs.push({ key: 'content-type', value: 'application/json' })
    const appReq = { verb: method, path, headers: hdrs, body: bodyBytes, end_body: true }
    this.transport.sendRequest(streamId, service, appReq).catch((e) => this.log('send error:', e.message))
    return streamId
  }
  // Unary request: resolve {status, headers, body} once end_body arrives.
  request(method, path, { body, service = 0, headers = [], timeoutMs = 60000 } = {}) {
    if (!this.transport) return Promise.reject(new Error('not connected'))
    const streamId = this._send(method, path, body, { service, headers })
    const key = String(streamId)
    return new Promise((resolve, reject) => {
      const EMPTY_BODY_GRACE_MS = Number(process.env.MUSE_EMPTY_BODY_GRACE_MS ?? 1200)
      let status = null, respHeaders = [], settled = false
      const bodyParts = []
      let grace = null
      const finish = (err) => {
        if (settled) return; settled = true
        clearTimeout(timer); if (grace) clearTimeout(grace)
        this.handlers.delete(key)
        if (this._settled.size > 1000) this._settled.clear()
        this._settled.add(key)
        if (err) reject(err)
        else resolve({ status, headers: respHeaders, body: Buffer.from(concat(...(bodyParts.length ? bodyParts : [new Uint8Array(0)]))) })
      }
      const timer = setTimeout(() => finish(new Error(`request timeout ${method} ${path}`)), timeoutMs)
      this.handlers.set(key, {
        onFrame: (frame) => {
          const kind = frame.kind
          if (!kind) return
          if (kind.case === 'reset') { const r = kind.value; finish(new Error(`reset code=${Number(r.code)} reason=${Buffer.from(r.reason || new Uint8Array(0)).toString('utf8')}`)); return }
          if (kind.case === 'response') {
            status = Number(kind.value.status); respHeaders = kind.value.headers || []
            if (kind.value.body?.length) bodyParts.push(kind.value.body)
            // Don't resolve on an empty-body `response` if the JSON may still arrive as a
            // trailing body_chunk — give it a short grace, then finish with what we have.
            if (kind.value.end_body) { if (bodyParts.length) finish(); else grace = setTimeout(finish, EMPTY_BODY_GRACE_MS) }
          }
          else if (kind.case === 'body_chunk') { if (kind.value.data?.length) bodyParts.push(kind.value.data); if (kind.value.end_body) { if (status === null) status = 200; finish() } }
        },
        onEnd: () => { if (status === null) finish(new Error('stream closed before response')); else finish() },
      })
    })
  }
  async chatHistory(max = 50) {
    const r = await this.request('GET', `/chat/history?limit=${max}`)
    let json = null
    try { json = JSON.parse(r.body.toString('utf8')) } catch {}
    return { status: r.status, json, raw: r.body.toString('utf8').slice(0, 4000) }
  }
  // Enumerate chats/sessions shown in the sidebar.
  async listSessions() {
    const r = await this.request('GET', '/api/session/list')
    let json = null
    try { json = JSON.parse(r.body.toString('utf8')) } catch {}
    return { status: r.status, json, raw: r.body.toString('utf8').slice(0, 4000) }
  }
  // Write bytes to a VM workspace path (chunked base64 for files > 512 KiB).
  async fsWrite(path, bytes, { createParent = true } = {}) {
    const CH = 524288
    const wp = wsPath(path)
    if (bytes.length <= CH) {
      return this.request('POST', '/fs/write', { body: { path: wp, data_base64: Buffer.from(bytes).toString('base64'), overwrite: true, append: false, create_parent: createParent } })
    }
    let last = null
    for (let i = 0; i < bytes.length; i += CH) {
      const slice = bytes.subarray(i, Math.min(i + CH, bytes.length))
      last = await this.request('POST', '/fs/write', { body: { path: wp, data_base64: Buffer.from(slice).toString('base64'), overwrite: i === 0, append: i !== 0, create_parent: i === 0 ? createParent : false } })
      if (last.status && last.status >= 400) return last
    }
    return last
  }
  // Fetch a raw workspace file (generated media, uploaded attachments) as bytes.
  async fsRaw(path) {
    return this.request('GET', `/fs/raw/${wsPath(path)}`, { timeoutMs: 120000 })
  }
  // Upload an attachment into the workspace; returns the sandbox:// path.
  async uploadAttachment(bytes, filename, mime = 'application/octet-stream') {
    const safe = String(filename || 'file').replace(/[^\w.\-]+/g, '_').slice(0, 80) || 'file'
    const dot = safe.lastIndexOf('.')
    const base = dot > 0 ? safe.slice(0, dot) : safe
    const ext = dot > 0 ? safe.slice(dot) : ''
    const uploadPath = `workspace/user/files/${base}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}${ext}`
    const r = await this.fsWrite(uploadPath, bytes, { createParent: true })
    if (r.status && r.status >= 400) throw new Error(`fs.write ${r.status}: ${r.body.toString('utf8').slice(0, 200)}`)
    return { path: uploadPath, uri: `sandbox://${uploadPath}`, mime }
  }
  // Open the persistent chat subscription; parsed NDJSON events are queued for nextEvent().
  chatSubscribe({ capabilities = DEFAULT_CAPS, sessionId = null } = {}) {
    const body = { capabilities }
    if (sessionId) body.session_id = sessionId
    const streamId = this._send('POST', '/chat/subscribe', body)
    const key = String(streamId)
    const q = []
    let notify = null
    const state = { status: null, buf: new Uint8Array(0), closed: false, error: null }
    const wake = () => { if (notify) { const n = notify; notify = null; n() } }
    const drainLines = () => {
      let nl
      while ((nl = state.buf.indexOf(0x0a)) >= 0) {
        const line = state.buf.subarray(0, nl); state.buf = state.buf.subarray(nl + 1)
        const s = Buffer.from(line).toString('utf8').trim()
        if (!s) continue
        let ev = null; try { ev = JSON.parse(s) } catch { ev = { _raw: s } }
        q.push(ev); wake()
      }
    }
    this.handlers.set(key, {
      onFrame: (frame) => {
        const kind = frame.kind; if (!kind) return
        if (kind.case === 'reset') { state.error = new Error(`subscribe reset code=${Number(kind.value.code)} reason=${Buffer.from(kind.value.reason || new Uint8Array(0)).toString('utf8')}`); state.closed = true; wake(); return }
        if (kind.case === 'response') { state.status = Number(kind.value.status); if (kind.value.body?.length) { state.buf = concat(state.buf, kind.value.body); drainLines() } }
        else if (kind.case === 'body_chunk') { if (kind.value.data?.length) { state.buf = concat(state.buf, kind.value.data); drainLines() } }
      },
      onEnd: () => { drainLines(); state.closed = true; wake() },
    })
    return {
      streamId,
      getStatus: () => state.status,
      getError: () => state.error,
      isClosed: () => state.closed,
      async nextEvent(timeoutMs = 0) {
        if (q.length) return q.shift()
        if (state.closed || state.error) return null
        return new Promise((resolve) => {
          const done = () => { notify = null; resolve(q.length ? q.shift() : null) }
          notify = done
          if (timeoutMs) setTimeout(() => { if (notify === done) done() }, timeoutMs)
        })
      },
      stop: () => { this.handlers.delete(key); if (this._settled.size > 1000) this._settled.clear(); this._settled.add(key) },
    }
  }
  // Full turn. newSession=true creates a brand-new side chat (thread): we send
  // FIRST (which materializes the session server-side), THEN subscribe — the
  // reverse order yields zero events for a not-yet-existing session.
  // Retries transient failures (ack `request timeout`, stalled stream) with a fresh
  // session per attempt. Env: MUSE_RETRY (default 2 retries), MUSE_RETRY_BACKOFF_MS (2000),
  // MUSE_STALL_FIRST_MS (180000: no event at all after the ack), MUSE_STALL_IDLE_MS (120000: gap between events).
  async chat(prompt, opts = {}) {
    const retries = Number(process.env.MUSE_RETRY ?? 2)
    const backoff = Number(process.env.MUSE_RETRY_BACKOFF_MS ?? 2000)
    for (let attempt = 0; ; attempt++) {
      try { return await this._chatOnce(prompt, opts) }
      catch (e) {
        const retryable = e.stalled || /^request timeout POST \/chat\/stream/.test(e.message || '')
        if (!retryable) throw e
        // an ack timeout on a reused session may have been delivered: only auto-retry fresh sessions or stalls before any event
        if (attempt >= retries || !(opts.newSession || e.stalled || !sessionIdReused(opts))) { e.noRetry = true; e.attempts = attempt + 1; throw e }
        await new Promise(r => setTimeout(r, backoff * (attempt + 1) + Math.random() * 500))
        if (opts.onRetry) try { opts.onRetry(attempt + 1, e) } catch {}
      }
    }
  }
  async _chatOnce(prompt, { nodeId = crypto.randomUUID(), timeoutMs = 120000, onEvent, attachments = [], sessionId = null, newSession = false } = {}) {
    let text = prompt
    for (const a of attachments) { const alt = String(a.name || '').replace(/[\]\[]/g, ''); text += `\n![${alt}](${a.uri})` }
    const sid = newSession ? crypto.randomUUID() : sessionId
    const body = { items: [{ type: 'text', text }], node_id: nodeId, capabilities: DEFAULT_CAPS }
    if (sid) body.session_id = sid
    let ack, sub
    if (newSession) {
      ack = await this.request('POST', '/chat/stream', { body, timeoutMs: 30000 })
      sub = this.chatSubscribe({ sessionId: sid })
    } else {
      sub = this.chatSubscribe({ sessionId: sid })
      ack = await this.request('POST', '/chat/stream', { body, timeoutMs: 30000 })
    }
    const events = []
    const backstop = Date.now() + Number(process.env.MUSE_MAX_TURN_MS ?? 1800000) // absolute ceiling (max total turn)
    const stallFirst = Number(process.env.MUSE_STALL_FIRST_MS ?? 180000), stallIdle = Number(process.env.MUSE_STALL_IDLE_MS ?? 120000)
    const idleAfterFirst = timeoutMs && timeoutMs > 0 ? timeoutMs : stallIdle // timeoutMs now = idle gap between events
    let lastEv = Date.now()
    let idleWindow = stallFirst // sliding: tolerated silence; extends as long as events keep arriving
    let reply = '', replyReady = false, assistantMessageId = null
    while (Date.now() < backstop) {
      const ev = await sub.nextEvent(Math.max(50, Math.min(idleWindow - (Date.now() - lastEv), backstop - Date.now(), 5000)))
      if (ev === null) {
        if (sub.isClosed() || sub.getError()) break
        if (Date.now() - lastEv > idleWindow) {
          sub.stop()
          const e = new Error(`stalled: no event for ${Math.round((Date.now() - lastEv) / 1000)}s (${events.length} events so far)`)
          e.stalled = true
          throw e
        }
        continue
      }
      lastEv = Date.now()
      idleWindow = events.length ? idleAfterFirst : stallFirst // slide the idle window on every event (don't cut off active streaming)
      events.push(ev)
      if (onEvent) onEvent(ev)
      const name = ev.event || ev.event_name
      if (name === 'delta.text_append') { const t = ev.payload && ev.payload.text; if (typeof t === 'string') reply += t }
      else if (name === 'delta.message_done') {
        assistantMessageId = (ev.payload && ev.payload.message_id) || assistantMessageId
        const tr = ev.payload && ev.payload.transcript
        let final = ''
        if (tr && Array.isArray(tr.messages)) for (const m of tr.messages) if (m.role === 'assistant' && Array.isArray(m.content)) for (const c of m.content) if (c.type === 'text' && typeof c.text === 'string') final += c.text
        if (final) reply = final
        replyReady = true
        break
      }
    }
    sub.stop()
    if (isMuseSorry(reply)) throw museSorryError(reply, sid)
    return { ack, events, reply, replyReady, assistantMessageId, sessionId: sid }
  }
  close() { this._pumping = false; try { this.ws?.close() } catch {} this.ws = null; this.transport = null }
}

// Reads binary WS frames as they arrive; next() returns the next complete frame.
function _frameReader(ws, log = () => {}) {
  const q = []
  let resolveNext = null, closed = false
  ws.on('message', (data) => {
    const buf = Buffer.isBuffer(data) ? new Uint8Array(data) : new Uint8Array(data)
    log('WS msg len', buf.length)
    if (resolveNext) { const r = resolveNext; resolveNext = null; r(buf) }
    else q.push(buf)
  })
  ws.on('close', (code, reason) => { closed = true; log('WS close', code, String(reason || '')); if (resolveNext) { const r = resolveNext; resolveNext = null; r(null) } })
  ws.on('error', (e) => { closed = true; log('WS error', e.message) })
  return {
    next(timeoutMs = 0) {
      if (q.length) return Promise.resolve(q.shift())
      if (closed) return Promise.resolve(null)
      return new Promise((resolve) => {
        resolveNext = resolve
        if (timeoutMs) setTimeout(() => { if (resolveNext === resolve) { resolveNext = null; resolve(null) } }, timeoutMs)
      })
    },
  }
}

// ------------------------------------------------------------------ standalone
const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href
if (isMain) {
  // Quick smoke: needs cookies from a logged-in profile (see tools/noise-chat.mjs).
  const cookies = process.env.MUSE_COOKIES || ''
  const prompt = process.argv[2] || 'Say hello in exactly three words.'
  const client = new MuseNoiseClient({ cookies, log: (...a) => console.error('[noise]', ...a) })
  client.connect().then(async () => {
    const h = await client.chatHistory()
    console.error('[noise] chat.history status', h.status)
    const r = await client.chat(prompt, { timeoutMs: 120000 })
    console.error('[noise] events:', r.events.length, 'replyReady:', r.replyReady)
    console.log(r.reply)
    client.close()
    process.exit(0)
  }).catch((e) => { console.error('[noise] fatal', e.message); process.exit(1) })
}

// Muse answers with this canned text when its backend fails; surface it as an error.
const SORRY_RE = /^\s*Sorry, I ran into a problem while responding\.?\s*Please try again\.?\s*$/i
export function isMuseSorry(text) { return SORRY_RE.test(String(text || '')) }
export function museSorryError(text, sessionId) {
  const e = new Error(String(text).trim())
  e.noRetry = true
  e.museError = true
  if (sessionId) e.sessionId = sessionId
  return e
}
function sessionIdReused(opts) { return !!opts.sessionId }
