# 📄 PRD FINAL – UniRoute AI Gateway

**Nama:** UniRoute  
**Versi:** 7.0  
**Stack:** React Router v8 (Framework Mode) + Bun + SQLite + Tailwind CSS  
**Tipe Aplikasi:** AI Gateway Proxy & Router (Full Admin-Only)

---

## 1. Tujuan Sistem

Aplikasi proxy/routing untuk menggabungkan berbagai API AI Provider ke dalam **1 endpoint universal** (`/v1/chat/completions`).

**Alur Proxy:**

```
User Request → UniRoute → OpenAI/Anthropic/etc → UniRoute → User Response
```

UniRoute bertindak sebagai **transparent proxy**: menerima request OpenAI format, meneruskannya ke provider tujuan, lalu meneruskan response (termasuk SSE streaming) kembali ke user tanpa buffering.

**Fungsi Wajib:**

1. **Proxy Endpoint:** Terima format OpenAI → transform → kirim ke provider tujuan.
2. **Streaming SSE:** Real-time token-per-token, zero-buffering.
3. **Kompresi Prompt:** Pipeline RTK → Caveman via `Bun.spawn()`.
4. **Load Balancing:** Round Robin, Random, Priority, Weighted, Least Connections, First Available.
5. **Full Admin-Only:** Semua halaman memerlukan login.

---

## 2. Arsitektur Core (5-Stage Pipeline)

| Tahap | Nama | Fungsi |
|-------|------|--------|
| 1 | **Route** | Resolve `provider_id` dari `model` (lookup Registry/Database). Jalankan load balancing jika model memiliki multiple provider. |
| 2 | **Translate** | Ubah format OpenAI → format provider native. Jalankan kompresi jika aktif. |
| 3 | **Execute** | `fetch()` ke upstream URL. Timeout 120s, retry maksimal 1x. |
| 4 | **Stream** *(Kritis)* | Baca chunk upstream, transform ke OpenAI SSE, flush instan. Zero-Buffering. |
| 5 | **Record** | Catat log request (model, provider, durasi, token, status). |

---

## 3. Komponen Inti (Wajib)

| Komponen | Fungsi |
|----------|--------|
| **Registry** | Cache in-memory `model_name` → `provider_id`, reloadable. |
| **Load Balancer** | Pilih provider dari pool berdasarkan strategy (round_robin, random, priority, weighted, least_conn, first_available). |
| **Adapter** | `transformRequest()` & `transformStreamChunk()` per provider. |
| **Executor** | Handler pipeline streaming: fetch → read `ReadableStream` → write Response. |
| **Compressor** | Subprocess `Bun.spawn()` RTK → Caveman. Fallback ke prompt asli. |
| **Credential Store** | Baca/tulis API Key provider ke SQLite. |
| **Model Guard** | Cek model allowlist sebelum routing. |
| **Rule Engine** | Evaluasi routing rules (rewrite, deny, fallback) sebelum execute. |

---

## 4. Database Schema (SQLite)

