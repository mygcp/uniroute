# Configuration

**Zero-config**: the app runs without any `.env` file (default password
`CHANGEME`, port 3000, SQLite at `./data/`). `.env.example` contains the full
template — everything below is optional unless you want to change it.

All configuration is done through environment variables (`.env` file).

## Core

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | Production server port (`bun run start`). |
| `BASE_URL` | `http://localhost:3000` | Gateway address written into harness configs and used by clients. |
| `PASSWORD` | `CHANGEME` | Dashboard login password (session cookie 24h, in-memory). |
| `DATABASE_URL` | `./data/uniroute.db` | SQLite file path. Schema and indexes are created automatically at boot. |

## Security & API keys

| Variable | Purpose |
| --- | --- |
| `API_KEY_SECRET` | Encryption key (any string) used to store secrets encrypted. Required for the *reveal/reuse* key feature in API Manager & AI Agents — without it keys are stored as hashes only. |
| `ALLOW_API_KEY_REVEAL` | `1` = allow decrypting stored keys. Can also be enabled from the web (*Reuse stored keys* toggle on the AI Agents page, stored in the `settings` table). |

## AI Agents

| Variable | Purpose |
| --- | --- |
| `UNIROUTE_AGENT_HOME` | Overrides `$HOME` when reading/writing harness configs and backup folder (used by tests; normally unset). |
| `UNIROUTE_MCP_TOKEN` | Optional bearer token for the MCP HTTP transport (`bun app/.server/mcp-server.ts --http`). |
| `UNIROUTE_MCP_PORT` | MCP HTTP port when `--http` is given without a value (default `3007`). |

## Compression tools

| Variable | Purpose |
| --- | --- |
| `UNIROUTE_TOOLS_DIR` | Where RTK and Caveman Engine binaries are downloaded (default `~/.uniroute/bin`). |
| `UNIROUTE_RTK_VERSION` / `UNIROUTE_CAVEMAN_VERSION` | Pin a release instead of the latest. |
| `UNIROUTE_RTK_DOWNLOAD_URL` / `UNIROUTE_CAVEMAN_DOWNLOAD_URL` | Download from a mirror. |

See [Compression](compression.md).

## Harness config backups

Every harness config write automatically creates a copy under
`~/.uniroute/backups/<agent>/`. Delete them from the AI Agents page when
needed.

## Production

```bash
bun run build
PORT=3000 PASSWORD=... DATABASE_URL=... bun run start
```

- Login sessions are in-memory: restarting the server ends all dashboard sessions.
- SQLite runs with `journal_mode=WAL` and `synchronous=NORMAL`.
