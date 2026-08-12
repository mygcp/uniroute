# UniRoute Proxy Engine — Technical Specification

**Date**: 2026-08-11
**Status**: Implemented (2026-08-12)
**Tag**: proxy, outbound, http-connect, socks5, proxy-pool, failover

## 1. Overview

This document specifies the design for an **outbound proxy engine** within the UniRoute AI Gateway. The engine routes all outbound HTTP/S traffic from UniRoute to upstream AI providers through configurable proxy chains, supporting **HTTP CONNECT** and **SOCKS5** protocols.

All outbound traffic includes:

- Provider API requests (chat completions, embeddings, etc.)
- Provider connection tests
- Model list fetches (`modelsUrl`)
- Any future upstream HTTP calls

### Proxy Selection Hierarchy

Proxy resolution follows a strict priority chain:

1. **API Key (Credential Routing)** — When a client API key has `proxy_pool_id` set, use that pool.
2. **Provider Pool** — When a provider has an assigned proxy pool, use that pool.
3. **Direct** — Fall back to direct connection (current behavior). No proxy.

Within a pool, proxies are selected via **round-robin** using `last_used_at` (same pattern as `balancer.ts`). On connection errors or retryable status codes, the engine **failovers** to the next proxy in the pool. Authentication failures (401/407) are **not** failover-triggering.

### Key Design Decisions

- **Single egress point**: All upstream `fetch` calls go through `fetchUpstream()` in the new module `app/.server/proxy-resolver.ts`.
- **No new dependencies**: Bun's native `fetch` is used. HTTP CONNECT tunneling is handled via `node:http`/`bun:http` `CONNECT` method. SOCKS5 support uses a minimal pure-JS implementation or the optional `socks` package if absolutely needed.
- **Backward compatible**: Without active proxies, behavior remains unchanged.
- **Bulk management**: Proxies can be imported in bulk (text per line & JSON) and assigned in bulk (pool per provider, pool per API key).
- **Failover semantics**: Connection errors and retryable HTTP statuses trigger proxy rotation within the resolved pool. 401/407 proxy authentication failures halt failover.

## 2. Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Request Flow                            │
├─────────────────────────────────────────────────────────────┤
│  /v1/chat/completions                                       │
│      │                                                      │
│      ▼                                                      │
│  handleProxy() (app/.server/proxy-handler.ts)               │
│      │                                                      │
│      ├── authorize() ── resolves ClientKey (may carry       │
│      │                   proxy_pool_id)                      │
│      │                                                      │
│      ├── selectProvider() ── returns Provider (may carry    │
│      │                       proxy_pool_id)                  │
│      │                                                      │
│      ├── orderCandidates() ── provider failover list        │
│      │                                                      │
│      ▼                                                      │
│  For each provider candidate:                               │
│      │                                                      │
│      ▼                                                      │
│  buildUpstreamRequest() (translate/adapter)                 │
│      │                                                      │
│      ▼                                                      │
│  executeJson() / executeStreaming()                         │
│  (app/.server/executor.ts)                                  │
│      │                                                      │
│      ▼                                                      │
│  resolveProxyPool() ── determines proxy pool for this        │
│  (app/.server/proxy-resolver.ts)                             │
│  request (API key pool → provider pool → direct)             │
│      │                                                      │
│      ▼                                                      │
│  fetchUpstream() ── single egress point:                    │
│  selects proxy from pool (round-robin by last_used_at),     │
│  establishes tunnel (HTTP CONNECT or SOCKS5),               │
│  performs fetch(), handles failover                         │
└─────────────────────────────────────────────────────────────┘
```

### New Module: `app/.server/proxy-resolver.ts`

```typescript
// Proxy type definitions
export type ProxyType = "http-connect" | "socks5";

export interface ProxyConfig {
  id: number;
  name: string;
  type: ProxyType;
  host: string;
  port: number;
  username: string | null;
  password: string | null;  // encrypted
  is_active: boolean;
  last_used_at: number;
  created_at: number;
  updated_at: number;
}

