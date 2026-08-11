# Combo Engine — Design (MVP)

- **Tanggal**: 2026-08-10
- **Status**: Implementasi (MVP: `priority` + `pipeline`)
- **Tag**: combo, priority-chain, pipeline, routing

## 1. Ringkasan

Combo Engine adalah fitur **multi-model sequence routing**: sekumpulan langkah
(step) model yang dieksekusi berurutan sesuai strategi, dialamatkan dari client
sebagai **model sintetis** dengan prefix `combo:<nama>`.

Konsep penuh terinspirasi OmniRoute: priority chains, pipeline/fusion,
conditional routing, adaptive strategy, cost caps, smart caching, A/B testing,
human-in-the-loop, dan telemetri per step. **MVP ini hanya mengimplementasikan
dua strategi inti: priority (fallback chain) dan pipeline (sequential)** — yang
lain didokumentasikan sebagai roadmap.

## 2. Masalah yang Dipecahkan

- API keys uniroute memetakan satu model ke satu pool provider. Client yang
  ingin "coba A, gagal → B, gagal → C" harus melakukan fallback sendiri.
- Pipeline "A menghasilkan draft → B menyunting draft" tidak mungkin tanpa
  orchestrasi di sisi proxy.
- Keduanya dapat diekspresikan sebagai satu primitif: **combo** — daftar step
  bernama yang dieksekusi oleh proxy dengan satu request dari client.

## 3. Konsep & Semantik Strategi

### 3.1 Priority (fallback chain)

`combo:foo` dengan strategy `priority`, steps `[A, B, C]`:

1. Kirim request ke A (dengan fallback provider internal seperti biasa).
2. Jika A gagal (HTTP ≥ 400 atau network error) → coba B, lalu C.
3. Step pertama yang sukses → respons diteruskan ke client.
4. Semua gagal → `502 { error: { message: "all combo steps failed" } }`.

- Request streaming: fallback hanya terjadi **sebelum stream mulai**; begitu
  step mengembalikan 2xx, respons streaming langsung diteruskan.
- Step yang tidak diizinkan oleh api key (`modelAllowed`) → **dilewati**,
  bukan memblokir seluruh request.
- Priority **tidak** me-chain output antar step. (Itu tugas pipeline.)

### 3.2 Pipeline (sequential)

`combo:bar` dengan strategy `pipeline`, steps `[A, B]`:

1. Eksekusi A **non-streaming**.
2. Ekstrak teks utama dari respons A (`extractUpstreamText`) dan tambahkan ke
   messages step B sebagai pesan user `[Output dari langkah sebelumnya]`.
3. B adalah step final: boleh streaming sesuai `stream` request client.
4. Step perantara yang gagal → **hentikan pipeline**, kembalikan error dengan
   detail step gagal. (Bukan fallback chain — itu priority.)

Instruksi per step (`prompt`) disisipkan sebagai system message setelah
system messages asli request (jika ada).

### 3.3 Tambahan

- **Step ref provider**: tiap step boleh mem-pin provider id tertentu
  (`step.provider_id`); bila kosong, provider dipilih via `selectProvider`
  dari pool model tersebut (load balancing biasa berlaku).
- **Skip vs blokir**: model step yang tidak diizinkan api key dilewati
  (priority) / menghentikan pipeline dengan error (pipeline).
- **Model asli vs combo**: nama model asli tidak pernah bentrok; combo hanya
  di-resolve bila string model berawalan `combo:`.

## 4. Model Reference dari Client

- Format: `combo:<nama>` — contoh `combo:coding-fallback`.
- Valid name: `[a-zA-Z0-9._-]+` (dicek `validateComboInput`).
- `parseComboModel("combo:foo")` → `"foo"`; `parseComboModel("gpt-4o")` → `null`.
- Nested combo di dalam step belum didukung (ditolak validasi).

## 5. Arsitektur

```
POST /v1/chat/completions (atau /v1/messages)
        │
        ▼
┌───────────────────────────────────────────────┐
│ proxy-handler.ts (handleProxy)                │
│  parse → authorize → concurrency → guards     │
│  (modelAllowed untuk combo: dilewati)         │
│  → rule processing → effectiveModel          │
│  → resolveCombo(effectiveModel) ── ya ──►    │
│      runComboEngine(...) ◄─────────────────────┼──┐
│        combo-runner.ts                         │  │
│        loop steps → executeStep()              │  │
│          pool resolve → beginConnection        │  │
│          toProvider → transformRequest         │  │
│          executeJson / executeStreaming        │  │
│          recordRequestLog + usage + metric     │  │
│        priority: sukses pertama → return       │  │
│        pipeline: chain text, final → return    │  │
│  ── bukan combo ──► pool/getProviders biasa    │  │
└───────────────────────────────────────────────┘  │
        semua jalur ───────────────────────────────┘
        (concurrency scope di-lepas di finally)
```

### Modul baru

| File | Isi |
| --- | --- |
| `app/.server/combo.ts` | Types, `parseComboModel`, CRUD (`listCombo`, `createCombo`, `updateCombo`, `deleteCombo`), `validateComboInput`, `extractUpstreamText`, `recordComboMetric` |
| `app/.server/combo-runner.ts` | `runComboEngine(params)` — eksekusi strategi, per-step logging/usage/metric |
| `app/routes/combo.chains.tsx` | UI CRUD combo (`/combo/chains`) |

