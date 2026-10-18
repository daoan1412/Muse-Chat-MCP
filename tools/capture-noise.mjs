#!/usr/bin/env node
/**
 * tools/capture-noise.mjs — reconnaissance for Phase 2 (headless Noise client).
 *
 * Drives a real Chrome, logs in to Muse with the Meta account, sends a prompt,
 * and records everything needed to re-implement the encrypted chat transport:
 *   - raw WebSocket frames (handshake + RPC) via an in-page WebSocket hook
 *   - the client JS bundles (where the Noise keys / pattern / framing live)
 *   - the REST calls (auth/check, session, wake) and a HAR
 *
 * Artifacts land in ./captures (git-ignored). Re-run reuses the login profile.
 *
 *   node tools/capture-noise.mjs                 # login (if needed) + capture
 *   MUSE_PROMPT="hi" node tools/capture-noise.mjs
 *   MUSE_HEADLESS=0 node tools/capture-noise.mjs # watch it in a window
 */
import '../muse-env.mjs' // credentials come from .env, never from literals in this file
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { accountCreds } from '../muse-env.mjs'
import { clearStaleSingleton } from '../muse-driver.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const CAP = path.join(ROOT, 'captures')
const PROFILE = process.env.MUSE_PROFILE_DIR || path.join(ROOT, '.muse-profile')
// MUSE_ACCOUNT_ID picks one account from the .env pool; empty = the global MUSE_* vars.
const creds = accountCreds(process.env.MUSE_ACCOUNT_ID || '')
const BASE = (process.env.MUSE_MAILTEMP_URL || 'https://mailtemp.vn').replace(/\/+$/, '')
const EMAIL = process.env.MUSE_META_EMAIL || creds.email
const META_PASS = process.env.MUSE_META_PASSWORD || creds.metaPassword
const MAIL_PASS = process.env.MUSE_MAIL_PASSWORD || creds.mailPassword
const MAIL_API = `${BASE}/api/site`
const PROMPT = process.env.MUSE_PROMPT || 'Say hello in exactly three words.'
const HEADLESS = process.env.MUSE_HEADLESS !== '0'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.error('[capture]', ...a)

if (!EMAIL || !MAIL_PASS) {
  console.error('capture-noise: no credentials found. Set MUSE_META_EMAIL + MUSE_MAIL_PASSWORD,')
  console.error('or MUSE_ACCOUNT_ID=<id> with that account defined in .env — nothing is hardcoded here anymore.')
  process.exit(1)
}

fs.mkdirSync(CAP, { recursive: true })
fs.mkdirSync(path.join(CAP, 'js'), { recursive: true })

// ------------------------------------------------------------------ mailtemp
async function mailUnlock() {
  const r = await fetch(`${MAIL_API}/unlock`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ address: EMAIL, password: MAIL_PASS }),
  })
  if (!r.ok) throw new Error(`mail unlock ${r.status}: ${await r.text()}`)
  const j = await r.json()
  return j.token
}
async function mailCodes(token) {
  const r = await fetch(`${MAIL_API}/inbox?address=${encodeURIComponent(EMAIL)}`, { headers: { 'x-mailbox-token': token } })
  if (!r.ok) throw new Error(`mail inbox ${r.status}: ${await r.text()}`)
  const j = await r.json()
  return (j.messages || []).map((m) => ({ id: m.id, subject: m.subject, code: m.code, from: m.from, receivedAt: m.receivedAt }))
}
async function waitCode(token, seenIds, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const msgs = await mailCodes(token)
    const fresh = msgs.filter((m) => !seenIds.has(m.id) && m.code && /\b\d{5,6}\b/.test(m.code))
    if (fresh.length) { const m = fresh[0]; return { code: m.code.match(/\b\d{5,6}\b/)[0], subject: m.subject, id: m.id } }
    await sleep(2500)
  }
  return null
}

