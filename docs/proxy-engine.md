# Proxy Engine

All upstream requests can egress through HTTP CONNECT / SOCKS5 outbound
proxies, with health tracking and rotation.

## Proxies

Managed on the **Proxies → List** page: add manually, bulk import, or sync a
public free list. Each proxy has a health state:

- `Healthy · Xms` — last test succeeded
- `Error` — last test failed (hover for the error message)
- `Untested` — never used/tested

List toolbar: search, status/health filters, **Test all** & **Test selected**
with a custom URL (default `https://api.openai.com/v1/models`), bulk
selection (activate/deactivate/delete), and one-click **Delete error**.

## Pools & rotation strategies

A pool groups proxies for auto-management. Each pool has a **strategy**:

| Strategy | Behavior |
| --- | --- |
| `round_robin` | Even rotation — least-recently-used goes first |
| `priority` | List order; the first entry is primary |
| `random` | Random per request |

Related MCP tools: see [AI Agents & MCP](ai-agents.md).

## Egress priority

When a request is executed, proxy sources are tried in order
(`resolveProxyPool` in `app/.server/proxy-resolver.ts`):

```
1. client key pool      (assignment on a client API key)
2. account pool         (per upstream credential — singleton/single proxy)
3. combo pool           (per-combo proxy pool, stored in combo config)
4. provider assignment  (pool OR single proxy on the provider page)
5. global pool          (Proxies → Proxy Pools → Global)
6. direct               (no proxy)
```

Only the first matching level is used: a client-key or account pool wins
over the combo pool, and the combo pool wins over the provider and global
pools. A deleted, deactivated, or empty pool is skipped as if unset.

## Per-combo proxy pool

Each combo can pin a proxy pool: set **Proxy pool (optional)** in the add /
edit form on the **Combo** page (`proxy_pool_id` in the combo config).
Combos with a pool show a `proxy: <pool name>` badge in the combo list.
The pool is passed as `comboPoolId` through `combo-runner.ts` and applies
to every step of the combo run, but only when no client-key or account
pool is set.

Combination examples:

- A provider without keys can still get a provider-level assignment.
- A single client key can be pinned to one specific proxy.
- Distribute automatically splits a pool/list across all provider accounts
  round-robin (creating an `auto · …` pool per account).

## Health & logging

Every use/test updates `success_count`, `fail_count`, `last_ok_at`,
`last_latency_ms`, `last_error`. These drive the Health badge, the Error
filter, and the *Delete error* button.

## Slow-proxy protections

- Tunnel establishment (TCP + CONNECT/SOCKS handshake) is capped at **8s**;
  exceeding it destroys the socket and triggers failover to the next proxy.
- Proxies whose last latency exceeded **5s** are demoted to the end of the
  rotation regardless of pool strategy — healthy proxies always go first
  (locked by a unit test in `proxy-resolver.test.ts`).
- If every proxy in the assigned chain fails, the request returns 502 with
  the last proxy error; it does **not** silently fall back to direct egress.
  Deactivate dead proxies (or unassign the pool) to return to direct.

## Operational safety

- All config/log writes are atomic (tmp + rename).
- The Proxies page only performs confirmed actions; bulk deletes always go
  through a confirmation dialog.
