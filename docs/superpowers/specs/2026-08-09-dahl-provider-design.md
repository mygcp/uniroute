# Add Dahl Global Provider

## Tujuan

Menambahkan **Dahl Global** sebagai provider OpenAI-compatible baru di UniRoute:
muncul di "Daftar provider" (DB seed), bisa diaktifkan dan diberi API key.
OpenCode Zen sudah terintegrasi (5 task sebelumnya) dan **tidak** berubah;
tidak ada varian `opencode` berbayar (keputusan user: skip).

## Fakta Terverifikasi (live)

- `GET https://inference.dahl.global/v1/models` anonim → HTTP 200, daftar model:
  `MiniMaxAI/MiniMax-M2.7`, `moonshotai/Kimi-K2.6`.
- `POST https://inference.dahl.global/v1/chat/completions` tanpa auth → **HTTP 401
  "Missing API token"**. Jadi Dahl butuh **Bearer** (`Authorization: Bearer <key>`),
  bukan `x-goog-api-key` (type `apikey` UniRoute milik Google). Entry memakai
  `authType: "bearer"`.
- `base_url = https://inference.dahl.global/v1` + `urlSuffix: "chat/completions"`
  → URL keluar `https://inference.dahl.global/v1/chat/completions` (path `/v1`
  dipertahankan sesuai mekanisme `urlSuffix` dari integrasi Zen).

## Desain

### 1. `app/registry/dahl.ts` (baru)

- `DAHL_ENTRY`: `id: "dahl"`, `alias: "Dahl Global"`, `format: "openai"`,
  `authType: "bearer"`, `free: false`, `baseUrl: "https://inference.dahl.global/v1"`,
  `urlSuffix: "chat/completions"`, `modelsUrl: "https://inference.dahl.global/v1/models"`,
  `description`, `color`.
- Model: `MiniMaxAI/MiniMax-M2.7` (Kimi K2.6 = `moonshotai/Kimi-K2.6`) sesuai
  daftar live.
- Daftarkan ke `PROVIDER_REGISTRY` di `app/registry/index.ts`.

### 2. `app/.server/db.ts`

- Seed utama: insert provider `dahl` (`https://inference.dahl.global/v1`,
  `auth_type = 'bearer'`, `is_active = 0`) + 2 model (sesuai live list),
  context_length default 200000 (endpoint live tidak memberi angka).
- `ensureDahlProvider()` — rekonsiliasi DB lama (INSERT OR IGNORE provider +
  model, guard auth_type bearer) meniru `ensureOpenCodeProvider()`; dipanggil
  di modul load setelah `seed()` dan `ensureOpenCodeProvider()`.

### 3. Adapter & `testProvider`

- Tidak ada perubahan: `auth_type === "bearer"` dan `urlSuffix` sudah didukung
  (dari integrasi Zen). Dahl aktif + API key → `Authorization: Bearer`.
- `testProvider`: Dahl membutuhkan key (bukan `none`), jadi path key-based
  yang sudah ada berlaku. `modelsUrl` via entry `modelsUrl`.

### 4. Template

- `app/components/provider-templates.tsx` TIDAK disentuh — hanya `openai` /
  `anthropic` yang jadi template. Dahl hanya muncul di "Daftar provider"
  (konsisten dengan `opencode`).

### 5. Pengujian

- `app/.server/registry.test.ts`: add test Dahl — setelah `ensureDahlProvider()` +
  aktifkan, `getProviders("moonshotai/Kimi-K2.6")` memetakan `dahl` dengan
  `auth_type === "bearer"`; daftar model Dahl == 2 live model.
- `app/.server/adapter.test.ts`: add test — `transformRequest` untuk provider
  `dahl` (`base_url` + `/v1`, `auth_type "bearer"`) menghasilkan URL
  `https://inference.dahl.global/v1/chat/completions` dan `Authorization:
  Bearer <key>` saat key ada.
- Jalankan `npm test`, `npm run typecheck`, `npm run build`.

## Out of Scope

- Varian paid `opencode` (`https://opencode.ai/v1`, bearer) — di-skip user.
- Mengubah perilaku OpenCode Zen yang sudah jalan.
- Nilai `context_length` Dahl dari live (tidak tersedia); default 200000.