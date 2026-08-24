# UniRoute

UniRoute is a self-hosted AI gateway with a web dashboard. It puts multiple
LLM providers behind a single OpenAI-compatible endpoint and adds routing,
client API keys, outbound proxies, request logging, usage analytics, and an
MCP server that lets coding agents manage the gateway through tool calls.

## Features

- OpenAI-compatible API: `/v1/chat/completions`, `/v1/messages`, `/v1/responses`, `/v1/models` — requests are translated between OpenAI, Anthropic, and Gemini formats automatically.
- Routing rules for model rewrites, provider fallback chains, and a load-balancing strategy per model.
- Client API keys with quotas, budgets, expiry, IP rules, auto-block, and rotation.
- Outbound proxy engine: HTTP CONNECT and SOCKS5 pools with round-robin, priority, or random rotation, health tracking, and egress assignment per client key, account, or provider.
- Realtime request logs (status, duration, tokens, transport, proxy, endpoint, upstream TLS) and proxy operation logs.
- Usage analytics split by input/output/cached tokens with cost estimates.
- Per-provider chat playground with streaming, markdown rendering, and sessions saved to SQLite.
- Media passthrough: `/v1/images/generations`, `/v1/audio/speech`, `/v1/audio/transcriptions`; vision and audio inputs are translated per provider.
- MCP server exposing 40 tools, registrable from the dashboard into Claude Code, Codex, and OpenCode.

## Quick start

Requires [Bun](https://bun.sh).

```bash
bun install
bun run dev
```

Open http://localhost:5173 and log in. The app works without configuration;
the default password is `CHANGEME`. Copy `.env.example` to `.env` to change
it. See [docs/configuration.md](docs/configuration.md).

For production:

```bash
bun run build && bun run start   # serves on PORT (default 3000)
```

## Documentation

| Document | Contents |
| --- | --- |
| [Getting Started](docs/getting-started.md) | Install, log in, first provider, first request |
| [Configuration](docs/configuration.md) | Environment variables |
| [Architecture](docs/architecture.md) | Stack, request flow, data model |
| [Providers](docs/providers.md) | Providers, API keys, models, vision and audio |
| [Chat Playground](docs/chat-playground.md) | Multi-turn chat, saved sessions |
| [Proxy Engine](docs/proxy-engine.md) | Proxies, pools, rotation strategies, egress priority |
| [Monitoring](docs/monitoring.md) | Request/proxy logs, usage analytics |
| [API Reference](docs/api-reference.md) | `/v1/*` endpoints and error formats |
| [AI Agents & MCP](docs/ai-agents.md) | Harness config, MCP server, tool list |
| [Performance](docs/performance.md) | Measured baseline, hot-path invariants, benchmarks |
| [Development](docs/development.md) | Scripts, testing, code conventions |

## Scripts

```bash
bun run dev         # dev server on :5173
bun run build       # production build
bun run start       # serve the build (Bun)
bun run test        # unit tests
bun run typecheck   # typegen + tsc
```
