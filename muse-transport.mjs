#!/usr/bin/env node
/**
 * muse-transport.mjs — Phase 2 transport switch.
 *
 * Picks the backend for the MCP server / OpenAI shim based on MUSE_TRANSPORT:
 *   MUSE_TRANSPORT=browser (default) -> drive the real logged-in Chrome (muse-driver.mjs)
 *   MUSE_TRANSPORT=noise             -> headless Noise_XX client (muse-noise.mjs), no browser
 *
 * Both expose the same facade methods the server/shim call (status, login,
 * chat, chatStream, readLast, readChat, listChats, chatMedia, close, ...).
 * Over the noise transport attachments upload via /fs/write, media is read from
 * the workspace via /fs/raw, and chats are listed via /api/session/list. Only
 * openChat (single active session) and dump_dom (no DOM) remain browser-only.
 *
 * The noise transport still needs the login cookies; they are read once from
 * the same persistent Chrome profile the browser driver uses (headless, then
 * closed) and cached for the session.
 */
import path from 'node:path'
import { promises as fsp } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { driver } from './muse-driver.mjs'
import { MuseNoiseClient } from './muse-noise.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROFILE_DIR = process.env.MUSE_PROFILE_DIR || path.join(__dirname, '.muse-profile')
const APP_URL = process.env.MUSE_URL || 'https://muse.ai/'
const CHANNEL = process.env.MUSE_CHANNEL || 'chrome'
const TRANSPORT = (process.env.MUSE_TRANSPORT || 'browser').toLowerCase()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.error('[muse-transport]', ...a)

// Read login cookies from the persistent profile without keeping a browser open.
async function grabCookies() {
  const { chromium } = await import('playwright-core')
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: CHANNEL, headless: true, viewport: { width: 1366, height: 900 },
    args: ['--no-sandbox', '--disable-gpu', '--disable-blink-features=AutomationControlled'],
  })
  try {
    const p = ctx.pages()[0] || await ctx.newPage()
    await p.goto(APP_URL, { waitUntil: 'domcontentloaded' })
    await sleep(2500)
    return await ctx.cookies()
  } finally {
    await ctx.close().catch(() => {})
  }
}

// Pull assistant/user display texts out of a /chat/history payload.
function historyMessages(json) {
  const evs = (json && json.result && json.result.chat_events) || (json && json.chat_events) || []
  const msgs = []
  for (const e of evs) {
    const name = e.event_name || e.event
    if (name !== 'message.user' && name !== 'message.assistant') continue
    const text = typeof e.display_text === 'string' ? e.display_text.trim() : ''
    if (text) msgs.push({ role: name === 'message.assistant' ? 'assistant' : 'user', text })
  }
  return msgs
}

const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', pdf: 'application/pdf',
  txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
}
const mimeFor = (name) => MIME[String(name).toLowerCase().split('.').pop()] || 'application/octet-stream'

// Read a local path or http(s) URL into bytes.
async function readRef(ref) {
  if (/^https?:\/\//i.test(ref)) {
    const res = await fetch(ref)
    if (!res.ok) throw new Error(`fetch ${ref} -> ${res.status}`)
    return { bytes: new Uint8Array(await res.arrayBuffer()), name: ref.split('/').pop().split('?')[0] || 'file' }
  }
  const buf = await fsp.readFile(ref)
  return { bytes: new Uint8Array(buf), name: ref.split('/').pop().split('\\').pop() || 'file' }
}

// Extract generated/attached media from a list of chat events (history or live).
function extractMedia(events) {
  const out = []
  const seen = new Set()
  const add = (path, mime, label, kind) => {
    if (!path) return
    const key = String(path)
    if (seen.has(key)) return
    seen.add(key)
    out.push({ path, uri: path.startsWith('sandbox://') ? path : `sandbox://${path}`, mime: mime || mimeFor(path), label: label || '', kind: kind || 'file' })
  }
  for (const e of events) {
    const pl = e.payload || e
    const name = e.event_name || e.event
    // presentation events (live + history): payload.data.{images,videos,files,audio}
    const data = pl.data || {}
    for (const bucket of ['images', 'videos', 'files', 'audio']) {
      const arr = data[bucket]
      if (Array.isArray(arr)) for (const it of arr) add(it.path || it.uri, it.mime || it.mimeType, it.label || it.name, bucket)
    }
    // message.assistant presentations[] (history) may nest the same shape
    if (Array.isArray(pl.presentations)) for (const pr of pl.presentations) {
      const d = pr.data || pr
      for (const bucket of ['images', 'videos', 'files', 'audio']) {
        const arr = d[bucket]
        if (Array.isArray(arr)) for (const it of arr) add(it.path || it.uri, it.mime || it.mimeType, it.label || it.name, bucket)
      }
    }
    // media_paths (some payloads)
    if (Array.isArray(pl.media_paths)) for (const p of pl.media_paths) add(p, pl.media_type, '', pl.media_type || 'file')
    // markdown sandbox:// images in text
    const text = typeof pl.display_text === 'string' ? pl.display_text : typeof pl.text === 'string' ? pl.text : ''
    const re = /!\[[^\]]*\]\((sandbox:\/\/[^)]+)\)/g
    let m
    while ((m = re.exec(text))) add(m[1], '', '', 'image')
  }
  return out
}

