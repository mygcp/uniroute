# Fase 5 — UI Halaman Admin

> **For agentic workers:** REQUIRED SUB-SKILL: subagent-driven-development atau executing-plans. Steps use checkbox syntax.

**Tujuan:** Membangun semua halaman dashboard admin (PRD §6.2, §7, §9.6, §10). Setiap halaman = folder `app/routes/*.tsx` + komponen shared di `app/components/`. Semua route protected (diwarisi dari Fase 4).

**Deliverable:** Halaman Home (stats+chart), Providers (CRUD), Compression, API (allowlist+rules), Combo (3 tab), Proxy playground, + resource `/api/stats`.

**Sumber:** PRD §9.6 (combo), §10 (API mgmt), §13 (DoD UI).

---

## Task 5.1 — Home + Stats

**Files:**
- Create: `app/routes/home.tsx`
- Create: `app/routes/api.stats.ts` (resource route)
- Create: `app/components/stat-card.tsx`
- Create: `app/components/usage-chart.tsx`

- [ ] **Step 1: Resource route `GET /api/stats`**

```ts
export async function loader() {
  const total = db.query(`SELECT COUNT(*) c FROM request_logs`).get().c;
  const success = db.query(`SELECT COUNT(*) c FROM request_logs WHERE status='success'`).get().c;
  const avgLatency = db.query(`SELECT AVG(duration_ms) a FROM request_logs`).get().a;
  const activeProviders = db.query(`SELECT COUNT(*) c FROM providers WHERE is_active=1`).get().c;
  return { total, successRate: total ? Math.round((success/total)*100) : 0, avgLatency: Math.round(avgLatency ?? 0), activeProviders };
}
```

- [ ] **Step 2: `home.tsx` loader + UI**

```tsx
export async function loader({ request }) {
  // guard sudah dipenuhi root
  const res = await fetch(new URL("/api/stats", process.env.BASE_URL), { headers: { cookie: request.headers.get("cookie") ?? "" } });
  return { stats: await res.json() };
}
```

Render: 4 x `StatCard` (Total Requests, Success Rate, Avg Latency, Active Providers) + `usage-chart` (chart bar/timeseries dari query per-hari `request_logs`).

- [ ] **Step 3: `stat-card.tsx`**

Props: `title`, `value`, `suffix?`, `accent?` → card Tailwind.

- [ ] **Step 4: `usage-chart.tsx`**

Inline SVG bar chart: dataset 7 hari terakhir (query `request_logs` group by date). **Tanpa** library chart eksternal.

- [ ] **Step 5: Verifikasi UI**

Login → `/home` → angka muncul dari seed `/api/stats`.

---

## Task 5.2 — Provider CRUD

**Files:**
- Create: `app/routes/providers.tsx`
- Create: `app/components/provider-form.tsx`

- [ ] **Step 1: `providers.tsx` loader + action**

Loader: daftar `providers` all.
Action POST (atau method `PUT`/`DELETE` pada form):
- `create`: INSERT providers (name, base_url, auth_type, active, weight, priority).
- `update`: UPDATE by id.
- `delete`: DELETE by id.
- Setelah mutasi: `registry.reload()`.

- [ ] **Step 2: `provider-form.tsx` — form modal/reusable**

Fields: name, base_url, auth_type (select none/bearer/apikey), is_active (checkbox), weight (number), priority (number).

- [ ] **Step 3: Tabel daftar provider**

Kolom: name, base_url, auth_type, active, weight, priority, actions (edit/delete).

- [ ] **Step 4: Verifikasi**

Create provider → tampil; edit weight → tersimpan & registry reload; delete → hilang.

---

## Task 5.3 — Compression settings page

**Files:**
- Create: `app/routes/compression.tsx`
- Create: `app/components/compression-panel.tsx`

- [ ] **Step 1: Tabel `compression_settings` (id=1) read/write**

Loader: baca row id=1. Action: update field (rtk_enabled, caveman_enabled, rtk_binary_path, caveman_binary_path).

- [ ] **Step 2: UI panel**

Toggle RTK enabled + path input; toggle Caveman enabled + path input; tombol **Test** (memanggil `compressor.testPipeline(prompt)` dari Fase 7 — placeholder di fase ini → alert "pending Fase 7").

- [ ] **Step 3: Verifikasi**

Toggle tersimpan ke DB; reload halaman merepresentasikan.

---

