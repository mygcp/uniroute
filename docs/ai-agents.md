# AI Agents & MCP

The **Tools → AI Agents** page connects coding agent CLIs to the gateway.

## 1. Harness config (chat)

Three cards — Codex CLI, Claude Code, OpenCode:

- Pick a **pool OR single proxy** + default model, then **Apply to disk**.
- Before overwriting, the old config is backed up automatically to
  `~/.uniroute/backups/<agent>/` — View/Restore/Delete at any time.
- JSON is *merged* (other settings preserved); files that fail to parse are
  never overwritten; writes are atomic with mode 0600.
- The **Remove UniRoute config** button cleans UniRoute entries and restores
  defaults when nothing else remains.

## 2. Stored API keys

The **Reuse stored keys** toggle lets forms reuse keys from API Manager
(selected by name). A key can only be recovered if it was stored encrypted
(`API_KEY_SECRET` set when the key was created/rotated).

## 3. MCP server

UniRoute exposes itself as an MCP server so agents can manage the gateway
through natural language.

### Transport

| Mode | Command | Notes |
| --- | --- | --- |
| stdio | `bun mcp-server.ts` | Agent spawns this process |
| HTTP | `bun mcp-server.ts --http 3007` | `POST /mcp`, optional `Authorization: Bearer $UNIROUTE_MCP_TOKEN` |

### Quick registration

```bash
# Claude Code
claude mcp add uniroute -- bun /path/to/uniroute/mcp-server.ts
```

```jsonc
// OpenCode (opencode.json)
{ "mcp": { "servers": { "uniroute": {
  "type": "local",
  "command": ["bun", "/path/to/uniroute/mcp-server.ts"] } } } }
```

```toml
# Codex CLI (config.toml)
[mcp_servers.uniroute]
command = "bun"
args = ["/path/to/uniroute/mcp-server.ts"]
```

Or press **Register** on the MCP Server card (writes the config with an
automatic backup, same as harness config).

### Tool list (40)

**Monitoring** — `gateway_stats`, `usage_summary`, `recent_requests`,
`recent_proxy_logs`, `recent_webhooks`, `compression_settings`

**Providers & models** — `list_providers`, `toggle_provider`,
`test_provider_connection`, `list_models`, `add_model`, `remove_model`,
`set_primary_model`, `sync_models`, `create_routing_rule`,
`list_routing_rules`, `delete_routing_rule`, `allow_model`, `deny_model`,
`check_model_allowed`

**Proxy engine** — `list_proxies`, `add_proxy`, `toggle_proxy`,
`delete_proxy`, `update_pool` (strategy/members), `delete_pool`,
`assign_provider_proxy`, `unassign_provider_proxy`, `assign_key_proxy`,
`unassign_key_proxy`

**Client keys** — `list_client_keys`, `create_client_key` (plaintext shown once),
`toggle_client_key`, `get_client_key`, `set_key_budget`,
`rotate_client_key`

**Other** — `chat_completion` (test a model through full routing),
`set_compression`, `test_compression`, `clear_logs`
