#!/usr/bin/env node
/**
 * muse-tuan89.mjs — tuan89.site inbox reader for OTP-based auto-login.
 *
 * tuan89.site is a reseller's temp-mail site (MX mail.tuan89.site, so generator.email never sees that mail). Its
 * inbox page (/mail/?email=<email>) polls a public JSON API, no key or browser needed:
 *   GET /api/temp-mail/inbox?email=<email>   -> { success, messages: [{ id, from_email, subject, otp_code, … }] }
 * The site already pulls the code out (otp_code); Meta's subject carries it too.
 * Exposes the same { id, code, from, subject } messages + waitForCode(seen) as MailTemp.
 */
import { MailTemp, extractCode } from './muse-mailtemp.mjs'

const BASE = (process.env.MUSE_TUAN89_URL || 'https://tuan89.site').replace(/\/+$/, '')

export const isTuan89Url = (u) => /^https?:\/\/(www\.)?tuan89\.site\//i.test(String(u || ''))

export class Tuan89 extends MailTemp {
  constructor({ email, log = () => {} } = {}) {
    super({ email, log })
    this.mode = 'tuan89'
  }

  async messages() {
    if (!this.email) throw new Error('tuan89: no email set')
    const r = await fetch(`${BASE}/api/temp-mail/inbox?email=${encodeURIComponent(this.email)}`, { headers: { accept: 'application/json' } })
    const j = await r.json().catch(() => ({}))
    if (!r.ok || !j.success) throw new Error(`tuan89 ${r.status}: ${j.message || ''}`)
    return (j.messages || []).map((m) => ({
      id: String(m.id),
      code: extractCode(m.subject) ? m.subject : (m.otp_code || ''),
      from: m.from_email || '',
      subject: m.subject || '',
    }))
  }
}

export default Tuan89
