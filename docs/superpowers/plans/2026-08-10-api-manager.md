# UniRoute API Manager Implementation Plan
> **Untuk agentic workers:** WAJIB sub-skill: superpowers:subagent-driven-development (disarankan) atau superpowers:executing-plans untuk implementasi task-by-task. Steps pakai checkbox (`- [ ]`).

**Goal:** Membangun API Manager lengkap dari spec `docs/superpowers/specs/2026-08-10-api-manager-design.md`: AES key storage, pipeline enforcement (budget/quota, whitelist/blacklist granular model & provider, IP & time access, rate limit, rotation/expiry + grace, auto-block), audit trail, analytics, health check, templates, groups (shared quota), bulk ops, webhook events, dan UI halaman `/api-manager` (+ create/detail/templates/groups) serta filter log by key.

**Architecture:** Semua enforcement berkumpul di `authorize()` dan titik pencatatan usage (`onComplete` di `app/.server/proxy-handler.ts`). Modul helper murni (rate-limiter, net, time-access, pricing) dipisah agar mudah di-unit-test tanpa DB. Pencatatan usage/audit/webhook via queue SQLite (pola `logger.ts`). UI route baru `api-manager.*` mengikuti konvensi flat-route yang ada (`providers.$id.tsx`, `logs.requests.tsx`).

**Tech Stack:** Bun (`bun test`, `bun server.ts`), `bun:sqlite`/`node:sqlite` via `query()`/`exec()` di `app/.server/db.ts`, React Router (React 19), Tailwind v4, lucide-react, `node:crypto` (AES & sha256). **TANPA dependency baru.**

## Global Constraints

- Akses DB hanya lewat `query()`/`exec()` dari `app/.server/db.ts`; jangan buka koneksi lain.
- Larangan tambah dependency ke `package.json`.
- Runtime hanya Bun. `npm run typecheck` (react-router typegen + tsc) dan `npm test` (bun test paralel) harus hijau.
- Test baru: file `*.test.ts` di `app/.server/`, `import "./test-env"` dulu (set DATABASE_URL temp), pakai `bun:test`, dan `resetTestDb()` dari `./test-db` bila perlu DB bersih.
- Perilaku default tanpa API key TIDAK berubah (kecuali `require_api_key` aktif) — semua check hanya aktif pada key yang memakainya.
- Env baru `API_KEY_SECRET` dan `ALLOW_API_KEY_REVEAL` — keduanya opsional. Tanpa `API_KEY_SECRET`, `key_enc` tidak ditulis (key baru tetap hash-only seperti hari ini) dan UI reveal non-aktif.
- Tanpa perlu migration data: key hash-only lama tetap valid (lihat Task A2).
- Tulis juga `key_audit_logs` untuk operasi lifecycle dashboard (create/rotate/suspend/reactivate/delete/update) — bukan hanya REQUEST.
- Tidak ada REST API manajemen publik; semuanya action dashboard / server function.

## File Structure

Baru (server):
- `app/.server/key-crypto.ts` — AES-256-GCM encrypt/decrypt + env helpers
- `app/.server/pricing.ts` — static price map + baca/tulis `model_pricing`
- `app/.server/rate-limiter.ts` — sliding window RPM/TPM + concurrency counter (in-memory)
- `app/.server/net.ts` — parse CIDR/IPv4, `ipInList`, `ipInCidr`
- `app/.server/time-access.ts` — cek `access_hours` (timezone-aware)
- `app/.server/key-usage.ts` — upsert `key_usage_daily`, ringkasan bulanan/harian
- `app/.server/key-audit.ts` — tulis/baca `key_audit_logs`
- `app/.server/webhook.ts` — enqueue + deliverer retry (`webhook_events`)
- `app/.server/key-enforce.ts` — semua check per-request digabung + komputasi status/health
- `app/.server/key-ops.ts` — rotate/suspend/reactivate/delete + audit + webhook
- `app/.server/key-bulk.ts` — bulk ops (update/suspend/reactivate/delete/rotate/export)
- `app/.server/key-templates.ts` — CRUD `key_templates`
- `app/.server/key-groups.ts` — CRUD `key_groups` + `key_group_members` + cek shared quota

