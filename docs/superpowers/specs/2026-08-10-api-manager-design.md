# Desain: UniRoute API Manager

Tanggal: 2026-08-10
Status: Approved

## Ringkasan

Mengubah sistem client API key saat ini menjadi **API Manager** lengkap: dashboard
terdedikasi + pipeline enforcement untuk budget/quota, granular whitelist/blacklist,
IP & time-based access, rotation/expiry dengan grace period, audit trail, analytics,
health check, templates, groups (shared quota), bulk operations, dan webhook events.

## Keputusan Kunci

| Area | Keputusan |
| --- | --- |
| Penyimpanan key | AES-256-GCM via `API_KEY_SECRET`; `key_hash` dipertahankan sebagai index lookup. Reveal di UI dikontrol `ALLOW_API_KEY_REVEAL` |
| Permukaan manajemen | Dashboard-only (session cookie). Tidak ada REST API manajemen publik `/api/keys/*`. `scopes` disimpan tapi tidak diberlakukan |
| Sumber biaya | Tabel harga statis bawaan (USD per 1M token) + tabel `model_pricing` untuk override admin |
| Rate limiter | In-memory sliding window (RPM/TPM/concurrent). Per-proses, reset saat restart |
| Migrasi | Key lama (hash-only) tetap valid; `key_enc` NULL sampai key pertama kali di-rotate. Tidak ada kehilangan data |
| URL halaman | `/api-manager` (sesuai gaya flat-route yang ada) |

## Dasar Hukum / Konvensi Existing

- `client_api_keys` saat ini: `id, name, key_hash, key_prefix, allowed_models, model_override, pinned_provider_id, is_active, created_at` (`app/.server/db.ts:209`).
- CRUD saat ini di `app/.server/client-key.ts`; validasi di `app/.server/proxy-handler.ts` (`authorize` + `modelAllowed`).
- Auth dashboard: session in-memory via cookie (`app/.server/auth.ts`).
- Logging: `request_logs` + `proxy_logs`, flush ber-batch (`app/.server/logger.ts`).
- Tidak ada harga model di registry (`app/registry/*`).

## Data Model

### `client_api_keys` — kolom baru

```
description TEXT NULL
key_enc TEXT NULL                    -- AES-256-GCM dari key mentah (key baru / hasil rotate)
previous_key_hash TEXT NULL          -- key lama saat rotation (grace period)
previous_key_enc TEXT NULL
previous_expires_at INTEGER NULL     -- batas validitas key lama
blocked_models TEXT NULL             -- JSON array model yang diblokir
allowed_providers TEXT NULL          -- JSON array provider whitelist
blocked_providers TEXT NULL          -- JSON array provider blacklist
budget TEXT NULL                     -- JSON {monthly, daily, per_request} USD
quota TEXT NULL                      -- JSON {tokens_per_month, requests_per_day, concurrent_requests}
alert_threshold REAL NULL            -- 0..1, cross threshold -> webhook alert
auto_block INTEGER NOT NULL DEFAULT 0
blocked_at INTEGER NULL              -- timestamp auto-block / suspend
ip_whitelist TEXT NULL               -- JSON array CIDR/IP
ip_blacklist TEXT NULL
strict_ip INTEGER NOT NULL DEFAULT 0
access_hours TEXT NULL               -- JSON {enabled, timezone, allowed_days[], start_time, end_time}
expires_at INTEGER NULL
rotation_interval_days INTEGER NULL
grace_period_days INTEGER NULL
webhook_url TEXT NULL
scopes TEXT NULL                     -- disimpan, tidak diberlakukan (dashboard-only)
```

### Tabel baru