// ------------------------------------------------------------------ login
async function findInput(p, names) {
  // Match by name, then by placeholder / aria-label keyword, then by type.
  for (const n of names) {
    const byName = p.locator(`input[name="${n}"]`)
    if (await byName.count()) return byName.first()
  }
  const kw = {
    email: ['mobile number or email', 'email', 'phone'],
    password: ['password'],
    code: ['code', 'security', 'confirmation'],
  }
  const kinds = [...new Set(names.map((n) => (n === 'password' ? 'password' : n === 'code' ? 'code' : 'email')))]
  for (const k of kinds) {
    for (const word of kw[k]) {
      const byPh = p.locator(`input[placeholder*="${word}" i], input[aria-label*="${word}" i]`)
      if (await byPh.count()) return byPh.first()
    }
  }
  if (names.includes('password')) {
    const pw = p.locator('input[type="password"]')
    if (await pw.count()) return pw.first()
  }
  return null
}
async function clickButton(p, re) {
  const btn = p.getByRole('button', { name: re }).first()
  if (await btn.count()) { await btn.click({ timeout: 5000 }).catch(() => {}); return true }
  return false
}
async function dumpStage(p, tag) {
  const info = await p.evaluate(() => ({
    url: location.href,
    title: document.title,
    inputs: [...document.querySelectorAll('input')].map((i) => ({ name: i.name, type: i.type, ph: i.placeholder })),
    buttons: [...document.querySelectorAll('button')].map((b) => (b.innerText || '').replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 12),
    text: document.body.innerText.replace(/\s+/g, ' ').slice(0, 300),
  })).catch(() => ({ url: p.url(), err: 'eval failed' }))
  log(`stage ${tag}:`, JSON.stringify(info))
  return info
}

async function isLoggedIn(p) {
  try {
    const r = await p.evaluate(async () => {
      try { const res = await fetch('/api/auth/check', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', credentials: 'same-origin' }); const j = await res.json().catch(() => null); return !!(j && j.ok) } catch { return false }
    })
    return r
  } catch { return false }
}

async function detectScreen(p) {
  return p.evaluate(() => {
    const has = (sel) => !!document.querySelector(sel)
    const txt = () => document.body.innerText
    if (has('[data-hatch-composer-root]')) return 'app'
    if (has('input[aria-label*="code" i]') || /enter your code|resend code/i.test(txt())) return 'code'
    if (has('input[type="password"]')) return 'password'
    if (has('input[placeholder*="mobile" i]') || /log in or create an account/i.test(txt())) return 'email'
    if (/remember this device|use this device|this was me|save login|not now/i.test(txt())) return 'device'
    return 'other'
  }).catch(() => 'other')
}

async function login(p) {
  if (await isLoggedIn(p)) { log('already logged in'); return true }
  await p.goto('https://muse.ai/', { waitUntil: 'domcontentloaded', timeout: 60000 })
  await sleep(1500)
  await dumpStage(p, 'landing')

  const token = await mailUnlock()
  const seen = new Set((await mailCodes(token)).map((m) => m.id))

  for (let step = 0; step < 20; step++) {
    if (await isLoggedIn(p)) { log('logged in at step', step); return true }
    const screen = await detectScreen(p)
    log(`step ${step}: screen=${screen}`)

    if (screen === 'email') {
      const email = await findInput(p, ['email'])
      if (email) {
        const val = await email.evaluate((e) => e.value).catch(() => '')
        if (!val) await email.fill(EMAIL)
        await email.evaluate((e) => { e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })) }).catch(() => {})
        await sleep(500)
        const clicked = await clickButton(p, /continue|tiếp tục/i)
        if (!clicked) await email.press('Enter')
        await sleep(3500); continue
      }
    }
    if (screen === 'password') {
      const pass = await findInput(p, ['password'])
      if (pass) { await pass.fill(META_PASS || MAIL_PASS); await sleep(300); await clickButton(p, /continue|next|log in|sign in|submit|tiếp tục/i) || await pass.press('Enter'); await sleep(3000); continue }
    }
    if (screen === 'code') {
      const code = await findInput(p, ['code'])
      if (code) {
        const c = await waitCode(token, seen, 90000)
        if (!c) { log('no fresh code arrived'); break }
        log('filling code', c.code, '(', c.subject, ')')
        await code.fill(c.code); seen.add(c.id)
        await sleep(400)
        await clickButton(p, /next|continue|confirm|submit|verify|tiếp tục|xác nhận/i) || await code.press('Enter')
        await sleep(4000); continue
      }
    }
    if (screen === 'device') {
      if (await clickButton(p, /next|yes|save|this was me|use this device|tiếp tục/i)) { await sleep(2500); continue }
      if (await clickButton(p, /not now/i)) { await sleep(2500); continue }
    }
    await sleep(2000); await dumpStage(p, `idle-${step}`)
  }
  return await isLoggedIn(p)
}

