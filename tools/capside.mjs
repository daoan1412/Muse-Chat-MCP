// Capture the real session.start params by hooking JSON.stringify (pre-encryption)
// and driving the "new side chat" UI in a logged-in headless Chrome.
const PROFILE = '/media/daoan/Data/Projects/Muse-Chat-MCP/.muse-profile'
const { chromium } = await import('playwright-core')

const ctx = await chromium.launchPersistentContext(PROFILE, {
  channel: 'chrome', headless: true, viewport: { width: 1366, height: 900 },
  args: ['--no-sandbox', '--disable-gpu', '--disable-blink-features=AutomationControlled'],
})
const watchdog = setTimeout(async () => { console.log('WATCHDOG'); try { await ctx.close() } catch {} process.exit(0) }, 75000)
watchdog.unref()

try {
  const p = ctx.pages()[0] || await ctx.newPage()
  await p.addInitScript(() => {
    const orig = JSON.stringify
    window.__CAP = []
    JSON.stringify = function (...a) {
      const s = orig.apply(this, a)
      try {
        if (typeof s === 'string' && s.length < 1500 && window.__CAP.length < 40) {
          if (s.includes('/api/session/start') || s.includes('session.start') || s.includes('session%2Fstart') || (/session/.test(s) && /lifecycle|origin|is_thread|side_?chat|is_primary/.test(s)))
            window.__CAP.push(s.slice(0, 1000))
        }
      } catch {}
      return s
    }
    const of = window.fetch
    window.__F = []
    window.fetch = function (u, opt) {
      try { const us = typeof u === 'string' ? u : (u && u.url) || ''; if (us.includes('session') && /start|side|thread/.test(us) && window.__F.length < 20) window.__F.push(us + ' :: ' + ((opt && opt.body && String(opt.body).slice(0, 500)) || '')) } catch {}
      return of.apply(this, arguments)
    }
  })

  await p.goto('https://muse.ai/', { waitUntil: 'domcontentloaded' })
  await p.waitForTimeout(7000)

  const dump = () => p.evaluate(() => {
    const els = [...document.querySelectorAll('button,[role=button],[role=menuitem],[aria-label]')]
    return els.map((e) => (e.getAttribute('aria-label') || e.textContent || '').trim().slice(0, 45)).filter((t) => t && /side|new|chat|thread|create|fork|branch|\+/i.test(t)).slice(0, 40)
  })

  console.log('BTNS_BEFORE=' + JSON.stringify(await dump()))
  await p.keyboard.press('Meta+b').catch(() => {})
  await p.waitForTimeout(1500)
  console.log('BTNS_AFTER_METAB=' + JSON.stringify(await dump()))

  const tries = [/new side chat/i, /side chat/i, /new chat/i, /^new/i, /create/i, /open side/i]
  for (const re of tries) {
    try {
      const loc = p.getByRole('button', { name: re }).first()
      if (await loc.count()) { await loc.click({ timeout: 2500 }); await p.waitForTimeout(2500); console.log('CLICKED ' + re) }
    } catch (e) { console.log('CLICKFAIL ' + re + ' ' + String(e.message).slice(0, 60)) }
  }

  const cap = await p.evaluate(() => ({ cap: window.__CAP || [], f: window.__F || [] }))
  console.log('CAP_COUNT=' + cap.cap.length)
  for (const s of cap.cap) console.log('CAP ' + s)
  for (const s of cap.f) console.log('FETCH ' + s)
} catch (e) { console.log('ERR ' + e.message) }
finally { clearTimeout(watchdog); try { await ctx.close() } catch {} }
process.exit(0)