```sql
-- Provider upstream
CREATE TABLE providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  auth_type TEXT NOT NULL DEFAULT 'bearer',  -- 'none' | 'bearer' | 'apikey'
  is_active INTEGER NOT NULL DEFAULT 1,
  weight INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 0,
  current_connections INTEGER NOT NULL DEFAULT 0,
  last_used_at INTEGER DEFAULT 0,
  created_at INTEGER DEFAULT (unixepoch())
);

-- Model → Provider mapping (Registry) — many-to-many
CREATE TABLE models (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model_name TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  context_length INTEGER,
  is_active INTEGER NOT NULL DEFAULT 1,
  is_primary INTEGER NOT NULL DEFAULT 0,
  UNIQUE(model_name, provider_id)
);

-- Model Allowlist (Guard)
CREATE TABLE model_allowlist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model_name TEXT NOT NULL,
  action TEXT NOT NULL DEFAULT 'allow',  -- 'allow' | 'deny'
  reason TEXT,
  created_at INTEGER DEFAULT (unixepoch()),
  UNIQUE(model_name, action)
);

-- Routing Rules (Combo)
CREATE TABLE routing_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  source_model TEXT NOT NULL,
  rule_type TEXT NOT NULL,         -- 'rewrite' | 'deny' | 'fallback'
  target_model TEXT,
  target_provider_id TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  description TEXT,
  created_at INTEGER DEFAULT (unixepoch())
);

-- Load Balancing Settings per Model
CREATE TABLE load_balancing (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model_name TEXT NOT NULL UNIQUE,
  strategy TEXT NOT NULL DEFAULT 'round_robin',
  fallback_enabled INTEGER NOT NULL DEFAULT 1,
  health_check_enabled INTEGER NOT NULL DEFAULT 0,
  health_check_url TEXT,
  health_check_interval INTEGER DEFAULT 60,
  created_at INTEGER DEFAULT (unixepoch()),
  updated_at INTEGER DEFAULT (unixepoch())
);

-- Kompresi settings
CREATE TABLE compression_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  rtk_enabled INTEGER NOT NULL DEFAULT 0,
  caveman_enabled INTEGER NOT NULL DEFAULT 0,
  rtk_binary_path TEXT DEFAULT './bin/rtk',
  caveman_binary_path TEXT DEFAULT './bin/caveman',
  updated_at INTEGER DEFAULT (unixepoch())
);

-- Request logs (proxy log)
CREATE TABLE request_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model TEXT,
  provider_id TEXT,
  strategy_used TEXT,
  rule_applied TEXT,
  duration_ms INTEGER,
  status TEXT,                     -- 'success' | 'error' | 'timeout' | 'denied'
  error_message TEXT,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  created_at INTEGER DEFAULT (unixepoch())
);

-- Proxy system logs (internal log)
CREATE TABLE proxy_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  level TEXT NOT NULL,             -- 'info' | 'warn' | 'error' | 'debug'
  source TEXT NOT NULL,            -- 'compressor' | 'executor' | 'guard' | 'registry' | 'balancer' | 'system'
  message TEXT NOT NULL,
  metadata TEXT,                   -- JSON string
  created_at INTEGER DEFAULT (unixepoch())
);
```

**Seed data minimal:** OpenAI, Anthropic, Google, Groq, OpenRouter, + 3 free provider.

---

## 5. Environment Variables (4 vars)

```env
PORT=3000
BASE_URL=http://localhost:3000
PASSWORD=CHANGEME
DATABASE_URL=./data/uniroute.db
```

> **Peringatan Keamanan:** `PASSWORD` default `CHANGEME` untuk first-run development. **Wajib diubah** sebelum deploy production.

---

## 6. Routing & Autentikasi (100% Protected)

### 6.1 Aturan Global

- Semua route UI memerlukan autentikasi.
- Semua halaman adalah flat route.
- API endpoint `/v1/chat/completions` untuk consumer API (proxy endpoint).

### 6.2 Route Table (Flat)

| Route | Tipe | Akses | Fungsi |
|-------|------|-------|--------|
| `/` | UI | Redirect | Redirect ke `/home`. |
| `/login` | UI | **Public** | Halaman login. Form password only. |
| `/home` | UI | Protected | **🏠 Home** — Overview stats, chart usage, gateway health. |
| `/providers` | UI | Protected | **🔌 Provider** — CRUD provider (name, base_url, auth_type, active, weight, priority). |
| `/compression` | UI | Protected | **🗜️ Compression** — Setting RTK & Caveman: on/off, path binary, test. |
| `/api` | UI | Protected | **🔑 API** — API Management: allowlist, routing rules, test proxy. |
| `/combo` | UI | Protected | **🔗 Combo** — Kelola mapping model→provider + load balancing strategy. |
| `/proxy` | UI | Protected | **🌐 Proxy** — Proxy playground: test endpoint, lihat request/response. |
| `/logs` | UI Layout | Protected | **📋 Logs** — Layout dengan nested outlet untuk log viewer. |
| `/logs/requests` | UI | Protected | **📋 Request Logs** — Log request proxy (model, provider, strategy, durasi, status). |
| `/logs/proxy` | UI | Protected | **📋 Proxy Logs** — Log internal sistem (compressor, executor, guard, balancer, system). |
| `/v1/chat/completions` | Resource | API Key / None | Proxy endpoint. Terima OpenAI format, return SSE stream. |

