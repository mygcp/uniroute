# Performance Playbook

Purpose of this document: **the next optimization round never starts from
zero.** It contains the measured baseline, invariants that must hold, a
checklist for new features, and how to re-measure. Read this BEFORE
optimizing anything.

## Hot path map (streaming gateway)

```
POST /v1/* → handleProxy
  ├─ authorize            ~1ms   (in-memory session / key lookup by hash)
  ├─ guard + rules        <1ms   (indexed point SELECTs)
  ├─ compress (optional)  2–6ms  (binary spawn; safe fallback)
  ├─ registry.getProviders  O(1)  (in-memory cache — no DB query)
  ├─ transform+translate  <1ms
  └─ executeStreaming     total gateway overhead: <1% of stream duration
       pipeTo(TransformStream) → empty-delta filter → token count → SSE
```

Baseline numbers (2026-08-24, deterministic mock, median of 7 pairs):

| Metric | Value |
| --- | --- |
| Handler pre-flight until upstream fetch | 15–20ms |
| Full-stream throughput overhead | +5–13ms (<1%) |
| Stream byte reduction (empty-frame filter) | −23% on the noisy mock |
| Test suite | 301 tests ≈ 6s |

## Invariants — DO NOT BREAK in new code

1. **The registry cache is never reloaded from the request path.**
   `handleProxy` calls `getProviders()` which reads the in-memory cache.
   Consequence: **every providers/models mutation MUST refresh the cache**:
   - Through the service layer → automatic (`upsertProviderModel` /
     `syncProviderModels` already call `reload()`).
   - Raw SQL (route action / MCP tool) → call `reload()` manually after the
     write. Examples: `mcp-tools.ts::toggle_provider`, `remove_model`.
   - 🔒 Locked by test: `provider-models.test.ts`.

2. **SQL must be static literals.** `db.query()` caches prepared statements
   per SQL string (matters for node:sqlite). Concatenating input into SQL
   bloats the cache AND invites injection. Bind parameters with `?`.

3. **Never create `TextDecoder`/`TextEncoder` inside chunk loops.** The
   executor uses one `{stream:true}` decoder per request and a module-shared
   encoder (`ENCODER`).

4. **Consume upstream bodies via `pipeTo(TransformStream)`** — not a manual
   `ReadableStream` + `getReader()` wrapper. Keep-alive, token counting, and
   finalization live in `buildStreamResponse` (executor.ts).

5. **Empty text delta frames are not forwarded to clients**
   (`format-stream.ts::process`). 🔒 Locked by test: `format-stream.test.ts`
   ("drops empty content_delta frames").

6. **The logger is batched** (`queueMicrotask` + BEGIN/COMMIT transaction).
   Do not INSERT directly per event on the request path.

7. **Use narrow queries for narrow needs**: e.g. `getRoutingPoolId()`
   (one column) instead of pulling the full credential row just to read a pool.

8. **Proxy metadata is captured once** via the `onProxyUsed` callback during
   egress; do not re-query it in `onComplete`.

## New-feature checklist (for agents/devs)

- [ ] Touches `/v1/*`? → no heavy sync IO, no N+1 queries, no per-chunk
      allocations in streaming loops.
- [ ] Mutates providers/models? → registry invalidation (see invariant #1).
- [ ] New SQL? → static literal + `?` parameters; add an index in
      `initSchema()` if the column is used for filtering/grouping.
- [ ] Changed streaming format? → update `format-stream.test.ts` and run the
      benchmark below.
- [ ] `bun run typecheck && bun run test` clean before committing.

## How to re-measure

```bash
# 1) deterministic mock upstream
node scripts/bench/mock-upstream.mjs &

# 2) register the bench provider, then RESTART the server
node scripts/bench/register-bench-provider.mjs

# 3) measure (direct vs through the gateway, alternating)
BASE=http://localhost:5173 PASSWORD=CHANGEME node scripts/bench/run-bench.mjs

# 4) clean up
node scripts/bench/register-bench-provider.mjs --clean
```

Record results with a date in the history table below. Compare **total &
bytes** for throughput; direct ttft includes the mock's empty frames, so the
gateway ttft (filtered) being "slower" is expected and desired.

## Optimization history

| Date | Changes |
| --- | --- |
| 2026-08-24 | Registry cache + central invalidation (removed per-request reload); prepared-statement cache for node:sqlite; executor rebuilt on `TransformStream`/`pipeTo`; empty-delta filter; decoder hoist + streaming decode; lightweight `getRoutingPoolId()`; proxy metadata via `onProxyUsed` (no re-query); fixed production build (`.server` imports leaking into client bundle in provider routes) |