```sql
CREATE TABLE IF NOT EXISTS key_usage_daily (
  key_id INTEGER NOT NULL REFERENCES client_api_keys(id),
  date TEXT NOT NULL,                -- 'YYYY-MM-DD' (UTC)
  requests INTEGER NOT NULL DEFAULT 0,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  cost REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (key_id, date)
);

CREATE TABLE IF NOT EXISTS key_audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key_id INTEGER NOT NULL REFERENCES client_api_keys(id),
  action TEXT NOT NULL,              -- REQUEST, KEY_CREATED, KEY_ROTATED, KEY_SUSPENDED,
                                     -- KEY_REACTIVATED, KEY_DELETED, BUDGET_BLOCKED, ...
  model TEXT, provider_id TEXT,
  status INTEGER, tokens INTEGER, cost REAL,
  details TEXT,                      -- JSON ekstra (old_key_id, new_key_id, dsb.)
  ip TEXT, user_agent TEXT,
  created_at INTEGER DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_audit_key ON key_audit_logs (key_id, created_at);

CREATE TABLE IF NOT EXISTS model_pricing (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  input_per_mtok REAL NOT NULL DEFAULT 0,
  output_per_mtok REAL NOT NULL DEFAULT 0,
  updated_at INTEGER DEFAULT (unixepoch()),
  UNIQUE (model, provider_id)
);

CREATE TABLE IF NOT EXISTS key_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  config TEXT NOT NULL,              -- JSON: allowed_models, budget, quota, ip_*, access_hours, dsb.
  created_at INTEGER DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS key_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  shared_quota TEXT,                 -- JSON {monthly_budget, tokens_per_month}
  created_at INTEGER DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS key_group_members (
  group_id INTEGER NOT NULL REFERENCES key_groups(id) ON DELETE CASCADE,
  key_id INTEGER NOT NULL REFERENCES client_api_keys(id) ON DELETE CASCADE,
  PRIMARY KEY (group_id, key_id)
);

CREATE TABLE IF NOT EXISTS webhook_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key_id INTEGER,                    -- NULL untuk event global
  event TEXT NOT NULL,
  url TEXT NOT NULL,
  payload TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | success | failed | dropped
  next_retry_at INTEGER DEFAULT (unixepoch()),
  created_at INTEGER DEFAULT (unixepoch())
);
```

`request_logs` mendapat kolom `api_key_id INTEGER NULL`.

### Enkripsi Key

- `API_KEY_SECRET` (hex 32 byte). Key didekripsi hanya untuk: reveal UI (jika
  `ALLOW_API_KEY_REVEAL=1`), rotation (menyalin nilai lama ke `previous_key_enc`).
- Validasi autentikasi tetap lewat `key_hash` (constant-time lookup), nilai plaintext
  tidak pernah dibaca pada jalur request.
- AES-256-GCM: iv 12 byte acak + ciphertext + tag; disimpan base64 di `key_enc`.
  Kunci AES diturunkan dari `API_KEY_SECRET` via SHA-256.

## Enforcement Pipeline (`/v1/chat/completions`, `/v1/responses`, `/v1/messages`)

Urutan di `authorize()` / setelah parse body:

1. Session admin valid → bypass (perilaku saat ini).
2. Token Bearer:
   - lookup `key_hash`; tidak ketemu atau `blocked_at`/`is_active=0` → 401.
   - cocok `previous_key_hash` dan masih dalam `previous_expires_at` → pakai key tsb
     (grace period setelah rotation).
3. `expires_at` < now → 403 `"api key expired"`.
4. IP check (`strict_ip` → cuma whitelist; selainnya blacklist diberlakukan) → 403.
5. `access_hours` enabled → cek day + window (timezone) → 403.
6. Budget/quota (aggregasi `key_usage_daily` + in-memory counter) →
   bulanan/harian/per-request → 429 `"budget exceeded"` atau `"quota exceeded"`;
   jika `auto_block=1` → set `blocked_at`, audit `BUDGET_BLOCKED` + webhook.
7. Rate limit in-memory (RPM/TPM/concurrent) → 429.
8. Grup: jika key adalah anggota grup, cek shared quota grup → 429.
9. Model check: `modelAllowed` existing + `blocked_models` + `allowed_providers`/
   `blocked_providers` (cek provider terpilih) → 403.
10. Catat sukses: `request_logs.api_key_id`, upsert `key_usage_daily`, insert
    `key_audit_logs` (REQUEST).

Setelah request selesai (success/error dengan token usage): update usage, cek
threshold (`alert_threshold`) → webhook `on_budget_exceeded` sekali per periode
jika belum terkirim; jika `auto_block` dan budget habis → suspend.

### Rate limiter in-memory

