# Fase 2 — Core Proxy Pipeline (Kritis)

> **For agentic workers:** REQUIRED SUB-SKILL: subagent-driven-development atau executing-plans. Steps use checkbox syntax.

**Tujuan:** Membangun inti UniRoute: pipeline streaming `/v1/chat/completions` sebagai transparent proxy dengan zero-buffering. Ini adalah bagian PERTAMA yang wajib berfungsi (Prioritas 1 PRD §14).

**Deliverable:** `POST /v1/chat/completions` menerima request OpenAI format, memproses 5-stage (Route → Translate → Execute → Stream → Record), dan return SSE stream token-per-token tanpa menumpuk response di memory. Test dengan mock upstream provider.

**Sumber:** PRD §2 (5-stage pipeline), §3 (komponen), §11 (alur streaming), §10.5 (resource route), Acceptance criteria §13.

---

## Task 2.1 — Registry (model → provider)

**Files:**
- Create: `app/.server/registry.ts`

**Interfaces:**
- Consumes: `db` dari `app/.server/db.ts` (Fase 1).
- Produces: `getProviders(model: string): Provider[]`, `getAnyProvider(model: string): Provider[]`, `reload(): void`, `type Provider`.

- [ ] **Step 1: Definisikan tipe `Provider`**

```ts
export type Provider = {
  id: string;
  name: string;
  base_url: string;
  auth_type: "none" | "bearer" | "apikey";
  is_active: boolean;
  weight: number;
  priority: number;
  current_connections: number;
  last_used_at: number;
};
```

- [ ] **Step 2: Buat cache in-memory + reload dari join `models` × `providers`**

```ts
import { db } from "./db";

const cache = new Map<string, Provider[]>();

export function reload() {
  cache.clear();
  const rows = db.query(`
    SELECT p.* FROM models m
    JOIN providers p ON p.id = m.provider_id
    WHERE m.is_active = 1 AND p.is_active = 1
  `).all() as Provider[];
  for (const row of rows) {
    const list = cache.get(row.model_name) ?? [];
    list.push(row);
    cache.set(row["model_name"], list);
  }
}
```

- [ ] **Step 3: Getter**

```ts
export function getProviders(model: string): Provider[] {
  if (cache.size === 0) reloadProviders();
  return cache.get(model) ?? [];
}
```

- [ ] **Step 4: TDD - tulis test `registry.test.ts` (bun:test)**

```ts
import { describe, test, expect } from "bun:test";
```

Test: seed dengan `gpt-4o` → 3 provider; provider non-aktif tidak dikembalikan; `reload()` setelah perubahan DB mengembalikan dengan benar.

- [ ] **Step 5: Verifikasi**

```bash
bun test app/.server/registry.test.ts
```

Expected: PASS.

---

## Task 2.2 — Adapter (transform OpenAI ↔ provider)

**Files:**
- Create: `app/.server/adapter.ts`

**Interfaces:**
- Consumes: tipe `Provider`.
- Produces: `transformRequest(body: Record<string, unknown>, provider: Provider, options): { url: string; headers: Headers; body: string }`, `transformStreamChunk(chunk: Uint8Array, provider: Provider): Uint8Array`.

> Fase ini fokus pada provider yang OpenAI-compatible (OpenAI, Groq, OpenRouter, Mistral, DeepSeek) yang mirip format. Provider khusus Anthropic/Google menjadi ekstensi di fase berikutnya (disampel placeholder path).

- [ ] **Step 1: `transformRequest` untuk provider OpenAI-compatible**

```ts
export function transformRequest(body, provider) {
  const url = new URL("/v1/chat/completions", provider.base_url).toString();
  const headers = new Headers({
    "Content-Type": "application/json",
  });
  if (provider.auth_type === "bearer") {
    const key = getApiKey(provider.id); // dari credential store (Fase 2.6)
    headers.set("Authorization", `Bearer ${key}`);
  } else if (provider.auth_type === "apikey") {
    headers.set("x-goog-api-key", getApiKey(provider.id));
  }
  // body dimap: pastikan field model tetap model yang dipakai client
  return { url, headers, body: JSON.stringify(body) };
}
```

