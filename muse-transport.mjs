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
import './muse-env.mjs' // .env must land in process.env before any MUSE_* is read below
import path from 'node:path'
import fs, { promises as fsp } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { accountCreds, loadDotEnv } from './muse-env.mjs'
import { driver, MuseDriver, clearStaleSingleton } from './muse-driver.mjs'
import { MuseNoiseClient } from './muse-noise.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROFILE_DIR = process.env.MUSE_PROFILE_DIR || path.join(__dirname, 'accounts', 'acc1')
const APP_URL = process.env.MUSE_URL || 'https://muse.ai/'
const CHANNEL = process.env.MUSE_CHANNEL || 'chrome'
// MUSE_CHROME_PATH: launch this browser binary instead of the installed Chrome channel (e.g. Playwright's cached Chromium).
const CHROME_PATH = process.env.MUSE_CHROME_PATH || ''
const TRANSPORT = (process.env.MUSE_TRANSPORT || 'browser').toLowerCase()
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.error('[muse-transport]', ...a)

// Read login cookies from a persistent profile without keeping a browser open.
async function grabCookies(profileDir = PROFILE_DIR) {
  const { chromium } = await import('playwright-core')
  clearStaleSingleton(profileDir) // a killed server leaves Chrome's singleton files behind
  const ctx = await chromium.launchPersistentContext(profileDir, {
    ...(CHROME_PATH ? { executablePath: CHROME_PATH } : { channel: CHANNEL }), headless: true, viewport: { width: 1366, height: 900 },
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

const extFor = (mime) => Object.keys(MIME).find((k) => MIME[k] === mime) || 'bin'

// Read a local path, http(s)/data: URL, or the shim's { url } / { buffer, name, mimeType } file refs into bytes.
// `n` (1-based position in the files list) names data: URLs `attachment-<n>.<ext>` so the numbering stays visible.
async function readRef(ref, n = 1) {
  if (ref && typeof ref === 'object') {
    if (ref.buffer) {
      const buf = Buffer.isBuffer(ref.buffer) ? ref.buffer : Buffer.from(ref.buffer, 'base64')
      return { bytes: new Uint8Array(buf), name: ref.name || `attachment-${n}`, mime: ref.mimeType }
    }
    ref = ref.url || ref.path || ''
  }
  const data = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(ref)
  if (data) {
    const mime = data[1] || 'application/octet-stream'
    return { bytes: new Uint8Array(Buffer.from(data[3], data[2] ? 'base64' : 'utf8')), name: `attachment-${n}.${extFor(mime)}`, mime }
  }
  if (/^file:\/\//i.test(ref)) ref = fileURLToPath(ref)
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
  constructor() {
    this.accounts = new Map() // id -> { id, profileDir, cookies, client, viewerId, connecting, q, inflight, downUntil }
    this.order = []
    this._rr = 0 // round-robin cursor for load balancing
    this.base = path.resolve(__dirname, process.env.MUSE_ACCOUNTS_DIR || 'accounts')
    const entries = (process.env.MUSE_ACCOUNTS || '').split(',').map((s) => s.trim()).filter(Boolean)
    // `*` = every profile folder under MUSE_ACCOUNTS_DIR, re-scanned while running: drop a new logged-in
    // profile into accounts/<id> (creds in .env) and it joins the pool without a restart
    this.scan = entries.includes('*')
    this.scanEveryMs = Math.max(0, Number(process.env.MUSE_ACCOUNTS_RESCAN_SEC ?? 30)) * 1000
    this.scannedAt = 0
    entries.filter((e) => e !== '*').forEach((e, i) => {
      const eq = e.indexOf('=')
      let id, dir
      if (eq > 0) { id = e.slice(0, eq).trim(); dir = path.resolve(__dirname, e.slice(eq + 1).trim()) }
      else { id = e; dir = path.join(this.base, e) } // bare id -> <MUSE_ACCOUNTS_DIR>/<id> (default ./accounts)
      this._add(id || `acc${i + 1}`, dir)
    })
    if (this.scan) this._rescan(true)
    if (!this.order.length) this._add('default', PROFILE_DIR)
    this.defaultId = this.order[0]
  }
  _add(id, profileDir) {
    if (this.accounts.has(id)) return
    // creds come from .env (MUSE_ACCOUNT_<ID>_*), never from literals in this file
    this.accounts.set(id, { id, profileDir, creds: accountCreds(id), cookies: null, client: null, viewerId: null, connecting: null, inflight: 0, downUntil: 0, q: Promise.resolve() })
    this.order.push(id)
  }
  // Pick up profile folders added under MUSE_ACCOUNTS_DIR since the last scan (only with `*` in MUSE_ACCOUNTS).
  // A folder counts once it is a Chrome profile (has Default/); hidden folders are skipped. Folders that vanish
  // leave the pool (not the default account, not while a turn runs on it). Throttled to MUSE_ACCOUNTS_RESCAN_SEC (default 30).
  _rescan(force = false) {
    if (!this.scan) return
    const now = Date.now()
    if (!force && now - this.scannedAt < this.scanEveryMs) return
    this.scannedAt = now
    let names
    try { names = fs.readdirSync(this.base, { withFileTypes: true }) } catch { return }
    const dirs = new Map(names
      .filter((d) => (d.isDirectory() || d.isSymbolicLink()) && !d.name.startsWith('.'))
      .map((d) => [d.name, path.join(this.base, d.name)])
      .filter(([, dir]) => fs.existsSync(path.join(dir, 'Default'))))
    const real = (dir) => { try { return fs.realpathSync(dir) } catch { return dir } }
    const known = new Set([...this.accounts.values()].map((a) => real(a.profileDir))) // same folder under two names = one account
    const added = []
    for (const [id, dir] of [...dirs].sort(([x], [y]) => x.localeCompare(y))) {
      if (this.accounts.has(id) || known.has(real(dir))) continue
      if (!added.length && this.defaultId) { // after start: re-read .env for creds added since
        loadDotEnv(undefined, { refresh: true })
        for (const a of this.accounts.values()) a.creds = accountCreds(a.id)
      }
      this._add(id, dir)
      added.push(id)
    }
    const gone = this.order.filter((id) => {
      const a = this.accounts.get(id)
      return id !== this.defaultId && !(a.inflight > 0) && path.dirname(a.profileDir) === this.base && !dirs.has(path.basename(a.profileDir))
    })
    for (const id of gone) {
      const a = this.accounts.get(id)
      try { a.client?.close() } catch {}
      this.accounts.delete(id)
    }
    if (gone.length) this.order = this.order.filter((id) => this.accounts.has(id))
    if (this.defaultId && (added.length || gone.length)) log('accounts rescan: +', added.join(',') || '-', ' -', gone.join(',') || '-', '→', this.order.length)
  }
  _acct(id) {
    id = id || this.defaultId
    if (!this.accounts.has(id)) this._rescan(true) // a just-added profile named explicitly
    const a = this.accounts.get(id)
    if (!a) throw new Error(`unknown account "${id}" (known: ${this.order.join(', ')})`)
    return a
  }
  async _ensure(a) {
    if (a.client && a.client.ws && a.client.ws.readyState === 1) return a.client
    if (a.client) { try { a.client.close() } catch {}; a.client = null } // stale/closed -> drop it
    if (a.connecting) return a.connecting // dedupe concurrent callers (one cookie-grab / connect)
    a.connecting = (async () => {
      try {
        if (!a.cookies) a.cookies = await grabCookies(a.profileDir)
        const c = new MuseNoiseClient({ cookies: a.cookies, log })
        await c.connect()
        a.client = c
        return c
      } finally {
        a.connecting = null
      }
    })()
    return a.connecting
  }
  async _reconnect(a) {
    try { a.client?.close() } catch {}
    a.client = null; a.cookies = null
    return this._ensure(a)
  }
  // Serialize chat turns PER ACCOUNT: noise has one active session per account and
  // every turn subscribes to the same feed, so concurrent chats on the same account
  // cross-contaminate. Different accounts run in parallel (separate connections).
  _serial(a, fn) {
    const run = a.q.then(() => fn())
    a.q = run.then(() => {}, () => {}) // keep the chain alive on rejection
    return run
  }
  async launch(opts = {}) { await this._ensure(this._acct(opts.account)); return { ok: true, transport: 'noise', accounts: this.order, defaultAccount: this.defaultId } }
  async status(opts = {}) {
    const a = this._acct(opts.account)
      const accounts = this.order.map((id) => { const x = this.accounts.get(id); return { id: x.id, email: x.creds.email || null, profileDir: x.profileDir, loggedIn: !!x.cookies, connected: !!(x.client && x.client.ws && x.client.ws.readyState === 1), inflight: x.inflight || 0, viewerId: x.viewerId } })
    const connected = !!(a.client && a.client.ws && a.client.ws.readyState === 1)
    return {
      browserRunning: false, url: APP_URL, transport: 'noise',
      account: a.id, defaultAccount: this.defaultId,
      loggedIn: !!a.cookies, connected, viewerId: a.viewerId,
      profileDir: a.profileDir, headless: true, accounts,
    }
  }
  async login(opts = {}) {
    // Noise has no login UI: it needs auth cookies in the account's profile. If
    // none are cached yet and unattended credentials are supplied, drive a
    // one-shot browser sign-in (mailtemp OTP) into that profile to seed it.
    const a = this._acct(opts.account)
    if (!a.cookies) {
      const creds = a.creds
      const email = opts.email || creds.email
      const mailPassword = opts.mailPassword || creds.mailPassword
      const metaPassword = opts.metaPassword || creds.metaPassword
      const apiKey = opts.apiKey || creds.apiKey
      const hasCreds = !!(metaPassword || mailPassword || apiKey)
      if (email && hasCreds && opts.auto !== false) {
        const d = new MuseDriver(a.profileDir)
        try { await d.login({ ...opts, email, metaPassword, mailPassword, apiKey }) }
        catch (e) { log('noise: browser seed sign-in failed:', e.message) }
        await d.close().catch(() => {}) // release the profile lock before grabCookies()
      }
    }
    const c = await this._ensure(a)
    const h = await c.chatHistory(1)
    a.viewerId = (h.json && h.json.result && h.json.result.viewer_id) || null
    return { account: a.id, loggedIn: h.status === 200, transport: 'noise', viewerId: a.viewerId }
  }
  async newChat(opts = {}) { const a = this._acct(opts.account); return { ok: true, transport: 'noise', account: a.id, note: 'over noise a new side chat is created per request via new_thread/newSession (the thread materializes on first send)' } }
  async _run(a, prompt, opts = {}) {
    const t0 = Date.now()
    const onDelta = opts.onDelta
    const refs = opts.files || []
    const attachments = []
    for (let attempt = 0; attempt < 2; attempt++) {
      const client = await this._ensure(a)
      try {
        if (!attachments.length) {
          for (const [i, ref] of refs.entries()) {
            try {
              const { bytes, name, mime } = await readRef(ref, i + 1)
              const up = await client.uploadAttachment(bytes, name, mime || mimeFor(name))
              attachments.push(up)
            } catch (e) { log('attachment failed:', ref, e.message) }
          }
        }
        let committed = ''
        const r = await client.chat(prompt, {
          timeoutMs: opts.timeoutMs || Number(process.env.MUSE_STALL_IDLE_MS || 120000), // idle gap between events (activity-based; see _chatOnce)
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
          account: a.id,
          ...(r.sessionId ? { sessionId: r.sessionId } : {}),
          ...(attachments.length ? { attachments } : {}),
          ...(r.replyReady ? {} : { timedOut: true }),
        }
      } catch (e) {
        if (e.noRetry) throw e // Muse itself reported an error: return it to the caller as-is
        log('chat attempt', attempt, 'failed:', e.message)
        try { a.client?.close() } catch {}
        a.client = null // keep cookies; force a fresh connection on retry
        if (attempt === 1) throw e
      }
    }
  }
  // Assign a turn to an account, tracking in-flight so least_conn can balance.
  // New-session turns run in parallel (own feed); shared-session turns serialize
  // per account to avoid cross-contamination.
  _turn(a, prompt, opts = {}) {
    a.inflight = (a.inflight || 0) + 1
    const settle = (r) => { a.inflight = Math.max(0, (a.inflight || 0) - 1); return r }
    const fail = (e) => { a.inflight = Math.max(0, (a.inflight || 0) - 1); throw e }
    const p = (opts.newSession || opts.newThread) ? this._run(a, prompt, opts) : this._serial(a, () => this._run(a, prompt, opts))
    return p.then(settle, fail)
  }
  // Ordered candidate accounts for a request that did NOT name one.
  // MUSE_ACCOUNT_LB: round_robin (default when >1 account) | least_conn | first|none (pin default).
  _lbCandidates(opts = {}) {
    this._rescan()
    const ranked = this._lbOrder()
    // an account that just failed (not logged in, rate-limited, mid-login) goes last until its cooldown ends,
    // so a broken profile does not cost every request a Chromium launch
    const now = Date.now()
    return [...ranked.filter((a) => !(a.downUntil > now)), ...ranked.filter((a) => a.downUntil > now)]
  }
  _lbOrder() {
    const n = this.order.length
    if (n <= 1) return [this._acct()]
    const mode = (process.env.MUSE_ACCOUNT_LB || 'round_robin').toLowerCase()
    if (mode === 'first' || mode === 'none') return [this._acct()]
    const list = this.order.map((id) => this.accounts.get(id))
    if (mode === 'least_conn') return [...list].sort((a, b) => (a.inflight || 0) - (b.inflight || 0))
    const start = ((this._rr++ % n) + n) % n
    return Array.from({ length: n }, (_, i) => list[(start + i) % n])
  }
  // Try candidate accounts in LB order; on a connection/serve failure, fail over
  // to the next so one dead or rate-limited account doesn't sink the request.
  async _turnWithFailover(cands, prompt, opts = {}) {
    let last
    for (const a of cands) {
      try { return await this._turn(a, prompt, opts) }
      catch (e) {
        last = e
        log('LB failover from', a.id, ':', e && e.message)
        if (cands.length > 1) {
          a.downUntil = Date.now() + Math.max(0, Number(process.env.MUSE_ACCOUNT_COOLDOWN_SEC ?? 60)) * 1000
          a.cookies = null // re-read the profile after the cooldown (it may have been signed in meanwhile)
        }
      }
    }
    throw last
  }
  // A new-session turn gets its own thread + event feed, so concurrent ones are
  // isolated and can run in parallel (no serialization). Turns on the shared
  // active session must be serialized to avoid cross-contamination.
  async chat(prompt, opts = {}) {
    if (opts.account) return this._turn(this._acct(opts.account), prompt, opts)
    return this._turnWithFailover(this._lbCandidates(opts), prompt, opts)
  }
  async chatStream(prompt, opts = {}) {
    if (opts.account) return this._turn(this._acct(opts.account), prompt, opts)
    return this._turnWithFailover(this._lbCandidates(opts), prompt, opts)
  }
  async readLast(opts = {}) {
    const a = this._acct(opts.account)
    const h = await (await this._ensure(a)).chatHistory(50)
    const msgs = historyMessages(h.json)
    const last = [...msgs].reverse().find((m) => m.role === 'assistant')
    return { reply: last ? last.text : '', messages: msgs.map((m) => m.text), threadUrl: APP_URL, account: a.id }
  }
  async readChat(max = 100, opts = {}) {
    const a = this._acct(opts.account)
    const h = await (await this._ensure(a)).chatHistory(max)
    const evs = (h.json && h.json.result && h.json.result.chat_events) || []
    const msgs = historyMessages(h.json)
    const media = extractMedia(evs)
    return { messages: msgs.map((m) => m.text), entries: msgs.length, media, transport: 'noise', account: a.id }
  }
  async listChats(query, opts = {}) {
    const a = this._acct(opts.account)
    const s = await (await this._ensure(a)).listSessions()
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
    return { chats, threadUrl: APP_URL, transport: 'noise', account: a.id }
  }
  async openChat(target, opts = {}) { return { ok: false, note: 'open_chat is not supported over the noise transport (single active session)', transport: 'noise' } }
  async chatMedia(chat, { download = false, dir, account } = {}) {
    const a = this._acct(account)
    const client = await this._ensure(a)
    const h = await client.chatHistory(100)
    const evs = (h.json && h.json.result && h.json.result.chat_events) || []
    const media = extractMedia(evs)
    const items = media.map((m, index) => ({ index, role: '', text: m.label, urls: [m.uri] }))
    const urls = media.map((m) => m.uri)
    const result = { items, urls, count: urls.length, threadUrl: APP_URL, transport: 'noise', account: a.id }
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
  async usage(opts = {}) {
    const a = this._acct(opts.account)
    let c = a.client
    if (!c) {
      if (!a.cookies) a.cookies = await grabCookies(a.profileDir)
      c = new MuseNoiseClient({ cookies: a.cookies, log })
    }
    return { ...(await c.usage()), account: a.id, transport: 'noise' }
  }
  async dumpDom(max, opts = {}) { return { note: 'dump_dom is a browser-only diagnostic (noise transport has no DOM)', transport: 'noise' } }
  async close(opts = {}) { for (const a of this.accounts.values()) { try { a.client?.close() } catch {} a.client = null } }
}

export const transport = TRANSPORT === 'noise' ? new NoiseTransport() : driver
export default transport