Dimodifikasi (server):
- `app/.server/db.ts` — schema (kolom baru, tabel baru, `request_logs.api_key_id`, index)
- `app/.server/client-key.ts` — tipe `ClientKey` lengkap, create/update semua field, lookup hash + previous hash, parse JSON
- `app/.server/logger.ts` — dukung `api_key_id` pada RequestLog
- `app/.server/proxy-handler.ts` — integrasi enforce + pencatatan usage/audit/webhook
- `app/.server/auth.test.ts`/reruntut: tidak berubah

Baru (route UI):
- `app/routes/api-manager.tsx` — dashboard (list, stat, bulk, export)
- `app/routes/api-manager.create.tsx` — form create (+ dari template)
- `app/routes/api-manager.$id.tsx` — detail + audit + analytics + health
- `app/routes/api-manager.templates.tsx` — kelola template
- `app/routes/api-manager.groups.tsx` — kelola grup

Dimodifikasi (UI):
- `app/routes/api.tsx` — hapus tab "API Keys" (pindah ke `/api-manager`)
- `app/routes/logs.requests.tsx` — filter dropdown by API key
- `app/components/sidebar.tsx` — tambah nav `/api-manager`

Tests baru: `app/.server/{key-crypto,pricing,rate-limiter,net,time-access,key-usage,key-audit,webhook,key-enforce,key-ops,key-bulk,key-templates,key-groups}.test.ts` (+ patch `client-key.test.ts`, `proxy-handler.test.ts`).

## Task List

### Phase A — Fondasi: schema, crypto, harga, model

#### Task A1: Migrasi schema di `app/.server/db.ts`
- Tambah kolom-kolom baru pada `CREATE TABLE client_api_keys` (lihat spec section Data Model; gunakan `ALTER TABLE ... ADD COLUMN` idempotent via pragma cek seperti pola migrasi existing untuk `provider_credentials`). Kolom tambahan:
  `description, key_enc, previous_key_hash, previous_key_enc, previous_expires_at, blocked_models, allowed_providers, blocked_providers, budget, quota, alert_threshold, auto_block, blocked_at, ip_whitelist, ip_blacklist, strict_ip, access_hours, expires_at, rotation_interval_days, grace_period_days, webhook_url, scopes`.
- Buat tabel baru: `key_usage_daily`, `key_audit_logs` (+index `idx_audit_key`), `model_pricing`, `key_templates`, `key_groups`, `key_group_members`, `webhook_events` (SQL per spec).
- `ALTER TABLE request_logs ADD COLUMN api_key_id INTEGER NULL` (idempotent).
- Buat semua dengan `IF NOT EXISTS` / cek pragma agar idempoten.
- **Test:** Task ini diverifikasi manual — jalankan app, pastikan tidak error; atau assert `PRAGMA table_info` via satu test sementara di `db` (buat `app/.server/db.test.ts` baru: assert kolom2 ada & tabel baru ada).
- **Verify:** `bun test app/.server/db.test.ts` lalu `bun test` (semua existing tetap hijau).

#### Task A2: `app/.server/key-crypto.ts`
- `deriveKey()`: SHA-256 dari `process.env.API_KEY_SECRET`; `hasSecret()`.
- `encryptKey(raw): string | null` → base64(iv||ciphertext||tag) AES-256-GCM; return `null` bila `!hasSecret()`.
- `decryptKey(enc: string): string` (throw bila gagal/tidak ada secret).
- `normalizePrefix`/`generateKey` sudah di `client-key.ts` — jangan duplikat.
- **Test** `key-crypto.test.ts`: set env sekaligus dengan meng-import; roundtrip; beda iv tiap call; encrypt tanpa secret → null; decrypt salah → throw. Catatan: `API_KEY_SECRET` dibaca saat fungsi dipanggil (jangan cache saat module load), supaya test bisa set env per-case. Gunakan `vi.resetModules()`/dynamic import bila perlu.
- **Verify:** `bun test app/.server/key-crypto.test.ts`.

#### Task A3: `app/.server/pricing.ts`
- `STATIC_PRICES: Record<string, { input: number; output: number }>` per model id (USD per 1M token) untuk model populer: gpt-4o (2.5/10), gpt-4o-mini (0.15/0.6), gpt-4-turbo (10/30), gpt-4.1 (2/8), o3-mini (1.1/4.4), claude-3.5 & claude-3-5 variants (~3/15), gemini-1.5-pro (1.25/5), gemini-2.0-flash (0.1/0.4), deepseek-chat (0.27/1.1), mistral-large, llama-3.1-8b (~0.05/0.08), dsb. Nilai mendekati publik; jangan terlalu presisi.
- `getPrice(model, providerId)` → `{ input, output }`: prioritas row `model_pricing(model, providerId)` (bila ada), lalu `STATIC_PRICES[model]`, lalu `{0,0}`.
- `setPrice(model, providerId, input, output)`: upsert `model_pricing`.
- `listOverrides()`.
- **Test** `pricing.test.ts`: getPrice prioritas override > static > 0; setPrice upsert.
- **Verify:** `bun test app/.server/pricing.test.ts`.

