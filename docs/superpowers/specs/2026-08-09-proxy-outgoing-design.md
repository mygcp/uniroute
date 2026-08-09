# Outgoing HTTP/SOCKS5 Proxy Design

## Tujuan

Menambahkan dukungan **proxy keluar** (outbound proxy) untuk semua request yang
dikeluarkan UniRoute ke provider: chat completions (executor), test koneksi
provider, dan fetch modelsUrl. Mendukung **HTTP CONNECT** dan **SOCKS5**, dengan
transport yang bisa diperluas untuk proxy modern (mis. v2ray) di kemudian hari.

Fitur manajemen mencakup **bulk import** proxy (text per baris & JSON) dan
**bulk assignment** (pool proxy per provider). Proxy juga bisa dipasang **per
API key** (per akun). Prioritas pemilihan: **API key > pool provider > direct**.

## Fakta & Batasan Terverifikasi

- Runtime adalah **Bun** (`bun server.ts`, `bun test`). Bun native `fetch`
  menerima opsi `proxy` (HTTP CONNECT) dan `socks` (SOCKS5) — terverifikasi di
  lapangan (Request menerima keduanya tanpa throw; fetch benar-benar melewati
  proxy, terbukti dari kode 502 yang dikembalikan proxy CONNECT).
- Transport di-encapsulate di satu titik `fetchUpstream()` agar bisa diperluas
  ke v2ray (VMess) tanpa mengubah call-site.
- Prioritas assignment: **Key > Provider-pool > Direct**. Tanpa proxy aktif,
  request tetap direct (perilaku sekarang, tidak berubah).
- Rotasi pool: **round-robin** berdasar `last_used_at` (pola yang sudah ada di
  `balancer.ts roundRobin()`), plus **failover** ke proxy berikutnya saat proxy
  gagal (connect error / status retryable).
- Bulk import: text per baris (`host:port`, `host:port:user:pass`,
  `protocol://user:pass@host:port`) ATAU JSON array. Autodetect: mulai `[`/`{`
  → JSON; selain itu → per baris.
- Cakupan request yang lewat proxy: **semua request keluar** (chat, test
  koneksi, modelsUrl), hanya ketika proxy aktif/di-assign; selain itu direct.

## Desain

### 1. Data model (`app/.server/db.ts`)

Tabel baru `proxies`:

```
id           INTEGER PRIMARY KEY AUTOINCREMENT
protocol     TEXT NOT NULL DEFAULT 'http'   -- 'http' | 'socks5'
host         TEXT NOT NULL
port         INTEGER NOT NULL
username     TEXT
password     TEXT
is_active    INTEGER NOT NULL DEFAULT 1
last_used_at INTEGER DEFAULT 0              -- untuk round-robin pool
created_at   INTEGER DEFAULT (unixepoch())
UNIQUE(host, port, protocol)
```

Tabel baru `provider_proxies` (pool per provider):

```
provider_id  TEXT NOT NULL REFERENCES providers(id)
proxy_id     INTEGER NOT NULL REFERENCES proxies(id)
PRIMARY KEY(provider_id, proxy_id)
```

Migrasi `provider_credentials`: tambah kolom nullable `proxy_id INTEGER` untuk
proxy per API key (pola `PRAGMA table_info` → `ALTER TABLE` seperti migrasi
legacy single-key yang sudah ada).

### 2. Resolusi & transport (`app/.server/proxy-resolver.ts` baru)

- `resolveProxy(providerId)` → `ProxyConfig | null`, hierarki:
  1. Credential routing aktif (`is_routing=1` + `is_active=1`, pola `getApiKey`)
     dengan `proxy_id` → pakai proxy itu (jika aktif).
  2. Pool per provider aktif → `roundRobinPick(pool)`.
  3. Tidak ada → `null` (direct).
- `getActivePool(providerId)` → daftar `ProxyConfig` aktif diurutkan
  round-robin; `roundRobinPick` meng-update `last_used_at`.
