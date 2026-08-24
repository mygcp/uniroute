# Development

## Scripts

```bash
bun run dev         # dev server (Vite + SSR) on :5173
bun run build       # production build → build/
bun run start       # serve the build (Bun.serve, server.ts)
bun run test        # all unit tests
bun run typecheck   # react-router typegen + tsc
```

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
  .server/           # server modules (db, proxy-handler, translate/, …)
mcp-server.ts        # MCP stdio/HTTP
docs/                # this documentation
scripts/bench/       # gateway streaming benchmark toolkit
```
