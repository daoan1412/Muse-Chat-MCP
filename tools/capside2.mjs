// Capture v2: record gateway.request method sequence (with timestamps) + real
// request bodies, in main thread AND web workers, then drive "New side chat".
const PROFILE = '/media/daoan/Data/Projects/Muse-Chat-MCP/.muse-profile'
const { chromium } = await import('playwright-core')

const hook = () => {
  const W = typeof window !== 'undefined' ? window : self
  W.__REQ = W.__REQ || []; W.__M = W.__M || []
  const orig = JSON.stringify
  JSON.stringify = function (...a) {
    const s = orig.apply(this, a)
    try {
      if (typeof s === 'string') {
        const gm = s.match(/"trace_policy":"hatch\.gateway\.request","method":"([^"]+)"/)
        if (gm) W.__M.push([Date.now(), gm[1]])
        if (s.length < 1500 && W.__REQ.length < 60 && !s.includes('HatchQuickLogModule') && !s.includes('trace_policy') &&
          (s.includes('/api/session/start') || s.includes('session.start') || (/"params"/.test(s) && /session_id|title|is_thread|origin|lifecycle|is_primary/.test(s))))
          W.__REQ.push([Date.now(), s.slice(0, 1000)])
      }
    } catch {}
    return s
  }
}

const ctx = await chromium.launchPersistentContext(PROFILE, {
  channel: 'chrome', headless: true, viewport: { width: 1366, height: 900 },
  args: ['--no-sandbox', '--disable-gpu', '--disable-blink-features=AutomationControlled'],
})
const watchdog = setTimeout(async () => { console.log('WATCHDOG'); try { await ctx.close() } catch {} process.exit(0) }, 75000)
watchdog.unref()

const workers = []
ctx.on('page', (p) => {
  p.on('worker', (w) => { workers.push(w); w.evaluate(hook).catch(() => {}) })
})

try {
  const p = ctx.pages()[0] || await ctx.newPage()
  await p.addInitScript(hook)
  await p.goto('https://muse.ai/', { waitUntil: 'domcontentloaded' })
  await p.waitForTimeout(7000)
  for (const w of p.workers()) { workers.push(w); w.evaluate(hook).catch(() => {}) }

  // click "New side chat" and mark the time
  await p.evaluate(() => { window.__T0 = Date.now() })
  try { await p.getByRole('button', { name: /new side chat/i }).first().click({ timeout: 3000 }); console.log('CLICKED new side chat') } catch (e) { console.log('CLICKFAIL ' + String(e.message).slice(0, 60)) }
  await p.waitForTimeout(4000)

  const read = async (evaluable) => {
    try { return await evaluable.evaluate(() => ({ t0: window.__T0 || 0, m: window.__M || [], req: window.__REQ || [] })) } catch { return { t0: 0, m: [], req: [] } }
  }
  const main = await read(p)
  console.log('MAIN_METHODS after click:')
  for (const [t, m] of main.m) if (t >= main.t0) console.log('  ' + (t - main.t0) + 'ms ' + m)
  console.log('MAIN_METHODS all tail:')
  for (const [t, m] of main.m.slice(-15)) console.log('  ' + m)
  console.log('MAIN_REQ:')
  for (const [t, s] of main.req) console.log('  ' + (t - main.t0) + 'ms ' + s)

  for (const w of workers) {
    const r = await read(w)
    const ms = r.m.filter((x) => x[0] >= r.t0)
    if (ms.length || r.req.length) {
      console.log('WORKER ' + w.url().slice(-30) + ' methods after click: ' + JSON.stringify(ms.map((x) => x[1])))
      for (const [t, s] of r.req) console.log('  WREQ ' + (t - r.t0) + 'ms ' + s)
    }
  }
} catch (e) { console.log('ERR ' + e.message) }
finally { clearTimeout(watchdog); try { await ctx.close() } catch {} }
process.exit(0)
