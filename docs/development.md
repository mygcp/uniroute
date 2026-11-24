# Development

## Scripts

```bash
bun run dev         # dev server (Vite + SSR) on :5173
bun run build       # production build → build/
bun run start       # serve the build (Bun.serve, server.ts)
bun run test        # all unit tests
bun run typecheck   # react-router typegen + tsc
```

Note: the dev server compiles on demand, so the first request (login, endpoint) can take a few seconds. For representative performance numbers use `bun run build && bun run start`.

## Testing

Unit tests use `bun:test` and live next to the modules they cover
(`app/.server/*.test.ts`, `app/lib/*`, `app/.server/translate/*`).

- Test DBs are isolated automatically (`test-env.ts` points `DATABASE_URL`
  at `/tmp/…`).
- Filesystem tests (e.g. `agents-config.test.ts`) use a temporary home dir
  via parameter — real user data is never touched.
- Run one file: `bun test ./app/.server/agents-config.test.ts`

Before committing make sure `bun run typecheck` and `bun run test` are clean.

## Performance

Before optimizing anything (or adding a feature on the `/v1/*` path), read
[performance.md](performance.md): the measured baseline, hot-path invariants
(registry cache, statement cache, streaming rules), a new-feature checklist,
and ready-to-run benchmark scripts in `scripts/bench/`.

## Code conventions

- **Server-only** modules live under `app/.server/**` (never imported by
  client code). Resource routes keep loader/action in the route file.
- **State updaters must be pure** — side effects (fetcher.submit etc.) are
  forbidden inside updaters; use refs + effects. (Source of an earlier
  "duplicate save" bug.)
- **One fetcher per row** for table actions so parallel clicks don't cancel
  each other (pattern: proxy/provider rows).
- SSE streaming: each transformer owns its TextDecoder; backpressure via
  `pull()`; never release the reader lock on early return.
- Schema migrations: add columns/indexes idempotently in `initSchema()`
  (`ensureColumn` / `CREATE INDEX IF NOT EXISTS`) — never overwrite data.
- UI copy is English; internal comments are free-form.

## Layout overview

```
app/
  routes/            # pages + resource APIs (file-based)
  components/        # UI (ui/, usage/, chart)
  hooks/             # use-realtime-logs, use-streaming, …
  lib/               # client-safe helpers (format, markdown)
  registry/          # CLIENT provider templates (URL/auth hints, static model lists)
  .server/           # server-only modules
    registry.ts      # SERVER in-memory model->providers cache (hot path)
                     # Do NOT confuse with app/registry above.
docs/                # this documentation
scripts/bench/       # gateway streaming benchmark toolkit
```

### Registry cache (do not break)

- `app/registry/*` = static provider templates used for URL/auth hints.
- `app/.server/registry.ts` = runtime cache of active providers/models from SQLite.
- Every mutation of providers/models MUST call `reload()` from `.server/registry`
  (service layer does it automatically; raw SQL in routes/MCP must do it manually).
- `handleProxy` never reloads per request - regression locked by
  `provider-models.test.ts`.