#### Task A4: Perluas `app/.server/client-key.ts`
- Perluas tipe `ClientKey` + `ClientKeyRow` dengan semua kolom baru; `toClientKey` parse semua JSON kolom (`blocked_models, allowed_providers, blocked_providers, budget, quota, ip_whitelist, ip_blacklist, access_hours`) menjadi array/objek atau `null`, pakai helper `parseJson<T>(s)`.
- `CreateClientKeyInput` diperluas: description, blockedModels, allowedProviders, blockedProviders, budget, quota, alertThreshold, autoBlock, ipWhitelist, ipBlacklist, strictIp, accessHours, expiresAt, rotationIntervalDays, gracePeriodDays, webhookUrl, scopes, dan `noEncrypt?: boolean` (untuk test / tenant tanpa secret).
- `createClientKey` set kolom baru; `key_enc = encryptKey(key)` bila tersedia (tetap hash untuk index).
- `updateClientKey(id, patch)` — update kolom non-key; jangan pernah menimpa `key_hash/key_enc/previous_*` via update biasa.
- `getComments`: seleksi kolom baru di `getClientKeyById`/`listClientKeys`/`findByHash`.
- `findByHash(hash)`: cari `key_hash` ATAU `previous_key_hash` (jika `previous_expires_at > now`); return object yang menandakan apakah via previous (untuk keperluan log — optional field `usedPrevious?: boolean`).
- `setClientKeyBlocked(id, blockedAt | null)`.
- **Test** patch `client-key.test.ts`: create simpan semua field; update; findByHash previous-grace; status tidak berubah untuk key lama (key_enc null).
- **Verify:** `bun test app/.server/client-key.test.ts app/.server/proxy-handler.test.ts`.

### Phase B — Helper enforcement (murni, tanpa DB)

#### Task B1: `app/.server/net.ts`
- `ipInCidr(ip, cidr)`: IPv4; dukung IP tunggal (`x.x.x.x/x` atau tanpa slash → /32). Parse pakai bitwise uint32.
- `ipInList(ip, list: string[])`; `anyIpInList`.
- Gunakan di enforce: `strict_ip` → harus di whitelist; selainnya → blacklist ditolak.
- **Test** `net.test.ts`: /24, host, IP tunggal, kasus boundary, malformed list → tidak throw.
- **Verify:** `bun test app/.server/net.test.ts`.

#### Task B2: `app/.server/time-access.ts`
- `isWithinAccessHours(accessHours, now = new Date())`: cek `enabled`, hari bay (senin..minggu dari `allowed_days`) dan window `start_time`..`end_time`, semua dalam `timezone` (pakai `Intl.DateTimeFormat` dengan `timeZone`, format token). Jika window lintas tengah malam (start>end) — perlakukan sebagai range membalik (opsional, cukup dukung start<end; jika start≥end, anggap selalu salah kecuali dokumentasi terbatas).
- Return `{ allowed: boolean; reason?: string }`.
- **Test** `time-access.test.ts`: fix timezone UTC dengan data fixture; allowed day, wrong day, before/after window, disabled.
- **Verify:** `bun test app/.server/time-access.test.ts`.

#### Task B3: `app/.server/rate-limiter.ts`
- In-memory sliding window 60 detik: `checkRateLimit({ scope: string, incrementTokens: number, rpm?, tpm? })` → `{ allowed: boolean; limit?: "rpm"|"tpm"; remaining? }`. `scope` = `key-${id}`.
- Concurrency: `acquireSlot(scope, limit)` → boolean; `releaseSlot(scope)`; refcount map. `currentConcurrent(scope)`.
- Reset otomatis saat window lewat (map di-prune lazily).
- **Test** `rate-limiter.test.ts` pakai `vi.setSystemTime`/mock timer jika perlu, atau window kecil (buat param windowMs opsional untuk test).
- **Verify:** `bun test app/.server/rate-limiter.test.ts`.