## Task 5.4 — API Management page (`/api`)

**Files:**
- Create: `app/routes/api.tsx`
- Create: `app/components/api-manager.tsx`

- [ ] **Step 1: Tabs: Allowlist | Routing Rules**

`api.tsx` menyediakan 2 state tab; component `api-manager` render tabel berdasarkan tab aktif.

- [ ] **Step 2: Allowlist tab**

Loader: `model_allowlist` rows. Action: create (model_name+action+reason), delete.
Table: model_name, action, reason, actions.

- [ ] **Step 3: Routing Rules tab**

Loader: `routing_rules` rows. Action: CRUD (name, source_model, rule_type, target_model, target_provider_id, priority, is_active).
Table: name, source, type, target, priority, active, actions.

- [ ] **Step 4: Verifikasi**

Tambah allow deny → request model deny → 403 (terhubung ke Guard Fase 2). Tambah rewrite rule → terpengaruh.

---

## Task 5.5 — Combo page (`/combo`)

**Files:**
- Create: `app/routes/combo.tsx`
- Create: `app/components/combo-mapping-table.tsx`
- Create: `app/components/strategy-selector.tsx`

- [ ] **Step 1: Combo 3-tab layout**

Tab: **Model Mapping** | **Load Balancing** | **Provider Pool** (PRD §9.6).

- [ ] **Step 2: Tab Model Mapping**

Loader: `models` join `providers` (model_name, provider, context_length, active, primary, actions).
Form: model_name, provider select, context_length, primary checkbox. Satu model multi-provider (tambah row baru). DELETE row → registry.reload().

- [ ] **Step 3: Tab Load Balancing**

Loader: `load_balancing` rows + count provider per model.
Form: strategy select (`strategy-selector`), toggle fallback, toggle health check, interval input.
Visualisasi: mini bar/pie distribusi weight (optional inline SVG).

- [ ] **Step 4: Tab Provider Config**

Loader: per model → providers list (weight, priority, current_connections, last_used_at, health cache).
Edit inline: weight, priority (UPDATE).

- [ ] **Step 5: Verifikasi**

Mapping `gpt-4o` + `groq` tersimpan → proxy route menggabungkannya (lihat `request_logs` strategy_used).

---

## Task 5.6 — Proxy Playground (`/proxy`)

**Files:**
- Create: `app/routes/proxy.tsx`
- Create: `app/components/proxy-playground.tsx`
- Create: `app/components/model-selector.tsx`
- Create: `app/components/message-input.tsx`
- Create: `app/components/streaming-response.tsx`
- Create: `app/hooks/use-streaming.ts`

- [ ] **Step 1: `use-streaming` hook**

Fetch POST ke `/v1/chat/completions` (stream), parse SSE client-side (`ReadableStream` + `EventSource` fallback disallow karena POST), buka line `data:`, dispatch token ke callback. Abort pada unmount.

- [ ] **Step 2: Playground UI**

Form: model-select (`models` from registry), textarea prompt (`message-input`), toggle stream/stream off. Tombol Send → POST internal proxy endpoint.

Response area: display streaming tokens (streaming-response). Jika stream=false, tampil JSON.

Also: display request/response metadata (headers, status, duration_ms) via fetch ke internal debug endpoint (opsional — gunakan Fase 6 logger untuk timing).

- [ ] **Step 3: Verifikasi**

Pilih model ter-seed → send → token streaming live muncul; stop berhenti.

---

## Task 5.7 — Page `/logs` layout (shell for Fase 6)

**Files:**
- Create: `app/routes/logs.tsx` (shell + nested outlet)
- Create: `app/routes/logs.requests.tsx` (placeholder)
- Create: `app/routes/logs.proxy.tsx` (placeholder)

- [ ] **Step 1: `logs.tsx` shell**

Render `nav` (Request Logs | Proxy Logs links) + `<Outlet />`.

- [ ] **Step 2: Placeholder kedua child**

Isi "Fase 6" placeholder sementara.

---

## Checkpoint Fase 5

- [ ] Home menampilkan stats + chart dari `/api/stats`.
- [ ] Provider CRUD + registry reload.
- [ ] Compression page toggles tersimpan.
- [ ] `/api`: allowlist & rules CRUD → berdampak ke request.
- [ ] Combo 3 tab berfungsi (mapping multi-provider).
- [ ] Proxy playground: streaming tampil.
- [ ] Commit: `feat: admin UI pages`