#!/usr/bin/env node
/**
 * muse-genmail.mjs — generator.email inbox reader for OTP-based auto-login.
 *
 * generator.email has no API: the inbox at https://generator.email/<domain>/<user>
 * is server-rendered into #email-table, one row per message
 *   <div onclick="loadInboxClientSide('<domain>/<user>/<id>')">
 *     .from_div_45g45gg  .subj_div_45g45gg  .time_div_45g45gg
 * and Meta puts the OTP in the subject ("Use code 359562 to log in").
 *
 * The site fingerprints visitors (`__ab_fp*`): a HeadlessChrome user-agent gets an
 * "Access temporarily limited" page, so this opens its own small Chromium with a
 * regular desktop UA instead of borrowing the Muse profile's context. Exposes the
 * same { id, code, from, subject } messages + waitForCode(seen) as MailTemp, so the
 * driver's auto-login is provider-agnostic. Call close() when done.
 */
import { MailTemp } from './muse-mailtemp.mjs'

const UA = process.env.MUSE_GENMAIL_UA ||
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export const isGeneratorEmailUrl = (u) => /^https?:\/\/(www\.)?generator\.email\//i.test(String(u || ''))

export class GeneratorEmail extends MailTemp {
  constructor({ email, url, log = () => {} } = {}) {
    super({ email, log })
    const [user, domain] = String(email || '').split('@')
    this.url = url || `https://generator.email/${domain}/${user}`
    this.mode = 'generator'
    this.browser = null
    this.page = null
  }

  async _page() {
    if (this.page && !this.page.isClosed()) return this.page
    const { chromium } = await import('playwright-core')
    const CHROME_PATH = process.env.MUSE_CHROME_PATH || ''
    this.browser = await chromium.launch({
      ...(CHROME_PATH ? { executablePath: CHROME_PATH } : { channel: process.env.MUSE_CHANNEL || 'chrome' }),
      headless: true,
      ignoreDefaultArgs: ['--enable-automation'],
      args: ['--disable-blink-features=AutomationControlled'],
    })
    const ctx = await this.browser.newContext({ userAgent: UA, locale: 'en-US', viewport: { width: 1366, height: 900 } })
    this.page = await ctx.newPage()
    return this.page
  }

  async _open() {
    const p = await this._page()
    for (let i = 0; i < 2; i++) {
      await p.goto(this.url, { waitUntil: 'domcontentloaded', timeout: 30000 })
      const limited = p.getByText('Remove the limit')
      if (!(await limited.count())) return p
      this.log('generator.email rate-limited, clearing the check')
      await limited.first().click().catch(() => {})
      await sleep(8000)
    }
    throw new Error('generator.email: access limited')
  }

  async messages() {
    if (!this.email) throw new Error('genmail: no email set')
    const p = await this._open()
    await p.waitForSelector('#email-table', { timeout: 10000 }).catch(() => {})
    return p.$$eval('#email-table [onclick*="loadInboxClientSide"]', (rows) => rows.map((r) => {
      const m = (r.getAttribute('onclick') || '').match(/loadInboxClientSide\('([^']+)'\)/)
      const q = (c) => (r.querySelector(c)?.textContent || '').trim()
      const subject = q('.subj_div_45g45gg')
      return { id: m ? m[1].split('/').pop() : subject + q('.time_div_45g45gg'), code: subject, from: q('.from_div_45g45gg'), subject }
    }))
  }

  // Polls a web page, so keep it slower than the API client to stay under the rate limit.
  waitForCode(seen, opts = {}) { return super.waitForCode(seen, { pollMs: 6000, ...opts }) }

  async close() {
    const b = this.browser
    this.browser = null; this.page = null
    if (b) await b.close().catch(() => {})
  }
}

export default GeneratorEmail
