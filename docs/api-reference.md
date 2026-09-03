# API Reference

All chat endpoints accept and return the format matching their path
(translated automatically between providers). Auth: dashboard session **or**
`Authorization: Bearer <CLIENT_API_KEY>`.

## Chat

| Endpoint | Client format |
| --- | --- |
| `POST /v1/chat/completions` | OpenAI Chat (vision & audio parts supported) |
| `POST /v1/messages` | Anthropic Messages |
| `POST /v1/responses` | OpenAI Responses |
| `GET /v1/models` | Merged model list |

`"stream": true` → SSE (`data: {…}` … `data: [DONE]`) with keep-alive
comments while waiting for the first byte.

Error shape is consistent:

```json
{ "error": { "message": "…", "type": "model_not_found" } }
```

`type` distinguishes the cause: `model_not_found` (unknown model),
`model_disabled` (`model 'X' is disabled`), or `provider_disabled`
(`model 'X' is unavailable: provider 'Y' is disabled`). Status is 404 in
all three cases so clients can handle them uniformly.

Common codes: 400 invalid body · 401/403 auth/guard · 404 model/provider not
found · 429 rate limit/concurrency · 502 upstream failure. Upstream 5xx is
retried once; **the 120s timeout is not retried**.

## Media passthrough

| Endpoint | Body | Response |
| --- | --- | --- |
| `POST /v1/images/generations` | JSON `{model, prompt, …}` | Upstream JSON |
| `POST /v1/audio/speech` | JSON `{model, input, voice, …}` | Binary audio |
| `POST /v1/audio/transcriptions` | multipart/form-data | Upstream JSON |

Routing uses the `model` field; it must be registered under a provider.

## Dashboard routes

| Path | Page |
| --- | --- |
| `/`, `/home` | Dashboard + usage chart |
| `/providers`, `/providers/[id]`, `/providers/create` | Providers, keys, models, chat playground |
| `/api-manager` (+ create/$id) | Client API keys |
| `/combo`, `/compression`, `/proxies` (+create) | Combo engine, compression, proxy engine |
| `/logs`, `/logs/proxy` | Realtime request & proxy logs |
| `/analytics/usage` | Usage analytics |
| `/agents` | AI Agents — harness config & MCP registration |

Other internal endpoints (`/api/logs/*`, `/api-manager/export`, etc.) are
used by the dashboard and are not public contract.
