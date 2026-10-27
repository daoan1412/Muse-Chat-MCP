#!/usr/bin/env node
/**
 * muse-seed.mjs — sign new accounts in while the shim runs, then hand them to its pool.
 *
 *   node muse-seed.mjs <account-id> [...]
 *
 * Each id needs MUSE_ACCOUNT_<ID>_EMAIL + a way to read its code in .env (OTP_URL on generator.email / luuvan.site / tuan89.site,
 * or a mailtemp MAIL_TOKEN / PASSWORD / API_KEY). Per id: unattended sign-in into the hidden folder accounts/.<id>
 * (skipped by the shim's `*` scan, so it never reads half-written cookies) -> when the address is not a mailtemp box,
 * add one as a second Meta contact email and switch .env to it (muse-addmail.mjs; MUSE_ADD_MAILTEMP=0 skips) ->
 * rename to accounts/<id>, which the shim picks up within MUSE_ACCOUNTS_RESCAN_SEC.
 *
 * Headless on this server: MUSE_HEADLESS=1 MUSE_CHROME_PATH=<chromium> (+ LD_LIBRARY_PATH for its libs).
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { accountCreds, loadDotEnv } from './muse-env.mjs'
import { MuseDriver } from './muse-driver.mjs'
import { ensureMailtempContact } from './muse-addmail.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const accountsDir = path.resolve(__dirname, process.env.MUSE_ACCOUNTS_DIR || 'accounts')
const log = (...a) => console.log('[muse-seed]', ...a)

let failed = 0
for (const id of process.argv.slice(2)) {
  const live = path.join(accountsDir, id)
  if (fs.existsSync(live)) { log(id, 'already in the pool:', live); continue }
  loadDotEnv(undefined, { refresh: true })
  const c = accountCreds(id)
  if (!c.email) { log(id, `no MUSE_ACCOUNT_${id.toUpperCase()}_EMAIL in .env`); failed++; continue }
  const d = new MuseDriver(path.join(accountsDir, `.${id}`))
  let ok = false
  try {
    const r = await d.login({ ...c, timeoutMs: 120000 })
    log(id, 'sign-in:', JSON.stringify(r))
    ok = !!r.loggedIn
    if (ok && process.env.MUSE_ADD_MAILTEMP !== '0') {
      try { await ensureMailtempContact(await d.requirePage(), { id, email: c.email, log }) }
      catch (e) { log(id, 'adding a mailtemp email failed (account still joins the pool):', e.message) }
    }
  } catch (e) {
    log(id, 'sign-in failed:', e.message)
  } finally {
    await d.close().catch(() => {})
  }
  if (ok) { fs.renameSync(path.join(accountsDir, `.${id}`), live); log(id, 'joined the pool:', live) }
  else failed++
}
process.exit(failed ? 1 : 0)