- Struktur: `Map<key_id_or_global, {window_start, req_count, token_count}>`,
  window = 60 detik untuk RPM/TPM; counter terpisah untuk `concurrent_requests`
  (refcount aktif, decrement saat selesai).
- Global fallback untuk request tanpa key (jika ada rate limit dari rules global
  — opsional, di luar scope awal).

### Perhitungan Biaya

- Static map model → `{input, output}` per 1M token untuk model populer
  (openai, anthropic, gemini, dsb.); lookup memprioritaskan `model_pricing`
  (override admin), lalu static map, lalu 0.
- `cost = prompt_tokens*input + completion_tokens*output) / 1_000_000`.
- Disimpan di `key_usage_daily.cost` dan audit.

## Fitur → Implementasi

| Konsep | Implementasi |
| --- | --- |
| Dashboard page + stat cards + table + copy | `/api-manager` |
| Create/Delete/Edit key | form create + row actions |
| Usage stats per key | agregasi `key_usage_daily` |
| Status indicators | computed: Active/Locked(blocked_at)/Expired/Near Limit(≥ alert_threshold)/Suspend |
| Model-level permissions + wildcard | `allowed_models` existing (prefix match) |
| Granular whitelist/blacklist model & provider | `blocked_models`, `allowed_providers`, `blocked_providers` |
| IP whitelist/blacklist | kolom IP + parser CIDR (netmask, IPv4) |
| Time-based access | `access_hours` |
| Budget & quota per key | `budget`, `quota`, `auto_block`, `alert_threshold` |
| Expiry | `expires_at` |
| Auto rotation + grace | `rotation_interval_days`, `previous_*` |
| Audit trail | `key_audit_logs` + halaman detail |
| Analytics | agregasi harian + chart (komponen `usage-chart`) |
| Health check | fungsi computed dari usage + status |
| Bulk operations | checkbox select → suspend/rotate/reactivate/delete/update/export CSV+JSON |
| Templates | `key_templates` + "Create from Template" |
| Groups/Teams | `key_groups` + members + shared quota |
| Webhooks | queue `webhook_events` + deliverer retry |
| AES encryption | `key_enc` + `API_KEY_SECRET` |
| Management API access | tidak diberlakukan (dashboard-only) |
| Real-time log filter by key | `request_logs.api_key_id` + filter di `/logs/requests` |

## UI Pages

- `/api-manager` — header "API Manager", stat cards, tombol Create/Templates/Groups,
  search + filter status, tabel (name, key masked, status, usage bar, actions),
  bulk toolbar, export JSON/CSV.
- `/api-manager/create` — form lengkap (permissions, model access, budget/quota,
  rate limit, security, webhook) + "from template" dropdown.
- `/api-manager/:id` — detail: status, meta, usage overview, budget bar, recent
  activity (audit), permissions, tombol Edit/Rotate/Delete/Export.
- `/api-manager/templates`, `/api-manager/groups`.
- Tab "API Keys" di `/api` dipindah ke `/api-manager` (route baru).

## Env Baru

```
API_KEY_SECRET=<hex 32 byte>      # AES key
ALLOW_API_KEY_REVEAL=0|1          # tampilkan full key di UI
```

## Pengujian

- Unit: migration path (key lama valid), AES roundtrip, semua check pipeline,
  rate limiter, cost calc, rotation grace, budget auto-block, shared quota grup,
  IP/time access, parser CIDR, bulk ops, webhook queue.
- Pakai harness `app/.server/test-db.ts`.

## Catatan

- Semua route client (`/v1/chat/completions`, `/v1/responses`, `/v1/messages`) ikut
  enforcement via `handleProxy` yang sama.
- `auto_block_new` dalam konsep (model baru auto-block) sudah tercakup oleh
  semantik `allowed_models`: model yang tidak ada di allowlist → `403 model not
  allowed`.
- Operasi lifecycle di dashboard (create, rotate, suspend, reactivate, delete,
  bulk, update security) juga menulis `key_audit_logs` — tidak hanya REQUEST.

## Di Luar Scope (sengaja)

- REST API manajemen publik `/api/keys/*` (dashboard-only).
- Enforce `scopes` pada Bearer management (kolom disimpan untuk masa depan).
