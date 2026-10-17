# AGENTS.md — Muse-Chat-MCP

Guidance for AI coding agents working in this repository.

## What this is

MCP server + OpenAI-compatible HTTP shim that expose Meta Muse (`muse.ai`, "Hatch").
Two interchangeable backends selected by `MUSE_TRANSPORT`:

- `browser` (default) — drive a real, logged-in Chrome with Playwright.
- `noise` — headless pure-Node client (no browser) over the encrypted Noise WebSocket.

See `README.md` for usage.

## Map

- `muse-transport.mjs` — `MUSE_TRANSPORT` switch; facade both backends expose the same
  methods the server/shim call (`status`/`login`/`chat`/`chatStream`/`readLast`/`readChat`/`usage`/`close`).
- `muse-driver.mjs` — browser driver (selectors, `_run`/`chat`/`chatStream`, `_serial`, `usage`).
- `muse-noise.mjs` — headless Noise_XX client: `Noise_XX_25519_AESGCM_SHA256` handshake,
  protobuf HTTP/2-mux framing, REST bootstrap, `chatHistory`/`chatSubscribe`/`chat`/`usage`.
- `muse-server.mjs` — MCP stdio server (12 tools incl. `muse_usage`) + shim bootstrap;
  `--self-test`, `--dump-dom`, `--serve-only`.
- `muse-openai-shim.mjs` — OpenAI shim (`/v1/models`, `/v1/chat/completions`, `response_format`
  structured output, `/v1/muse/chats|chat|media|usage`).
- `muse-cli.mjs` — CLI over the shim (`--json-schema` forces schema-valid JSON, `--usage` prints the meter).
- `tools/capture-noise.mjs` — Playwright capture harness (login + WS frames + JS bundles).
- `tools/noise-chat.mjs` — end-to-end test of the headless client (`--history`, `MUSE_DUMP_EVENTS=1`).
- `tools/discover-usage.mjs` / `tools/capture-subaction.mjs` — recon: open Settings→Usage, read the
  rendered meter, and capture the `fetchSubscriptionAction` RSC request/response (re-run after a
  redeploy to refresh `MUSE_SUBSCRIPTION_ACTION_ID`).
- `docs/index.html` — GitHub Pages landing page.

## Invariants (do not break)

- CDP-attached sessions **disconnect only** on close — never kill the user's browser.
- All browser work is serialized through `driver._serial`.
- Streaming emits only **monotonic, stability-quieted** text; exactly one `finish_reason`.
- Tool calling is **decision-only** (Muse must not actually execute the tool).
- Prompts are sent **verbatim** — never add `### USER/### ASSISTANT` roleplay markers or a
  "continue the conversation" wrapper; Muse flags those as prompt-injection and refuses.
- Structured output (`response_format` `json_object`/`json_schema`) is prompt-injected, Ajv-validated,
  and retried up to `MUSE_SCHEMA_RETRY` (default 2); the schema directive is appended, but the verbatim
  rule (no roleplay markers) still applies to the user's own text.
- Usage/credits (`muse_usage` / `--usage` / `transport.usage()`) comes from the Next.js RSC server
  action `fetchSubscriptionAction`, NOT a noise route (it is absent from the route table). POST the
  action id to the app origin with `accept: text/x-component` + `content-type: text/plain` +
  `next-action` and full browser client-hint headers (`sec-ch-ua*`, `accept-encoding`, `accept-language`)
  or Cloudflare returns `403 Forbidden`; parse the flight result from the `1:` line. The action id is a
  build-specific hash — refresh it with `tools/capture-subaction.mjs` (or set `MUSE_SUBSCRIPTION_ACTION_ID`)
  after a Muse redeploy.
- Attachments go on the hidden composer `input[type="file"]` via `setInputFiles`.
- **Never** commit secrets: no `.muse-profile/`, no `*.har`, no tokens.

### Noise-transport specifics (hard-won, do not regress)

- msg3 `se` DH is `DH(client_static, server_EPHEMERAL)` — the first 32 bytes of msg2, NOT
  the server static. Getting this wrong makes the server close right after msg3 (1006).
- msg1 payload (34-byte nonce protobuf) travels **in the clear** — the cipherstate is not
  keyed until the first `mixKey` (matches the real client; protocol name zero-padded to 32,
  not hashed into the initial key).
- `encodeMessage` has no oneof awareness: set the oneof member field directly
  (`{stream_id, request: appReq}`), or the server resets the stream with `PROTOCOL_ERROR`
  "empty frame kind".
- `ServiceFrame` oneof includes `reset` (field 5); handle it — a reset is a stream error.
- The reply is NOT in the `chat.stream` response body (that is just a `{message_id}` ack).
  It arrives on the persistent `chat.subscribe` stream as NDJSON events: `delta.text_append`
  (`payload.text`) accumulates the reply, `delta.message_done` (`payload.transcript`) is final.
- Subscribe body needs `capabilities` (see `DEFAULT_CAPS`); frames are chunked
  `NoiseTransportFrame` reassembled by `chunk_id` (max 256 chunks, `CHUNK_MAX` 65489).
- Body-bearing requests MUST send a `content-type: application/json` header in the
  `ApplicationRequest.headers` — without it the gateway returns `415`.
- Attachments: `POST /fs/write` `{path:"workspace/user/files/<name>", data_base64,
  overwrite, create_parent}` (chunk 512 KiB, append for later parts), then reference the
  file in the message text as `![alt](sandbox://workspace/user/files/<name>)`.
- Generated media lives in `delta.presentation` events (live AND in `chat.history`):
  `payload.data.{images,videos,files}[]` each `{path:"sandbox://workspace/…", mime, label}`;
  download with `GET /fs/raw/workspace/<path>` (binary).
- `list_chats` = `GET /api/session/list` → `result.sessions[]` (`title`, `session_id`,
  `is_primary`, `snippet`, `pinned`). `open_chat`/`dump_dom` stay browser-only.
- Concurrency: reads (`list_chats`/`chat_media`/`history`/`fs`) multiplex safely on one
  connection (each gets its own `stream_id`, pump dispatches by id). Chat on the SHARED
  active session does NOT — every turn subscribes to the same feed and cross-contaminates,
  so the facade serializes those via `_serial` (like the browser driver); `ensure()`
  reconnects when the WS is no longer OPEN and `_run` retries once on a dead-connection error.
- New side chat per request (`new_thread` / `x-muse-thread: new` / `opts.newSession`):
  generate a fresh `session_id` (uuid), `chat.stream` FIRST (server materializes the thread,
  `is_thread:true`), THEN `chat.subscribe` with that `session_id` — the reverse order yields
  zero events for a not-yet-existing session. Each such turn has its own feed, so concurrent
  new-session turns run in PARALLEL on one connection, isolated. Verified 2- and 3-way
  (facade + shim `x-muse-thread: new`) → `isolated=true`, distinct `session_id`s.

## Verify changes

```bash
npm run selftest                                   # browser transport (default)
MUSE_TRANSPORT=noise npm run selftest              # noise transport (headless)
node muse-cli.mjs "Say hello in three words."      # CLI over the shim
MUSE_TRANSPORT=noise node tools/noise-chat.mjs     # headless client e2e
```

