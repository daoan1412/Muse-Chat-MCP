#!/usr/bin/env node
/**
 * muse-env.mjs — reads .env into process.env and resolves per-account credentials.
 *
 * WHY: the repo must not carry secrets in code. Credentials now live only in
 * .env (git-ignored); importing this module first makes them visible to the
 * rest of the app without adding a dotenv dependency.
 *
 * Rules:
 *   - The real environment always wins over the file, so a one-off
 *     `MUSE_META_EMAIL=… node …` still overrides what is on disk.
 *   - Per-account credentials are keyed by the account id used in MUSE_ACCOUNTS:
 *       MUSE_ACCOUNT_<ID>_EMAIL            sign-in address
 *       MUSE_ACCOUNT_<ID>_PASSWORD         mailbox password (also the Meta password)
 *       MUSE_ACCOUNT_<ID>_META_PASSWORD    optional, overrides PASSWORD for Meta
 *       MUSE_ACCOUNT_<ID>_API_KEY          optional mailtemp.vn x-api-key
 *       MUSE_ACCOUNT_<ID>_OTP_URL          informational: where the code arrives
 *     <ID> may be written in either case. The global MUSE_META_EMAIL /
 *     MUSE_MAIL_PASSWORD / MUSE_META_PASSWORD are the fallback for accounts
 *     that have no entry of their own.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ENV_FILE = process.env.MUSE_ENV_FILE || path.join(__dirname, '.env')

let loaded = false
const fileKeys = new Set() // keys this loader set from the file (a refresh may update them; real env stays untouched)

/**
 * Parse .env into process.env. Values already present in the real environment
 * are left untouched; quoted values are unwrapped, unquoted ones may carry a
 * trailing `# comment`. `{ refresh: true }` re-reads the file so accounts added
 * to .env while the server runs get their credentials without a restart.
 */
export function loadDotEnv(file = ENV_FILE, { refresh = false } = {}) {
  if (loaded && !refresh) return process.env
  loaded = true
  let text
  try { text = fs.readFileSync(file, 'utf8') } catch { return process.env } // no .env -> pure env mode
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const key = line.slice(0, eq).trim().replace(/^export\s+/, '')
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    if (process.env[key] !== undefined && !fileKeys.has(key)) continue // shell wins
    let value = line.slice(eq + 1).trim()
    const q = value[0]
    if ((q === '"' || q === "'") && value.endsWith(q) && value.length > 1) value = value.slice(1, -1)
    else {
      const hash = value.indexOf(' #')
      if (hash > 0) value = value.slice(0, hash).trim()
    }
    process.env[key] = value
    fileKeys.add(key)
  }
  return process.env
}

/**
 * Credentials for one account id, falling back to the global MUSE_* vars.
 * `metaPassword` defaults to the mailbox password, matching the driver's
 * historical behaviour (Meta accepts the same string as its password).
 */
export function accountCreds(id, env = process.env) {
  loadDotEnv()
  const pick = (suffix) => {
    const v = env[`MUSE_ACCOUNT_${id}_${suffix}`]
    return v !== undefined ? v : env[`MUSE_ACCOUNT_${String(id).toUpperCase()}_${suffix}`]
  }
  const mailPassword = pick('PASSWORD') || env.MUSE_MAIL_PASSWORD || ''
  return {
    id,
    email: pick('EMAIL') || env.MUSE_META_EMAIL || '',
    mailPassword,
    metaPassword: pick('META_PASSWORD') || env.MUSE_META_PASSWORD || mailPassword,
    apiKey: pick('API_KEY') || env.MUSE_MAILTEMP_API_KEY || '',
    otpUrl: pick('OTP_URL') || '',
  }
}

loadDotEnv() // importing this module is enough to make .env visible
