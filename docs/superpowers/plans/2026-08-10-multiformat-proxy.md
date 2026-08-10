# Plan: Multi-Format Proxy + /v1/models

Spec: `docs/superpowers/specs/2026-08-10-multiformat-proxy-design.md`

## Ringkasan

Bangun **translation layer** yang membuat UniRoute menerima tiga format client API
(OpenAI chat, OpenAI Responses, Anthropic Messages) dan meneruskannya ke provider
dengan format apa pun (openai / anthropic / gemini), termasuk tool calling,
gambar, dan streaming. Tambah `GET /v1/models` dengan flag `is_public` per model
dan toggle `models_public`. Romba client API key: custom prefix + bersihkan dummy.

Runtime: **Bun**. Test: `bun test --parallel $(find ./app/.server ./app/routes -maxdepth 1 -name '*.test.ts')`.
Typecheck: `npm run typecheck`. Build: `npm run build`.

## Struktur File

Dibuat:
- `app/.server/translate/canonical.ts` — tipe CanonicalRequest/Message/Event.
- `app/.server/translate/from-openai-chat.ts` — chat → canonical.
- `app/.server/translate/from-responses.ts` — Responses → canonical.
- `app/.server/translate/from-anthropic.ts` — Messages → canonical.
- `app/.server/translate/to-openai.ts` — canonical → chat upstream.
- `app/.server/translate/to-anthropic.ts` — canonical → Anthropic.
- `app/.server/translate/to-gemini.ts` — canonical → Gemini.
- `app/.server/translate/parse-stream.ts` — provider SSE → CanonicalEvent.
- `app/.server/translate/format-stream.ts` — CanonicalEvent → client SSE + `composeStreamTransformer`.
- `app/.server/translate/format-response.ts` — non-streaming provider JSON → client JSON.
- `app/.server/translate/index.ts` — barrel: `toProvider()`, `fromProvider`? (pilih format).
- `app/.server/proxy-handler.ts` — pipeline bersama (guard/rules/balancer/proxy/exec).
- `app/.server/model-public.ts` — helpers `is_public` + setting `models_public`.
- `app/routes/v1.responses.ts`, `app/routes/v1.messages.ts`, `app/routes/v1.models.ts`.
- Test files: `translate/*.test.ts`, `proxy-handler.test.ts`, `v1.models.test.ts`.

Diubah:
- `app/.server/db.ts` — migrasi `models.is_public`.
- `app/.server/client-key.ts` — `generateKey(prefix)`; hapus dummy keys (SQL sekali jalan).
- `app/.server/executor.ts` — dukung `streamTransformer` + jalur non-streaming JSON.
- `app/.server/adapter.ts` — `transformRequest(body, provider, { model })` sadar format.
- `app/routes/v1.chat.completions.ts` — jadi thin wrapper `handleProxy`.
- `app/routes/api.tsx` — input prefix + toggle `models_public`.
- `app/routes/combo.tsx` — toggle `is_public` per model.

## Type Kunci (kontrak antar modul)

```ts
// canonical.ts
export type CanonicalContentPart =
  | { type: "text"; text: string }
  | { type: "image"; image_url?: string; data?: string; media_type?: string };

export type CanonicalMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | CanonicalContentPart[];
  name?: string;
  tool_call_id?: string;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
};

export type CanonicalTool = {
  type: "function";
  function: { name: string; description?: string; parameters: Record<string, unknown> };
};

export type CanonicalRequest = {
  model: string;
  messages: CanonicalMessage[];
  stream: boolean;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stop?: string | string[];
  tools?: CanonicalTool[];
  tool_choice?: unknown;
  extra: Record<string, unknown>;
};

export type CanonicalStreamEvent =
  | { type: "message_start"; model: string }
  | { type: "content_start" }
  | { type: "content_delta"; text: string }
  | { type: "tool_calls_delta"; id?: string; name?: string; arguments: string }
  | { type: "finish"; finish_reason: string; usage?: { prompt_tokens: number; completion_tokens: number } }
  | { type: "done" };

export type ClientFormat = "openai-chat" | "openai-responses" | "anthropic";
export type ProviderFormat = "openai" | "anthropic" | "gemini";

export type StreamTransformer = {
  transform(chunk: Uint8Array): Uint8Array;
  flush(): Uint8Array;
  countTokens?: (chunkText: string) => number;
};
```

