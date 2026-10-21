#!/usr/bin/env node
/**
 * muse-openai-shim.mjs
 * ------------------------------------------------------------------
 * OpenAI-compatible HTTP shim over the Muse browser transport.
 *
 *   GET  /v1/models              -> model list
 *   POST /v1/chat/completions    -> OpenAI chat completions (stream + non-stream)
 *   GET  /health                 -> browser/login state
 *
 * Why a shim: Muse has no OpenAI-compatible API (encrypted Noise WebSocket),
 * so we translate OpenAI requests into a prompt sent via muse-driver, then
 * translate the reply back into OpenAI JSON / SSE.
 *
 * Patterns (SSE chunk shape, /v1 error objects, stream headers) mirror
 * Chat2API's deepseek-stream.ts + routes/chat.ts.
 *
 * Streaming is real: chatStream() reports incremental DOM text, which we
 * re-emit as OpenAI deltas (first token appears when Muse starts answering).
 *
 * Prompt-injected tool calling (experimental): if `tools` are supplied, their
 * schemas are embedded in the prompt and Muse is asked to answer with either
 * normal text or {"tool_calls":[{"name","arguments"}]}; the latter is parsed
 * into OpenAI tool_calls.
 *
 * Structured output: `response_format` (OpenAI `json_object` / `json_schema`)
 * constrains the reply to schema-valid JSON — the schema is injected into the
 * prompt, the reply is extracted, validated with Ajv, and retried on failure.
 * ------------------------------------------------------------------
 */
import http from 'node:http'
import Ajv from 'ajv'
import addFormats from 'ajv-formats'
import { transport } from './muse-transport.mjs'

const PORT = Number(process.env.MUSE_SHIM_PORT || 8787)
const HOST = process.env.MUSE_SHIM_HOST || '127.0.0.1'
const DEFAULT_TIMEOUT_MS = Number(process.env.MUSE_SHIM_TIMEOUT_MS || 240000)
const MODEL_IDS = (process.env.MUSE_SHIM_MODELS || 'muse-spark-1.3,muse-spark-1.3-contributor,muse')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
// Optional shared secret. When set, /v1/* requires `Authorization: Bearer <key>`
// (or `x-api-key`). Empty (default) = no auth, as before.
const API_KEY = process.env.MUSE_SHIM_API_KEY || ''

const log = (...a) => console.error('[muse-shim]', ...a)
const rid = () => `chatcmpl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
const now = () => Math.floor(Date.now() / 1000)
const approxTokens = (s) => Math.max(1, Math.ceil((s || '').length / 4))

// ---------------------------------------------------------------- prompt build

function textOf(content) {
  if (content == null) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === 'string' ? p : p && (p.text ?? p.content ?? '')))
      .filter(Boolean)
      .join('\n')
  }
  return String(content)
}

function buildPrompt(body) {
  const messages = Array.isArray(body.messages) ? body.messages : []
  const system = messages.filter((m) => m.role === 'system').map((m) => textOf(m.content)).filter(Boolean).join('\n\n')

  // Send the latest user (or tool-result) message as a plain message. Roleplay-style
  // role markers ("### USER"/"### ASSISTANT") make Muse push back with "that's a fake
  // transcript", and Muse already keeps its own conversation thread.
  let userText = ''
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role === 'user' || m.role === 'tool') { userText = textOf(m.content); break }
  }

  const parts = []
  if (system) parts.push(system)

  const tools = Array.isArray(body.tools) ? body.tools : []
  if (tools.length && body.tool_choice !== 'none') {
    const schemas = tools.map((t) => t.function || t).map((f) => ({
      name: f.name,
      description: f.description,
      parameters: f.parameters,
    }))
    parts.push(
      [
        'If the request needs a tool, reply with ONLY this JSON and nothing else:',
        '{"tool_calls":[{"name":"<tool name>","arguments":{ ... }}]}',
        'You are only DECIDING whether a tool call should be made — do NOT perform the action,',
        'do NOT browse, do NOT invent results. Otherwise reply normally. Tool schemas:',
        JSON.stringify(schemas),
      ].join('\n'),
    )
  }

  const rfInfo = normalizeResponseFormat(body.response_format)
  if (rfInfo) parts.push(schemaDirective(rfInfo))

  if (userText) parts.push(userText)
  return parts.join('\n\n').trim()
}

function parseToolCalls(text) {
  if (!text) return null
  const trimmed = text.trim()
  // Accept a bare JSON object or one inside a ```json fence.
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const candidate = (fenced ? fenced[1] : trimmed).trim()
  if (!candidate.startsWith('{') || !candidate.endsWith('}')) return null
  let obj
  try { obj = JSON.parse(candidate) } catch { return null }
  const calls = obj && (obj.tool_calls || obj.toolCalls)
  if (!Array.isArray(calls) || !calls.length) return null
  return calls
    .map((c, i) => {
      const name = c.name || c?.function?.name
      if (!name) return null
      const args = c.arguments ?? c?.function?.arguments ?? {}
      return {
        id: `call_${Date.now().toString(36)}${i}`,
        type: 'function',
        function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) },
      }
    })
    .filter(Boolean)
}

