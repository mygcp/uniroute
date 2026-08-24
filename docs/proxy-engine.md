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

When a request is executed, proxy sources are tried in order:

```
1. client key pool      (assignment on a client API key)
2. account pool         (per upstream credential — singleton/single proxy)
3. provider assignment  (pool OR single proxy on the provider page)
4. global pool          (Proxies → Proxy Pools → Global)
5. direct               (no proxy)
```

Combination examples:

- A provider without keys can still get a provider-level assignment.
- A single client key can be pinned to one specific proxy.
- Distribute automatically splits a pool/list across all provider accounts
  round-robin (creating an `auto · …` pool per account).

## Health & logging

Every use/test updates `success_count`, `fail_count`, `last_ok_at`,
`last_latency_ms`, `last_error`. These drive the Health badge, the Error
filter, and the *Delete error* button.

## Operational safety

- All config/log writes are atomic (tmp + rename).
- The Proxies page only performs confirmed actions; bulk deletes always go
  through a confirmation dialog.