`ProviderFormat` diambil dari `RegistryFormat` (`app/types/index.ts`) — nilai
`claude` di-map ke `anthropic`.

---

## Task 1 — Migrasi DB: `models.is_public` + helper `model-public.ts`

TDD: test dulu di `app/.server/model-public.test.ts` (gunakan pola `test-env.ts`:
set `DATABASE_URL` ke `/tmp/...` sebelum import db).

`app/.server/db.ts` — tambah blok migrasi idempoten setelah migrasi yang ada:
```ts
const modelCols = query("PRAGMA table_info(models)").all() as { name: string }[];
if (!modelCols.some((c) => c.name === "is_public")) {
  db.exec("ALTER TABLE models ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0");
}
```

`app/.server/model-public.ts`:
- `isModelsPublic(): boolean` — baca settings `models_public` (`"1"` → true).
- `setModelsPublic(v: boolean): void` — upsert settings.
- `setModelPublic(modelId: number, v: boolean): void` — `UPDATE models SET is_public=? WHERE id=?`.
- `listPublicModels(): { id, model_name, provider_id, context_length, owned_by }[]` —
  `SELECT m.*, p.name AS owned_by FROM models m JOIN providers p ON p.id=m.provider_id WHERE m.is_active=1 AND m.is_public=1`.

Test: insert model, set is_public, listPublicModels memfilter benar; settings
`models_public` default off.

---

## Task 2 — Client API key: custom prefix + bersihkan dummy

TDD di `app/.server/client-key.test.ts` (file sudah ada; baca dulu).

`app/.server/client-key.ts`:
- `generateKey(prefix = "sk-")`: normalisasi prefix (trim; jika kosong atau
  mengandung karakter selain `[A-Za-z0-9_-]` → fallback `"sk-"`), return
  `` `${prefix}${hex}` ``.
- `CreateClientKeyInput` tambah `prefix?: string`.
- `createClientKey`: gunakan `generateKey(input.prefix)`; simpan `key_prefix`
  = prefix hasil normalisasi (bukan 8 karakter pertama lagi).
- `toClientKey`/query tidak berubah (kolom `key_prefix` sudah ada).

Perilaku lama dipertahankan: tanpa `prefix` → `sk-…` (test existing tetap hijau).

Bersihkan dummy keys (sekali jalan, manual):
```sql
DELETE FROM client_api_keys WHERE name IN ('Tmp','Frontend','Bot X','off','test');
```

Test: `generateKey()` default `sk-`; `generateKey("ur-")` → `ur-…`; prefix berisi
spasi/karakter aneh → fallback.

---

## Task 3 — Canonical types

`app/.server/translate/canonical.ts`: tipe di atas. Helper kecil:
- `toText(m: CanonicalMessage): string | null` — gabung content jika string atau
  array semua `{type:"text"}`.
- Test file opsional minimal (ekspor type saja tidak perlu test).

---

## Task 4 — Translator client → canonical

TDD: `app/.server/translate/from-translators.test.ts`.

`from-openai-chat.ts` → `export function parse(body: Record<string, unknown>): CanonicalRequest`
- `model`, `stream` (bool), `temperature`, `top_p`, `max_tokens`, `stop`.
- `messages`: role system/user/assistant/tool; content string → string; array
  `[{type:"text",text}|{type:"image_url",image_url:{url}}]` → `CanonicalContentPart[]`
  (image_url → `{type:"image", image_url: url}`).
- assistant `tool_calls` (passthrough), tool message `tool_call_id`.
- `tools` → `CanonicalTool`; `tool_choice` raw.
- Sisa field → `extra`.

`from-responses.ts` → `parse(body)`:
- `instructions` (string) → pesan system pertama (jika ada).
- `input`: string → satu pesan user; array `[{role, content}]` di mana content
  bisa `string | [{type:"input_text",text}|{type:"input_image",image_url|data+media_type}|{type:"output_text",text}]`.
  - `input_text` → text; `input_image` dengan `image_url` → image url; dengan
    `data`+`media_type` → `{type:"image", data, media_type}`.
  - role `developer`/`system` → system; `user`/`assistant`/`tool` dipetakan.
  - item `{type:"function_call", name, arguments, call_id}` pada pesan assistant
    → `tool_calls` (arguments JSON string).
  - item `{type:"function_call_output", call_id, output}` → pesan tool
    (`role:"tool"`, `content: output`, `tool_call_id: call_id`).