- `formatProxy(proxy)` → `{ proxy: "http://user:pass@host:port" }` atau
  `{ socks: "socks5://user:pass@host:port" }`.
- `fetchUpstream(url, opts)` — satu titik keluaran, sekarang memakai fetch
  native Bun dengan opsi proxy/socks; titik perluasan transport v2ray nanti.
- `parseBulkProxies(text)` → `{ imported: ProxyRow[], skipped: string[] }`
  (pustaka baris + JSON, filter duplicate/invalid) — dipisah agar bisa diuji
  unit.

### 3. Eksekusi (`app/.server/executor.ts`)

- `ExecutorOptions` menerima `proxies: ProxyConfig[]` (daftar hasil resolusi).
- `attempt()` memakai `fetchUpstream`; saat proxy pertama gagal (connect error
  / status retryable 5xx) coba proxy berikutnya di pool sebelum menyerah.
  Error auth proxy (401) tidak retryable.
- Antarmuka `executeStreaming(options)` tidak berubah bagi caller lain.

### 4. Chat route (`app/routes/v1.chat.completions.ts`)

- Per provider: `provider.proxies = resolveProxyCandidates(provider.id)`.
- Perulangan provider `for (const provider of candidates)` meneruskan daftar
  proxy ke `executeStreaming`.

### 5. UI — halaman baru `/proxies` (sidebar `Proxies`)

Tiga tab mengikuti pola tab `Combo`/`API` (tombol header + konten tab):

**Daftar Proxy:** tabel (protocol, host:port, username, status, toggle on/off,
Test, Edit, Hapus) + form tambah.

**Bulk Import:** textarea (baris) / textarea JSON, tombol Import, autodetect,
ringkasan `X imported, Y skipped`.

**Bulk Assignment:** dua daftar checkbox (Providers | Proxies), tombol Assign
→ INSERT OR IGNORE tiap pasangan; tabel assignment yang ada + hapus pasangan.

### 6. Proxy per API key (`app/routes/api.tsx`)

- `EditKeyForm` ditambah select Proxy (opsional).
- `updateClientKey` (mengganti `updateClientKeyRules`) menyimpan `proxy_id`.
- Resolver membaca `proxy_id` credential routing aktif (prioritas tertinggi).

### 7. Cakupan request keluar lain

- `providers.tsx testProvider`: panggil `resolveProxy` untuk proxy (per key
  saat iterasi keys) — test koneksi ikut lewat proxy.
- Fetch modelsUrl / models list: pakai pool proxy provider tersebut.

### 8. Error handling

- Proxy connect gagal → failover ke proxy berikutnya, lalu provider berikutnya.
- Proxy auth invalid → error `proxy auth failed`, bukan retryable.
- Log `status: "error"` + `error_message` menyertakan konteks proxy
  (`proxy connect failed: host:port`).
- Test proxy: request kecil lewat proxy, cek bukan network error (status
  non-zero / berhasil konek).

### 9. Pengujian

- `proxy-resolver.test.ts` — hierarki (key > pool > direct), rotasi
  round-robin `last_used_at`, pool kosong → null.
- `executor.test.ts` — fetchUpstream melewati proxy (mock), failover antar 2
  proxy, error auth tidak retryable.
- Uji parse `parseBulkProxies` (baris text, JSON, campuran valid+invalid,
  duplicate → import/skip count).
- UI tab diuji manual (import + assignment end-to-end).
- Regresi penuh: `npm test` (77 existing + new), `npm run typecheck`,
  `npm run build`. Test baru mengikuti pola yang ada: berbasis file komponen
  di `app/.server/` (bukan `app/routes/`).

## Out of Scope

- Transport v2ray (VMess) — hanya disiapkan titik perluasan `fetchUpstream`.
- Autentikasi proxy selain user:pass.
- Rotasi/load-balancing lanjutan di luar round-robin + failover.
- Proxy untuk request masuk (client → UniRoute); ini murni proxy keluar.