### 6.3 Flow Autentikasi

```
User akses / ──→ redirect /home
                    │
                    ▼
            Cek cookie "uniroute_session"
                    │
        ┌───────────┴───────────┐
    Valid                   Kosong / Invalid
        │                           │
        ▼                           ▼
    Render Layout             Redirect /login
        │
        ├── Sidebar
        │     ├── 🏠 Home
        │     ├── 🔌 Provider
        │     ├── 🗜️ Compression
        │     ├── 🔑 API
        │     ├── 🔗 Combo
        │     ├── 🌐 Proxy
        │     ├── 📋 Logs
        │     │     ├── Request Logs
        │     │     └── Proxy Logs
        │     └── 🚪 Logout
        │
        └── Outlet (halaman aktif)
```

### 6.4 Mekanisme Login

- **Metode:** Password-only (username, register).
- **Password Source:** Dibandingkan dengan `PASSWORD` dari `.env`.
- **Session:** Cookie `uniroute_session` (httpOnly, Secure di production, max-age 24 jam).
- **Logout:** Hapus cookie → redirect `/login`.

---

## 7. Sidebar Navigation (Layout Global)

```
┌─────────────────────────────────────┐
│  🚀 UniRoute AI Gateway             │
├─────────────────────────────────────┤
│  🏠 Home            (/home)         │
│  🔌 Provider        (/providers)    │
│  🗜️ Compression     (/compression)  │
│  🔑 API             (/api)          │
│  🔗 Combo           (/combo)        │
│  🌐 Proxy           (/proxy)        │
│  📋 Logs            (/logs)         │
│    ├── Request Logs (/logs/requests)│
│    └── Proxy Logs   (/logs/proxy)   │
├─────────────────────────────────────┤
│  🚪 Logout                          │
└─────────────────────────────────────┘
```

---

## 8. File Structure (React Router v8 Best Practice)

```
app/
├── root.tsx                          # Root layout: sidebar + auth guard + outlet
├── routes.ts                         # Route config (flat routes + resource routes)
├── .server/                          # Server-only code (never bundled to client)
│   ├── db.ts                         # SQLite client (bun:sqlite)
│   ├── registry.ts                   # Model→Provider cache
│   ├── balancer.ts                   # Load balancing engine
│   ├── adapter.ts                    # OpenAI ↔ Provider transform
│   ├── executor.ts                   # Streaming pipeline handler
│   ├── compressor.ts                 # Bun.spawn RTK/Caveman
│   ├── guard.ts                      # Model allowlist checker
│   ├── rules.ts                      # Routing rule engine
│   ├── auth.ts                       # Cookie session + password verify
│   └── logger.ts                     # Proxy system logger
├── routes/                           # Route modules (auto-discovered by flatRoutes)
│   ├── _index.tsx                    # / → redirect ke /home
│   ├── login.tsx                     # /login (password gate, public)
│   ├── home.tsx                      # /home (Overview)
│   ├── providers.tsx                 # /providers
│   ├── compression.tsx               # /compression
│   ├── api.tsx                       # /api (API Management)
│   ├── combo.tsx                     # /combo (Registry + Load Balancing)
│   ├── proxy.tsx                     # /proxy (Proxy Playground)
│   ├── logs.tsx                      # /logs (Layout untuk nested logs)
│   ├── logs.requests.tsx             # /logs/requests (Request Logs)
│   ├── logs.proxy.tsx                # /logs/proxy (Proxy Logs)
│   ├── v1.chat.completions.ts        # Resource route: POST /v1/chat/completions
│   └── api.stats.ts                  # Resource route: GET /api/stats
├── components/                       # Shared UI components
│   ├── sidebar.tsx                   # Sidebar navigation
│   ├── stat-card.tsx                 # Statistik card
│   ├── usage-chart.tsx               # Chart komponen
│   ├── model-selector.tsx            # Dropdown pilih model
│   ├── message-input.tsx             # Input pesan
│   ├── streaming-response.tsx        # Display streaming response
│   ├── provider-form.tsx             # Form CRUD provider
│   ├── compression-panel.tsx         # Panel setting kompresi
│   ├── api-manager.tsx               # Allowlist + Routing Rules UI
│   ├── combo-mapping-table.tsx       # Tabel mapping model→provider + strategy
│   ├── strategy-selector.tsx         # Dropdown pilih load balancing strategy
│   ├── proxy-playground.tsx          # Test proxy endpoint
│   ├── log-stream.tsx                # Realtime log viewer
│   └── request-log-table.tsx         # Tabel request logs
├── hooks/                            # Custom React hooks
│   ├── use-auth.ts                   # Auth state & logout
│   ├── use-streaming.ts              # Handle SSE streaming
│   └── use-realtime-logs.ts          # SSE log subscription
├── lib/                              # Shared utilities (client-safe)
│   ├── utils.ts                      # Helper functions
│   └── constants.ts                  # App constants
└── styles/
    └── tailwind.css
```