// Proxy pool linking proxies together
export interface ProxyPool {
  id: number;
  name: string;
  proxy_ids: number[];  // JSON array of proxy IDs
  is_active: boolean;
  created_at: number;
  updated_at: number;
}

// Assignment linking pools to providers or API keys
export interface ProxyAssignment {
  id: number;
  proxy_pool_id: number;
  target_type: "provider" | "client_key";
  target_id: string | number;  // provider.id or client_api_keys.id
  created_at: number;
}

// Resolution result
export interface ResolvedProxy {
  config: ProxyConfig;
  pool: ProxyPool;
}

// Core functions:
export function resolveProxyPool(params: {
  apiKeyPoolId?: number | null;
  providerPoolId?: number | null;
}): ResolvedProxy[] | null;

export async function fetchUpstream(
  url: string,
  options: RequestInit & {
    proxyPoolId?: number | null;
    providerId?: string | null;
    signal?: AbortSignal;
    retryable?: boolean;  // enable failover
  },
): Promise<Response>;
```

### Integration with `executor.ts`

The executor's `attempt()` function currently calls `fetch()` directly. It will be modified to call `fetchUpstream()` from the proxy resolver instead:

```typescript
// Before (current):
const upstream = await fetch(url, { method: "POST", headers, body, signal });

// After:
const upstream = await fetchUpstream(url, {
  method: "POST",
  headers,
  body,
  signal,
  proxyPoolId,  // passed from ProxyHandlerConfig
  providerId,
});
```

`fetchUpstream()` handles:

1. Pool resolution (API key → provider → direct)
2. Round-robin proxy selection within the pool
3. Tunnel establishment (HTTP CONNECT or SOCKS5)
4. The actual `fetch()` call
5. Failover to next proxy on connection errors / retryable statuses
6. Updating `last_used_at` on the selected proxy

### Integration with `proxy-handler.ts`

The `ProxyHandlerConfig` type gains optional proxy resolution fields:

```typescript
export type ProxyHandlerConfig = {
  clientFormat: ClientFormat;
  parse: (body: Record<string, unknown>) => CanonicalRequest;
};

// The handler passes proxy context to executeJson/executeStreaming
// via ExecutorOptions (extended):
type ExecutorOptions = {
  url: string;
  headers: Headers;
  body: string;
  signal?: AbortSignal;
  streamTransformer?: StreamTransformer;
  onComplete: (log: Partial<RequestLog>) => void;
  // ── New ──
  proxyPoolId?: number | null;
  providerId?: string | null;
};
```

## 3. Database Schema

All tables are created via `initSchema()` in `app/.server/db.ts` using `CREATE TABLE IF NOT EXISTS` (idempotent).

### 3.1 `outbound_proxies`

```sql
CREATE TABLE IF NOT EXISTS outbound_proxies (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  type          TEXT NOT NULL DEFAULT 'http-connect',  -- 'http-connect' | 'socks5'
  host          TEXT NOT NULL,
  port          INTEGER NOT NULL,
  username      TEXT,
  password_enc  TEXT,                                  -- encrypted at rest
  is_active     INTEGER NOT NULL DEFAULT 1,
  last_used_at  INTEGER DEFAULT 0,
  created_at    INTEGER DEFAULT (unixepoch()),
  updated_at    INTEGER DEFAULT (unixepoch())
);
```

### 3.2 `proxy_pools`

```sql
CREATE TABLE IF NOT EXISTS proxy_pools (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  proxy_ids   TEXT NOT NULL,                          -- JSON array of outbound_proxies.id
  is_active   INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER DEFAULT (unixepoch()),
  updated_at  INTEGER DEFAULT (unixepoch())
);
```

### 3.3 `proxy_pool_assignments`

```sql
CREATE TABLE IF NOT EXISTS proxy_pool_assignments (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  proxy_pool_id INTEGER NOT NULL REFERENCES proxy_pools(id) ON DELETE CASCADE,
  target_type   TEXT NOT NULL,                        -- 'provider' | 'client_key'
  target_id     TEXT NOT NULL,                        -- providers.id or client_api_keys.id
  created_at    INTEGER DEFAULT (unixepoch()),
  UNIQUE(proxy_pool_id, target_type, target_id)
);
```

### 3.4 Schema Alter for `client_api_keys`

No schema change needed. The API key → proxy pool mapping is stored via `proxy_pool_assignments` (target_type='client_key').

## 4. Proxy Resolution Logic

### 4.1 `resolveProxyPool()`

```
INPUT: apiKeyPoolId?, providerPoolId?
OUTPUT: ResolvedProxy[] | null  (ordered list for failover)

