#!/usr/bin/env node
/**
 * tools/capture-subaction.mjs — open Settings->General->Usage, intercept the
 * Next.js RSC server-action POST (next-action header) that fetches the
 * subscription/usage data, and dump request headers + body + response flight.
 * Artifacts -> /tmp/opencode/subaction-capture/*.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const PROFILE = process.env.MUSE_PROFILE_DIR || path.join(ROOT, '.muse-profile')
const APP = 'https://muse.ai'
const OUT = '/tmp/opencode/subaction-capture'
const RES = '/tmp/opencode/subaction_result.txt'
fs.mkdirSync(OUT, { recursive: true })
fs.writeFileSync(RES, '')
const w = (s) => fs.appendFileSync(RES, s + '\n')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const hits = []
let n = 0
const ctx = await chromium.launchPersistentContext(PROFILE, {
  channel: 'chrome', headless: true, viewport: { width: 1366, height: 900 },
  args: ['--no-sandbox', '--disable-gpu', '--disable-blink-features=AutomationControlled'],
})
const p = ctx.pages()[0] || await ctx.newPage()

p.on('request', async (req) => {
  try {
    const h = await req.allHeaders()
    if (h['next-action']) {
      const rec = { url: req.url(), method: req.method(), headers: h, postData: req.postData() || '' }
      hits.push(rec)
      w(`REQ next-action=${h['next-action']} url=${req.url()} body=${(rec.postData || '').slice(0, 200)}`)
    }
  } catch {}
})
p.on('response', async (res) => {
  try {
    const req = res.request()
    const h = await req.allHeaders()
    if (h['next-action']) {
      const id = h['next-action']
      const body = await res.text().catch(() => '')
      const idx = hits.findIndex((x) => x.headers['next-action'] === id && !x.resp)
      if (idx >= 0) hits[idx].resp = { status: res.status(), ct: res.headers()['content-type'] || '', body }
      const fn = path.join(OUT, `resp_${(n++).toString().padStart(2, '0')}_${id.slice(0, 12)}.txt`)
      fs.writeFileSync(fn, body)
      w(`RESP ${res.status()} action=${id} len=${body.length} -> ${fn}`)
    }
  } catch {}
})

await p.goto(APP, { waitUntil: 'domcontentloaded', timeout: 60000 }); await sleep(5000)
const clickRe = async (re, tag) => { const loc = p.locator('a,button,[role=tab],[role=menuitem],[role=option],[role=link],li,summary').filter({ hasText: re }).first(); try { if (await loc.count()) { await loc.click({ timeout: 3000 }); await sleep(3000); w(`clicked ${tag}`); return true } } catch {} w(`no ${tag}`); return false }

let opened = false
for (const sel of ['[aria-label*="settings" i]', '[title*="settings" i]', '[aria-label*="cài đặt" i]', 'button[aria-haspopup]']) {
  try { const el = p.locator(sel).first(); if (await el.count()) { await el.click({ timeout: 3000 }); opened = true; w(`opened settings via ${sel}`); break } } catch {}
}
await sleep(3000)
if (!opened) w('settings NOT opened')
await clickRe(/settings/i, 'settings-menu-item')
await sleep(3000)
await clickRe(/general/i, 'general')
await clickRe(/usage/i, 'usage')
await clickRe(/additional\s*usage|extra\s*usage|top ?up/i, 'additional')
await sleep(8000)

// also read rendered usage text
const bodyText = await p.evaluate(() => document.body.innerText).catch(() => '')
w('--- USAGE TEXT ---')
for (const line of bodyText.split('\n')) { const t = line.trim(); if (t.length > 2 && /usage|credit|weekly|reset|renew|remaining|additional|limit|plan|out of|left|used|resets|top ?up|metered|%/i.test(t)) w('  ' + t.slice(0, 160)) }

// dump all captured action requests as JSON
fs.writeFileSync(path.join(OUT, 'actions.json'), JSON.stringify(hits, null, 2))
w('TOTAL ACTIONS: ' + hits.length)
for (const h of hits) {
  w(`ACTION ${h.headers['next-action']} router-state-len=${(h.headers['next-router-state-tree'] || '').length} dep=${h.headers['x-deployment-id']} resp=${h.resp ? h.resp.status + ' ' + h.resp.body.length : 'none'}`)
}
w('ALLDONE')
await ctx.close().catch(() => {})
process.exit(0)
