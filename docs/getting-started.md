# Getting Started

## 1. Install

```bash
bun install
```

Runtime: **Bun** for production. The dev server also runs on Node via Vite,
but some modules (e.g. SQLite) pick the Bun driver when available.

## 2. Configuration

Plug and play: the app runs without a `.env` file and logs in with the
default password `CHANGEME` (the server logs a warning so you know).
Changing it is still recommended:

Copy `.env.example` to `.env`:

```env
PORT=3000
BASE_URL=http://localhost:3000
PASSWORD=CHANGEME
DATABASE_URL=./data/uniroute.db
```

- `PASSWORD` — dashboard login password (change it in production).
- `BASE_URL` — gateway address used by agents/clients.
- `DATABASE_URL` — SQLite file path (created automatically along with the schema).

Full list: [configuration.md](configuration.md).

## 3. Run

```bash
bun run dev      # development (http://localhost:5173)
# or production:
bun run build && bun run start   # http://localhost:3000
```

Open the dashboard and log in with `PASSWORD`.

## 4. Add a provider and API key

1. **Providers** page → pick a template or create one manually (id + base URL).
2. Open the provider detail → **API Keys** tab → add an upstream key.
3. **Models** tab → **Sync models** to pull the catalog from upstream,
   then mark one model as *primary*.

An active provider without keys can still be selected for routing, but
requests to authenticated providers (`bearer`/`apikey`) will fail — add at
least one active key for such providers.

## 5. First request

From any OpenAI-compatible client:

```bash
curl http://localhost:3000/v1/chat/completions \
  -H "Authorization: Bearer <CLIENT_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"model":"<model-name>","messages":[{"role":"user","content":"hi"}]}'
```

Client API keys are created in **API Manager** (not upstream keys).

## 6. Monitor

- **Request Logs** (`/logs`) — realtime, newest first, PROXY/DIRECT badge;
  transport/proxy/endpoint/TLS appear in the detail panel.
- **Usage** (`/analytics/usage`) — input/output/cache tokens plus cost estimates.

Next steps: set up outbound proxies in [Proxy Engine](proxy-engine.md),
add routing rules, then connect your coding agent via [MCP](ai-agents.md).
