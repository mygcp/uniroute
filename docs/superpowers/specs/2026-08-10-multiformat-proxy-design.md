# Multi-Format Proxy + /v1/models Design

## Tujuan

UniRoute sudah punya `/v1/chat/completions` (OpenAI chat) sebagai proxy endpoint.
Rencana ini menambahkan dukungan **multi-format client API**:

- `POST /v1/chat/completions` — OpenAI Chat Completions (existing, direfactor ke pipeline bersama).
- `POST /v1/responses` — OpenAI Responses API.
- `POST /v1/messages` — Anthropic Messages API.
- `GET /v1/models` — listing model, bisa **public** (berdasar flag `is_public` per model + toggle global `models_public`).

Semua proxy endpoint di-autentikasi **client API key** (`sk-…`) yang dibuat di
dashboard `/api`. Client API key dirombak: **custom prefix** saat pembuatan dan
**penghapusan dummy keys** yang tersisa di database.

## Fakta & Batasan Terverifikasi

- Registry tiap provider sudah punya field `format`: `openai`, `anthropic`,
  `gemini` (lihat `app/registry/*.ts`). Ini menjadi penentu translator upstream.
- Runtime **Bun**; SSE streaming sudah berjalan lewat `ReadableStream` +
  `createStreamTransformer()` di `app/.server/adapter.ts` (hanya normalize
  delta text ke format OpenAI chat; format anthropic/gemini belum didukung).
- Pipeline guard/rules/balancer/proxy sudah matang di
  `app/routes/v1.chat.completions.ts` (263 baris) — akan di-ekstrak ke shared
  handler tanpa mengubah perilaku; test `v1.chat.completions.test.ts` tetap hijau.
- `model_override`, `pinned_provider_id`, `allowed_models` pada client key tetap
  berlaku di semua endpoint proxy.
- `max_tokens` **wajib** di Anthropic Messages → translator Anthropic harus
  mengisi default bila tidak disediakan.
- Respons `GET /v1/models` memakai format OpenAI:
  `{"object":"list","data":[{"id","object","created","owned_by"}]}`.
- `require_api_key` saat ini hanya mengatur apakah `/v1/chat/completions` menolak
  request tanpa token; kebijakan serupa diterapkan konsisten ke `/v1/responses`
  dan `/v1/messages`.

## Desain

### 1. Canonical format — `app/.server/translate/canonical.ts`

```ts
export type CanonicalContentPart =
  | { type: "text"; text: string }
  | { type: "image"; image_url?: string; data?: string; media_type?: string };

export type CanonicalMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | CanonicalContentPart[];
  name?: string;
  tool_call_id?: string;
  tool_calls?: {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }[];
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
```

### 2. Translator client → canonical — `app/.server/translate/from-*.ts`

- `from-openai-chat.ts`: `messages[]` (string | `[{type,text,image_url}]`),
  `tools[]` (`function.{name,description,parameters}`), `tool_choice`,
  param dasar (temperature, top_p, max_tokens, stop). Param lain → `extra`.
- `from-responses.ts`: `instructions` → system; `input` (string atau array
  `{role,content}`) → messages; blok `input_text`, `input_image`
  (image_url/data+media_type); tools Responses (`name` top-level) → canonical;
  `tool_choice` (`{type,name}`/string); `max_output_tokens` → `max_tokens`;
  output assistant `function_call` + `function_call_output` → tool_calls/tool.
- `from-anthropic.ts`: `system` (string | blok) → system message; `messages[]`
  content string | blok (`text`, `image.source.{type,media_type,data|url}`);
  `tool_use` → assistant tool_calls; `tool_result` → tool message;
  `tools[]` (`input_schema`) → canonical; `tool_choice`
  (`{type:"auto"|"any"|"tool",name}`); `stop_sequences` → stop.

### 3. Translator canonical → provider — `app/.server/translate/to-*.ts`

- `to-openai.ts`: kembalikan ke format chat upstream (content array
  `image_url`; tools; tool_choice). Provider format `openai` (default untuk
  custom/groq/dsb).
- `to-anthropic.ts`: `system` di top-level (string); blok `image.source.base64`;
  assistant tool_calls → `tool_use`; tool → `tool_result`; tools
  `{name,description,input_schema}`; tool_choice anthropic; `stop` →
  `stop_sequences`; `max_tokens` default 4096 bila kosong.
