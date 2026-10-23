#!/usr/bin/env node
/**
 * muse-luuvan.mjs — luuvan.site inbox reader for OTP-based auto-login.
 *
 * luuvan.site serves a catch-all inbox for the reseller's domains (e.g. *.animee.tokyo, MX on Cloudflare Email
 * Routing — generator.email never sees that mail) through a public JSON API, no key or browser needed:
 *   GET /api/public/inbox?address=<email>            -> { mailbox, messages: [{ id, from, subject, receivedAt, … }] }
 *   GET /api/public/messages/<id>?address=<email>     -> { message: { text, html, subject, … } }
 * Meta's sign-in code is usually in the subject; when it is not, the body is read once per message and cached.
 * Exposes the same { id, code, from, subject } messages + waitForCode(seen) as MailTemp.
 */
import { MailTemp, extractCode } from './muse-mailtemp.mjs'

const BASE = (process.env.MUSE_LUUVAN_URL || 'https://luuvan.site').replace(/\/+$/, '')

export const isLuuVanUrl = (u) => /^https?:\/\/(www\.)?luuvan\.site\//i.test(String(u || ''))

export class LuuVan extends MailTemp {
  constructor({ email, log = () => {} } = {}) {
    super({ email, log })
    this.mode = 'luuvan'
    this.bodies = new Map() // message id -> code found in its body ('' = none)
  }

  async _json(url) {
    const r = await fetch(url, { headers: { accept: 'application/json' } })
    const j = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(`luuvan ${r.status}: ${j.error || ''}`)
    return j
  }

  async _bodyCode(id) {
    if (this.bodies.has(id)) return this.bodies.get(id)
    const j = await this._json(`${BASE}/api/public/messages/${encodeURIComponent(id)}?address=${encodeURIComponent(this.email)}`)
    const m = j.message || {}
    // body: 6-8 digits only — the footer carries "© 2026" and Meta's zip 94025, which the 4-8 digit rule would take
    const t = m.text || String(m.html || '').replace(/<[^>]+>/g, ' ')
    const code = (t.match(/\b\d{6,8}\b/) || [''])[0]
    this.bodies.set(id, code)
    return code
  }

  async messages() {
    if (!this.email) throw new Error('luuvan: no email set')
    const j = await this._json(`${BASE}/api/public/inbox?address=${encodeURIComponent(this.email)}`)
    const out = []
    for (const m of j.messages || []) {
      let code = extractCode(m.subject) ? m.subject : ''
      // only Meta mail is worth opening; seen ids are skipped by waitForCode before the code matters
      if (!code && /meta|facebook|instagram/i.test(m.from || '')) code = await this._bodyCode(m.id).catch(() => '')
      out.push({ id: m.id, code, from: m.from || '', subject: m.subject || '' })
    }
    return out
  }
}

export default LuuVan