- `tools`: `[{type:"function", name, description, parameters}]` (name top-level)
  → `CanonicalTool`.
- `tool_choice`: string atau `{type:"function", name}` → canonical raw
  (`{type:"function", function:{name}}`).
- `max_output_tokens` → `max_tokens`; `temperature`, `top_p`, `stop` dipetakan.

`from-anthropic.ts` → `parse(body)`:
- `system` (string atau `[{type:"text",text}]`) → pesan system.
- `messages`: content string → string; array blok:
  - `{type:"text", text}` → text part.
  - `{type:"image", source:{type:"url",url}}` → `{type:"image", image_url:url}`.
  - `{type:"image", source:{type:"base64",media_type,data}}` → `{type:"image", data, media_type}`.
  - `{type:"tool_use", id, name, input}` → assistant `tool_calls`
    (`arguments: JSON.stringify(input)`).
  - `{type:"tool_result", tool_use_id, content}` → pesan tool
    (content string | array `[{type:"text",text}]` → gabung).
- `tools`: `[{name, description, input_schema}]` → `CanonicalTool`.
- `tool_choice`: `{type:"auto"|"any"|"tool", name?}` → raw.
- `max_tokens` → `max_tokens`; `stop_sequences` (array) → `stop`;
  `temperature`, `top_p` dipetakan; `stream` bool.

Aturan bersama: `stream` default false; model diambil dari `body.model`; pesan
role yang tak dikenal dilempar ke `extra`? — No: abaikan content tak dikenal
(keep as text if string). Jika `model` bukan string → lempar `Error("model required")`
yang ditangkap route → 400.

---

## Task 5 — Translator canonical → provider

TDD: `app/.server/translate/to-translators.test.ts`.

`to-openai.ts` → `export function build(c: CanonicalRequest): Record<string, unknown>`
- `model`, `messages` (content array → `[{type:"text",text}|{type:"image_url",image_url:{url}}]`),
  `tools`, `tool_choice`, `temperature`, `top_p`, `max_tokens`, `stop`, `stream`,
  plus `...c.extra`.

`to-anthropic.ts` → `build(c)`:
- Gabung pesan system → `system` (string).
- `messages`: pesan non-system.
  - assistant `tool_calls` → blok `{type:"tool_use", id, name, input: JSON.parse(arguments)}`.
  - tool → blok `{type:"tool_result", tool_use_id, content: <string>}`.
  - image part → `{type:"image", source:{type:"base64"|"url", media_type?, data?|url?}}`.
- `tools`: `{name, description, input_schema: parameters}`.
- `tool_choice`: map `"auto"`→`{type:"auto"}`; `"any"`/`"required"`→`{type:"any"}`;
  object `{type:"function",function:{name}}`→`{type:"tool", name}`.
- `max_tokens`: `c.max_tokens ?? 4096`.
- `stop`: array string → `stop_sequences` (string → array satu elemen).
- `stream`, `temperature`, `top_p`, `extra` (minus yang sudah dipetakan).

`to-gemini.ts` → `build(c)`:
- `contents`: system dipisah → `systemInstruction: { parts: [{ text }] }`.
- user/assistant → `{ role: "user"|"model", parts: [...] }`:
  - text part → `{ text }`.
  - image url → `{ fileData: { mimeType?, fileUri } }`; image data → `{ inlineData: { mimeType, data } }`.
  - assistant `tool_calls` → `{ functionCall: { name, args: JSON.parse(arguments) } }`.
  - tool → `{ functionResponse: { name, response: { result: content } } }`.
- `tools`: `[{ functionDeclarations: [{ name, description, parameters }] }]`.
- `generationConfig`: `temperature`, `topP`, `maxOutputTokens`, `stopSequences`.
- `extra` disebar ke tingkat atas jika bukan kunci Gemini.

---

## Task 6 — Streaming: parse provider SSE → canonical events

TDD: `app/.server/translate/parse-stream.test.ts` (sampel SSE untuk ketiga format).

`parse-stream.ts`:
```ts
export function tokenizeSse(bytes: Uint8Array): { frames: string[]; rest: Uint8Array }
export function parseFrame(providerFormat: ProviderFormat, frame: string): CanonicalStreamEvent | null
```
- `tokenizeSse`: akumulasi buffer, potong per `\n\n`, frame = gabungan baris
  `data:` / `event:` (return frame text dari payload `data:` saja; bila event
  anthropic, `event:` diambil sebagai konteks — cukup parse dari payload JSON
  karena semua event punya `type`).
