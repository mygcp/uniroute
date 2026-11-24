# Tunneling

The **Tunneling** page (`/tunnels`) exposes your local UniRoute gateway over a
public HTTPS URL or a custom domain without configuring nginx or firewall port
forwarding manually.

Four external tunnel clients are supported and **not bundled** with UniRoute:

| Provider | Source | Quick HTTPS | Custom Domain | Self-Hosted |
| --- | --- | --- | --- | --- |
| `cloudflared` | [cloudflare/cloudflared](https://github.com/cloudflare/cloudflared) | Yes (`*.trycloudflare.com`) | Yes (Zero Trust token) | No |
| `ngrok` | [ngrok.com](https://ngrok.com) | Yes | Yes (`--url`) | No |
| `frpc` | [fatedier/frp](https://github.com/fatedier/frp) | No | Yes (`customDomains` / `subdomain`) | Yes (`frps` on VPS) |
| `bore` | [ekzhang/bore](https://github.com/ekzhang/bore) | Yes (`bore.pub`) | No | Yes (`bore server`) |

## External binaries

Binaries are downloaded separately from the **External Tunnel Binaries** cards
into `~/.uniroute/bin/` (override with `UNIROUTE_TOOLS_DIR`):

- GitHub-hosted releases (`cloudflared`, `frpc`, `bore`) resolve tags via
  `/releases/latest` redirects and `/releases.atom` without `api.github.com` or
  OAuth, avoiding API rate limits on VPS servers.
- `ngrok` downloads directly from the official Equinox CDN.
- `frpc` downloads are verified against `frp_sha256_checksums.txt` before
  installing.
- Binary lookup priority: custom binary path override -> `~/.uniroute/bin/` ->
  system `PATH`.

## Provider setup & custom domains

### Cloudflare Tunnel (`cloudflared`)

- **Quick Tunnel**: no token or account required. Produces a temporary
  `https://<random>.trycloudflare.com` URL.
- **Named Tunnel (Custom Domain)**: create a tunnel in Cloudflare Zero Trust,
  route your domain (for example `ai.yourdomain.com`) to `http://127.0.0.1:3000`,
  set **Cloudflare Tunnel Mode** to `Named Tunnel`, paste the token, and enter
  `ai.yourdomain.com` in **Custom Domain**.

### ngrok

- Paste your **ngrok Authtoken** from `dashboard.ngrok.com`.
- Set **Custom Domain** to bind a static ngrok domain or a custom branded
  domain (`--url=<domain>`).

### FRP Client (`frpc`)

- Ideal when you control your own VPS running `frps`.
- Enter **FRP Server Address** (and port, default `7000`), **Custom Domain** or
  **Subdomain**, and optional shared **FRP Auth Token**.
- UniRoute writes `~/.uniroute/tunnels/frpc.toml` with mode `0600` at launch.

### bore

- Fast TCP forwarding to `bore.pub` or a self-hosted `bore` server. Set
  **Remote Port** (`0` for random) and optional **Bore Secret**.

## Auto-tunneling

- **Auto-start on boot**: when enabled, UniRoute automatically starts the
  configured tunnel when the server boots (`server.ts` / `uni start`).
- **Auto-reconnect**: if the tunnel process exits unexpectedly, UniRoute
  restarts it automatically with exponential backoff (2s, 4s, 8s, 15s, 30s).

## Integration with MCP & AI Agents

When a tunnel is active and `BASE_URL` is not set, `/mcp` and `/agents`
automatically use the active public tunnel URL for remote MCP endpoints and
agent configs.

Three MCP tools control tunneling remotely: `tunnel_status`, `start_tunnel`, and
`stop_tunnel`.

## Environment overrides

| Variable | Purpose |
| --- | --- |
| `UNIROUTE_TOOLS_DIR` | Directory for downloaded binaries (default `~/.uniroute/bin`) |
| `UNIROUTE_TUNNELS_DIR` | Directory for generated `frpc.toml` (default `~/.uniroute/tunnels`) |
| `UNIROUTE_CLOUDFLARED_VERSION`, `UNIROUTE_FRPC_VERSION`, `UNIROUTE_BORE_VERSION` | Pin a release tag instead of latest |
| `UNIROUTE_CLOUDFLARED_DOWNLOAD_URL`, `UNIROUTE_NGROK_DOWNLOAD_URL`, `UNIROUTE_FRPC_DOWNLOAD_URL`, `UNIROUTE_BORE_DOWNLOAD_URL` | Download from a custom mirror URL |