- `to-gemini.ts`: `systemInstruction`; `contents[]` `{role:user|model,
  parts:[{text}|{inline_data}]}`; `functionDeclarations`; `maxOutputTokens`;
  `stopSequences`; tool_calls → `functionCall`, tool → `functionResponse`.

### 4. Streaming — `app/.server/translate/parse-stream.ts` & `format-stream.ts`

- `parse-stream.ts`: tokenizer SSE umum + parser per format upstream
  (openai chat, anthropic event, gemini chunk) → `CanonicalStreamEvent[]`.
  Anthropic: `content_block_start`, `content_block_delta` (text_delta /
  input_json_delta), `message_delta` (stop_reason), `message_stop`.
  Gemini: `candidates[0].content.parts[*].text` / `functionCall`,
  `finishReason`, `usageMetadata`.
- `format-stream.ts`: penulis SSE per format client:
  - **chat**: `choices[0].delta.{content|tool_calls}`, `finish_reason`,
    `data: [DONE]`.
  - **responses**: event `response.created`, `response.output_text.delta`,
    `response.function_call_arguments.delta`, `response.completed`.
  - **messages**: event `message_start`, `content_block_start`,
    `content_block_delta` (text_delta / input_json_delta), `message_delta`,
    `message_stop`.

### 5. Non-streaming — `app/.server/translate/format-response.ts`

Peta 3×3: provider JSON (openai chat / anthropic / gemini) → client JSON
(chat / responses / messages), termasuk usage tokens. Tool calls dan image
diterjemahkan ke bentuk native format client.

### 6. Shared pipeline — `app/.server/proxy-handler.ts`

Ekstrak logika `v1.chat.completions.ts` (guard, rules, balancer, compressor,
model_override, proxy resolve, log) menjadi satu fungsi
`handleProxy(request, { parseInput, formatStream, formatResponse })`.
Route files menjadi tipis:

- `app/routes/v1.chat.completions.ts` → parse `from-openai-chat`, format chat.
- `app/routes/v1.responses.ts` → parse `from-responses`, format responses.
- `app/routes/v1.messages.ts` → parse `from-anthropic`, format anthropic.

Translator upstream dipilih dari `format` registry entry provider terpilih;
body yang dikirim ke upstream ditentukan `to-*.ts` lalu `transformRequest`
(existing) untuk url/header.

### 7. `/v1/models` — `app/routes/v1.models.ts`

- Migrasi DB: `ALTER TABLE models ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0`.
- Setting `models_public` (default `0`) di tabel `settings`.
- Autentikasi: admin session / client key (via `resolveClientKey`) / none.
- Aturan respons:
  - Tanpa auth: jika `models_public=1`, tampilkan model `is_public=1`;
    selain itu `401`.
  - Client key: model public + model yang diizinkan key (`modelAllowed`).
  - Admin session: semua model.
- `owned_by` diambil dari nama provider.

### 8. Client API key — `app/.server/client-key.ts` + UI `/api`

- `generateKey(prefix = "sk-")`; simpan `key_prefix` hasil custom prefix.
- UI "Tambah Key" mendapat input **Prefix** (default `sk-`).
- Hapus dummy keys dari DB (Tmp/Frontend/Bot X/off/test — data percobaan).

### 9. UI dashboard — `app/routes/api.tsx` (+ halaman model)

- Toggle `models_public` (public models on/off).
- Toggle `is_public` per model di daftar model.
- Input prefix di form pembuatan key.

## Di Luar Cakupan

- Management API /v1 untuk keys/providers/rules/stats (dibatalkan sesuai arahan).
- Admin API key terpisah.
- Provider format selain openai/anthropic/gemini (mis. oauth custom).

## Acceptance Criteria

- [ ] `POST /v1/chat/completions` tetap berfungsi (test existing hijau) dan
      streaming chat tetap normalize ke format chat.
- [ ] `POST /v1/responses` menerima format Responses, translate ke provider
      terpilih, dan stream kembali event Responses.
- [ ] `POST /v1/messages` menerima format Anthropic, translate, stream kembali
      event Anthropic.
- [ ] Tool calling & image lintas format (chat↔responses↔messages, gemini).
- [ ] Non-streaming mengembalikan JSON dalam format client.
- [ ] `GET /v1/models` menghormati `models_public` + `is_public` + key scope.
- [ ] Client key mendukung custom prefix; dummy keys terhapus.