- `parseFrame("openai", frame)`: JSON `choices[0].delta.content` → `content_delta`;
  `delta.tool_calls[*]` (id/name/arguments parsial) → `tool_calls_delta`;
  `choices[0].finish_reason` → `finish`; `[DONE]` → `done`; `usage` → lampirkan ke finish.
- `parseFrame("anthropic", frame)`: `message_start` → `message_start` (model);
  `content_block_start` dengan `content_block.type==="tool_use"` → `tool_calls_delta`
  dengan `name`; `content_block_delta.delta.type==="text_delta"` → `content_delta`;
  `content_block_delta.delta.type==="input_json_delta"` → `tool_calls_delta`
  (`arguments: partial_json`); `message_delta.delta.stop_reason` → `finish`;
  `message_stop` → `done`.
- `parseFrame("gemini", frame)`: `candidates[0].content.parts[*].text` →
  `content_delta`; `parts[*].functionCall` → `tool_calls_delta`
  (`arguments: JSON.stringify(args)`); `candidates[0].finishReason` → `finish`;
  `usageMetadata` → usage; tidak ada event → `null`.

---

## Task 7 — Streaming: canonical events → client SSE

TDD: `app/.server/translate/format-stream.test.ts`.

`format-stream.ts`:
```ts
export function formatEvent(clientFormat: ClientFormat, ev: CanonicalStreamEvent): string | null
export function composeStreamTransformer(providerFormat: ProviderFormat, clientFormat: ClientFormat): StreamTransformer
```
- `composeStreamTransformer`: bungkus loop read → `tokenizeSse` → `parseFrame` →
  `formatEvent` → bytes; `countTokens` = estimasi token dari teks delta (regex per format client).
- `formatEvent("openai-chat", ev)`:
  - `content_delta` → `data: {"choices":[{"delta":{"content":"…"},"index":0}]}\n\n`.
  - `tool_calls_delta` → `data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":?,"function":{"name":?,"arguments":"…"}}]},"index":0}]}\n\n`.
  - `finish` → `data: {"choices":[{"delta":{},"index":0,"finish_reason":"…"}]}\n\n`.
  - `done` → `data: [DONE]\n\n`.
- `formatEvent("openai-responses", ev)`:
  - `message_start` → `data: {"type":"response.created","response":{"id":...,"object":"response","status":"in_progress","output":[]}}\n\n` (id: `resp_` + random).
  - `content_start` → `data: {"type":"response.output_item.added","item_id":...,"output_index":0,"item":{"type":"message",...}}` + `response.content_part.added`.
  - `content_delta` → `data: {"type":"response.output_text.delta","item_id":...,"output_index":0,"content_index":0,"delta":"…"}\n\n`.
  - `tool_calls_delta` → `data: {"type":"response.function_call_arguments.delta","item_id":...,"output_index":0,"delta":"…"}\n\n`.
  - `finish` → `data: {"type":"response.completed","response":{"id":...,"object":"response","status":"completed","output":[]}}\n\n`.
  - `done` → `null` (Responses API tidak pakai `[DONE]`).
- `formatEvent("anthropic", ev)`:
  - `message_start` → `event: message_start\ndata: {"type":"message_start","message":{"id":...,"type":"message","role":"assistant","model":"…","content":[],"stop_reason":null,"usage":{"input_tokens":0,"output_tokens":0}}}\n\n`.
  - `content_start` → `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n`.
  - `content_delta` → `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"…"}}\n\n`.
  - `tool_calls_delta` (dengan name) → `event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"…","name":"…","input":{}}}\n\n`.
  - `tool_calls_delta` (arguments) → `event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"…"}}\n\n`.
  - `finish` → `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":…}}\n\n`.
  - `done` → `event: message_stop\ndata: {"type":"message_stop"}\n\n`.

---

## Task 8 — Non-streaming: provider JSON → client JSON

TDD: `app/.server/translate/format-response.test.ts` (sampel 3×3).