- [ ] **Step 2: `transformStreamChunk` — parse chunk upstream menjadi SSE OpenAI delta**

```ts
export function transformStreamChunk(chunk, provider) {
  const text = new TextDecoder().decode(chunk);
  // setiap baris "data: {...}" upstream → rewrite jadi format OpenAI
  // output: "data: {\"choices\":[{\"delta\":{\"content\":\"...\"}}]}\n\n"
  return new TextEncoder().encode(transformedSse);
}
```

> Implementasi detail: parse buffer teks, sisakan potongan partial di toggle sampai baris `\n` lengkap (`buffered` state per stream). **Tetap zero-buffer**: hanya baris partial yang dipindah, bukan seluruh response.

- [ ] **Step 3: TDD test adapter**

Test: input chunk OpenAI-style partial + complete → output SSE delta benar; nama provider non-OpenAI menghasilkan path yang benar.

- [ ] **Step 5: Verifikasi**

```bash
bun test app/.server/adapter.test.ts
```

---

## Task 2.3 — Executor (streaming pipeline)

**Files:**
- Create: `app/.server/executor.ts`

**Interfaces:**
- Consumes: `transformRequest`, `transformStreamChunk` (2.2), `Provider`.
- Produces: `executeStreaming({ url, headers, body, signal, onRecord }): Promise<Response>`, dan granular `start + stream` internal helper.

- [ ] **Step 1: `executeStreaming` — fetch + ReadableStream output**

```ts
export async function handleStreaming({ url, headers, body, signal, provider }) {
  const timeout = AbortSignal.timeout(120_000); // PRD execute timeout
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort);

  const upstream = await fetch(url, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.any([timeout, controller.signal]),
  });
  if (!upstream.ok || !upstream.body) {
    return new Response(await upstream.text(), { status: upstream.status });
  }

  const reader = upstream.body.getReader();
  const stream = new ReadableStream({
    async start(wsController) {
      try {
        let buffer = "";
        while (true) {
          const { done, value } = await reader.read(); // chunk 4KB
          if (done) { wsController.enqueue(new TextEncoder().encode("data: [DONE]\n\n")); break; }
          buffer += new TextDecoder().decode(value);
          // split per event, transform tiap data: {...}
          ...
          wsController.enqueue(transformedChunk); // flush instan
        }
        wsController.close();
      } catch (e) {
        wsController.error(e);
      } finally {
        reader.releaseLock();
        abort();
      }
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
  });
}
```

> **JANGAN** mengakumulasi seluruh response. Hanya potongan partial buffer (max 1 event) yang dipers.

- [ ] **Step 2: Retry ≤ 1x**

Jika hasil pertama: network error / status 5xx / 429 sebelum stream : coba 1x lagi dengan provider sama. Setelah itu stop.

- [ ] **Step 3: Test dengan mock upstream**

Buat `scripts/mock-upstream.ts` (Bun).Server): jalankan di `localhost:8787`, endpoint `/v1/chat/completions` yang mengeluarkan SSE bertahap dengan delay 20ms per token.

- [ ] **Step 4: E2E streaming test**

```bash
bun -e "const res = await fetch('http://localhost:8787/...') ..." # atau curl
curl -N -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4o","messages":[{"role":"user","content":"Hi"}],"stream":true}'
```

Expected: token muncul bertahap `data: {...}` per chunk, diakhiri `data: [DONE]`.

---

## Task 2.4 — Guard (model allowlist)

**Files:**
- Create: `app/.server/guard.ts`

**Interfaces:**
- Produces: `checkAllowlist(model: string): {ok: boolean; reason?: string}`.

- [ ] **Step 1: Implement check `model_allowlist`**

