# Architecture

## Stack

- **Runtime**: Bun (production) / Node + Vite (dev)
- **Framework**: React Router v8 (SSR, file-based routes in `app/routes`)
- **DB**: SQLite (`bun:sqlite` or `node:sqlite`), WAL, schema created automatically
- **UI**: React 19 + Tailwind v4 with glass design tokens (see `app/app.css`)

## Chat request flow

```
client ──POST /v1/chat/completions──▶ handleProxy
                                        │
              1. authorize              │ session cookie / Bearer client key
              2. guard + routing rule   │ allowlist, rewrite, fallback
              3. concurrency/quota      │ per client key
              4. pick provider          │ balancer strategy + pinned
              5. translate request      │ openai-chat ⇄ anthropic ⇄ gemini
              6. egress                 │ client-key pool → account pool →
              │                         │ provider pool → global → direct
              7. stream/JSON            │ SSE transformer per format
              │                         │ (empty delta frames are not
              │                         │  forwarded to the client)
              8. onComplete             │ request_logs (+realtime broadcast)
```

Egress is chosen by `resolveProxyPool` and **ordered by the pool's
`strategy`** (`round_robin` LRU, `priority` list order, `random`). The proxy
used is logged (`via_proxy`, `proxy_id`) and its health is updated.

## Hot-path optimizations

- **Registry cache**: the model→provider mapping is cached in memory;
  invalidation happens at mutation points (`provider-models.ts`, MCP tools,
  route actions) — `handleProxy` never reloads per request.
- **Streaming**: the upstream body is piped through a `TransformStream`
  (not a manual reader wrapper) with a per-instance decoder; empty text
  delta frames from upstream are not forwarded.
- **Prepared statement cache** for SQLite drivers without an internal cache.

## Storage (main tables)

| Table | Contents |
| --- | --- |
| `providers`, `models`, `provider_credentials` | Upstreams & credentials (multiple keys per provider, one *routing key*) |
| `routing_rules`, `model_allowlist` | Model rewrite/fallback, guard |
| `client_api_keys`, `key_usage_daily` | Client keys + quota/budget/scopes |
| `outbound_proxies`, `proxy_pools`, `proxy_pool_assignments` | Proxy engine (strategy per pool) |
| `request_logs` | One row per request — status, duration, tokens (in/out/cached), transport (via_proxy/proxy_id), endpoint, TLS |
| `proxy_logs` | Operational egress/auth/compressor events — client_ip, api_key_id, provider, proxy_id, latency |
| `chat_sessions`, `chat_messages` | Saved Chat Playground conversations |
| `settings` | Internal KV (global pool id, reveal toggle, etc.) |

Hot indexes are created automatically for the most-used filter/group columns
(`created_at`, `status`, etc.).

## Key server modules

| Module | Role |
| --- | --- |
| `.server/proxy-handler.ts` | Orchestrates one chat request (auth→route→execute) |
| `.server/executor.ts` | Upstream execution + streaming via `TransformStream` (empty-delta filter, keep-alive, token counting) |
| `.server/translate/*` | Canonical format between client ⇄ provider (chat, stream, usage) |
| `.server/outbound-proxy.ts` | Proxy/pool CRUD + strategy-aware egress resolution |
| `.server/logger.ts` + `log-stream.ts` | Batched inserts + realtime SSE broadcast |
| `.server/usage.ts`, `stats.ts` | Usage analytics |
| `.server/agents-config.ts` | Agent harness configs (backup/restore/MCP registration) |
| `mcp-server.ts` | MCP stdio/HTTP server (40 tools) |

## Realtime

The Monitoring & AI Agents pages receive events over SSE `/api/logs/stream`
(new logs, request start/end). The `useRealtimeLogs` hook manages buffering,
rAF batching, pause/resume, and in-flight request tracking.