**Route Config (`routes.ts`):**

```ts
import { type RouteConfig, route } from "@react-router/dev/routes";
import { flatRoutes } from "@react-router/fs-routes";

export default [
  route("v1/chat/completions", "routes/v1.chat.completions.ts"),
  route("api/stats", "routes/api.stats.ts"),
  ...flatRoutes(),
] satisfies RouteConfig;
```

---

## 9. Load Balancing / Distribution Strategy

### 9.1 Konsep

Satu `model_name` dipetakan ke **multiple provider**. Load balancer memilih provider dari pool berdasarkan **strategy** yang dikonfigurasi per model.

### 9.2 Strategy Tersedia

| Strategy | Kode | Cara Kerja |
|----------|------|------------|
| **Round Robin** | `round_robin` | Giliran berurutan: Provider A → B → C → A → ... |
| **Random** | `random` | Pilih provider acak dari pool. |
| **Priority** | `priority` | Pilih provider dengan `priority` tertinggi. Gagal → fallback ke priority berikutnya. |
| **Weighted** | `weighted` | Pilih berdasarkan `weight` (probabilitas proporsional). Provider A weight 3, B weight 1 = A 75%, B 25%. |
| **Least Connections** | `least_conn` | Pilih provider dengan `current_connections` terendah. |
| **First Available** | `first_available` | Pilih provider pertama yang aktif dan healthy (health check). |

### 9.3 Konfigurasi per Model

Setiap model di tabel `load_balancing` punya:

- `strategy`: strategy yang dipakai.
- `fallback_enabled`: provider yang dipilih gagal, coba provider lain di pool.
- `health_check_enabled`: cek health provider secara berkala.
- `health_check_url`: endpoint health check (opsional, default base_url).
- `health_check_interval`: interval cek dalam detik.

### 9.4 Provider Attributes

Di tabel `providers`:

- `weight`: bobot untuk weighted strategy (default 1).
- `priority`: urutan untuk priority strategy (default 0, semakin tinggi semakin diprioritaskan).
- `current_connections`: jumlah koneksi aktif (di-update real-time).
- `last_used_at`: timestamp terakhir dipakai (untuk round_robin).

### 9.5 Alur Load Balancing

```
1. Client request model "gpt-4o"
2. Cek pool provider untuk "gpt-4o":
   - Provider A (OpenAI) — weight 3, priority 2
   - Provider B (Groq) — weight 1, priority 1
   - Provider C (OpenRouter) — weight 2, priority 0
3. Cek strategy di load_balancing:
   - "round_robin" → pilih provider dengan last_used_at paling lama
   - "random" → random dari pool
   - "priority" → pilih Provider A (priority 2 tertinggi)
   - "weighted" → weighted random: A 50%, B 16.7%, C 33.3%
   - "least_conn" → pilih provider dengan current_connections terendah
   - "first_available" → cek health, pilih pertama yang healthy
4. Increment current_connections untuk provider terpilih
5. Execute request ke provider
6. Decrement current_connections setelah selesai/gagal
7. Update last_used_at (untuk round_robin)
8. Gagal dan fallback_enabled → coba provider berikutnya di pool
9. Record log dengan strategy_used
```