// ------------------------------------------------------------------ capture
function installWsHook() {
  // Runs before any app script: wraps WebSocket so every frame is recorded.
  return `(() => {
    if (window.__wslog) return
    window.__wslog = []
    const Orig = window.WebSocket
    const b64 = (buf) => { const u = new Uint8Array(buf); let s=''; const CH=0x8000; for (let i=0;i<u.length;i+=CH) s+=String.fromCharCode.apply(null, u.subarray(i,i+CH)); return btoa(s) }
    const enc = (d) => {
      if (typeof d === 'string') return { t: 'text', d }
      if (d instanceof ArrayBuffer) return { t: 'bin', d: b64(d) }
      if (ArrayBuffer.isView(d)) return { t: 'bin', d: b64(d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength)) }
      return { t: 'other', d: String(d) }
    }
    class WS extends Orig {
      constructor(url, protocols) {
        super(url, protocols)
        const e = { url: String(url), protocols: protocols ? String(protocols) : null, sent: [], recv: [], t0: Date.now(), opened: false, closed: false }
        window.__wslog.push(e)
        this.__e = e
        this.addEventListener('open', () => { e.opened = true; e.openAt = Date.now() })
        this.addEventListener('close', () => { e.closed = true; e.closeAt = Date.now() })
        this.addEventListener('message', (ev) => { try { e.recv.push(Object.assign({ at: Date.now() }, enc(ev.data))) } catch {} })
        const os = Orig.prototype.send
        this.send = function (d) { try { e.sent.push(Object.assign({ at: Date.now() }, enc(d))) } catch {}; return os.call(this, d) }
      }
    }
    window.WebSocket = WS
  })()`
}

async function main() {
  const { chromium } = await import('playwright-core')
  clearStaleSingleton(PROFILE, log) // a killed run leaves Chrome's singleton files behind
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    channel: 'chrome', headless: HEADLESS, viewport: { width: 1366, height: 900 },
    acceptDownloads: false, recordHar: { path: path.join(CAP, 'muse.har'), content: 'embed', mode: 'full' },
    args: ['--no-sandbox', '--disable-gpu', '--no-first-run', '--disable-blink-features=AutomationControlled'],
  })
  await ctx.addInitScript(installWsHook())

  const api = []
  ctx.on('page', (page) => wire(page, api))
  const page = ctx.pages()[0] || (await ctx.newPage())
  await wire(page, api)

  const ok = await login(page)
  log('login result:', ok)
  if (!ok) { await save(ctx, page, api); await ctx.close(); process.exit(2) }

  // Drive a real chat so the noise WS + RPC frames are captured.
  await page.goto('https://muse.ai/', { waitUntil: 'domcontentloaded', timeout: 60000 })
  await sleep(3000)
  try {
    const editor = page.locator('[data-lexical-editor="true"], [data-hatch-composer-root] textarea, [contenteditable="true"]').first()
    await editor.waitFor({ state: 'visible', timeout: 30000 })
    await editor.click()
    await page.keyboard.insertText(PROMPT)
    await sleep(200)
    await page.keyboard.press('Enter')
    log('prompt sent, waiting for reply ...')
    await sleep(20000)
  } catch (e) { log('composer/prompt failed:', e.message) }

  await save(ctx, page, api)
  await ctx.close()
  log('done. see', CAP)
}

async function wire(page, api) {
  page.on('response', async (res) => {
    try {
      const u = res.url()
      if (/\/api\/(auth\/check|session|hatch\/vm\/wake|chat)/.test(u) || u.includes('metaaivm')) {
        let body = ''
        try { body = await res.text() } catch {}
        api.push({ url: u, status: res.status(), body: body.slice(0, 4000), headers: await res.allHeaders() })
      }
      if (/\.(js|mjs)(\?|$)/.test(u) && !/ingest|sentry|analytics/i.test(u)) {
        try {
          const ct = res.headers()['content-type'] || ''
          if (ct.includes('javascript')) {
            const name = 'js-' + u.replace(/[^a-z0-9]+/gi, '_').slice(-80) + '.js'
            const txt = await res.text()
            fs.writeFileSync(path.join(CAP, 'js', name), txt)
          }
        } catch {}
      }
    } catch {}
  })
}

async function save(ctx, page, api) {
  try {
    const ws = await page.evaluate(() => window.__wslog || [])
    fs.writeFileSync(path.join(CAP, 'ws-frames.json'), JSON.stringify(ws, null, 2))
    log('ws connections captured:', ws.length, '| noise:', ws.filter((w) => /noise|metaaivm/.test(w.url)).length)
    for (const w of ws.filter((w) => /noise|metaaivm/.test(w.url))) {
      log('  ', w.url, 'opened=' + w.opened, 'sent=' + w.sent.length, 'recv=' + w.recv.length)
    }
  } catch (e) { log('ws dump failed', e.message) }
  fs.writeFileSync(path.join(CAP, 'api.json'), JSON.stringify(api, null, 2))
  log('api calls captured:', api.length)
}

main().catch((e) => { log('fatal', e && e.stack || e); process.exit(1) })
