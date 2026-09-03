# Providers, Models, Vision & Audio

## Providers

Created from a template or manually (id, base URL, auth type
`bearer`/`apikey`/`none`). A provider can be disabled without deleting it;
only **active** providers are used for routing.

## Prefix (model namespace)

Each provider can have an optional prefix, stored as a **name only**
(e.g. `openai`, never `openai/`). The `/` separator is added automatically,
so the requestable display id is always `prefix/model_name`.

- No deduping: if the upstream model name already contains a slash, it is
  kept as-is. Prefix `oc` + model `oc/muse1.3` displays (and is requested)
  as `oc/oc/muse1.3`; the part after the first `prefix/` is sent to upstream
  untouched as the bare name.
- Prefixes must be unique across providers (1-32 chars: letters, digits,
  `.` `_` `-`).

## API keys (upstream credentials)

A provider can hold multiple keys. Exactly one acts as the **routing key** —
the credential UniRoute uses to authenticate each request to upstream.
Related features:

- Per-key connectivity test (hits upstream `/models`)
- Model catalog sync from upstream
- Per-account **proxy pool** (see [Proxy Engine](proxy-engine.md))

## Models

- Synced automatically from upstream `/models` (context length included).
- Manual models can be added; one model is marked *primary*.
- Media models (e.g. `dall-e-3`, `tts-1`) just need to be registered so the
  media passthrough endpoints can route them.
- Per-model **custom display name** override: when set, it wins over
  `prefix/model_name` everywhere (listing, chat selector, `/v1/models`) and
  is requestable like any model id. Clearing it falls back to
  `prefix/model_name`. The upstream (bare) name never changes.
- The import dialog has **type-to-search**: filter the fetched upstream
  catalog by substring, with a match count (`N of M match`).

## Disabled provider / model errors

Both return **404** with a typed `error.type`:

- Model on a disabled provider → `provider_disabled`:
  `model 'X' is unavailable: provider 'Y' is disabled`
- Disabled model on an active provider → `model_disabled`:
  `model 'X' is disabled`

## Vision (image input)

Send it in the usual OpenAI format; the gateway translates per provider:

```json
{"role":"user","content":[
  {"type":"text","text":"What is in this image?"},
  {"type":"image_url","image_url":{"url":"https://…"}}
]}
```

| Target | Output shape |
| --- | --- |
| OpenAI-format | `image_url` (direct URL or data URI) |
| Gemini | `fileData` (URL) / `inlineData` (base64) |
| Anthropic | `source.url` / `source.base64` |

## Audio (audio input)

```json
{"type":"input_audio","input_audio":{"data":"<base64>","format":"mp3"}}
```

- OpenAI-format → forwarded as-is
- Gemini → `inlineData{mimeType:"audio/mp3"}`
- Anthropic → audio parts are skipped (API does not support them); text parts remain

## Media generation passthrough

Non-chat endpoints are forwarded raw to the provider that has the model
registered (auth, proxy pool, and logging still apply):

| Endpoint | Purpose |
| --- | --- |
| `POST /v1/images/generations` | Image generation (JSON) |
| `POST /v1/audio/speech` | TTS — binary audio response |
| `POST /v1/audio/transcriptions` | STT — multipart body forwarded intact |

The model must be registered under a provider; otherwise the response is a
404 with guidance to add it.
