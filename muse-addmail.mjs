#!/usr/bin/env node
/**
 * muse-addmail.mjs — give a signed-in Meta account a mailtemp.vn address we own, so its sign-in code keeps arriving
 * after the address it came with (a reseller's catch-all on generator.email / luuvan.site…) goes away.
 *
 * Flow (done by hand for talleysr 22/10/2026, automated here):
 *   1. POST mailtemp.vn/api/site/mailboxes {localPart, root, turnstileToken: ""} -> {address, token}
 *      (no API key; the site has no turnstile key, so an empty token passes). The token is the only way back in.
 *   2. accountscenter.meta.com/youraccount/contact_points -> Add new contact info -> Add email -> address -> Next
 *      (-> account picker: keep defaults) -> code mailed to the new box -> Next. No re-authentication is asked.
 *   3. .env: the account's EMAIL / OTP_URL / MAIL_TOKEN now point at the mailtemp box; the old lines stay, commented,
 *      as a fallback.
 *
 * Used by the noise transport right after an unattended seed sign-in whose address is not on mailtemp, and as a CLI
 * for accounts already in the pool (works on a copy of the profile, so the running shim is not disturbed):
 *   node muse-addmail.mjs <account-id> [...]
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { MailTemp } from './muse-mailtemp.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const BASE = (process.env.MUSE_MAILTEMP_URL || 'https://mailtemp.vn').replace(/\/+$/, '')
const ENV_FILE = process.env.MUSE_ENV_FILE || path.join(__dirname, '.env')
const CONTACTS = 'https://accountscenter.meta.com/youraccount/contact_points/'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let rootsCache = null
export async function mailtempRoots() {
  if (rootsCache) return rootsCache
  const r = await fetch(`${BASE}/api/site/config`)
  if (!r.ok) throw new Error(`mailtemp config ${r.status}`)
  rootsCache = ((await r.json()).roots || []).map((x) => x.name).filter(Boolean)
  return rootsCache
}

/** Is this address a mailtemp.vn box (its domain is, or is under, one of the site's roots)? */
export async function isMailtempAddress(email) {
  const domain = String(email || '').split('@')[1]?.toLowerCase() || ''
  if (!domain) return false
  const roots = await mailtempRoots().catch(() => [])
  return roots.some((r) => domain === r || domain.endsWith(`.${r}`))
}

export async function createBox(localPart, exclude = []) {
  const all = await mailtempRoots()
  const roots = all.filter((r) => !exclude.includes(r))
  const root = (roots.length ? roots : all)[Math.floor(Math.random() * (roots.length || all.length))]
  const base = String(localPart || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 16)
  for (let i = 0; ; i++) {
    // a local part is taken site-wide once used (409 "User này đã từng được tạo"): add a random suffix
    const lp = i ? `${base}${Math.floor(100 + Math.random() * 900)}` : base
    const r = await fetch(`${BASE}/api/site/mailboxes`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ localPart: lp, root, turnstileToken: '' }),
    })
    const j = await r.json().catch(() => ({}))
    const box = j.data || j
    if (r.status === 409 && i < 3) continue
    if (!r.ok || !box.address || !box.token) throw new Error(`mailtemp create ${r.status}: ${JSON.stringify(j).slice(0, 200)}`)
    return { address: box.address, token: box.token }
  }
}

/**
 * On a page signed in to the Meta account: add `box.address` as a contact email and confirm it with the code mailed
 * to the box. Returns true when the contact-points page lists the address afterwards.
 */