1. If apiKeyPoolId is set and active → return proxies in that pool
2. Else if providerPoolId is set and active → return proxies in that pool
3. Else → return null (direct connection)
```

The returned array is ordered by `last_used_at ASC` (oldest first, for round-robin). Each proxy's `last_used_at` is updated after a successful or attempted fetch.

### 4.2 `fetchUpstream()`

```
INPUT: url, options (including optional proxyPoolId, providerId)
OUTPUT: Response

1. resolved = resolveProxyPool({ apiKeyPoolId, providerPoolId })
2. If resolved is null → fetch(url, options) [direct, no proxy]
3. For each proxy in resolved (round-robin order):
   a. Establish tunnel:
      - HTTP CONNECT: send "CONNECT host:port HTTP/1.1", authenticate if creds
      - SOCKS5: handshake with optional username/password auth
   b. Attempt fetch through tunnel
   c. On success → return response
   d. On failure:
      - Connection error / ECONNRESET / ETIMEDOUT → continue to next proxy
      - Retryable HTTP status (502, 503, 504, 408, 429) → continue to next proxy (if retryable=true)
      - Auth failure (401, 407) → stop, return error (non-retryable)
   e. Update proxy.last_used_at
4. If all proxies failed → throw/reject with aggregated error
```

### 4.3 HTTP CONNECT Tunneling

For `http-connect` proxies, the flow is:

1. **Connect** to proxy host:port
2. **Send** `CONNECT <upstream_host>:<upstream_port> HTTP/1.1\r\nHost: <upstream_host>:<upstream_port>\r\n`
3. If proxy requires auth: prepend `Proxy-Authorization: Basic <base64(user:pass)>\r\n`
4. **Read** response — expect `HTTP/1.1 200 Connection Established`
5. **Upgrade** the TCP socket to a tunnel
6. **Perform** the HTTP request through the tunnel

In Bun, this is achieved via `net.connect()` to the proxy, sending the CONNECT request, and then using the socket as a custom transport for `fetch()` (via `undici` or manual HTTP request through the socket).

### 4.4 SOCKS5 Handshake

For `socks5` proxies, the flow is:

1. **Connect** to SOCKS5 proxy host:port
2. **Send** greeting: `\x05\x01\x00` (no auth) or `\x05\x02\x00\x02` (username/password)
3. If username/password auth: send `\x01\x00\x00\x00<host_len><host>...<port>` after auth sub-negotiation
4. **Send** CONNECT command: `\x05\x01\x00\x03<host_len><host><port>`
5. **Read** response — expect `\x05\x00\x00\x03<host_len><host><port>` (success)
6. **Use** the socket for the HTTP request

## 5. Failover Behavior

| Scenario | Action |
| --- | --- |
| `ECONNREFUSED` to proxy | Failover to next proxy |
| `ECONNRESET` during fetch | Failover to next proxy |
| `ETIMEDOUT` | Failover to next proxy |
| HTTP 502 / 503 / 504 | Failover to next proxy (if retryable) |
| HTTP 408 | Failover to next proxy (if retryable) |
| HTTP 429 | Failover to next proxy (if retryable) |
| HTTP 401 / 407 from proxy | **Stop** — non-retryable, return error |
| All proxies exhausted | Return error (502 or last proxy's error) |
| No proxy pool resolved | Direct fetch (current behavior) |

## 6. API Surface

### 6.1 CRUD: Proxy Management

**New module**: `app/.server/outbound-proxy.ts`

| Function | Signature | Description |
| --- | --- | --- |
| `createProxy` | `(input: CreateProxyInput) => ProxyConfig` | Insert a new proxy |
| `listProxies` | `() => ProxyConfig[]` | List all proxies (active) |
| `getProxy` | `(id: number) => ProxyConfig \| null` | Get single proxy |
| `updateProxy` | `(id: number, input: UpdateProxyInput) => void` | Update proxy |
| `deleteProxy` | `(id: number) => void` | Delete proxy |
| `createPool` | `(input: CreatePoolInput) => ProxyPool` | Create proxy pool |
| `listPools` | `() => ProxyPool[]` | List all pools |
| `getPool` | `(id: number) => ProxyPool \| null` | Get single pool |
| `updatePool` | `(id: number, input: UpdatePoolInput) => void` | Update pool (replaces proxy_ids) |
| `deletePool` | `(id: number) => void` | Delete pool |
| `assignPool` | `(input: AssignPoolInput) => void` | Assign pool to provider or API key |
| `unassignPool` | `(targetType: string, targetId: string\|number) => void` | Remove assignment |
| `getPoolForProvider` | `(providerId: string) => ProxyPool \| null` | Resolve pool for a provider |
| `getPoolForApiKey` | `(apiKeyId: number) => ProxyPool \| null` | Resolve pool for an API key |
| `bulkImportProxies` | `(rows: BulkProxyRow[]) => { imported: number; errors: string[] }` | Bulk import |

### 6.2 Resolver: Egress Module

**New module**: `app/.server/proxy-resolver.ts`

| Function | Signature | Description |
| --- | --- | --- |
| `resolveProxyPool` | `(params) => ResolvedProxy[] \| null` | Resolve proxy chain for a request |
| `fetchUpstream` | `(url, options) => Promise<Response>` | Single egress point for all upstream fetches |
| `getProxyAssignments` | `() => ProxyAssignment[]` | List all assignments |
| `testProxyConnection` | `(proxy: ProxyConfig, testUrl: string) => Promise<{ ok: boolean; latencyMs: number }>` | Test a proxy |

### 6.3 Integration: Executor & Handler

| File | Change |
| --- | --- |
| `app/.server/executor.ts` | `ExecutorOptions` gains `proxyPoolId?`, `providerId?`; `attempt()` calls `fetchUpstream()` instead of `fetch()` |
| `app/.server/proxy-handler.ts` | Passes proxy context (from `clientKey` and selected provider) to executor |
| `app/.server/combo-runner.ts` | Passes proxy context through (if needed) |

### 6.4 UI Routes

| Route | Purpose |
| --- | --- |
| `app/routes/proxies.tsx` | Proxy list + status (tabbed: List, Bulk Import, Assignments) |
| `app/routes/proxies.$id.tsx` | Proxy detail/edit |
| `app/routes/proxies.create.tsx` | New proxy form |
| `app/routes/proxy-pools.tsx` | Pool management |
| `app/routes/proxy-pools.$id.tsx` | Pool detail/edit |

## 7. Testing Strategy

### 7.1 Unit Tests

New test files in `app/.server/`:

- `app/.server/proxy-resolver.test.ts`
  - `resolveProxyPool()` priority chain (API key → provider → direct)
  - Pool ordering by `last_used_at`
  - Round-robin rotation
  - Inactive pool/proxy filtering

- `app/.server/outbound-proxy.test.ts`
  - CRUD operations
  - Bulk import (text + JSON formats)
  - Pool assignment / unassignment
  - `last_used_at` updates

- `app/.server/proxy-tunnel.test.ts`
  - HTTP CONNECT handshake (mock socket)
  - SOCKS5 handshake (mock socket)
  - Failover selection logic
  - Auth failure non-retry

Tests follow the existing pattern:

```typescript
import { describe, it, expect } from "bun:test";
import "./test-env";  // sets DATABASE_URL to temp file
import { query } from "./db";
// ...
```

### 7.2 Integration Tests

- **Proxy passthrough**: Start a local HTTP CONNECT proxy (using `http-proxy` or a simple tunnel mock), verify `fetchUpstream()` sends requests through it.
- **Failover**: Configure a pool with one dead proxy and one alive proxy; verify the engine fails over.
- **Auth failure**: Configure a proxy with wrong credentials; verify no failover.
- **Direct fallback**: Remove all proxy assignments; verify direct fetch still works.

## 8. Security Considerations

- **Password encryption**: Proxy passwords are encrypted at rest using the same mechanism as `client_api_keys` (`password_enc` column).
- **Secret rotation**: Proxy passwords can be updated via `updateProxy()`.
- **Access control**: Proxy management routes are admin-only (same auth as all other routes).
- **No logging of credentials**: Proxy auth headers are never logged.
- **Tunnel isolation**: Each proxy tunnel is created per-request with a fresh socket; sockets are closed after use.

## 9. Backwards Compatibility

- Without any proxy records: **100% unchanged** behavior (direct fetch).
- `ProxyHandlerConfig` gains optional fields; existing callers are unaffected.
- `ExecutorOptions` gains optional fields; existing callers are unaffected.
- No changes to existing routes, schemas, or public API.

## 10. Implementation Phases

1. **Phase 1 — Schema & CRUD**: Create tables, implement `outbound-proxy.ts` CRUD functions.
2. **Phase 2 — Resolver**: Implement `proxy-resolver.ts` (`resolveProxyPool`, `fetchUpstream`, tunnel logic).
3. **Phase 3 — Integration**: Wire `executor.ts` and `proxy-handler.ts` to use `fetchUpstream()`.
4. **Phase 4 — UI**: Build `/proxies`, `/proxy-pools` routes with CRUD + bulk import + assignment.
5. **Phase 5 — Tests**: Unit + integration tests for all components.
6. **Phase 6 — Docs**: Update plan & design docs.

## 11. Open Questions

- Should proxy health checks (periodic) be implemented? (Deferred to Phase 5+)
- Should SOCKS5 be supported via a pure-JS implementation or the `socks` npm package? (Decision: pure-JS minimal to avoid new dependency)
- How to handle proxy pools with different types (mixed HTTP CONNECT + SOCKS5)? (Answer: round-robin across all, each establishes its own tunnel type)

---

## 12. Implementation Notes (2026-08-12)

Shipped per phases 1–6:

- **Schema**: `outbound_proxies`, `proxy_pools`, `proxy_pool_assignments` created in `app/.server/db.ts` (`initSchema`).
- **CRUD**: `app/.server/outbound-proxy.ts` — proxy/pool/assignment CRUD, `getPoolForProvider()`, `getPoolForApiKey()`, `bulkImportProxies()`. Proxy passwords encrypted at rest via `key-crypto` (`API_KEY_SECRET`); fall back to plaintext column storage when no secret is configured.
- **Resolver**: `app/.server/proxy-resolver.ts` — `resolveProxyPool()` (api key → provider → direct), `pickProxy()` round-robin by `last_used_at`, `fetchUpstream()` as the single egress point, `testProxyConnection()`. Tunneling via `node:net`/`node:tls` with zero new dependencies: HTTP CONNECT and SOCKS5 (RFC 1928) handshakes; raw HTTP/1.1 request/response with Content-Length and chunked body streaming.
- **Failover**: connection errors and retryable statuses (429/500/502/503/504) rotate within the resolved pool; 401/407 never fail over; exhausted pool → 502 `proxy_error`.
- **Integration**: `executor.ts` `attempt()` now calls `fetchUpstream()` with `apiKeyPoolId`/`providerPoolId`/`providerId`; `proxy-handler.ts` and `combo-runner.ts` resolve and pass pool context from the client key and the selected provider.
- **UI**: `/proxies` (List / Bulk Import / Assignments tabs), `/proxies/create`, `/proxies/:id` (edit + test connection), `/proxy-pools`, `/proxy-pools/:id`; sidebar entries added.
- **Tests**: `outbound-proxy.test.ts` (CRUD, assignments, bulk import) and `proxy-resolver.test.ts` (resolve priority, round-robin, direct fallback, CONNECT tunnel round-trip, chunked streaming, failover, 401 no-failover, all-dead → 502).
- **Deviations**: SOCKS5 handshake implemented but not integration-tested against a live SOCKS5 server; proxy health checks deferred (noted in Open Questions).