### Schema (tabel baru di `initSchema`, idempotent)

```sql
combos(
  id INTEGER PK AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  strategy TEXT NOT NULL DEFAULT 'priority',   -- 'priority' | 'pipeline'
  config TEXT NOT NULL DEFAULT '{}',           -- cadangan (conditional, caps, dll)
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch())
)
combo_steps(
  id INTEGER PK AUTOINCREMENT,
  combo_id INTEGER NOT NULL REFERENCES combos(id) ON DELETE CASCADE,
  step_order INTEGER NOT NULL,
  provider_id TEXT,        -- pin provider (opsional)
  model_id TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 1.0,   -- cadangan untuk weighted strategy
  prompt TEXT,             -- instruksi step (dipakai pipeline / system hint)
  created_at INTEGER DEFAULT (unixepoch())
)
combo_metrics(            -- fondasi telemetri/adaptive di fase lanjut
  id INTEGER PK AUTOINCREMENT,
  combo_id INTEGER NOT NULL REFERENCES combos(id) ON DELETE CASCADE,
  combo_name TEXT, strategy TEXT, step_index INTEGER,
  model_id TEXT, provider_id TEXT, timestamp INTEGER DEFAULT (unixepoch()),
  latency_ms INTEGER, cost REAL, success INTEGER NOT NULL DEFAULT 0,
  tokens_used INTEGER, error TEXT
)
```

### Titik integrasi di `proxy-handler.ts`

1. Import `resolveCombo` + `runComboEngine`.
2. Guard `modelAllowed` dimodifikasi: bila model adalah combo valid → guard
   dilewati di level request (diperiksa per step di runner).
3. Branch baru setelah `const fallbackId = ...` dan **sebelum**
   `getProviders(effectiveModel)` — combo tidak akan pernah match pool.

## 6. Eksekusi Step (`combo-runner.ts`)

`executeStep` per step:

1. Skip bila `rule && !modelAllowed(rule, step.modelId)` (log info `combo`).
2. Pool = `getProviders(modelId)` → fallback `getAnyProvider`; filter `providerId`
   bila di-pin; pilih via `selectProvider` (atau `pool[0]`).
3. Tidak ada provider → `404 model not found` (metric `success=0`).
4. `toProvider(providerFormat, stepCanonical)` → `transformRequest(...)` →
   `resolveProxyCandidates(provider.id)` → `beginConnection`.
5. Streaming (final pipeline / priority `stream=true`):
   `executeStreaming(...)`; `status < 400` → return, selain itu → fail.
6. Non-stream: `executeJson(...)`; `ok` → `translateResponse` + return;
   selain itu → fail.
7. `onComplete` (dipanggil executor di semua jalur): `recordRequestLog`
   (`strategy_used: "combo:<strategy>"`), `recordRequestUsage`, `endConnection`,
   `recordComboMetric` (latency, `estimateCost`, tokens, success, error).

### Chaining pipeline

- `carryText = extractUpstreamText(json)` dari step sukses.
- Step berikutnya menerima pesan user tambahan
  `[Output dari langkah sebelumnya]\n<carryText>`.
- Step terakhir boleh streaming; step perantara **dipaksa non-stream**
  (`buildStepCanonical` set `stream=false` kecuali final).
- Gagal di tengah → `json({ error: { message: "combo pipeline failed at step N" } }, status)`.

## 7. Pricing & Telemetri

- Biaya per step: `estimateCost(step.modelId, providerId, promptTokens, completionTokens)`
  (harga statis + `model_pricing` override).
- `combo_metrics` mencatat per step: latency, cost USD, tokens, success,
  error — **fondasi** untuk adaptive strategy & cost caps fase lanjut.
- Log request per step memakai `strategy_used: "combo:priority|pipeline"`
  sehingga mudah difilter di halaman logs.

## 8. UI (`/combo/chains`)

- Loader: `listCombos()` + datalist model & provider.
- Action: `section=create` (nama, strategi, N step: model, provider opsional,
  prompt opsional — dynamic rows), `section=delete` (confirm).
- List combo terdaftar: badge strategi, urutan steps, tombol hapus.
- Link dari header halaman `/combo` (pro tip: kombinasi mapping per-model di
  Combo biasa tetap berlaku per step model).

## 9. Roadmap (fitur konsep yang ditunda — fase lanjut)

Dari konsep doc Combo (OmniRoute-inspired):

- [ ] 13 strategi routing (afinitas, latency, priority, weighted, dll.)
- [x] Priority chain (MVP ini)
- [x] Pipeline sequential (MVP ini)
- [ ] Parallel pipeline (fan-out) & fusion output
- [ ] Conditional routing (rule per step: `if-message`, `if-quality`, ...)
- [ ] Adaptive strategy (pilih strategi dari `combo_metrics`)
- [ ] Cost caps & budget per combo/key
- [ ] Smart caching per step (cacheable responses)
- [ ] A/B testing antar combo
- [ ] Human-in-the-loop (persetujuan step kritis)
- [ ] Session stickiness dalam suatu chain
- [ ] Auto-combo `auto/<need>` (resolve otomatis kombinasi model)
- [ ] Edit combo eksisting di UI (saat ini: delete + create ulang)