### Phase C — Usage, audit, webhook (queue SQLite)

#### Task C1: `app/.server/key-usage.ts`
- `recordUsage(keyId, { promptTokens, completionTokens, cost, at? })`: upsert `key_usage_daily(key_id, date)` (+=).
- `usagePeriod(keyId, fromTs)`: SUM requests/prompt/completion/cost.
- `usageToday(keyId)`, `usageThisMonth(keyId)` (UTC date dari `Math.floor(now/86400000)` basis created_at? gunakan kalender UTC `toISOString().slice(0,10)` per window; window disimpan per hari UTC).
- `concurrency` tidak dihitung di DB.
- **Test** `key-usage.test.ts`: upsert akumulasi; SUM period; resetDb antar-case.
- **Verify:** `bun test app/.server/key-usage.test.ts`.

#### Task C2: `app/.server/key-audit.ts`
- `logAudit(keyId, action, fields?: { model?, providerId?, status?, tokens?, cost?, ip?, userAgent?, details? })`.
- `listAudit(keyId, limit=50)`.
- **Test** `key-audit.test.ts`.
- **Verify:** `bun test app/.server/key-audit.test.ts`.

#### Task C3: `app/.server/webhook.ts`
- `enqueueWebhook({ keyId, event, url, payload })` → insert `webhook_events` status `pending`.
- `deliverPending()`: ambil ≤10 pending dengan `next_retry_at<=now`; POST JSON ke `url` (fetch, timeout 5s); sukses → `success`; gagal → `attempts+1`, backoff `30s * 2^attempts`, >5 attempts → `dropped`.
- `startDeliverer()`: `setInterval(deliverPending, 5000)`; panggil sekali saat app boot (dari `server.ts` atau module side-effect yang aman untuk test — pakai flag `window.setInterval` guard by `process.env.NODE_ENV`/bun test: panggil manual di server, jangan side-effect di module agar test tidak memicu interval).
- **Test** `webhook.test.ts`: enqueue; deliverPending pakai stub `globalThis.fetch` (mock) sukses & gagal; backoff attempts.
- **Verify:** `bun test app/.server/webhook.test.ts`.

### Phase D — Enforcement engine + integrasi pipeline

#### Task D1: `app/.server/key-enforce.ts`
- `computeStatus(key, usage)`: `"expired"` (expires_at<now) | `"suspended"`/`"locked"` (blocked_at != null / is_active=0) | `"near_limit"` (usage ≥ threshold) | `"active"`.
- `checkIp(key, ip)` → `{ ok }` / `{ ok:false, error }`
- `checkHours(key, now)` → `{ ok }` / `{ ok:false, error }`
- `checkBudget(key, usage)`: per_request (pakai estimasi cost request current via `getPrice` setelah tokens diketahui — untuk pre-check gunakan 0); daily & monthly dari `usageThisDay/ThisMonth`; juga cek `quota.tokens_per_month`, `quota.requests_per_day`. Return urutan.
- `checkSharedGroupQuota(groupsOfKey, usage)` — panggil helper `key-groups` (Task E3).
- `checkModelProviders(key, model, selectedProviderId)`: `modelAllowed` existing + `blocked_models` (prefix match, pola yang sama dengan `allowed_models`) + `allowed_providers`/`blocked_providers` (subset, wildcard `*` didukung).
- `monthlyCostEstimate(key, deltaTokens)` untuk threshold alert.
- **Test** `key-enforce.test.ts` (berat ke check murni; budget pakai `key-usage` real DB).
- **Verify:** `bun test app/.server/key-enforce.test.ts`.

#### Task D2: Integrasi `app/.server/proxy-handler.ts`
- `authorize()`: setelah `resolveClientKey` ok, jalankan secara berurutan:
  1. `computeStatus` → expired → 403 `"api key expired"`; suspended/blocked → 401.
  2. IP (`request.headers: cf-connecting-ip || x-forwarded-for || remote`) → 403.
  3. `checkHours(now)` → 403.
  4. budget/quota pre-check (monthly/daily + quota) → 429 `"budget exceeded"`/`"quota exceeded"`; bila `auto_block` → `setClientKeyBlocked` + audit `BUDGET_BLOCKED` + webhook `budget_exceeded`.
  5. `checkRateLimit` RPM/TPM (estimasi tokens dari `canonical` bila mungkin, atau pakai `computePromptTokens` sederhana) → 429 `"rate limit exceeded"`.
  6. `acquireSlot` concurrent (release akhir) → 429.
  7. Setelah provider terpilih: `checkModelProviders` (model + providerId) → 403 `"model not allowed"`/`"provider not allowed"`.