export async function addContactEmail(p, box, log = () => {}) {
  const mt = new MailTemp({ email: box.address, mailToken: box.token, log })
  const seen = new Set((await mt.messages().catch(() => [])).map((m) => m.id))
  const dialog = () => p.locator('[role="dialog"]').last()
  const click = async (re) => {
    const b = dialog().getByRole('button', { name: re })
    if (await b.count()) { await b.last().click(); return true }
    const t = dialog().getByText(re)
    if (await t.count()) { await t.last().click(); return true }
    return false
  }
  const text = async () => (await dialog().innerText().catch(() => '')).replace(/\s+/g, ' ')
  await p.goto(CONTACTS, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await sleep(5000)
  await p.getByText('Add new contact info').last().click({ timeout: 15000 }); await sleep(2000)
  await p.getByText('Add email', { exact: true }).last().click({ timeout: 15000 }); await sleep(3000)
  await dialog().locator('input[type="text"], input[type="email"]').last().fill(box.address); await sleep(500)
  await click(/^Next$/); await sleep(5000)
  // account picker (checkboxes): keep the defaults
  if (/select|choose|which/i.test(await text()) && !/code/i.test(await text())) { await click(/^(Next|Done|Continue)$/); await sleep(4000) }
  if (!/code/i.test(await text())) throw new Error(`no code screen after adding the email: ${(await text()).slice(0, 200)}`)
  const c = await mt.waitForCode(seen, { timeoutMs: 120000, pollMs: 4000 })
  if (!c) throw new Error(`no code arrived in ${box.address}`)
  log('add-email: code', c.code, `(${c.subject || c.from})`)
  await dialog().locator('input').last().fill(String(c.code)); await sleep(500)
  await click(/^(Next|Confirm|Continue|Done)$/); await sleep(5000)
  await p.goto(CONTACTS, { waitUntil: 'domcontentloaded', timeout: 60000 }); await sleep(5000)
  return (await p.locator('body').innerText()).toLowerCase().includes(box.address.toLowerCase())
}

/** Point the account's EMAIL / OTP_URL / MAIL_TOKEN at the box; the previous lines stay in .env, commented. */
export function saveEnv(id, box, file = ENV_FILE) {
  const U = String(id).toUpperCase()
  const keys = ['EMAIL', 'OTP_URL', 'MAIL_TOKEN', 'PASSWORD', 'API_KEY'].map((k) => `MUSE_ACCOUNT_${U}_${k}`)
  const lines = fs.readFileSync(file, 'utf8').split('\n')
  const out = lines.map((l) => (keys.some((k) => l.trim().toUpperCase().startsWith(`${k}=`)) ? `# ${l}` : l))
  if (out[out.length - 1] === '') out.pop()
  out.push(
    `# ${id}: mailtemp box added as a Meta contact email ${new Date().toISOString().slice(0, 10)} (muse-addmail.mjs); the commented lines above are the old address`,
    `MUSE_ACCOUNT_${U}_EMAIL=${box.address}`,
    `MUSE_ACCOUNT_${U}_MAIL_TOKEN=${box.token}`,
    `MUSE_ACCOUNT_${U}_OTP_URL=${BASE}/#addr=${box.address}&t=${box.token}`,
    '')
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, out.join('\n'), { mode: 0o600 })
  fs.renameSync(tmp, file)
}

/** Create a box, add it on the signed-in page `p`, save it to .env. → the box, or null when Meta did not take it. */
export async function ensureMailtempContact(p, { id, email, log = () => {} }) {
  if (await isMailtempAddress(email)) return null
  // 23/10/2026: Meta's code never reached a box on entu.io.vn (the others got theirs) → one more try on another root
  const tried = []
  for (let attempt = 1; ; attempt++) {
    const box = await createBox(id, tried)
    const root = (await mailtempRoots()).find((r) => box.address.toLowerCase().endsWith(`.${r}`) || box.address.toLowerCase().endsWith(`@${r}`))
    log(`add-email: ${id} ${email} -> ${box.address}`)
    try {
      if (!(await addContactEmail(p, box, log))) throw new Error(`Meta does not list ${box.address} after confirming`)
    } catch (e) {
      if (attempt >= 2 || !/no code arrived/.test(e.message)) throw e
      log(`add-email: ${e.message}, trying another mailtemp root`)
      if (root) tried.push(root)
      continue
    }
    saveEnv(id, box)
    log(`add-email: ${id} saved ${box.address} to .env`)
    return box
  }
}

// CLI: existing accounts, each on a throwaway copy of its profile
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const { accountCreds, loadDotEnv } = await import('./muse-env.mjs')
  const { MuseDriver } = await import('./muse-driver.mjs')
  const log = (...a) => console.log('[muse-addmail]', ...a)
  const accountsDir = path.resolve(__dirname, process.env.MUSE_ACCOUNTS_DIR || 'accounts')
  let failed = 0
  for (const id of process.argv.slice(2)) {
    loadDotEnv(undefined, { refresh: true })
    const { email } = accountCreds(id)
    if (await isMailtempAddress(email)) { log(id, 'already on mailtemp:', email); continue }
    const src = [path.join(accountsDir, id), path.join(accountsDir, `.${id}`)].find((d) => fs.existsSync(d))
    if (!src) { log(id, 'no profile folder'); failed++; continue }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `muse-addmail-${id}-`))
    fs.cpSync(src, tmp, { recursive: true, filter: (s) => !/Singleton(Lock|Socket|Cookie)$/.test(s) })
    const d = new MuseDriver(tmp)
    try {
      const p = await d.requirePage()
      const box = await ensureMailtempContact(p, { id, email, log })
      log(id, 'OK', box?.address)
    } catch (e) {
      failed++
      log(id, 'FAILED:', e.message)
    } finally {
      await d.close().catch(() => {})
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  }
  process.exit(failed ? 1 : 0)
}
