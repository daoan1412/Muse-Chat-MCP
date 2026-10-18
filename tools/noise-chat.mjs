#!/usr/bin/env node
// tools/noise-chat.mjs — end-to-end test of the headless Noise client.
// Grabs the logged-in cookies from the Playwright profile, then runs the
// pure-Node MuseNoiseClient (REST bootstrap + Noise_XX WS + protobuf RPC).
//
//   node tools/noise-chat.mjs                       # chat.history + a prompt
//   node tools/noise-chat.mjs "Explain B-trees"     # custom prompt
//   node tools/noise-chat.mjs --history             # only read history
import '../muse-env.mjs' // .env first: muse-noise.mjs reads MUSE_* at import time
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { MuseNoiseClient } from '../muse-noise.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROFILE = process.env.MUSE_PROFILE_DIR || path.join(__dirname, '..', '.muse-profile')
const PROMPT = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'Say hello in exactly three words.'
const ONLY_HISTORY = process.argv.includes('--history')

async function getCookies() {
  const { chromium } = await import('playwright-core')
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    channel: 'chrome', headless: true, viewport: { width: 1366, height: 900 },
    args: ['--no-sandbox', '--disable-gpu', '--disable-blink-features=AutomationControlled'],
  })
  const p = ctx.pages()[0] || await ctx.newPage()
  await p.goto('https://muse.ai/', { waitUntil: 'domcontentloaded' })
  await new Promise((r) => setTimeout(r, 2500))
  const cookies = await ctx.cookies()
  await ctx.close()
  return cookies
}

async function main() {
  console.error('[test] grabbing cookies from profile ...')
  const cookies = await getCookies()
  const names = cookies.map((c) => c.name)
  console.error('[test] cookies:', names.length, '(', names.filter((n) => /c_user|datr|session|auth|sd|fr/.test(n)).join(','), ')')

  const client = new MuseNoiseClient({ cookies, log: (...a) => console.error('[noise]', ...a) })
  await client.connect()

  // Drain any frames the server sends right after the handshake (before we ask).
  if (process.env.MUSE_DRAIN) {
    console.error('[test] draining raw frames for 4s ...')
    const t0 = Date.now()
    while (Date.now() - t0 < 4000) {
      const raw = await client._recv.next(1000)
      if (!raw) { console.error('[test] no more raw frames (closed?)'); break }
      let f = null
      try { f = await client.transport.feedFrame(raw) } catch (e) { console.error('[test] feedFrame err', e.message) }
      console.error('[test] raw', raw.length, '->', f ? ('stream ' + String(f.stream_id) + ' ' + (f.kind && f.kind.case)) : 'partial')
    }
  }

  const h = await client.chatHistory()
  console.error('[test] chat.history status =', h.status)
  if (h.json) {
    const msgs = h.json.messages || h.json.items || h.json.history || []
    console.error('[test] history entries:', Array.isArray(msgs) ? msgs.length : typeof h.json)
    console.error('[test] sample:', JSON.stringify(h.json).slice(0, 500))
  } else {
    console.error('[test] history raw (not JSON):', h.raw.slice(0, 400))
  }
  if (ONLY_HISTORY) { client.close(); return }

  console.error('[test] sending chat:', JSON.stringify(PROMPT))
  let n = 0
  const r = await client.chat(PROMPT, {
    timeoutMs: 120000,
    onEvent: (ev) => {
      n++
      const name = ev.event || ev.event_name || ev.type
      if (process.env.MUSE_DUMP_EVENTS && /delta|message/.test(name)) console.error('[ev]', n, name, JSON.stringify(ev).slice(0, 1200))
    },
  })
  console.error('[test] chat ack status =', r.ack.status, 'events =', r.events.length, 'replyReady =', r.replyReady)
  console.log('--- reply text ---')
  console.log(r.reply)
  if (!r.reply) { console.log('--- last 3 raw events ---'); for (const ev of r.events.slice(-3)) console.log(JSON.stringify(ev).slice(0, 500)) }
  client.close()
}
main().catch((e) => { console.error('[test] FATAL', e && e.stack || e); process.exit(1) })