- `onComplete` dan titik pencatatan log: tambahkan `api_key_id` ke `recordRequestLog`; setelah itu `recordUsage(keyId, tokens)` + `logAudit(keyId, "REQUEST", ...)` + `checkThreshold` (usage ≥ alert_threshold & auto_block/alert) → set blocked + audit + webhook `budget_exceeded` bila budget habis. Pakai informasi `clientKey.rule.id`.
- `import` helpers baru; jaga semua guard jangan patah saat `rule` null (anon).
- Admin session tetap bypass penuh (perilaku existing).
- **Test** patch `proxy-handler.test.ts`/`v1.chat.completions.test.ts`: expired → 403; budget monthly exceeded → 429 & auto-block; IP strict → 403; provider blocked → 403; anonymous path tidak berubah.
- **Verify:** `bun test` (seluruh suite) + `npm run typecheck`.

### Phase E — Lifecycle ops & fitur lanjutan

#### Task E1: `app/.server/key-ops.ts`
- `rotateKey(id, by?)`: generate key baru; simpan `key_hash/key_enc` lama ke `previous_key_hash/previous_key_enc`; set `previous_expires_at = now + grace_period_days` (0 → langsung hapus prev); tulis key baru di row; audit `KEY_ROTATED` (details old/new); webhook `rotated`; return `{ key, id }` baru (tampilkan sekali).
- `suspendKey(id)`: `blocked_at=now`; audit `KEY_SUSPENDED`; webhook `suspended`.
- `reactivateKey(id)`: `blocked_at=NULL`; audit `KEY_REACTIVATED`.
- `deleteKey(id)`: audit `KEY_DELETED`; hapus row (+ cek group membership cascade); webhook `deleted`.
- `healthCheck(id)`: gunakan `computeStatus` + usage + error rate (audit last hour) + avg latency.
- **Test** `key-ops.test.ts`: rotate (grace valid via findByHash), susp/reactivate, delete + audit rows.
- **Verify:** `bun test app/.server/key-ops.test.ts`.

#### Task E2: `app/.server/key-bulk.ts`
- `applyBulk(filter, action, data)`: filter `{ status }` (active/suspended/expired), `created_before`; action: `activate`, `suspend`, `delete`, `rotate`, `extend_expiry`, `set_budget`, `export` (kembalikan array → caller serialize CSV/JSON).
- Semua action memanggil `key-ops` per item + akumulasi hasil `{ done, failed }`.
- **Test** `key-bulk.test.ts`.
- **Verify:** `bun test app/.server/key-bulk.test.ts`.

#### Task E3: `app/.server/key-templates.ts` + `app/.server/key-groups.ts`
- `key-templates.ts`: `listTemplates`, `createTemplate(input)`, `deleteTemplate(id)`, `getTemplate(id)`. `config` JSON berisi sub-bagian field create (allowed_models, budget, quota, ip_*, access_hours, dll).
- `key-groups.ts`: CRUD group (bulk insert members); `groupsOfKey(keyId)`; `sharedQuotaExceeded(group, usage)` → cek monthly_budget & tokens_per_month grup (jumlah usage seluruh member); audit `GROUP_UPDATED` bila perlu.
- **Test** masing-masing `key-templates.test.ts`, `key-groups.test.ts`.
- **Verify:** `bun test app/.server/key-templates.test.ts app/.server/key-groups.test.ts`.

#### Task E4: Panggil `startDeliverer()` di `app/server.ts` (setelah server listen) dan safe-guard `process.env.NODE_ENV === "test"` tidak perlu (interval hanya dari server.ts).

### Phase F — UI

