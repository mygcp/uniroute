# Align OpenCode Zen Integration (Free / No-Key)

## Tujuan

Menyelaraskan integrasi OpenCode Zen agar pakai mode **free, tanpa API key** sesuai referensi:
`authType: 'none'`, base URL `https://opencode.ai/zen/v1`, format OpenAI-compatible.
Tidak ada key yang dikirim ke Zen; provider harus bekerja anonim.

## Fakta Terverifikasi (live)

- `POST https://opencode.ai/zen/v1/chat/completions` tanpa header auth **berhasil streaming** (tidak perlu key / sentinel).
- `GET https://opencode.ai/zen/v1/models` tanpa auth mengembalikan daftar model (HTTP 200).
- Daftar model free live saat integrasi ditulis:
  `big-pickle`, `deepseek-v4-flash-free`, `mimo-v2.5-free`,
  `ling-3.0-flash-free`, `ling-3.0-tiny-free`, `nemotron-3-ultra-free`,
  `north-mini-code-free`, `laguna-s-2.1-free`, `longcat-2.0-free`.
  Model `hy3-free` **tidak lagi ada** di daftar live.

## Bug yang Ditemukan

`app/.server/adapter.ts:15` membangun URL keluar dengan
`new URL("/v1/chat/completions", provider.base_url)`.
Path berawalan `/` me-reset ke origin, sehingga dengan
`base_url = https://opencode.ai/zen/v1` hasilnya menjadi
`https://opencode.ai/v1/chat/completions` — segmen `/zen` hilang.
Akibatnya request chat ke Zen akan salah arah.

Tipe `RegistryEntry` sudah punya field `urlSuffix?: string` yang belum dipakai —
dipakai untuk memperbaiki pembangunan URL secara generik.

## Desain

### 1. `app/registry/opencode.ts`

- `authType: "apikey"` → `authType: "none"`.
- Hapus `authHeader`/`authPrefix` (tidak ada key yang dikirim).
- Tambah `urlSuffix: "chat/completions"` — karena `baseUrl` sudah mengandung `/zen/v1`.
- Terapkan asset model:
  - Hapus `hy3-free`.
  - Tambah `ling-3.0-flash-free`, `ling-3.0-tiny-free`, `laguna-s-2.1-free`, `longcat-2.0-free`.
- Pertahankan `free: true`, `passthroughModels: true`, `modelsUrl`,
  metadata model yang lain, serta `defaultContextLength: 200000`.

### 2. `app/.server/adapter.ts`

- Jika `entry?.urlSuffix` ada: bangun URL dengan string join
  `${base_url}/${urlSuffix}` (trim trailing slash dulu), **bukan** `new URL`.
- Jika tidak ada `urlSuffix`: pertahankan perilaku lama
  `new URL("/v1/chat/completions", provider.base_url)`.
  Ini membuat semua provider lain (openai, google, dsb.) tidak berubah.
- Karena entry opencode tidak lagi punya `authHeader`/`authPrefix`,
  dan `provider.auth_type === "none"`, tidak ada header auth yang disetel.
  Blok `entry?.authHeader` serta cabang `bearer`/`apikey` tidak tersentuh.

### 3. `app/.server/db.ts`

- Provider opencode di seed utama: `auth_type: "apikey"` → `"none"`; base_url tetap
  `https://opencode.ai/zen/v1`.
- `ensureOpenCodeProvider()` perlu **merekonsiliasi** DB lama (bukan hanya
  `INSERT OR IGNORE`):
  - `UPDATE providers SET auth_type = 'none'` untuk id `opencode` (bila berbeda).
  - Insert model baru yang belum ada.
  - Set `hy3-free` menjadi `is_active = 0` (non-aktif), bukan delete, agar tidak
    merusak referensi lama.
- Nilai `context_length` dipertahankan; endpoint `/v1/models` tidak memberikan
  angka context window yang otoritatif.

### 4. `app/routes/providers.tsx` — `testProvider`

- Jika `provider.auth_type === "none"`: lakukan `GET` anonim ke modelsUrl dan hitung
  sebagai connected. Sehingga provider free tanpa key tidak selalu tampil 0 connected.

### 5. Pengujian

- `app/.server/adapter.test.ts`:
  - Update kasus opencode: URL keluar `https://opencode.ai/zen/v1/chat/completions`
    dan **tidak ada** header `Authorization`.
  - Tambah kasus base_url berpath: URL keluar benar sambil mempertahankan segmen path.
- `app/.server/registry.test.ts`: memastikan tetap lolos (base_url opencode tidak berubah).
- Jalankan `npm test`, `npm run typecheck`, `npm run build`.

## Out of Scope

- `app/components/provider-templates.tsx`: opencode tetap TIDAK menjadi template
  "Tambah provider" (konten dibenarkan di "Daftar provider").
- Gate `require_api_key` di playground: terpisah dari auth provider; bypass sesi
  admin sudah ada dan tidak berubah.
- Nilai `context_length`: tidak ada sumber otoritatif live; tidak diubah.