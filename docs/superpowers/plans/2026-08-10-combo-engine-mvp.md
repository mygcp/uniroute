# Combo Engine MVP — Plan & Progress

- **Tanggal**: 2026-08-10
- **Spec**: [2026-08-10-combo-engine-mvp-design.md](../specs/2026-08-10-combo-engine-mvp-design.md)
- **Choice**: User memilih *langsung implementasi MVP* (priority + pipeline),
  sisanya fase lanjut.

## Tujuan

Satu request dari client dengan model `combo:<nama>`:

- **priority** → coba step 1, gagal → step 2, dst.
- **pipeline** → step berurutan, output step diteruskan ke step berikutnya.

## Task

- [x] **T1 — Schema**: 3 tabel baru di `app/.server/db.ts` `initSchema()`
      (`combos`, `combo_steps` FK CASCADE, `combo_metrics`), idempotent.
- [x] **T2 — Model layer**: `app/.server/combo.ts` — types, `parseComboModel`,
      `validateComboInput`, CRUD, `recordComboMetric`, `extractUpstreamText`
      (openai/chat, responses/output, anthropic, gemini).
- [x] **T3 — Runner**: `app/.server/combo-runner.ts` — `runComboEngine`,
      `executeStep`, priority fallback, pipeline chaining, per-step
      log + usage + metric + cost.
- [x] **T4 — Integrasi**: `app/.server/proxy-handler.ts` — branch combo
      sebelum `getProviders`, guard `modelAllowed` dilewati untuk combo valid.
- [x] **T5 — UI**: `app/routes/combo.chains.tsx` (`/combo/chains`) — create
      multi-step, list, delete; datalist model/provider.
- [x] **T6 — Link**: header halaman `/combo` (combo.tsx) → `/combo/chains`.
- [x] **T7 — Test**: `app/.server/combo.test.ts` (pure + DB layer) &
      `app/.server/combo-runner.test.ts` (fallback chain end-to-end dgn
      provider dummy unreachable).
- [x] **T8 — Verifikasi**: `npm test` (257 pass / 0 fail), `npm run typecheck` ✅,
      `npm run build` ✅, smoke test runtime: `combo:smoke-prio` → priority
      chain mengeksekusi kedua step, `combo_metrics` + `request_logs`
      (`strategy_used: combo:priority`) tercatat, HTTP 404 (status upstream
      terakhir) diteruskan.
- [x] **T9 — Commit**.

## Progress

| Tanggal | Status | Catatan |
| --- | --- | --- |
| 2026-08-10 | **MVP selesai** | T1–T9 done: 257 test pass, typecheck & build OK, smoke test runtime terbukti (priority fallback, metrics, logs). |

## Catatan Implementasi

- Root cause api-manager sebelumnya (suffix `_index`) tidak relevan di sini —
  halaman baru memakai flat route `combo.chains.tsx` → `/combo/chains`.
- Runner memakai deps yang sama persis dengan `handleProxy`
  (`transformRequest`, `resolveProxyCandidates`, `executeJson`,
  `executeStreaming`, `translateResponse`, `selectProvider`,
  `recordRequestLog/Usage`, `estimateCost`) — tidak ada dependency baru.
- Enum guard: untuk request `combo:` tanpa api key, `rule=null` → semua step
  berjalan; dengan api key, step yang tak diizinkan dilewati (priority) /
  menghentikan pipeline (error).
- Streaming pipeline: hanya step final yang boleh streaming; step perantara
  dipaksa `stream=false`.
- Smoke test memakai `getAnyProvider` untuk step model tak terdaftar →
  provider priority>0 dicoba (perilaku disengaja; model unknown tetap
  dicoba ke provider yang mungkin menerimanya).