### 9.6 UI `/combo`

**Tab 1: Model Mapping**

- Tabel: model_name | provider | context_length | active | primary | actions.
- Form tambah: input model_name, dropdown provider, input context_length, checkbox primary.
- Satu model punya multiple provider (tambah row baru dengan model_name sama, provider berbeda).

**Tab 2: Load Balancing**

- Tabel: model_name | strategy | providers count | fallback | health check | actions.
- Form edit: dropdown strategy, toggle fallback, toggle health check, input interval.
- Visualisasi: pie chart distribusi weight per provider.

**Tab 3: Provider Pool**

- Tabel detail per model: provider | weight | priority | current_connections | last_used | health status.
- Edit inline: weight, priority.

---

## 10. API Management

### 10.1 Model Allowlist (Guard)

Sebelum request diproses, sistem cek tabel `model_allowlist`:

- Model ada di daftar **deny** → return `403 Forbidden` dengan reason.
- Default mode: **permissive** (izinkan semua kecuali yang di-deny).

**UI `/api` — Tab Allowlist:**

- Tabel model dengan action (allow/deny).
- Form tambah: input model_name + dropdown action + reason.

### 10.2 Routing Rules

Aturan untuk mengubah/menolak request sebelum ke provider:

- **Rewrite**: Ganti `source_model` → `target_model`.
- **Deny**: Block request, return 403.
- **Fallback**: Provider primary gagal, redirect ke `target_model`.

**UI `/api` — Tab Routing Rules:**

- Tabel rules: name, source, type, target, priority, active.
- Form CRUD rule.

### 10.3 Proxy Playground (`/proxy`)

Halaman untuk test proxy endpoint secara internal:

- Form: dropdown model, textarea prompt, toggle stream.
- Display request/response detail (headers, body, timing).
- Tampilkan response streaming token per token.

### 10.4 Realtime Logs

**Mekanisme:**

- SSE endpoint: `/api/logs/stream`.
- Client connect → server kirim log baru setiap ada insert.

**UI `/logs/requests`:**

- Stream log realtime (auto-scroll, pause/resume).
- Kolom: timestamp, model, provider, strategy, status, duration.

**UI `/logs/proxy`:**

- Stream proxy system logs.
- Filter: level, source (balancer, compressor, executor, guard, registry, system).

### 10.5 API Endpoints (Resource Routes)

| Method | Endpoint | Fungsi |
|--------|----------|--------|
| POST | `/v1/chat/completions` | **Proxy endpoint.** Terima OpenAI format, return SSE stream. |
| GET | `/api/stats` | Overview stats: total requests, success rate, avg latency, active providers. |

> API untuk manage UniRoute sementara **tidak ada**. Semua management dilakukan via UI Dashboard.

---

## 11. Alur Streaming (Kritis)

1. Client POST `/v1/chat/completions` dengan `"stream": true`.
2. Server (`v1.chat.completions.ts` action):
   - **Guard:** Cek model allowlist. Denied → return 403.
   - **Rules:** Evaluasi routing rules. Rewrite model jika perlu.
   - **Route:** Resolve provider pool dari model (registry).
   - **Balance:** Pilih provider dari pool berdasarkan strategy.
   - **Translate:** Transform body, jalankan kompresi jika aktif.
   - **Execute:** `fetch()` ke upstream.
3. Dapatkan `Response.body` upstream (`ReadableStream`).
4. Loop baca chunk (buffer 4KB):
   - Transform ke format SSE OpenAI.
   - `controller.enqueue(transformedChunk)`.
   - Flush instan.
5. Client disconnect (`AbortSignal`) → hentikan.
6. Kirim `data: [DONE]

` sebagai EOF.
7. **Record:** Insert log ke `request_logs` (async, non-blocking).
8. Return `new Response(readableStream, { headers })`.

**Larangan:** Mengakumulasi seluruh response di memory (array/string) sebelum dikirim.

---