// ---------------------------------------------------------------- structured output

const ajv = new Ajv({ allErrors: true, strict: false })
addFormats(ajv)
const _validatorCache = new Map()

function compileValidator(schema) {
  const key = JSON.stringify(schema)
  let v = _validatorCache.get(key)
  if (!v) {
    const validate = ajv.compile(schema)
    v = (data) => { const ok = validate(data); v.errors = validate.errors; return ok }
    _validatorCache.set(key, v)
  }
  return v
}

// Accept OpenAI `response_format` shapes: {type:"json_object"}, {type:"json_schema",
// json_schema:{name,schema,strict}}, or a bare schema object. Returns null when no
// constraint applies.
function normalizeResponseFormat(rf) {
  if (!rf || typeof rf !== 'object') return null
  if (rf.type === 'text') return null
  if (rf.type === 'json_object') return { mode: 'json_object', schema: null, name: 'response' }
  if (rf.type === 'json_schema' || rf.type === 'jsonSchema') {
    const js = rf.json_schema || rf.jsonSchema || rf.schema
    if (js && typeof js === 'object') {
      if (js.schema && typeof js.schema === 'object') return { mode: 'json_schema', schema: js.schema, name: js.name || 'response' }
      if (js.type || js.properties || js.$schema) return { mode: 'json_schema', schema: js, name: js.name || 'response' }
    }
    return { mode: 'json_object', schema: null, name: 'response' }
  }
  if (rf.type || rf.properties || rf.$schema) return { mode: 'json_schema', schema: rf, name: 'response' }
  return null
}

function schemaDirective(rfInfo) {
  if (rfInfo.mode === 'json_object') {
    return 'Respond with ONLY a single valid JSON object. No prose, no commentary, no markdown code fences.'
  }
  return [
    'Respond with ONLY a single JSON object that validates against the JSON Schema below.',
    'Output raw JSON — no prose, no commentary, no markdown code fences.',
    'Include every required key; do not add keys the schema does not allow.',
    'JSON Schema:',
    JSON.stringify(rfInfo.schema),
  ].join('\n')
}

// Pull the first balanced JSON value out of a reply that may have prose or ``` fences.
function extractJson(text) {
  if (!text) return { ok: false }
  let t = String(text).trim()
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) t = fence[1].trim()
  try { return { ok: true, value: JSON.parse(t) } } catch {}
  const start = t.search(/[{[]/)
  if (start < 0) return { ok: false }
  const open = t[start], close = open === '{' ? '}' : ']'
  let depth = 0, inStr = false, esc = false, end = -1
  for (let i = start; i < t.length; i++) {
    const c = t[i]
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue }
    if (c === '"') { inStr = true; continue }
    if (c === open) depth++
    else if (c === close) { depth--; if (depth === 0) { end = i; break } }
  }
  if (end < 0) return { ok: false }
  try { return { ok: true, value: JSON.parse(t.slice(start, end + 1)) } } catch { return { ok: false } }
}