#### Task F1: Route `app/routes/api-manager.tsx` (dashboard)
- Loader: `listClientKeys()` (dengan ringkasan usage via `usageThisMonth` per key, cost), `counts` (total/active/restricted), templates, groups, `ALLOW_API_KEY_REVEAL`.
- UI mengikuti concept section 4.1: stat cards (Total Keys, Active, Restricted, Requests bulan ini), search box, filter status dropdown, tabel (Name, Key masked `key_prefix…`, Status badge, Usage bar % via cost budget, Actions 📋 copy / 🗑️ delete / ⚙️ detail), bulk toolbar (checkbox select all → Suspend/Reactivate/Rotate/Delete/Export CSV/JSON), tombol `+ Create New Key`, tautan Templates & Groups.
- Copy button: navigator.clipboard (fallback textarea). Reveal hanya jika `ALLOW_API_KEY_REVEAL=1` dan `key_enc` ada; tampil modal sekali, lalu perbaruan.
- Rotate: action POST via `key-ops.rotateKey`, tampilkan key baru sekali (banner kuning).
- Action-button classes Tailwind mengikuti style existing (`api.tsx`).
- **Verify:** `bun dev` lalu buka halaman.

#### Task F2: Route `app/routes/api-manager.create.tsx`
- Form lengkap (concept 4.2): Key name, description, permissions bitset (chat/embeddings/image/audio/rerank — simpan sebagai `scopes` display-only), Model Access (radio all/specific + combobox menggunakan `getModelSuggestions`), Budget & Quota (monthly/daily/per-request, tokens/month, req/day, concurrents, auto-block checkbox, alert threshold), Rate limit (rpm/tpm/concurrent), Security (expires date, IP whitelist/blacklist, strict_ip, webhook url, manage-access checkbox → simpan ke scopes), **"Create from Template"** dropdown (isi form dari `key_templates.config`).
- Submit POST via `createClientKey`; tampilkan full key sekali (banner), dengan tombol copy.
- **Verify:** manual di dev.

#### Task F3: Route `app/routes/api-manager.$id.tsx` (detail)
- Loader: getClientKeyById, usage summary (total requests/tokens/cost, avg latency, success rate dari audit), budgetUsed monthly, recent audit (listAudit 50), analytics chart data (per-day dari `key_usage_daily`), health via `healthCheck`.
- UI (concept 4.3): status cards, usage overview, budget bar, recent activity table, permissions list, tombol Edit (mode toggle form yang reuse field create), Rotate, Delete, Export Logs (CSV audit).
- Chart: reuse `app/components/usage-chart.tsx` bila cocok, atau chart sederhana SVG/tailwind bar.
- **Verify:** manual di dev.

#### Task F4: Routes `app/routes/api-manager.templates.tsx` & `app/routes/api-manager.groups.tsx`
- Templates: list, create form (name, description, config JSON editor sederhana + helper checkbox model), delete.
- Groups: list, create (name, desc, shared_quota monthly_budget & tokens_per_month), add/remove member (select dari keys), tampilkan aggregated usage member & status vs shared quota.
- **Verify:** manual di dev.

#### Task F5: Integrasi navigasi & old page
- `app/components/sidebar.tsx`: tambah `{ to: "/api-manager", label: "API Manager", icon: KeyRound }`.
- `app/routes/api.tsx`: hapus tab & handler API Keys (pindahkan seluruhnya; sisakan Allowlist + Routing Rules). Saat `/api` masih butuh `listClientKeys` dsb., hapus import yang tak terpakai agar typecheck bersih.
- `app/routes/logs.requests.tsx`: drop filter "API Key" (list dari `listClientKeys`), query tambah `WHERE api_key_id = ?` saat dipilih.
- **Verify:** `npm run typecheck`; manual nav & filter.

### Phase G — Verifikasi akhir

#### Task G1: Seluruh suite + typecheck + smoke
- `npm test` (semua test hijau), `npm run typecheck` bersih.
- `bun dev` manual: create key → pakai di curl `Authorization: Bearer`, coincide budget/IP/time/rate, rotate + grace, suspend, webhook (pakai `https://webhook.site`/local sink), export CSV, kelompok via group shared quota, filter logs by key.
- Update spec status bila ada penyimpangan kecil → catat di PR.

## Urutan eksekusi & dependensi

- A1 sebelum semua (schema). A2-A4 paralel setelah A1.
- B1-B3 paralel (murni). C1-C3 paralel.
- D1 butuh B×&C1&C2. D2 butuh D1 & A4. E1 butuh C2&C3&A4. E2 butuh E1. E3 butuh A4/C1/C2. E4 butuh C3.
- F1-F5 urut (F5 butuh F1 untuk memastikan fitur pindah). G1 terakhir.

Konflik file harus dihindari antar task paralel: task paralel menulis file yang berbeda. Hanya `client-key.ts` & `proxy-handler.ts` yang disentuh oleh >1 task → urut (A4 → D1 → D2).