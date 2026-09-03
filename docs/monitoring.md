# Monitoring

## Request logs (`/logs`)

Realtime (SSE, newest first) — a new row appears the moment a request comes
in with a `running` badge, then finalizes when upstream finishes. Parallel
requests stack visibly.

Fixed columns per row: time · status · model · provider · source ·
**PROXY/DIRECT** · duration.

### Detail panel

| Field | Description |
| --- | --- |
| transport | `proxy` / `direct` |
| proxy | name + host:port + id |
| endpoint | `chat-completions` / `messages` / `responses` / combo |
| upstream_tls | https / http |
| prompt/completion/cached/total tokens | split per category |
| est_cost | cost estimate from the pricing table |
| api_key | client key used (label + id) |
| rule_applied | routing rule applied (rewrite/fallback target) |

Filters: model, provider, status, source, transport (proxy/direct), plus
free-text search (errors/rules).

## Proxy logs (`/logs/proxy`)

Operational events: auth denials (client ip + key), per-request egress
(`egress · upstream <provider> via proxy #id`), compressor, resolver
failures. Each row shows the **↳ proxy host:port** when a proxy was used; the
detail panel holds time/latency/client_ip/api_key/provider/endpoint +
message & metadata.

## Usage analytics (`/analytics/usage`)

Range day/week/month/year/all:

- Summary cards: **Total · Input · Output · Cache Tokens**, Est. Cost,
  Requests (+ trend % vs previous period), **Latency p95** (with p50 subline)
- Time series & breakdowns per provider/model/key, plus a success-rate
  trend chart and a "More stats" popover (token split, p95 latency)
- Top error messages

Cached tokens come from official provider usage (OpenAI
`prompt_tokens_details.cached_tokens`, Anthropic `cache_*`, Gemini
`cachedContentTokenCount`) for both JSON and streaming responses.

## Realtime hook

All monitoring pages use SSE `/api/logs/stream` with rAF batching,
pause/resume, a 1000-event cap, and newest-first ordering whose auto-scroll
respects your reading position.