function corrective(errors, rfInfo) {
  const e = (errors || []).map((x) => (x && x.message ? x.message : String(x))).slice(0, 8).join('; ')
  const tail = rfInfo.mode === 'json_schema' ? `\nSchema:\n${JSON.stringify(rfInfo.schema)}` : ''
  return `\n\nYour previous reply was NOT valid. Return ONLY corrected JSON (raw, no fences). Errors: ${e || 'invalid'}.${tail}`
}

// Ask Muse until the reply parses and (if a schema) validates, or attempts run out.
async function runStructured(basePrompt, rfInfo, validate, opts) {
  const maxAttempts = Math.max(1, (Number(process.env.MUSE_SCHEMA_RETRY) || 2) + 1)
  let prompt = basePrompt
  let last = null
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const r = await transport.chat(prompt, opts)
    if (r.error && !r.reply) throw new Error(r.error)
    const ex = extractJson(r.reply || '')
    if (!ex.ok) {
      last = { raw: r.reply, errors: ['reply is not valid JSON'] }
      prompt = basePrompt + corrective(last.errors, rfInfo)
      log(`schema attempt ${attempt}: parse-fail`)
      continue
    }
    if (validate) {
      if (validate(ex.value)) { log(`schema attempt ${attempt}: valid`); return { obj: ex.value, attempts: attempt } }
      const errs = (validate.errors || []).map((v) => `${v.instancePath || '/'} ${v.message}`)
      last = { obj: ex.value, errors: errs }
      prompt = basePrompt + corrective(errs, rfInfo)
      log(`schema attempt ${attempt}: invalid (${errs.length} errors)`)
      continue
    }
    if (ex.value && typeof ex.value === 'object') return { obj: ex.value, attempts: attempt }
    last = { obj: ex.value, errors: ['expected a JSON object'] }
    prompt = basePrompt + corrective(last.errors, rfInfo)
  }
  const err = new Error('Muse did not return schema-valid JSON')
  err.detail = last
  throw err
}

// Collect attachments from an OpenAI-style request:
//   - body.files: ["C:\\img.png", "https://.../v.mp4", { url } | { path } | { buffer, name, mimeType }]
//   - message.content parts: { type: "image_url", image_url: { url } } | { type: "input_image", image_url }
//   - message.content parts: { type: "file", file: { file_url | file_data, filename, mime_type } }
function collectFiles(body) {
  const out = []
  if (Array.isArray(body.files)) for (const f of body.files) if (f) out.push(f)
  const messages = Array.isArray(body.messages) ? body.messages : []
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue
    for (const part of m.content) {
      if (!part || typeof part === 'string') continue
      const t = part.type
      if ((t === 'image_url' || t === 'input_image') && part.image_url) {
        out.push({ url: typeof part.image_url === 'string' ? part.image_url : part.image_url.url })
      } else if (t === 'file' && part.file) {
        const f = part.file
        if (f.file_url) out.push({ url: f.file_url })
        else if (f.file_data) {
          const d = String(f.file_data)
          if (/^data:/i.test(d)) out.push({ url: d })
          else out.push({ buffer: d, name: f.filename || 'file', mimeType: f.mime_type || 'application/octet-stream' })
        }
      }
    }
  }
  return out
}

// ---------------------------------------------------------------- responses

const sseHeaders = (res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': '*',
  })
}
const chunk = (id, model, created, delta, finish = null) =>
  `data: ${JSON.stringify({
    id, object: 'chat.completion.chunk', created, model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`

function sendError(res, status, message, type = 'invalid_request_error', code = null, param = null) {
  const body = JSON.stringify({ error: { message, type, param, code } })
  if (res.headersSent) { try { res.end() } catch {} return }
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
  res.end(body)
}