```ts
export function checkAllowlist(model: string) {
  const row = db.query(`SELECT action, reason FROM model_allowlist WHERE model_name = ? AND action = 'deny'`).get(model);
  if (row) return { ok: false, reason: row.reason ?? "model denied" };
  return { ok: true };
}
```

Mode default permissive: hanya deny yang memblokir.

- [ ] **Step 2: Test**

Model `nonexistent-model` yang di-seed sebagai deny → `ok: false`; model lain → `ok: true`.

---

## Task 2.5 — Credential store + resource route

**Files:**
- Modify: `app/.server/db.ts` (tambah tabel `provider_credentials` jika perlu) — atau simpan API key di kolom provider (keputusan di bawah).
- Create: `app/routes/v1.chat.completions.ts`

**Keputusan Tersimpan:** PRD menyimpan API key di SQLite. Karena skema §4 belum punya kolom `api_key`, tambahkan tabel `provider_credentials (provider_id TEXT PK, api_key TEXT)` — dipilih atas penyimpanan di env karena PRD §13 "API Key provider diambil dari SQLite".

- [ ] **Step 1: Tambah kolom/tabel credential di `db.ts`**

```sql
CREATE TABLE IF NOT EXISTS provider_credentials (
  provider_id TEXT PRIMARY KEY,
  api_key TEXT NOT NULL,
  updated_at INTEGER DEFAULT (unixepoch())
);
```

Provider seed yang memakai token belum punya key → ditandai `auth_type` saja.

- [ ] **Step 2: `getApiKey(providerId): string | null` di `app/.server/credential.ts`**

Query `provider_credentials.api_key`.

- [ ] **Step 3: Resource route action `v1.chat.completions.ts`**

Alur sesuai PRD §11:

```
1. parse body (JSON)
2. Guard.checkAllowlist(model) → jika deny return 403 {error:{...}}
3. Registry.getProviders(model) → pool
4. Route/Balance → pilih provider (Fase 2 pendekatan: pick pertama; Fase 3 mengganti dengan balancer)
5. transformRequest (adapter)
6. handleStreaming → return Response
7. Record: insert request_logs non-blocking (fire-and-forget .then())
```

- [ ] **Step 4: Record log non-blocking**

Function `recordRequestLog({model, provider_id, strategy_used, rule_applied, duration_ms, status, error_message, prompt_tokens, completion_tokens})` di `app/.server/logger.ts` (detail Fase 6) → call tanpa `await` dari action; internal pakai queue async.

- [ ] **Step 5: Test E2E penuh**

- Mock provider dijalankan.
- Curl ke `POST /v1/chat/completions` dengan model ter-seed.
- Expected: response SSE streaming; `request_logs` berisi row `success`.
- Test deny model → HTTP 403 JSON.

---

## Task 2.6 — Pembersihan: error 403 for deny, health endpoint, dan seed credential

**Files:**
- Modify: `app/routes/v1.chat.completions.ts`
- Create: `scripts/mock-upstream.ts` (final)

- [ ] **Step 1: Upstream not found**

Jika `getProviders(model)` kosong → `404 { error: { message: "model not found" } }`.

- [ ] **Step 2: Standar error**

Untuk error provider (timeout/fetch) → `502 Bad Gateway` JSON dengan message bawaan upstream.

- [ ] **Step 3: Pastikan log & fallback**

Jalankan `bun run dev`, streaming ke mock → `request_logs` dapat diinspeksi via sqlite3 manual (`sqlite3 data/uniroute.db "select * from request_logs"`).

---

## Checkpoint Fase 2 — Verified

- [ ] `curl -N` streaming token-per-token dengan `Content-Type: text/event-stream` dari mock upstream.
- [ ] `data: [DONE]` sebagai EOF.
- [ ] Model deny → 403; model tidak dikenal → 404.
- [ ] `request_logs` tercatat non-blocking.
- [ ] Commit: `feat: core streaming proxy pipeline`