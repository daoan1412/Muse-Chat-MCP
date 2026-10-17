#!/usr/bin/env node
// tools/noise-ext.mjs — probe the new noise methods (sessions, fs, attachments).
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import { MuseNoiseClient } from '../muse-noise.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROFILE = process.env.MUSE_PROFILE_DIR || path.join(__dirname, '..', '.muse-profile')

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

// 1x1 red PNG
const RED_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

async function main() {
  const cookies = await getCookies()
  const c = new MuseNoiseClient({ cookies, log: (...a) => console.error('[noise]', ...a) })
  await c.connect()

  // 1) sessions list
  const sess = await c.listSessions()
  console.log('=== listSessions status', sess.status, '===')
  console.log((sess.raw || '').slice(0, 700))

  // 2) fs write + raw roundtrip
  const probe = `workspace/user/files/probe_${Date.now()}.txt`
  const w = await c.fsWrite(probe, Buffer.from('hello-from-noise\n', 'utf8'))
  console.log('=== fsWrite status', w.status, 'body', w.body.toString('utf8').slice(0, 200), '===')
  const rr = await c.fsRaw(probe)
  console.log('=== fsRaw status', rr.status, 'bytes', rr.body.length, 'content', JSON.stringify(rr.body.toString('utf8').slice(0, 60)), '===')

  // 3) attachment upload + chat
  const up = await c.uploadAttachment(RED_PNG, 'probe.png', 'image/png')
  console.log('=== uploaded', JSON.stringify(up), '===')
  const r = await c.chat('What single color is the attached image? Answer with just the color name.', { attachments: [up], timeoutMs: 120000 })
  console.log('=== chat replyReady', r.replyReady, 'events', r.events.length, '===')
  console.log('REPLY:', JSON.stringify(r.reply))

  await c.close()
  process.exit(0)
}
main().catch((e) => { console.error('FATAL', e.stack || e); process.exit(1) })