`format-response.ts`:
```ts
export function translateResponse(providerFormat: ProviderFormat, clientFormat: ClientFormat, json: unknown): unknown
```
- **provider openai** (chat response `choices[0].message`, `usage`):
  - → chat: passthrough (return json).
  - → anthropic: `{id,type:"message",role:"assistant",model,content:[{type:"text",text}],stop_reason,usage:{input_tokens,output_tokens}}`.
  - → responses: `{id,object:"response",status:"completed",model,output:[{type:"message",id,role:"assistant",content:[{type:"output_text",text}]}],usage}`.
- **provider anthropic** (`content[]`, `stop_reason`, `usage.input_tokens/output_tokens`):
  - → chat: `choices[0].message.{role:"assistant",content:<gabung text>}` + usage.
  - → anthropic: passthrough.
  - → responses: seperti di atas.
- **provider gemini** (`candidates[0].content.parts`, `usageMetadata`):
  - → chat/anthropic/responses: gabung text parts → pesan assistant.
- Tool calls ikut diterjemahkan: chat `tool_calls` ↔ anthropic `tool_use` block ↔
  responses `function_call` item.

---

## Task 9 — Executor: streamTransformer + jalur JSON

TDD: perbarui `app/.server/executor.test.ts` (baca dulu; pertahankan semua kasus).

`app/.server/executor.ts`:
- `ExecutorOptions` tambah: `stream?: boolean` (default true),
  `streamTransformer?: StreamTransformer`.
- Refactor `attempt()` agar mengembalikan **raw upstream Response** (bukan hasil
  `buildStreamResponse`). Loop retry/failover dipindah ke fungsi bersama.
- `executeStreaming`: jika ok → `buildStreamResponse(upstream, controller, options)`
  memakai `options.streamTransformer ?? createStreamTransformer()`; token counting:
  `transformer.countTokens?.(text) ?? countDeltaContent(text)`.
- Tambah `executeJson(options): Promise<{ ok: true; status: number; json: unknown } | { ok: false; status: number; error: string }>`:
  retry/failover sama; jika ok → `await upstream.text()`, `JSON.parse` (gagal parse
  → `{ok:false,status:502,error:"invalid upstream json"}`); `onComplete({status:"success"|"error", ...})`.

---

## Task 10 — Adapter: URL sadar format

TDD: perbarui `app/.server/adapter.test.ts` (tambah kasus anthropic/gemini).

`app/.server/adapter.ts`:
```ts
export function transformRequest(body, provider, opts?: { model?: string }): TransformResult
```
- URL:
  - `entry?.urlSuffix` → `base/urlSuffix` (existing).
  - format `anthropic` → `new URL("/v1/messages", base)`.
  - format `gemini` → `${base}/v1beta/models/${opts?.model ?? ""}:generateContent`.
  - default → `new URL("/v1/chat/completions", base)`.
- Header auth tetap (bearer/apikey/authHeader).

---

## Task 11 — Shared pipeline: `proxy-handler.ts`

TDD: `app/.server/proxy-handler.test.ts` (mengikuti pola `v1.chat.completions.test.ts`:
seed db temp; kasus: JSON invalid → 400; tanpa model → 400; require key on +
tanpa token → 401; session admin bypass; model tak ada → 404; model diblokir
allowlist → 403; model dilarang key → 403).

`app/.server/proxy-handler.ts`:
```ts
export type ProxyHandlerConfig = {
  clientFormat: ClientFormat;
  parse: (body: Record<string, unknown>) => CanonicalRequest;
};
export async function handleProxy(request: Request, config: ProxyHandlerConfig): Promise<Response>
```
Langkah (urutan persis dari `v1.chat.completions.ts` yang sekarang, hanya body
beroperasi pada `CanonicalRequest`):
1. Baca JSON → 400 jika invalid.
2. `canonical = config.parse(body)`; `model = canonical.model` → 400 jika kosong.
3. `authorize(request)` (pindahkan logika dari route: session → null rule; bearer
   client key; `require_api_key`).
4. `modelAllowed(rule, model)` → 403 (log deny).
5. `model_override` → ubah `canonical.model`.
6. `checkAllowlist(model)` → 403.
7. `evaluateRules(model)` deny → 403; rewrite → ganti model.
8. Compressor: jika `isEnabled()` dan pesan terakhir content string (atau
   `[{type:"text",text}]`) → compress teksnya (fallback log via `recordProxyLog`).
