# Getting Started

## 1. Install

Pick one:

**Binary (recommended, Linux/macOS):**

```bash
curl -fsSL https://raw.githubusercontent.com/mygcp/uniroute/main/install.sh | sh
uni doctor
```

**From source (needs [Bun](https://bun.sh)):**

```bash
bun install
bun run build && bun run start   # production on PORT (default 3000)
# or: bun run dev                # development (http://localhost:5173)
# or via CLI source: bun cli/uni.ts start --daemon
```

**Light mode (no binary — runs the repo checkout via bun/node):**

```bash
git clone https://github.com/mygcp/uniroute uniroute
cd uniroute && bun install && bun run build
curl -fsSL https://raw.githubusercontent.com/mygcp/uniroute/main/install.sh | sh -s -- --light
```

**Termux / Android:** the standalone `uni-*` binaries are built with
`bun build --compile` and need glibc, so they do NOT run directly on Termux
(Bionic libc — `cannot execute: required file not found` means the ELF
interpreter is missing, not a corrupt download). The installer detects
Termux and refuses; use (a) `pkg install proot-distro &&
proot-distro install ubuntu`, then run the binary installer inside Ubuntu
(no root needed), (b) chroot into a distro on a ROOTED device, then install
inside, or (c) light mode from source with node (`pkg install nodejs git`, clone,
`npm ci`, `npm run build`, installer with `--light`). See README.

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
uni start --daemon --port 3000   # binary or light wrapper
uni status && uni logs -f
# from source without installing: bun run build && bun run start
```

Open the dashboard (`http://localhost:3000`, or `:5173` for `bun run dev`)
and log in with `PASSWORD`.

## 4. Add a provider and API key

1. **Providers** page → pick a template or create one manually (id + base URL).
2. Open the provider detail → **API Keys** tab → add an upstream key.
3. **Models** tab → **Sync models** to pull the catalog from upstream,
   then mark one model as *primary*. You can also set a custom display
   name per model (surfaced via `/v1/models`).

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
Keys support quotas, budgets, expiry, and rotation.

Optional: assign an outbound proxy pool per client key, account, combo,
or provider ([Proxy Engine](proxy-engine.md)).

## 6. Monitor

- **Request Logs** (`/logs`) — realtime, newest first, PROXY/DIRECT badge;
  transport/proxy/endpoint/TLS appear in the detail panel.
- **Usage** (`/analytics/usage`) — input/output/cache tokens plus cost estimates.

Next steps: set up outbound proxies in [Proxy Engine](proxy-engine.md),
add routing rules, then connect your coding agent via [MCP](ai-agents.md).