## 12. Integrasi Kompresor (RTK + Caveman)

- Pipeline: `prompt` → `Bun.spawn('./bin/rtk')` → `Bun.spawn('./bin/caveman')` → `compressed`.
- Timeout per subprocess: 5 detik.
- **Fallback:** Gagal / timeout / binary tidak ditemukan → gunakan prompt asli, log warning ke `proxy_logs`.
- Settings enable/disable tersimpan di `compression_settings`.

---

## 13. Acceptance Criteria (DoD)

- [ ] Server berjalan dengan 4 env vars (termasuk `PASSWORD`).
- [ ] Endpoint `/v1/chat/completions` menerima request OpenAI format dan proxy ke provider.
- [ ] **Alur Proxy:** User → UniRoute → Provider → UniRoute → User (transparent).
- [ ] **Load Balancing:** 6 strategy tersedia (round_robin, random, priority, weighted, least_conn, first_available).
- [ ] **Model Mapping:** Satu model dipetakan ke multiple provider.
- [ ] **Model Guard:** Request untuk model di-deny list return 403.
- [ ] **Routing Rules:** Rewrite dan deny rules berfungsi, dievaluasi by priority.
- [ ] Streaming SSE berhasil: chunk per chunk, zero-buffering.
- [ ] Compression pipeline aktif dengan fallback aman.
- [ ] Semua halaman memerlukan login.
- [ ] `/login` halaman login.
- [ ] **Flat routes:** Rute: `/home`, `/providers`, `/compression`, `/api`, `/combo`, `/proxy`, `/logs`.
- [ ] **Nested logs:** `/logs` layout dengan `/logs/requests` dan `/logs/proxy`.
- [ ] Sidebar lengkap: Home, Provider, Compression, API, Combo, Proxy, Logs (Request + Proxy).
- [ ] **Combo UI:** Tab Model Mapping + Load Balancing + Provider Pool.
- [ ] **Realtime Logs:** SSE stream log baru muncul langsung di UI.
- [ ] Default password `CHANGEME`, diatur via `PASSWORD` di `.env`.
- [ ] API Key provider diambil dari SQLite.
- [ ] Graceful shutdown ≤ 5 detik saat SIGTERM.
- [ ] Build size < 10 MB.

---

## 14. Panduan Developer

1. **Prioritas 1:** Streaming Pipeline (Stage 4) — `ReadableStream` langsung dipipe ke Response.
2. **Prioritas 2:** Load Balancer — implementasi 6 strategy dengan thread-safe counter.
3. **Prioritas 3:** Model Guard + Rule Engine — cek allowlist dan evaluasi rules sebelum fetch.
4. **Prioritas 4:** `Bun.spawn()` untuk RTK/Caveman dengan fallback aman.
5. **Prioritas 5:** Auth guard — cookie session, 1 password dari `PASSWORD`.
6. **Prioritas 6:** Realtime logs — SSE ke client, insert log non-blocking.
7. **Prioritas 7:** Combo UI — visualisasi pool provider dan strategy config.
8. **Test Wajib:**
   ```bash
   curl -N -X POST http://localhost:3000/v1/chat/completions \
     -H "Content-Type: application/json" \
     -d '{"model":"gpt-4o","messages":[{"role":"user","content":"Hi"}],"stream":true}'
   ```

---

## 15. Catatan Teknis React Router v8

- **Package:** Gunakan `react-router` (bukan `react-router-dom`). Import DOM-specific dari `react-router/dom`.
- **Baseline:** Node 22.22+, React 19.2.7+, Vite 7+, ESM-only.
- **Middleware:** Aktif by default di v8 — gunakan untuk auth protection.
- **Resource Route:** `v1.chat.completions.ts` dan `api.stats.ts` hanya export `action`/`loader`.
- **File Routes:** Gunakan `flatRoutes()` dari `@react-router/fs-routes`.
- **Server-only code:** Taruh di `.server/` — di-bundle ke client.
- **Naming convention:** Kebab-case untuk file dan komponen.

---

**PRD Final Revisi v7.0 – UniRoute. Siap eksekusi.** 🚀