9. `pool = getProviders(effectiveModel)` → 404 jika kosong.
10. `cfg = getStrategy`, `selected = selectProvider`, `candidates = orderCandidates(pool, selected, fallbackId, pinned)`.
11. Loop candidates (maks 2 attempt):
    - `entry = getRegistryEntry(provider.id)`; `providerFormat = (entry?.format === "claude" ? "anthropic" : entry?.format) ?? "openai"`.
    - `providerBody = toProvider(providerFormat, canonical)` (pilih to-* oleh format).
    - `transformed = transformRequest(providerBody, provider, { model: effectiveModel })`.
    - jika `canonical.stream` → `executeStreaming({..., streamTransformer: composeStreamTransformer(providerFormat, clientFormat) })`;
      response stream langsung dikembalikan ke client (break).
    - jika tidak → `executeJson(...)`; jika ok → `translateResponse(providerFormat, clientFormat, json)` → `json(result, upstreamStatus)`; break.
    - error attempt → lanjut ke candidate berikutnya; setelah semua → 502.
    - `onComplete` mencatat request_log + `endConnection` (pindahkan dari route).
12. `reload()` dan `markUsed(selected)` tetap dipanggil.

`app/.server/translate/index.ts`: barrel `{ parseChat, parseResponses, parseAnthropic, toOpenAi, toAnthropic, toGemini }` + `toProvider(format, c)`.

---

## Task 12 — Refactor route `/v1/chat/completions`

`app/routes/v1.chat.completions.ts` → muat ulang jadi:
```ts
import type { Route } from "./+types/v1.chat.completions";
import { handleProxy } from "../.server/proxy-handler";
import { parse } from "../.server/translate/from-openai-chat";

export async function action({ request }: Route.ActionArgs) {
  return handleProxy(request, { clientFormat: "openai-chat", parse });
}
```
- Test existing `v1.chat.completions.test.ts` harus tetap hijau tanpa perubahan.
- Logika `authorize`, `orderCandidates`, `json()` pindah ke `proxy-handler.ts`.

---

## Task 13 — Routes `/v1/responses` & `/v1/messages`

TDD: `app/.server/v1.responses.test.ts` & `v1.messages.test.ts` (kasus auth &
validasi sama seperti chat; flatRoutes mendaftar otomatis dari nama file).

- `app/routes/v1.responses.ts`: `action` → `handleProxy(request, { clientFormat: "openai-responses", parse: parseResponses })`.
- `app/routes/v1.messages.ts`: `action` → `handleProxy(request, { clientFormat: "anthropic", parse: parseAnthropic })`.

---

## Task 14 — `GET /v1/models`

TDD: `app/.server/v1.models.test.ts`.

`app/routes/v1.models.ts`:
```ts
export async function loader({ request }: Route.LoaderArgs): Promise<Response>
```
- Auth: session admin (`isValid(getSessionToken)`) → semua model (aktif).
  - Bearer `sk-…` via `resolveClientKey` → public + `modelAllowed(rule, m)`.
  - Tanpa auth → jika `isModelsPublic()` → `listPublicModels()`; selain itu 401.
- Respons: `{ object:"list", data:[{ id: model_name, object:"model", created: m.created_at ?? 0, owned_by }] }`,
  sort by `id`.
- Filter `is_active=1` selalu.

---

## Task 15 — UI: prefix, models_public, is_public

- `app/routes/api.tsx`:
  - Form "Tambah Key": tambah input `name="prefix"` default `sk-`; action `create`
    kirim `prefix` ke `createClientKey`.
  - Bagian baru "Public Models": toggle checkbox `models_public` → action
    `section="settings"`, `intent="models_public"`, `enabled`.
- `app/routes/combo.tsx`:
  - Loader tambah `is_public` di query model.
  - Kolom/row model: checkbox toggle `is_public` → action baru
    `section="mapping"`, `intent="public"`, `id`, `enabled` → `setModelPublic`.
- Typecheck & build hijau.

---

## Task 16 — Verifikasi akhir

- Hapus dummy keys (SQL Task 2).
- `npm run typecheck`.
- `npm run build`.
- `bun test --parallel $(find ./app/.server ./app/routes -maxdepth 1 -name '*.test.ts')`.
- Smoke test manual:
  - `curl -N -X POST localhost:3000/v1/messages -H "Authorization: Bearer <key>" -d '{"model":"...","max_tokens":50,"messages":[{"role":"user","content":"halo"}]}'`.
  - `curl localhost:3000/v1/models` (tanpa auth → sesuai `models_public`).