class NoiseTransport {
  constructor() { this.client = null; this.cookies = null; this.viewerId = null; this._connecting = null; this._q = Promise.resolve() }
  async ensure() {
    if (this.client && this.client.ws && this.client.ws.readyState === 1) return this.client
    if (this.client) { try { this.client.close() } catch {}; this.client = null } // stale/closed -> drop it
    if (this._connecting) return this._connecting // dedupe concurrent callers (one cookie-grab / connect)
    this._connecting = (async () => {
      try {
        if (!this.cookies) this.cookies = await grabCookies()
        const c = new MuseNoiseClient({ cookies: this.cookies, log })
        await c.connect()
        this.client = c
        return c
      } finally {
        this._connecting = null
      }
    })()
    return this._connecting
  }
  async _reconnect() {
    try { this.client?.close() } catch {}
    this.client = null; this.cookies = null
    return this.ensure()
  }
  async launch() { await this.ensure(); return { ok: true, transport: 'noise' } }
  async status() {
    const connected = !!(this.client && this.client.ws && this.client.ws.readyState === 1)
    return {
      browserRunning: false, url: APP_URL, transport: 'noise',
      loggedIn: !!this.cookies, connected, viewerId: this.viewerId,
      profileDir: PROFILE_DIR, headless: true,
    }
  }
  async login(opts = {}) {
    // Noise has no login UI: it needs auth cookies in the shared profile. If
    // none are cached yet and unattended credentials are supplied, drive a
    // one-shot browser sign-in (mailtemp OTP) to seed the profile first.
    if (!this.cookies) {
      const email = opts.email || process.env.MUSE_META_EMAIL || ''
      const hasCreds = !!(opts.metaPassword || opts.mailPassword || opts.apiKey ||
        process.env.MUSE_META_PASSWORD || process.env.MUSE_MAIL_PASSWORD || process.env.MUSE_MAILTEMP_API_KEY)
      if (email && hasCreds && opts.auto !== false) {
        try { await driver.login({ ...opts, email }) }
        catch (e) { log('noise: browser seed sign-in failed:', e.message) }
        await driver.close().catch(() => {}) // release the profile lock before grabCookies()
      }
    }
    const c = await this.ensure()
    const h = await c.chatHistory(1)
    this.viewerId = (h.json && h.json.result && h.json.result.viewer_id) || null
    return { loggedIn: h.status === 200, transport: 'noise', viewerId: this.viewerId }
  }
  async newChat() { return { ok: true, transport: 'noise', note: 'over noise a new side chat is created per request via new_thread/newSession (the thread materializes on first send)' } }
  // Serialize chat turns: noise has a single active session and every turn
  // subscribes to the same event feed, so concurrent chats cross-contaminate
  // (each sees the other's deltas and breaks on the wrong message_done). Reads
  // (list/media/history) use independent stream_ids and stay parallel.
  _serial(fn) {
    const run = this._q.then(() => fn())
    this._q = run.then(() => {}, () => {}) // keep the chain alive on rejection
    return run
  }
  async _run(prompt, opts = {}) {
    const t0 = Date.now()
    const onDelta = opts.onDelta
    const refs = opts.files || []
    const attachments = []
    for (let attempt = 0; attempt < 2; attempt++) {
      const client = await this.ensure()
      try {
        if (!attachments.length) {
          for (const ref of refs) {
            try {
              const { bytes, name } = await readRef(ref)
              const up = await client.uploadAttachment(bytes, name, mimeFor(name))
              attachments.push(up)
            } catch (e) { log('attachment failed:', ref, e.message) }
          }
        }
        let committed = ''
        const r = await client.chat(prompt, {
          timeoutMs: opts.timeoutMs || 120000,
          attachments,
          newSession: !!(opts.newSession || opts.newThread),
          sessionId: opts.sessionId || opts.chat || null,
          onEvent: (ev) => {
            if (!onDelta) return
            if ((ev.event || ev.event_name) === 'delta.text_append' && typeof ev.payload?.text === 'string') {
              committed += ev.payload.text
              try { onDelta(committed) } catch {}
            }
          },
        })
        return {
          reply: r.reply,
          messages: r.reply ? [r.reply] : [],
          threadUrl: APP_URL,
          elapsedMs: Date.now() - t0,
          transport: 'noise',
          ...(r.sessionId ? { sessionId: r.sessionId } : {}),
          ...(attachments.length ? { attachments } : {}),
          ...(r.replyReady ? {} : { timedOut: true }),
        }
      } catch (e) {
        if (e.noRetry) throw e // Muse itself reported an error: return it to the caller as-is
        log('chat attempt', attempt, 'failed:', e.message)
        try { this.client?.close() } catch {}
        this.client = null // keep cookies; force a fresh connection on retry
        if (attempt === 1) throw e
      }
    }
  }
  // A new-session turn gets its own thread + event feed, so concurrent ones are
  // isolated and can run in parallel (no serialization). Turns on the shared
  // active session must be serialized to avoid cross-contamination.
  async chat(prompt, opts = {}) { return (opts.newSession || opts.newThread) ? this._run(prompt, opts) : this._serial(() => this._run(prompt, opts)) }
  async chatStream(prompt, opts = {}) { return (opts.newSession || opts.newThread) ? this._run(prompt, opts) : this._serial(() => this._run(prompt, opts)) }
  async readLast() {
    const h = await (await this.ensure()).chatHistory(50)
    const msgs = historyMessages(h.json)
    const last = [...msgs].reverse().find((m) => m.role === 'assistant')
    return { reply: last ? last.text : '', messages: msgs.map((m) => m.text), threadUrl: APP_URL }
  }
  async readChat(max = 100) {
    const h = await (await this.ensure()).chatHistory(max)
    const evs = (h.json && h.json.result && h.json.result.chat_events) || []
    const msgs = historyMessages(h.json)
    const media = extractMedia(evs)
    return { messages: msgs.map((m) => m.text), entries: msgs.length, media, transport: 'noise' }
  }
  async listChats(query) {
    const s = await (await this.ensure()).listSessions()
    const sessions = (s.json && s.json.result && s.json.result.sessions) || []
    let chats = sessions.map((c) => ({
      title: c.title || c.snippet || '(untitled)',
      active: !!c.is_primary,
      pinned: !!c.pinned,
      archived: !!c.archived,
      session_id: c.session_id,
      snippet: c.snippet || '',
      updated_at_ms: c.updated_at_ms,
    }))
    if (query) { const q = String(query).toLowerCase(); chats = chats.filter((c) => c.title.toLowerCase().includes(q) || c.snippet.toLowerCase().includes(q)) }
    return { chats, threadUrl: APP_URL, transport: 'noise' }
  }
  async openChat(target) { return { ok: false, note: 'open_chat is not supported over the noise transport (single active session)', transport: 'noise' } }
  async chatMedia(chat, { download = false, dir } = {}) {
    const client = await this.ensure()
    const h = await client.chatHistory(100)
    const evs = (h.json && h.json.result && h.json.result.chat_events) || []
    const media = extractMedia(evs)
    const items = media.map((m, index) => ({ index, role: '', text: m.label, urls: [m.uri] }))
    const urls = media.map((m) => m.uri)
    const result = { items, urls, count: urls.length, threadUrl: APP_URL, transport: 'noise' }
    if (download && media.length) {
      const outDir = dir || path.join(__dirname, 'downloads')
      await fsp.mkdir(outDir, { recursive: true })
      const saved = []
      for (const m of media) {
        try {
          const r = await client.fsRaw(m.path)
          if (r.status === 200 && r.body.length) {
            const file = path.join(outDir, (m.path.split('/').pop() || 'media').replace(/[^\w.\-]/g, '_'))
            await fsp.writeFile(file, r.body)
            saved.push({ path: m.path, file, bytes: r.body.length })
          } else saved.push({ path: m.path, error: `fs.raw ${r.status}` })
        } catch (e) { saved.push({ path: m.path, error: e.message }) }
      }
      result.downloads = saved
    }
    return result
  }
  // Usage needs only the login cookies (plain HTTPS RSC action), not the noise WS.
  async usage() {
    let c = this.client
    if (!c) {
      if (!this.cookies) this.cookies = await grabCookies()
      c = new MuseNoiseClient({ cookies: this.cookies, log })
    }
    return { ...(await c.usage()), transport: 'noise' }
  }
  async dumpDom() { return { note: 'dump_dom is a browser-only diagnostic (noise transport has no DOM)', transport: 'noise' } }
  async close() { try { this.client?.close() } catch {} this.client = null }
}

export const transport = TRANSPORT === 'noise' ? new NoiseTransport() : driver
export default transport