// Accept `Authorization: Bearer <key>` or `x-api-key`; no-op when API_KEY unset.
function authOk(req) {
  if (!API_KEY) return true
  const auth = String(req.headers['authorization'] || '')
  const bearer = auth.replace(/^Bearer\s+/i, '').trim()
  const key = bearer || String(req.headers['x-api-key'] || '').trim()
  return key === API_KEY
}

// Start an SSE response and return a writer that stops writing once the client
// disconnects, so a mid-stream failure never throws into a dead socket.
function beginStream(res) {
  sseHeaders(res)
  let closed = false
  res.on('close', () => { closed = true })
  return { write: (s) => { if (!closed) { try { res.write(s) } catch { closed = true } } } }
}

// ---------------------------------------------------------------- handler

async function handleChat(req, res, body) {
  if (!body || typeof body !== 'object') return sendError(res, 400, 'Invalid request body')
  if (!body.model) return sendError(res, 400, 'Missing required field: model', 'invalid_request_error', null, 'model')
  if (!Array.isArray(body.messages) || !body.messages.length) {
    return sendError(res, 400, 'Missing required field: messages', 'invalid_request_error', null, 'messages')
  }

  const model = String(body.model)
  const id = rid()
  const created = now()
  const timeoutMs = Number(req.headers['x-muse-timeout-ms']) || DEFAULT_TIMEOUT_MS
  // Default: continue the current Muse thread and rely on the full transcript we send.
  // Send header `x-muse-thread: new` to start a fresh thread instead.
  const newThread = req.headers['x-muse-thread'] === 'new'
  const account = req.headers['x-muse-account'] || body.account || undefined
  const prompt = buildPrompt(body)
  const wantTools = Array.isArray(body.tools) && body.tools.length > 0 && body.tool_choice !== 'none'
  const stream = body.stream === true
  const rfInfo = normalizeResponseFormat(body.response_format)
  const files = collectFiles(body)
  let chat = req.headers['x-muse-chat'] !== undefined ? req.headers['x-muse-chat'] : body.chat
  if (typeof chat === 'string') {
    const s = chat.trim()
    if (!s) chat = undefined
    else if (/^\d+$/.test(s)) chat = Number(s)
  }

  let streamWriter = null
  // The caller hung up before we answered (client timeout, cancelled job, restarted app):
  // abort so the transport stops the Muse turn instead of running it — and its retries — for nobody.
  const ac = new AbortController()
  res.on('close', () => { if (!res.writableFinished) ac.abort() })
  const signal = ac.signal

  log(`chat model=${model} stream=${stream} tools=${wantTools} files=${files.length} target=${chat !== undefined ? chat : 'current'} account=${account || 'auto'} promptChars=${prompt.length}`)

  try {
    if (rfInfo) {
      let validate = null
      if (rfInfo.mode === 'json_schema') {
        try { validate = compileValidator(rfInfo.schema) }
        catch (e) { return sendError(res, 400, `Invalid JSON Schema: ${e.message}`, 'invalid_request_error', null, 'response_format') }
      }
      const out = await runStructured(prompt, rfInfo, validate, { timeoutMs, newThread, files, chat, account, signal })
      const jsonStr = JSON.stringify(out.obj)
      if (stream) {
        const w = beginStream(res); streamWriter = w; const write = w.write
        write(chunk(id, model, created, { role: 'assistant', content: '' }))
        for (let i = 0; i < jsonStr.length; i += 60) write(chunk(id, model, created, { content: jsonStr.slice(i, i + 60) }))
        write(chunk(id, model, created, {}, 'stop'))
        if (body.stream_options && body.stream_options.include_usage) {
          write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [], usage: { prompt_tokens: approxTokens(prompt), completion_tokens: approxTokens(jsonStr), total_tokens: approxTokens(prompt) + approxTokens(jsonStr) } })}\n\n`)
        }
        write('data: [DONE]\n\n')
        res.end()
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
      res.end(JSON.stringify({
        id, object: 'chat.completion', created, model,
        choices: [{ index: 0, message: { role: 'assistant', content: jsonStr }, finish_reason: 'stop' }],
        usage: { prompt_tokens: approxTokens(prompt), completion_tokens: approxTokens(jsonStr), total_tokens: approxTokens(prompt) + approxTokens(jsonStr) },
      }))
      return
    }

    let finishReason = 'stop'
    if (stream) {
      const w = beginStream(res); streamWriter = w; const write = w.write
      write(chunk(id, model, created, { role: 'assistant', content: '' }))
      let emitted = ''
      let r
      if (wantTools) {
        // Buffer so we can decide tool_calls vs content before emitting.
        r = await transport.chat(prompt, { timeoutMs, newThread, files, chat, account, signal })
        if (r.error) throw new Error(r.error)
        const calls = parseToolCalls(r.reply)
        if (calls && calls.length) {
          const deltas = calls.map((c, i) => ({
            index: i, id: c.id, type: 'function',
            function: { name: c.function.name, arguments: c.function.arguments },
          }))
          write(chunk(id, model, created, { tool_calls: deltas }))
          finishReason = 'tool_calls'
        } else {
          const s = r.reply || ''
          for (let i = 0; i < s.length; i += 60) write(chunk(id, model, created, { content: s.slice(i, i + 60) }))
        }
      } else {
        r = await transport.chatStream(prompt, {
          timeoutMs, newThread, files, chat, account, signal,
          onDelta: (full) => {
            const next = full.startsWith(emitted) ? full.slice(emitted.length) : full
            emitted = full
            if (next) write(chunk(id, model, created, { content: next }))
          },
        })
        if (r.error && !emitted) throw new Error(r.error)
      }

      write(chunk(id, model, created, {}, finishReason))
      if (body.stream_options && body.stream_options.include_usage) {
        write(`data: ${JSON.stringify({
          id, object: 'chat.completion.chunk', created, model, choices: [],
          ...(r.account ? { account: r.account } : {}),
          usage: { prompt_tokens: approxTokens(prompt), completion_tokens: approxTokens(emitted), total_tokens: approxTokens(prompt) + approxTokens(emitted) },
        })}\n\n`)
      }
      write('data: [DONE]\n\n')
      res.end()
      return
    }

    // Non-streaming
    const r = await transport.chat(prompt, { timeoutMs, newThread, files, chat, account, signal })
    if (r.error && !r.reply) throw new Error(r.error)
    const calls = wantTools ? parseToolCalls(r.reply) : null

    const message = calls && calls.length
      ? { role: 'assistant', content: null, tool_calls: calls }
      : { role: 'assistant', content: r.reply || '' }

    res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
    res.end(JSON.stringify({
      id, object: 'chat.completion', created, model,
      ...(r.account ? { account: r.account } : {}),
      choices: [{ index: 0, message, finish_reason: calls && calls.length ? 'tool_calls' : 'stop' }],
      usage: {
        prompt_tokens: approxTokens(prompt),
        completion_tokens: approxTokens(r.reply),
        total_tokens: approxTokens(prompt) + approxTokens(r.reply),
      },
    }))
  } catch (err) {
    if (signal.aborted) { log('client disconnected after', Math.round((Date.now() - created * 1000) / 1000), 's — turn cancelled'); return }
    log('error:', err && err.message)
    let msg = `Muse error: ${err && err.message ? err.message : String(err)}`
    if (err && err.detail && Array.isArray(err.detail.errors)) msg += ` (last attempt: ${err.detail.errors.slice(0, 6).join('; ')})`
    if (streamWriter) {
      // SSE headers already sent — a JSON error body is impossible. Emit an SSE
      // `event: error` (OpenAI-style error object) then [DONE] so the client
      // terminates cleanly instead of hanging on a silently truncated stream.
      streamWriter.write(`event: error\ndata: ${JSON.stringify({ error: { message: msg, type: 'api_error', param: null, code: null } })}\n\n`)
      streamWriter.write('data: [DONE]\n\n')
      try { res.end() } catch {}
    } else {
      sendError(res, 502, msg, 'api_error')
    }
  }
}

// ---------------------------------------------------------------- server

function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (c) => {
      data += c
      if (data.length > limit) { reject(new Error('request body too large')); req.destroy() }
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

export function startShim({ port = PORT, host = HOST, exitOnError = false } = {}) {
  const server = http.createServer(async (req, res) => {
    const url = (req.url || '').split('?')[0]
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
        'Access-Control-Allow-Headers': '*',
      })
      return res.end()
    }

    // Optional auth: /v1/* only; /health and / stay open for liveness probes.
    if ((url === '/v1' || url.startsWith('/v1/')) && !authOk(req)) {
      return sendError(res, 401, 'Invalid or missing API key (send Authorization: Bearer <MUSE_SHIM_API_KEY>)', 'authentication_error', 'invalid_api_key')
    }

    try {
      if (req.method === 'GET' && (url === '/health' || url === '/')) {
        let st = { browserRunning: false, loggedIn: false }
        try { st = await transport.status() } catch {}
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
        return res.end(JSON.stringify({ ok: true, ...st, models: MODEL_IDS }))
      }

      if (req.method === 'GET' && url === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
        return res.end(JSON.stringify({
          object: 'list',
          data: MODEL_IDS.map((m) => ({ id: m, object: 'model', created: 0, owned_by: 'muse' })),
        }))
      }

      // Session reading (Muse chats): list chats, or read one chat (optionally opening it first).
      if (req.method === 'GET' && url === '/v1/muse/chats') {
        const params = new URL(req.url, 'http://localhost').searchParams
        const data = await transport.listChats(params.get('query') || undefined, { account: params.get('account') || undefined })
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
        return res.end(JSON.stringify(data))
      }

      if (req.method === 'GET' && url === '/v1/muse/chat') {
        const params = new URL(req.url, 'http://localhost').searchParams
        const target = params.get('target')
        const acct = params.get('account') || undefined
        if (target) await transport.openChat(/^\d+$/.test(target) ? Number(target) : target, { account: acct })
        const data = await transport.readChat(Number(params.get('max')) || 100, { account: acct })
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
        return res.end(JSON.stringify(data))
      }

      if (req.method === 'GET' && url === '/v1/muse/media') {
        const params = new URL(req.url, 'http://localhost').searchParams
        const target = params.get('target')
        const download = params.get('download') === '1' || params.get('download') === 'true'
        const data = await transport.chatMedia(target || undefined, { download, dir: params.get('dir') || undefined, account: params.get('account') || undefined })
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
        return res.end(JSON.stringify(data))
      }

      if (req.method === 'GET' && url === '/v1/muse/usage') {
        const params = new URL(req.url, 'http://localhost').searchParams
        const data = await transport.usage({ account: params.get('account') || undefined })
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
        return res.end(JSON.stringify(data))
      }

      if (req.method === 'POST' && url === '/v1/chat/completions') {
        const raw = await readBody(req)
        let body
        try { body = JSON.parse(raw || '{}') } catch { return sendError(res, 400, 'Invalid JSON body') }
        return handleChat(req, res, body)
      }

      sendError(res, 404, `Unknown route: ${req.method} ${url}`, 'invalid_request_error')
    } catch (err) {
      log('unhandled:', err && err.message)
      sendError(res, 500, String(err && err.message || err), 'internal_error')
    }
  })

  server.on('error', (err) => {
    // Without this, EADDRINUSE (or any listen failure) emits an unhandled
    // 'error' event and crashes the whole process.
    log(`listen error on ${host}:${port}: ${err && err.message}`)
    if (exitOnError) { console.error(`[muse-shim] cannot start on ${host}:${port}: ${err && err.message}`); process.exit(1) }
  })
  server.listen(port, host, () => {
    log(`OpenAI shim listening on http://${host}:${port}/v1  (models: ${MODEL_IDS.join(', ')})${API_KEY ? '  [auth on]' : ''}`)
  })
  return server
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href
if (isMain || process.argv.includes('--standalone')) {
  startShim({ exitOnError: true })
}
