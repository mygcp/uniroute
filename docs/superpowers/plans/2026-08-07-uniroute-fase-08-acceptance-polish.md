# Fase 8 — Acceptance Criteria & Polish

> **For agentic workers:** REQUIRED SUB-SKILL: subagent-driven-development atau executing-plans. Steps use checkbox syntax.

**Tujuan:** Menyelesaikan item non-fungsional PRD §13: graceful shutdown ≤ 5s saat SIGTERM, build size < 10 MB, dan menjalankan seluruh Acceptance Criteria sebagai regression final.

**Deliverable:** Server yang dihentikan bersih, build ringkas, dan dokumen melacak tiap DoD checklist PRD §13.

---

## Task 8.1 — Graceful shutdown (SIGTERM ≤ 5s)

**Files:**
- Modify: `app/server.ts` (atau entrypoint server utama dari React Router/Bun)

- [ ] **Step 1: Pastikan port tombangkan Runtime**

Dengan React Router v8 (framework mode), server dijalankan via `bun run start` (build → `bun ./build/server/index.js`). Ambil kontol handler sinyal di entry:

```ts
process.on("SIGTERM", () => {
  console.log("SIGTERM received, shutting down...");
  // 1. tutup server HTTP
  server.close(async () => {
    // 2. flush log queue (Fase 6) — set timeout 3s guard
    await flushLogs?.();
    // 3. tutup sqlite
    db.close();
    process.exit(0);
  });
  // force exit bila melebihi 5s
  setTimeout(() => process.exit(1), 5000);
});
```

> Pastikan abort aktif request streaming (abort semua controller) saat shutdown.

- [ ] **Step 2: Verifikasi**

```bash
bun run build && bun run start &
kill -SIGTERM $!
```

Expected: log shutdown dalam ≤ 5 detik, exit 0. Ukur waktu real.

---

## Task 8.2 — Build size < 10 MB

**Files:**
- Check: `bun run build` output

- [ ] **Step 1: Ukur output**

```bash
bun run build
du -sh build/
```

Karena ESM build dengan client chunk: pastikan bukan server bundle dalam `build/`. List `build/client` and `build/server`.

- [ ] **Step 2: Guard:**

- Jika > 10MB: periksa apa yang masuk — verifikasi `.server/` TIDAK di-bundle ke client (kode dengan `import "bun:sqlite"` atau `node:` yang tidak safe client).
- Hindari lib berat yang tak perlu (chart inlined SVG sudah menekan ini).

- [ ] **Step 3: Verifikasi**

`du -sh build/client` < 10MB.

---

## Task 8.3 — Jalankan Acceptance Criteria (PRD §13)

Track full checklist:

- [ ] Server jalan dengan 4 env vars (PORT + PASSWORD).
- [ ] `/v1/chat/completions` menerima OpenAI format, proxy ke provider.
- [ ] **Alur Proxy:** User → UniRoute → Provider → UniRoute → User (transparent).
- [ ] **6 strategy** tersedia (round_robin, random, priority, weighted, least_conn, first_available).
- [ ] **Model Mapping** satu model → banyak provider.
- [ ] **Model Guard** denied → 403.
- [ ] **Routing Rules:** rewrite & deny, di-evaluasi by priority.
- [ ] **Streaming SSE** chunk per chunk zero-buffering.
- [ ] **Compression** pipeline aktif + fallback aman.
- [ ] Semua halaman memerlukan login.
- [ ] `/login` public.
- [ ] **Flat routes:** `/home`, `/providers`, `/compression`, `/api`, `/combo`, `/proxy`, `/logs`.
- [ ] **Nested logs:** `/logs` layout + `/logs/requests`, `/logs/proxy`.
- [ ] Sidebar lengkap (Home, Provider, Compression, API, Combo, Proxy, Logs + submenu).
- [ ] **Combo UI:** 3-tab (Mapping, Load Balancing, Provider Pool).
- [ ] **Realtime logs:** stream new log muncul langsung di UI.
- [ ] Default password `CHANGEME`, via `PASSWORD` env.
- [ ] API key provider dari SQLite (`provider_credentials`).
- [ ] Graceful shutdown ≤ 5s saat SIGTERM.
- [ ] Build size < 10 MB.

---

## Task 8.4 — Final E2E regression test

- [ ] **Test streaming** validasi streaming pastikan sekali lagi menggunakan mock upstream (Fase 2) bila provider asli tidak tersedia.

- [ ] **Deny model → 403:**

```bash
curl -X POST http://localhost:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"nonexistent-model","messages":[{"role":"user","content":"x"}],"stream":true}' \
  -i | head -20
```

Expected: HTTP 403.

- [ ] **Rewrite rule** → model dialihkan (log `rule_applied`).

- [ ] **Fallback provider** → request sukses via pool berikutnya saat primary gagal.

- [ ] **All pages render** bila login: `/home`, `/providers`, `/compression`, `/api`, `/combo`, `/proxy`, `/logs/requests`, `/logs/proxy`.

- [ ] **Cache headers** streaming benar (`no-cache`).

- [ ] **Auth check:** non-auth hitting UI → redirect `/login`.

---

## Checkpoint Fase 8

- [ ] Graceful shutdown terverifikasi ≤ 5s (dan abort ≤ 5s).
- [ ] Build < 10 MB.
- [ ] Semua item DoD checklist §13 selesai.
- [ ] Final E2E lulus.
- [ ] Commit: `chore: finalize acceptance criteria`
- [ ] Push / merge sesuai preferensi repo.

---

**CATATAN AKHIR:** Jika semua fase selesai dan checklist §13 lengkap, UniRoute siap eksekusi produksi dengan mengganti `PASSWORD=CHANGEME`, dan menyediakan binary `rtk`/`caveman` serta API key real di `provider_credentials`.