#!/usr/bin/env node
/**
 * tools/discover-usage.mjs — one-time recon: open Settings -> General -> Usage,
 * read the rendered numbers, and capture the lazy chunk that fetches the data.
 * Artifacts -> /tmp/opencode/usage-http, /tmp/opencode/usage-js.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const PROFILE = process.env.MUSE_PROFILE_DIR || path.join(ROOT, '.muse-profile')
const APP = 'https://muse.ai'
const OUT = '/tmp/opencode/usage-http'
const OUTJS = '/tmp/opencode/usage-js'
const RES = '/tmp/opencode/discover_result.txt'
fs.mkdirSync(OUT, { recursive: true }); fs.mkdirSync(OUTJS, { recursive: true })
const w = (s) => fs.appendFileSync(RES, s + '\n'); fs.writeFileSync(RES, '')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const KW = /usage|credit|weekly|week|reset|renew|remaining|additional|allowance|quota|limit|entitle|meter|subscription|plan|verified|topup|period|window|used|out_of|price|amount|left|\/[0-9]/i

let n = 0
const ctx = await chromium.launchPersistentContext(PROFILE, {
  channel: 'chrome', headless: true, viewport: { width: 1366, height: 900 },
  args: ['--no-sandbox', '--disable-gpu', '--disable-blink-features=AutomationControlled'],
})
const p = ctx.pages()[0] || await ctx.newPage()
p.on('response', async (res) => {
  try {
    const url = res.url(); const ct = res.headers()['content-type'] || ''; const status = res.status()
    if (ct.includes('javascript') || /\.js(\?|$)/.test(url)) { const b = await res.text().catch(() => ''); fs.writeFileSync(path.join(OUTJS, `${(n++).toString().padStart(3, '0')}_${url.replace(/[^a-z0-9]+/gi, '_').slice(-90)}`), b); return }
    if (status === 200 && ct.includes('json')) { const b = await res.text().catch(() => ''); if (KW.test(b)) { fs.writeFileSync(path.join(OUT, `${(n++).toString().padStart(3, '0')}_${url.replace(/[^a-z0-9]+/gi, '_').slice(-90)}`), b); w(`HIT ${status} ${url} len=${b.length}`) } }
  } catch {}
})

await p.goto(APP, { waitUntil: 'domcontentloaded', timeout: 60000 }); await sleep(5000)
const clickRe = async (re, tag) => { const loc = p.locator('a,button,[role=tab],[role=menuitem],[role=option],[role=link],li,summary').filter({ hasText: re }).first(); try { if (await loc.count()) { await loc.click({ timeout: 3000 }); await sleep(3000); w(`clicked ${tag}`); return true } } catch {} w(`no ${tag}`); return false }

// open settings via aria-label/title (icon button, no text)
let opened = false
for (const sel of ['[aria-label*="settings" i]', '[title*="settings" i]', '[aria-label*="cài đặt" i]', 'button[aria-haspopup]']) {
  try { const el = p.locator(sel).first(); if (await el.count()) { await el.click({ timeout: 3000 }); opened = true; w(`opened settings via ${sel}`); break } } catch {}
}
await sleep(3000)
if (!opened) w('settings NOT opened')
// the trigger opened a menu; click the "Settings" menu item to open the settings page
await clickRe(/settings/i, 'settings-menu-item')
await sleep(3000)
// dump settings nav labels
const labels = await p.evaluate(() => [...document.querySelectorAll('a,button,[role=tab],[role=menuitem],[role=option],[role=link]')].map((e) => (e.innerText || '').trim()).filter((t) => t && t.length < 40)).catch(() => [])
w('NAV LABELS: ' + JSON.stringify([...new Set(labels)].slice(0, 60)))
await clickRe(/general/i, 'general')
await clickRe(/usage/i, 'usage')
await clickRe(/additional\s*usage|extra\s*usage|top ?up/i, 'additional')
await sleep(6000)
w('FINAL URL: ' + p.url())
const bodyText = await p.evaluate(() => document.body.innerText).catch(() => '')
w('--- USAGE-RELATED TEXT ---')
for (const line of bodyText.split('\n')) { const t = line.trim(); if (t.length > 2 && /usage|credit|weekly|reset|renew|remaining|additional|limit|plan|verified|out of|left|used|\/[0-9]|resets|top ?up|buy|metered/i.test(t)) w('  ' + t.slice(0, 160)) }
w('ALLDONE'); await ctx.close().catch(() => {}); process.exit(0)
