#!/usr/bin/env node
/**
 * muse-mailtemp.mjs — mailtemp.vn client for OTP-based auto-login.
 *
 * Two interchangeable ways to read the inbox / OTP, picked automatically:
 *   A) Public API (needs x-api-key, see https://mailtemp.vn/api-docs)
 *        GET  /api/code/{email}?format=text   -> latest OTP as plain text
 *        GET  /api/messages/{email}           -> messages[] with primaryCode
 *   B) Mailbox-password flow (no API key; works with the temp-mail password)
 *        POST /api/site/unlock  {address,password} -> {token}
 *        GET  /api/site/inbox?address=…             (header x-mailbox-token)
 *      A box made on the web (POST /api/site/mailboxes) has no password, only the
 *      token it was created with — pass that as mailToken and unlock is skipped.
 *
 * Mode A is preferred when an API key is present; otherwise B is used when a
 * mailbox password is present. Both return the same normalized message shape
 * { id, code, from, subject } so the driver's auto-login is mode-agnostic.
 */
const BASE = (process.env.MUSE_MAILTEMP_URL || 'https://mailtemp.vn').replace(/\/+$/, '')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// mailtemp detects 4-8 digit codes and XXX-XXX (xAI/Grok style); normalize either.
export function extractCode(text) {
  const s = String(text || '')
  const num = s.match(/\b\d{4,8}\b/)
  if (num) return num[0]
  const dash = s.match(/\b\d{3}-\d{3}\b/)
  return dash ? dash[0] : null
}

export class MailTemp {
  constructor({ email, apiKey, mailPassword, mailToken, log = () => {} } = {}) {
    this.email = email || ''
    this.apiKey = apiKey || process.env.MUSE_MAILTEMP_API_KEY || ''
    this.mailPassword = mailPassword || process.env.MUSE_MAIL_PASSWORD || ''
    this.log = log
    this.token = mailToken || process.env.MUSE_MAIL_TOKEN || null
    this.mode = this.apiKey ? 'api' : this.mailPassword || this.token ? 'site' : 'none'
  }

  // site/unlock: exchange the mailbox password for a short-lived inbox token.
  async unlock() {
    if (this.mode !== 'site') return null
    if (this.token) return this.token
    const r = await fetch(`${BASE}/api/site/unlock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address: this.email, password: this.mailPassword }),
    })
    if (!r.ok) throw new Error(`mail unlock ${r.status}: ${await r.text().catch(() => '')}`)
    this.token = (await r.json()).token
    return this.token
  }

  // Normalized list of messages currently in the mailbox.
  async messages() {
    if (!this.email) throw new Error('mailtemp: no email set')
    if (this.mode === 'api') {
      const r = await fetch(`${BASE}/api/messages/${encodeURIComponent(this.email)}`, {
        headers: { 'x-api-key': this.apiKey },
      })
      if (r.status === 404) return [] // mailbox not created yet
      if (!r.ok) throw new Error(`mail messages ${r.status}: ${await r.text().catch(() => '')}`)
      const j = await r.json()
      return (j.messages || []).map((m) => ({
        id: m.id, code: m.primaryCode || m.code, from: m.from || '', subject: m.subject || '',
      }))
    }
    if (this.mode === 'site') {
      await this.unlock()
      const r = await fetch(`${BASE}/api/site/inbox?address=${encodeURIComponent(this.email)}`, {
        headers: { 'x-mailbox-token': this.token },
      })
      if (!r.ok) throw new Error(`mail inbox ${r.status}: ${await r.text().catch(() => '')}`)
      const j = await r.json()
      return (j.messages || []).map((m) => ({
        id: m.id, code: m.code, from: m.from || '', subject: m.subject || '',
      }))
    }
    throw new Error('mailtemp: need an API key (x-api-key), a mailbox password or a mailbox token')
  }

  // Latest OTP as plain text (mode A only); returns '' when none yet.
  async latestCodeText() {
    if (this.mode !== 'api') return ''
    const r = await fetch(`${BASE}/api/code/${encodeURIComponent(this.email)}?format=text`, {
      headers: { 'x-api-key': this.apiKey },
    })
    if (!r.ok) return ''
    return (await r.text()).trim()
  }

  // Poll until a NEW message (id not in `seen`) carrying a valid OTP arrives.
  async waitForCode(seen = new Set(), { timeoutMs = 90000, pollMs = 2500 } = {}) {
    const deadline = Date.now() + timeoutMs
    do {
      let msgs = []
      try { msgs = await this.messages() } catch (e) { this.log('mail poll:', e.message) }
      const fresh = msgs.filter((m) => !seen.has(m.id) && extractCode(m.code))
      if (fresh.length) {
        const m = fresh[0]
        return { code: extractCode(m.code), id: m.id, from: m.from, subject: m.subject }
      }
      await sleep(pollMs)
    } while (Date.now() < deadline)
    return null
  }
}

export default MailTemp
