#!/usr/bin/env node
// tools/probe-rest.mjs — dump the REST bootstrap Muse uses to open the noise WS.
// Reuses the logged-in profile; calls the endpoints from inside the page origin.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROFILE = process.env.MUSE_PROFILE_DIR || path.join(__dirname, '..', '.muse-profile')

async function main() {
  const { chromium } = await import('playwright-core')
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    channel: 'chrome', headless: true, viewport: { width: 1366, height: 900 },
    args: ['--no-sandbox', '--disable-gpu', '--disable-blink-features=AutomationControlled'],
  })
  const p = ctx.pages()[0] || await ctx.newPage()
  await p.goto('https://muse.ai/', { waitUntil: 'domcontentloaded' })
  await new Promise((r) => setTimeout(r, 3000))

  const out = await p.evaluate(async () => {
    const j = async (method, url, body) => {
      try {
        const res = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' })
        const txt = await res.text()
        return { status: res.status, body: txt.slice(0, 2000) }
      } catch (e) { return { err: String(e) } }
    }
    const auth = await j('POST', '/api/auth/check', {})
    const sess = await j('GET', '/api/session', null)
    let wake = null
    try {
      const s = JSON.parse(sess.body || '{}')
      const vm = s.vm_id || (s.vm && s.vm.vm_id) || (s.env && s.env.env_id)
      if (vm) wake = await j('POST', '/api/hatch/vm/wake', { vm_id: vm })
    } catch {}
    return { auth, sess, wake, cookies: document.cookie.split(';').map((c) => c.trim().split('=')[0]) }
  })
  console.log(JSON.stringify(out, null, 2))
  await ctx.close()
}
main().catch((e) => { console.error('ERR', e.message); process.exit(1) })
