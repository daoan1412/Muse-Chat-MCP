/**
 * muse-shim-keys.mjs
 * ------------------------------------------------------------------
 * API keys for the OpenAI shim, so machines other than this one can call it.
 *
 * Kept in <accounts>/.api-keys.json (hidden: the `*` account scan skips it). Only the SHA-256 of a key is stored;
 * the key itself is returned once, when it is made. The file is re-read whenever it changes, so adding or revoking a
 * key needs no restart. Use counts (requests, errors, last use, per VN day) go to .api-keys-usage.json, flushed every
 * 30 s, so they survive a restart; turns running per key are live only.
 *
 * MUSE_SHIM_API_KEY (env) still works as one more key, shown as id `env`.
 * ------------------------------------------------------------------
 */
import crypto from 'node:crypto'
import fs from 'node:fs'

const KEEP_DAYS = 14
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex')
// day of a use in Vietnam time (UTC+7), the day the console shows
const vnDay = (t) => new Date(t + 7 * 3600e3).toISOString().slice(0, 10)

export class KeyStore {
  constructor({ file, usageFile = file.replace(/\.json$/, '') + '-usage.json', envKey = '', flushMs = 30000 } = {}) {
    this.file = file
    this.usageFile = usageFile
    this.envKey = envKey
    this.keys = []
    this.byHash = new Map()
    this.mtime = -1
    this.inflight = new Map()
    this.usage = {}
    try { this.usage = JSON.parse(fs.readFileSync(usageFile, 'utf8')) || {} } catch {}
    this.dirty = false
    this._load()
    if (flushMs > 0) setInterval(() => this.flush(), flushMs).unref()
    process.on('exit', () => this.flush())   // muse-server's SIGTERM handler ends in process.exit
  }

  _load() {
    let mtime
    try { mtime = fs.statSync(this.file).mtimeMs } catch { mtime = 0 }
    if (mtime === this.mtime) return
    this.mtime = mtime
    let keys = []
    try { keys = JSON.parse(fs.readFileSync(this.file, 'utf8')).keys || [] } catch {}
    this.keys = keys.filter((k) => k && k.id && k.hash)
    this.byHash = new Map(this.keys.map((k) => [k.hash, k]))
  }

  _save() {
    const tmp = `${this.file}.tmp-${process.pid}`
    fs.writeFileSync(tmp, JSON.stringify({ keys: this.keys }, null, 1) + '\n', { mode: 0o600 })
    fs.renameSync(tmp, this.file)
    this.mtime = fs.statSync(this.file).mtimeMs
    this.byHash = new Map(this.keys.map((k) => [k.hash, k]))
  }

  flush() {
    if (!this.dirty) return
    this.dirty = false
    try {
      const tmp = `${this.usageFile}.tmp-${process.pid}`
      fs.writeFileSync(tmp, JSON.stringify(this.usage) + '\n', { mode: 0o600 })
      fs.renameSync(tmp, this.usageFile)
    } catch { this.dirty = true }
  }

  /** The key entry a presented secret belongs to, or null (unknown / disabled). */
  check(secret) {
    if (!secret) return null
    if (this.envKey && secret === this.envKey) return { id: 'env', name: 'MUSE_SHIM_API_KEY', enabled: true, maxInflight: null }
    this._load()
    const k = this.byHash.get(sha(secret))
    return k && k.enabled !== false ? k : null
  }

  /** Count one request on a key. Returns end(status) to call when the response closes, or null when the key already
   * has its maxInflight turns running (the caller answers 429). */
  begin(k, ip) {
    const n = this.inflight.get(k.id) || 0
    if (k.maxInflight && n >= k.maxInflight) return null
    this.inflight.set(k.id, n + 1)
    const now = Date.now()
    const u = (this.usage[k.id] ||= { requests: 0, errors: 0, days: {} })
    u.requests++
    u.lastUsedAt = new Date(now).toISOString()
    u.lastIp = ip || null
    const d = vnDay(now)
    u.days[d] = (u.days[d] || 0) + 1
    for (const old of Object.keys(u.days)) if (old < vnDay(now - KEEP_DAYS * 86400e3)) delete u.days[old]
    this.dirty = true
    let done = false
    return (status) => {
      if (done) return
      done = true
      this.inflight.set(k.id, Math.max(0, (this.inflight.get(k.id) || 1) - 1))
      if (status >= 400) { u.errors++; this.dirty = true }
    }
  }

  _public(k) {
    const u = this.usage[k.id] || {}
    const today = vnDay(Date.now())
    return {
      id: k.id, name: k.name, hint: k.hint, enabled: k.enabled !== false, maxInflight: k.maxInflight ?? null,
      createdAt: k.createdAt, createdBy: k.createdBy ?? null,
      requests: u.requests || 0, errors: u.errors || 0, today: (u.days || {})[today] || 0, days: u.days || {},
      lastUsedAt: u.lastUsedAt ?? null, lastIp: u.lastIp ?? null, inflight: this.inflight.get(k.id) || 0,
    }
  }

  list() {
    this._load()
    const out = this.keys.map((k) => this._public(k))
    if (this.envKey) out.push(this._public({ id: 'env', name: 'MUSE_SHIM_API_KEY', hint: 'env', enabled: true }))
    return out
  }

  /** Make a key; the only time its secret is returned. */
  create({ name, maxInflight = null, createdBy = null } = {}) {
    this._load()
    const secret = `msk_${crypto.randomBytes(24).toString('base64url')}`
    const k = {
      id: `k_${crypto.randomBytes(4).toString('hex')}`,
      name: String(name || '').trim() || 'không tên',
      hash: sha(secret),
      hint: `${secret.slice(0, 8)}…${secret.slice(-4)}`,
      enabled: true,
      maxInflight: maxInflight ? Math.max(1, Math.floor(Number(maxInflight))) : null,
      createdAt: new Date().toISOString(),
      createdBy,
    }
    this.keys.push(k)
    this._save()
    return { ...this._public(k), key: secret }
  }

  update(id, { name, enabled, maxInflight } = {}) {
    this._load()
    const k = this.keys.find((x) => x.id === id)
    if (!k) throw new Error(`no key ${id}`)
    if (name !== undefined) k.name = String(name).trim() || k.name
    if (enabled !== undefined) k.enabled = !!enabled
    if (maxInflight !== undefined) k.maxInflight = maxInflight ? Math.max(1, Math.floor(Number(maxInflight))) : null
    this._save()
    return this._public(k)
  }

  remove(id) {
    this._load()
    const i = this.keys.findIndex((x) => x.id === id)
    if (i < 0) throw new Error(`no key ${id}`)
    this.keys.splice(i, 1)
    this._save()
    delete this.usage[id]
    this.dirty = true
    return { id, deleted: true }
  }
}
