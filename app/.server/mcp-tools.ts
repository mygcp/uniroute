import { query } from "./db";
import {
  listProxies,
  createProxy,
  updateProxy,
  deleteProxy,
  listPools,
  createPool,
  updatePool,
  deletePool,
  assignPool,
  unassignPool,
  getPoolForProvider,
} from "./outbound-proxy";
import { testProviderConnection } from "./provider-test";
import { getUsageData } from "./usage";
import { getStats } from "./stats";
import { handleProxy } from "./proxy-handler";
import { createSession, SESSION_COOKIE } from "./auth";
import { parse } from "./translate/from-openai-chat";

// Sesi admin sekali-per-proses untuk tool yang memanggil pipeline internal:
// MCP berjalan di dalam gateway, jadi dianggap tepercaya — require_api_key
// tidak boleh memblokirnya. api_key eksplisit dari agent tetap diprioritaskan.
let mcpAdminSession: string | null = null;
function mcpAdminCookie(): string {
	mcpAdminSession ??= createSession();
	return `${SESSION_COOKIE}=${mcpAdminSession}`;
}
import {
  createClientKey,
  listClientKeys,
  setClientKeyActive,
} from "./client-key";
import {
  addApiKey,
  deleteApiKeyById,
  listApiKeys,
  setApiKeyActive,
  setRoutingKey,
} from "./credential";
import {
  getSettings as getCompressionSettings,
  isEnabled as compressionEnabled,
  testCompression,
} from "./compressor";
import { checkAllowlist } from "./guard";
import { evaluateRules } from "./rules";
import { reload } from "./registry";
import { rotateKey } from "./key-ops";
import {
  syncProviderModels,
  upsertProviderModel,
} from "./provider-models";
import {
  getPublicTunnelSettings,
  getTunnelSettings,
  getTunnelStatus,
  startTunnel,
  stopTunnel,
} from "./tunnel";
import { getAllTunnelToolsStatus } from "./tunnel-tools";
import { VALID_TUNNEL_PROVIDERS, type TunnelProviderId } from "../lib/tunnel-options";

/**
 * MCP tools UniRoute — dipakai mcp-server.ts (stdio). Semua akses langsung
 * ke SQLite yang sama dengan gateway, jadi tidak perlu HTTP.
 */

export type ToolDef = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type JsonValue = Record<string, unknown>;

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) ? v : Number(v ?? 0) || 0;

export const TOOLS: ToolDef[] = [
  {
    name: "gateway_stats",
    description:
      "UniRoute gateway stats: total requests, success rate, avg latency, active providers.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_providers",
    description: "List all upstream AI providers with status & assigned proxy pool.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "toggle_provider",
    description: "Enable or disable an upstream provider.",
    inputSchema: {
      type: "object",
      properties: {
        provider_id: { type: "string", description: "Provider id, e.g. 'openai'" },
        active: { type: "boolean" },
      },
      required: ["provider_id", "active"],
    },
  },
  {
    name: "test_provider_connection",
    description: "Test connectivity of one provider (hits its /models endpoint).",
    inputSchema: {
      type: "object",
      properties: { provider_id: { type: "string" } },
      required: ["provider_id"],
    },
  },
  {
    name: "get_provider",
    description:
      "Get detailed config of one provider (base_url, auth, weight, status, proxy pool, key/model counts).",
    inputSchema: {
      type: "object",
      properties: { provider_id: { type: "string" } },
      required: ["provider_id"],
    },
  },
  {
    name: "create_provider",
    description:
      "Create a new upstream provider. id must be unique slug (e.g. 'my-openai'). base_url is required.",
    inputSchema: {
      type: "object",
      properties: {
        provider_id: { type: "string", description: "Unique slug, e.g. 'my-openai'" },
        name: { type: "string" },
        base_url: { type: "string", description: "Upstream base URL, e.g. https://api.openai.com" },
        auth_type: { type: "string", enum: ["bearer", "apikey", "none"], default: "bearer" },
        is_active: { type: "boolean", description: "Enable immediately (default false)" },
        weight: { type: "integer", description: "Load-balancing weight (default 1)" },
        priority: { type: "integer", description: "Priority (default 0)" },
      },
      required: ["provider_id", "name", "base_url"],
    },
  },
  {
    name: "update_provider",
    description: "Update an existing provider (name, base_url, auth_type, weight, priority, is_active).",
    inputSchema: {
      type: "object",
      properties: {
        provider_id: { type: "string" },
        name: { type: "string" },
        base_url: { type: "string" },
        auth_type: { type: "string", enum: ["bearer", "apikey", "none"] },
        is_active: { type: "boolean" },
        weight: { type: "integer" },
        priority: { type: "integer" },
      },
      required: ["provider_id"],
    },
  },
  {
    name: "delete_provider",
    description: "Permanently delete a provider and its keys/models/assignments. Destructive!",
    inputSchema: {
      type: "object",
      properties: { provider_id: { type: "string" } },
      required: ["provider_id"],
    },
  },
  {
    name: "list_provider_keys",
    description: "List API keys (accounts) for a provider. Secrets are masked.",
    inputSchema: {
      type: "object",
      properties: { provider_id: { type: "string" } },
      required: ["provider_id"],
    },
  },
  {
    name: "add_provider_key",
    description: "Add an upstream API key to a provider (multi-account). Optionally set as routing key.",
    inputSchema: {
      type: "object",
      properties: {
        provider_id: { type: "string" },
        api_key: { type: "string", description: "Upstream API key / token" },
        label: { type: "string", description: "Optional label, e.g. 'account-1'" },
        is_routing: { type: "boolean", description: "Make this the routing key (default true if first key)" },
      },
      required: ["provider_id", "api_key"],
    },
  },
  {
    name: "delete_provider_key",
    description: "Permanently delete a provider API key by credential id.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "integer", description: "provider_credentials.id" } },
      required: ["id"],
    },
  },
  {
    name: "set_provider_routing_key",
    description: "Set which provider API key is the routing credential.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "integer", description: "provider_credentials.id" } },
      required: ["id"],
    },
  },
  {
    name: "toggle_provider_key",
    description: "Enable/disable a provider API key without deleting it.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "integer" },
        active: { type: "boolean" },
      },
      required: ["id", "active"],
    },
  },
  {
    name: "list_proxies",
    description: "List outbound proxies with health info.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "add_proxy",
    description: "Add an outbound proxy to the rotation list.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        type: { type: "string", enum: ["http-connect", "socks5"] },
        host: { type: "string" },
        port: { type: "integer" },
        username: { type: "string" },
        password: { type: "string" },
      },
      required: ["name", "type", "host", "port"],
    },
  },
  {
    name: "delete_proxy",
    description: "Permanently delete an outbound proxy by id.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "integer" } },
      required: ["id"],
    },
  },
  {
    name: "assign_provider_proxy",
    description:
      "Attach an existing proxy pool OR a single proxy (proxy_id) to a provider so every request to it egresses through it.",
    inputSchema: {
      type: "object",
      properties: {
        provider_id: { type: "string" },
        pool_id: { type: "integer", description: "Existing pool id" },
        proxy_id: {
          type: "integer",
          description: "Single proxy id (wrapped into an auto singleton pool)",
        },
      },
      required: ["provider_id"],
    },
  },
  {
    name: "recent_requests",
    description: "Recent requests through the gateway (newest first).",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "integer", default: 10 } },
    },
  },
  {
    name: "recent_proxy_logs",
    description: "Recent operational proxy/egress logs (newest first).",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", default: 10 },
        level: { type: "string", enum: ["info", "warn", "error", "debug"] },
      },
    },
  },
  {
    name: "usage_summary",
    description:
      "Token/cost usage summary for a range: total, input, output, cache tokens, cost, requests.",
    inputSchema: {
      type: "object",
      properties: {
        range: {
          type: "string",
          enum: ["day", "week", "month", "year", "all"],
          default: "week",
        },
      },
    },
  },
  {
    name: "chat_completion",
    description:
      "Send one chat completion through the gateway (full routing/pool/logging). Non-streaming. Returns the assistant message + usage.",
    inputSchema: {
      type: "object",
      properties: {
        model: { type: "string" },
        prompt: { type: "string" },
        system: { type: "string" },
        api_key: {
          type: "string",
          description: "Optional client API key if gateway requires one",
        },
      },
      required: ["model", "prompt"],
    },
  },
  {
    name: "list_models",
    description: "List active models of a provider.",
    inputSchema: {
      type: "object",
      properties: { provider_id: { type: "string" } },
      required: ["provider_id"],
    },
  },
  {
    name: "toggle_proxy",
    description: "Enable/disable an outbound proxy without deleting it.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "integer" },
        active: { type: "boolean" },
      },
      required: ["id", "active"],
    },
  },
  {
    name: "update_pool",
    description:
      "Update a proxy pool: rename, set rotation strategy, replace its proxies, enable/disable.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "integer" },
        name: { type: "string" },
        strategy: { type: "string", enum: ["round_robin", "priority", "random"] },
        proxy_ids: { type: "array", items: { type: "integer" } },
        is_active: { type: "boolean" },
      },
      required: ["id"],
    },
  },
  {
    name: "delete_pool",
    description: "Delete a proxy pool and its assignments.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "integer" } },
      required: ["id"],
    },
  },
  {
    name: "unassign_provider_proxy",
    description: "Remove the provider-level proxy assignment (back to direct/global).",
    inputSchema: {
      type: "object",
      properties: { provider_id: { type: "string" } },
      required: ["provider_id"],
    },
  },
  {
    name: "list_client_keys",
    description: "List client API keys (names only — secrets are never returned).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "create_client_key",
    description:
      "Create a new client API key. The plaintext key is returned ONCE here.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string" },
        budget_usd_monthly: { type: "number" },
      },
      required: ["name"],
    },
  },
  {
    name: "toggle_client_key",
    description: "Activate or deactivate a client API key.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "integer" },
        active: { type: "boolean" },
      },
      required: ["id", "active"],
    },
  },
  {
    name: "compression_settings",
    description: "Get current prompt-compression settings (rtk / caveman).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "set_compression",
    description: "Enable/disable rtk & caveman prompt compression.",
    inputSchema: {
      type: "object",
      properties: { rtk: { type: "boolean" }, caveman: { type: "boolean" } },
      required: ["rtk", "caveman"],
    },
  },
  {
    name: "clear_logs",
    description:
      "Permanently clear stored logs. scope=request|proxy|all. Destructive!",
    inputSchema: {
      type: "object",
      properties: { scope: { type: "string", enum: ["request", "proxy", "all"] } },
      required: ["scope"],
    },
  },
  {
    name: "list_routing_rules",
    description: "List routing rules (model rewrite / provider fallback chains).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "create_routing_rule",
    description:
      "Create a routing rule: rewrite a model name, or fall back to another provider when it fails.",
    inputSchema: {
      type: "object",
      properties: {
        source_model: { type: "string" },
        action: { type: "string", enum: ["rewrite", "fallback"] },
        target_model: { type: "string" },
        target_provider_id: { type: "string" },
        priority: { type: "integer" },
      },
      required: ["source_model", "action"],
    },
  },
  {
    name: "delete_routing_rule",
    description: "Delete a routing rule by id.",
    inputSchema: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] },
  },
  {
    name: "allow_model",
    description: "Allow a model through the guard allowlist.",
    inputSchema: {
      type: "object",
      properties: { model_name: { type: "string" } },
      required: ["model_name"],
    },
  },
  {
    name: "deny_model",
    description: "Deny a model through the guard allowlist.",
    inputSchema: {
      type: "object",
      properties: { model_name: { type: "string" }, reason: { type: "string" } },
      required: ["model_name"],
    },
  },
  {
    name: "check_model_allowed",
    description: "Check whether a model currently passes the allow/deny list.",
    inputSchema: {
      type: "object",
      properties: { model_name: { type: "string" } },
      required: ["model_name"],
    },
  },
  {
    name: "add_model",
    description: "Register a model under a provider (optionally as primary).",
    inputSchema: {
      type: "object",
      properties: {
        provider_id: { type: "string" },
        model_name: { type: "string" },
        context_length: { type: "integer" },
        primary: { type: "boolean" },
      },
      required: ["provider_id", "model_name"],
    },
  },
  {
    name: "remove_model",
    description: "Deactivate (soft-remove) a model from a provider.",
    inputSchema: {
      type: "object",
      properties: {
        provider_id: { type: "string" },
        model_name: { type: "string" },
      },
      required: ["provider_id", "model_name"],
    },
  },
  {
    name: "set_primary_model",
    description: "Set the primary (default) model of a provider.",
    inputSchema: {
      type: "object",
      properties: {
        provider_id: { type: "string" },
        model_name: { type: "string" },
      },
      required: ["provider_id", "model_name"],
    },
  },
  {
    name: "sync_models",
    description: "Pull the provider's /models catalog and upsert locally.",
    inputSchema: {
      type: "object",
      properties: { provider_id: { type: "string" } },
      required: ["provider_id"],
    },
  },
  {
    name: "get_client_key",
    description: "Full config of one client API key (no secrets).",
    inputSchema: {
      type: "object",
      properties: { id: { type: "integer" } },
      required: ["id"],
    },
  },
  {
    name: "set_key_budget",
    description: "Set monthly budget USD for a client API key. 0 = unlimited.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "integer" }, monthly_budget_usd: { type: "number" } },
      required: ["id", "monthly_budget_usd"],
    },
  },
  {
    name: "rotate_client_key",
    description:
      "Rotate a client API key — old stops working, new plaintext returned once.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "integer" } },
      required: ["id"],
    },
  },
  {
    name: "assign_key_proxy",
    description:
      "Give ONE client key its own egress: an existing pool or a single proxy id.",
    inputSchema: {
      type: "object",
      properties: {
        key_id: { type: "integer" },
        pool_id: { type: "integer" },
        proxy_id: { type: "integer" },
      },
      required: ["key_id"],
    },
  },
  {
    name: "unassign_key_proxy",
    description: "Remove the per-client-key proxy assignment.",
    inputSchema: {
      type: "object",
      properties: { key_id: { type: "integer" } },
      required: ["key_id"],
    },
  },
  {
    name: "test_compression",
    description: "Run rtk/caveman compressor against a sample prompt.",
    inputSchema: {
      type: "object",
      properties: { sample: { type: "string" } },
    },
  },
  {
    name: "recent_webhooks",
    description: "Recent webhook delivery attempts and status.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "integer" } },
    },
  },
  {
    name: "tunnel_status",
    description:
      "Get live tunnel runtime status, public URL, non-secret settings, and external binary availability.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "start_tunnel",
    description:
      "Start the configured public tunnel (cloudflared, ngrok, frpc, or bore).",
    inputSchema: {
      type: "object",
      properties: {
        provider: {
          type: "string",
          enum: ["cloudflared", "ngrok", "frpc", "bore"],
          description: "Optional provider override for this run.",
        },
      },
    },
  },
  {
    name: "stop_tunnel",
    description: "Stop the currently running public tunnel.",
    inputSchema: { type: "object", properties: {} },
  },
];

type ToolResult = unknown;
type ToolHandler = (args: JsonValue) => ToolResult | Promise<ToolResult>;

function providerRow(p: Record<string, unknown>): JsonValue {
  return p;
}

const HANDLERS: Record<string, ToolHandler> = {
  gateway_stats() {
    return getStats() as unknown as JsonValue;
  },

  list_providers() {
    const rows = query(
      `SELECT id, name, base_url, auth_type, is_active FROM providers ORDER BY is_active DESC, id`,
    ).all() as Array<Record<string, unknown>>;
    return rows.map((p) => {
      const pool = getPoolForProvider(String(p.id));
      return {
        ...providerRow(p),
        proxy_pool: pool
          ? { id: pool.id, name: pool.name, proxies: pool.proxy_ids.length }
          : null,
      };
    });
  },

  toggle_provider(args) {
    const id = str(args.provider_id);
    const active = args.active === true || args.active === "true" ? 1 : 0;
    const res = query(
      "UPDATE providers SET is_active = ? WHERE id = ?",
    ).run(active, id) as { changes?: number | bigint };
    reload(); // registry cache harus ikut berubah
    return { ok: Number(res.changes ?? 0) > 0, provider_id: id, active: !!active };
  },

  async test_provider_connection(args) {
    const r = await testProviderConnection(str(args.provider_id));
    return r as unknown as JsonValue;
  },

  get_provider(args) {
    const id = str(args.provider_id);
    if (!id) return { ok: false, error: "provider_id is required" };
    const row = query(
      "SELECT id, name, base_url, auth_type, is_active, weight, priority, current_connections, last_used_at, created_at FROM providers WHERE id = ?",
    ).get(id) as Record<string, unknown> | undefined;
    if (!row) return { ok: false, error: "provider not found" };
    const pool = getPoolForProvider(id);
    const keyCount = (
      query("SELECT COUNT(*) as c FROM provider_credentials WHERE provider_id = ?").get(id) as
        | { c: number }
        | undefined
    )?.c ?? 0;
    const activeKeyCount = (
      query(
        "SELECT COUNT(*) as c FROM provider_credentials WHERE provider_id = ? AND is_active = 1",
      ).get(id) as { c: number } | undefined
    )?.c ?? 0;
    const modelCount = (
      query("SELECT COUNT(*) as c FROM models WHERE provider_id = ? AND is_active = 1").get(id) as
        | { c: number }
        | undefined
    )?.c ?? 0;
    return {
      ...providerRow(row),
      proxy_pool: pool ? { id: pool.id, name: pool.name, proxies: pool.proxy_ids.length } : null,
      key_count: Number(keyCount),
      active_key_count: Number(activeKeyCount),
      model_count: Number(modelCount),
    };
  },

  create_provider(args) {
    const id = str(args.provider_id) || str(args.id);
    const name = str(args.name);
    const baseUrl = str(args.base_url) || str(args.baseUrl);
    if (!id || !name || !baseUrl) {
      return { ok: false, error: "provider_id, name and base_url are required" };
    }
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id)) {
      return { ok: false, error: "provider_id must be slug (alphanumeric, dot, dash, underscore)" };
    }
    try {
      new URL(baseUrl);
    } catch {
      return { ok: false, error: "base_url must be a valid URL" };
    }
    const exists = query("SELECT id FROM providers WHERE id = ?").get(id) as { id: string } | undefined;
    if (exists) return { ok: false, error: `provider '${id}' already exists` };
    const authType = ["bearer", "apikey", "none"].includes(str(args.auth_type))
      ? str(args.auth_type)
      : "bearer";
    const weight = args.weight != null ? Math.max(1, Math.round(num(args.weight))) : 1;
    const priority = args.priority != null ? Math.round(num(args.priority)) : 0;
    const isActive = args.is_active === true || args.is_active === "true" || args.is_active === 1 ? 1 : 0;
    query(
      `INSERT INTO providers (id, name, base_url, auth_type, is_active, weight, priority) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, name, baseUrl, authType, isActive, weight, priority);
    reload();
    return { ok: true, provider_id: id, name, base_url: baseUrl, auth_type: authType, is_active: !!isActive, weight, priority };
  },

  update_provider(args) {
    const id = str(args.provider_id) || str(args.id);
    if (!id) return { ok: false, error: "provider_id is required" };
    const existing = query("SELECT id FROM providers WHERE id = ?").get(id) as { id: string } | undefined;
    if (!existing) return { ok: false, error: "provider not found" };
    const fields: string[] = [];
    const vals: unknown[] = [];
    if (args.name !== undefined) { fields.push("name = ?"); vals.push(str(args.name)); }
    if (args.base_url !== undefined || args.baseUrl !== undefined) {
      const bu = str(args.base_url) || str(args.baseUrl);
      if (!bu) return { ok: false, error: "base_url cannot be empty" };
      try { new URL(bu); } catch { return { ok: false, error: "base_url must be a valid URL" }; }
      fields.push("base_url = ?"); vals.push(bu);
    }
    if (args.auth_type !== undefined) {
      const at = str(args.auth_type);
      if (!["bearer","apikey","none"].includes(at)) return { ok: false, error: "auth_type must be bearer|apikey|none" };
      fields.push("auth_type = ?"); vals.push(at);
    }
    if (args.is_active !== undefined) {
      const v = args.is_active === true || args.is_active === "true" || args.is_active === 1 ? 1 : 0;
      fields.push("is_active = ?"); vals.push(v);
    }
    if (args.weight !== undefined) { fields.push("weight = ?"); vals.push(Math.max(1, Math.round(num(args.weight)))); }
    if (args.priority !== undefined) { fields.push("priority = ?"); vals.push(Math.round(num(args.priority))); }
    if (fields.length === 0) return { ok: false, error: "no fields to update" };
    vals.push(id);
    query(`UPDATE providers SET ${fields.join(", ")} WHERE id = ?`).run(...vals);
    reload();
    const updated = query("SELECT id, name, base_url, auth_type, is_active, weight, priority FROM providers WHERE id = ?").get(id);
    return { ok: true, provider: updated };
  },

  delete_provider(args) {
    const id = str(args.provider_id) || str(args.id);
    if (!id) return { ok: false, error: "provider_id is required" };
    const exists = query("SELECT id FROM providers WHERE id = ?").get(id) as { id: string } | undefined;
    if (!exists) return { ok: false, error: "provider not found" };
    // cleanup assignments & pools auto-singleton
    unassignPool("provider", id);
    // auto singleton pools for this provider (mcp-single / provider-single / key-* / acct-*)
    const autoPools = query("SELECT id, name FROM proxy_pools WHERE name LIKE ?").all(`auto · ${id} · %`) as Array<{ id: number; name: string }>;
    for (const p of autoPools) {
      query("DELETE FROM proxy_pool_assignments WHERE proxy_pool_id = ?").run(p.id);
      query("DELETE FROM proxy_pools WHERE id = ?").run(p.id);
    }
    query("DELETE FROM provider_credentials WHERE provider_id = ?").run(id);
    query("DELETE FROM models WHERE provider_id = ?").run(id);
    query("DELETE FROM providers WHERE id = ?").run(id);
    reload();
    return { ok: true, deleted: id };
  },

  list_provider_keys(args) {
    const providerId = str(args.provider_id);
    if (!providerId) return { ok: false, error: "provider_id is required" };
    const exists = query("SELECT id FROM providers WHERE id = ?").get(providerId) as { id: string } | undefined;
    if (!exists) return { ok: false, error: "provider not found" };
    const rows = listApiKeys(providerId) as Array<Record<string, unknown>>;
    return rows.map((k) => {
      const apiKey = String(k.api_key ?? "");
      const masked = apiKey.length <= 8 ? "••••" : `${apiKey.slice(0, 6)}••••••••${apiKey.slice(-4)}`;
      return {
        id: k.id,
        provider_id: k.provider_id,
        label: k.label ?? null,
        masked_key: masked,
        key_prefix: apiKey.slice(0, 8),
        is_active: !!k.is_active,
        is_routing: !!k.is_routing,
        proxy_pool_id: k.proxy_pool_id ?? null,
        created_at: k.created_at,
        updated_at: k.updated_at,
      };
    });
  },

  add_provider_key(args) {
    const providerId = str(args.provider_id);
    const apiKey = str(args.api_key);
    if (!providerId || !apiKey) return { ok: false, error: "provider_id and api_key are required" };
    const exists = query("SELECT id FROM providers WHERE id = ?").get(providerId) as { id: string } | undefined;
    if (!exists) return { ok: false, error: "provider not found" };
    const label = str(args.label) || null;
    // first key always routing; otherwise respect explicit flag
    const existingCount = (
      query("SELECT COUNT(*) as c FROM provider_credentials WHERE provider_id = ?").get(providerId) as { c: number } | undefined
    )?.c ?? 0;
    let makeRouting: boolean;
    if (args.is_routing !== undefined) makeRouting = args.is_routing === true || args.is_routing === "true";
    else makeRouting = existingCount === 0 ? true : false;
    addApiKey(providerId, apiKey, label, makeRouting);
    const inserted = query(
      "SELECT id, label, is_routing, is_active FROM provider_credentials WHERE provider_id = ? ORDER BY id DESC LIMIT 1",
    ).get(providerId) as { id: number; label: string | null; is_routing: number; is_active: number } | undefined;
    return { ok: true, id: inserted?.id ?? null, provider_id: providerId, label, is_routing: !!inserted?.is_routing };
  },

  delete_provider_key(args) {
    const id = num(args.id);
    if (!id) return { ok: false, error: "id is required" };
    const row = query("SELECT id, provider_id, proxy_pool_id FROM provider_credentials WHERE id = ?").get(id) as
      | { id: number; provider_id: string; proxy_pool_id: number | null }
      | undefined;
    if (!row) return { ok: false, error: "credential not found" };
    deleteApiKeyById(id);
    return { ok: true, deleted: id, provider_id: row.provider_id };
  },

  set_provider_routing_key(args) {
    const id = num(args.id);
    if (!id) return { ok: false, error: "id is required" };
    const row = query("SELECT id FROM provider_credentials WHERE id = ?").get(id) as { id: number } | undefined;
    if (!row) return { ok: false, error: "credential not found" };
    setRoutingKey(id);
    return { ok: true, routing_id: id };
  },

  toggle_provider_key(args) {
    const id = num(args.id);
    if (!id) return { ok: false, error: "id is required" };
    if (args.active === undefined) return { ok: false, error: "active is required" };
    const row = query("SELECT id FROM provider_credentials WHERE id = ?").get(id) as { id: number } | undefined;
    if (!row) return { ok: false, error: "credential not found" };
    const active = args.active === true || args.active === "true";
    setApiKeyActive(id, active);
    return { ok: true, id, active };
  },

  list_proxies() {
    const rows = listProxies() as unknown as Array<Record<string, unknown>>;
    return rows.map((p) => ({
      id: p.id,
      name: p.name,
      type: p.type,
      address: `${String(p.host)}:${String(p.port)}`,
      active: !!p.is_active,
      health:
        p.last_error != null
          ? "error"
          : p.last_ok_at
            ? "ok"
            : "untested",
      latency_ms: p.last_latency_ms ?? null,
      last_error: p.last_error ?? null,
    }));
  },

  add_proxy(args) {
    const created = createProxy({
      name: str(args.name) || `${str(args.host)}:${num(args.port)}`,
      type: str(args.type) === "socks5" ? "socks5" : "http-connect",
      host: str(args.host),
      port: num(args.port),
      username: str(args.username) || null,
      password: str(args.password) || null,
    });
    return { ok: true, id: created.id };
  },

  delete_proxy(args) {
    deleteProxy(num(args.id));
    return { ok: true, deleted: num(args.id) };
  },

  assign_provider_proxy(args) {
    const providerId = str(args.provider_id);
    let poolId = num(args.pool_id) || 0;

    if (!poolId && args.proxy_id != null) {
      // Bungkus single proxy ke pool singleton deterministik.
      const pid = num(args.proxy_id);
      const name = `auto · ${providerId} · mcp-single`;
      let pool = listPools().find((p) => p.name === name);
      if (pool) pool.proxy_ids = [pid];
      else pool = createPool({ name, proxy_ids: [pid] });
      poolId = pool.id;
      query("UPDATE proxy_pools SET proxy_ids = ? WHERE id = ?").run(
        JSON.stringify([pid]),
        poolId,
      );
    }

    if (!poolId) {
      return { ok: false, error: "pool_id or proxy_id is required" };
    }
    assignPool({
      proxyPoolId: poolId,
      targetType: "provider",
      targetId: providerId,
    });
    const pool = getPoolForProvider(providerId);
    return { ok: true, provider_id: providerId, pool: pool?.name ?? null };
  },

  recent_requests(args) {
    const limit = Math.min(num(args.limit) || 10, 50);
    const rows = query(
      `SELECT r.id, r.model, r.provider_id, r.status, r.duration_ms,
              r.prompt_tokens, r.completion_tokens, r.cached_tokens,
              r.via_proxy, op.name AS proxy_name, op.host AS proxy_host,
              op.port AS proxy_port, r.endpoint, r.created_at
         FROM request_logs r LEFT JOIN outbound_proxies op ON op.id = r.proxy_id
        ORDER BY r.id DESC LIMIT ?`,
    ).all(limit) as Array<Record<string, unknown>>;
    return rows;
  },

  recent_proxy_logs(args) {
    const limit = Math.min(num(args.limit) || 10, 100);
    const level = str(args.level);
    const rows = (
      level
        ? query(
            `SELECT l.id, l.level, l.source, l.message, l.client_ip,
                    l.provider_id, l.latency_ms, l.endpoint, l.created_at,
                    op.host AS proxy_host
               FROM proxy_logs l LEFT JOIN outbound_proxies op ON op.id = l.proxy_id
              WHERE l.level = ? ORDER BY l.id DESC LIMIT ?`,
          ).all(level, limit)
        : query(
            `SELECT l.id, l.level, l.source, l.message, l.client_ip,
                    l.provider_id, l.latency_ms, l.endpoint, l.created_at,
                    op.host AS proxy_host
               FROM proxy_logs l LEFT JOIN outbound_proxies op ON op.id = l.proxy_id
              ORDER BY l.id DESC LIMIT ?`,
          ).all(limit)
    ) as Array<Record<string, unknown>>;
    return rows;
  },

  usage_summary(args) {
    const range = (["day", "week", "month", "year", "all"] as const).includes(
      args.range as never,
    )
      ? (args.range as "day")
      : "week";
    const data = getUsageData({ range });
    const s = data.summary;
    return {
      range,
      requests: data.performance.requests,
      success_rate: data.performance.successRate,
      total_tokens: s.totalTokens,
      input_tokens: s.inputTokens,
      output_tokens: s.outputTokens,
      cached_tokens: s.cachedTokens,
      est_cost_usd: Math.round(s.cost * 1e4) / 1e4,
    };
  },

  async chat_completion(args) {
    const model = str(args.model);
    const prompt = str(args.prompt);
    if (!model || !prompt) {
      return { ok: false, error: "model and prompt are required" };
    }
    const messages = [
      ...(str(args.system)
        ? [{ role: "system", content: str(args.system) }]
        : []),
      { role: "user", content: prompt },
    ];
    const headers = new Headers({ "Content-Type": "application/json" });
    const apiKey = str(args.api_key);
    if (apiKey) headers.set("Authorization", `Bearer ${apiKey}`);
    else headers.set("Cookie", mcpAdminCookie());
    const req = new Request("http://uni.local/v1/chat/completions", {
      method: "POST",
      headers,
      body: JSON.stringify({ model, messages, stream: false }),
    });
    try {
      const res = await handleProxy(req, {
        clientFormat: "openai-chat",
        parse,
        endpoint: "mcp-chat",
      });
      const text = await res.text();
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(text) as Record<string, unknown>;
      } catch {
        return { ok: false, status: res.status, error: text.slice(0, 300) };
      }
      if (!res.ok) {
        const errObj = body.error as { message?: string } | undefined;
        return {
          ok: false,
          status: res.status,
          error: errObj?.message ?? text.slice(0, 300),
        };
      }
      const choices = body.choices as
        | Array<{ message?: { content?: string } }>
        | undefined;
      return {
        ok: true,
        model,
        content: choices?.[0]?.message?.content ?? "",
        usage: body.usage ?? null,
      };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },

  list_models(args) {
    const rows = query(
      "SELECT model_name FROM models WHERE provider_id = ? AND is_active = 1 ORDER BY model_name",
    ).all(str(args.provider_id)) as Array<{ model_name: string }>;
    return rows.map((r) => r.model_name);
  },

  toggle_proxy(args) {
    const id = num(args.id);
    const active = args.active === true;
    updateProxy(id, { is_active: active });
    return { ok: true, id, active };
  },

  update_pool(args) {
    const id = num(args.id);
    const input: Record<string, unknown> = {};
    if (args.name !== undefined) input.name = str(args.name);
    if (args.strategy !== undefined) input.strategy = str(args.strategy);
    if (Array.isArray(args.proxy_ids)) {
      input.proxy_ids = (args.proxy_ids as unknown[]).map(num);
    }
    if (args.is_active !== undefined) input.is_active = args.is_active === true;
    const updated = updatePool(id, input);
    if (!updated) return { ok: false, error: "pool not found" };
    return {
      ok: true,
      pool: {
        id: updated.id,
        name: updated.name,
        strategy: updated.strategy,
        proxies: updated.proxy_ids.length,
        active: updated.is_active,
      },
    };
  },

  delete_pool(args) {
    deletePool(num(args.id));
    return { ok: true, deleted: num(args.id) };
  },

  unassign_provider_proxy(args) {
    unassignPool("provider", str(args.provider_id));
    return { ok: true };
  },

  list_client_keys() {
    return listClientKeys().map((k) => ({
      id: k.id,
      name: k.name,
      prefix: k.key_prefix,
      active: !!k.is_active,
      blocked_at: k.blocked_at ?? null,
    }));
  },

  create_client_key(args) {
    const created = createClientKey({
      name: str(args.name) || "MCP key",
      prefix: "sk-",
    });
    return {
      ok: true,
      id: created.id,
      key: created.key,
      note: "Plaintext shown once — store it now",
    };
  },

  toggle_client_key(args) {
    const id = num(args.id);
    const active = args.active === true;
    const key = listClientKeys().find((k) => k.id === id);
    if (!key) return { ok: false, error: "key not found" };
    setClientKeyActive(id, active);
    return { ok: true, id, active };
  },

  compression_settings() {
    const settings = getCompressionSettings();
    const enabled = compressionEnabled();
    return { ...settings, ...enabled };
  },

  set_compression(args) {
    query(
      `INSERT INTO compression_settings (id, rtk_enabled, caveman_enabled)
       VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         rtk_enabled = excluded.rtk_enabled,
         caveman_enabled = excluded.caveman_enabled`,
    ).run(args.rtk === true ? 1 : 0, args.caveman === true ? 1 : 0);
    return {
      ok: true,
      rtk: args.rtk === true,
      caveman: args.caveman === true,
    };
  },

  list_routing_rules() {
    return query(
      "SELECT id, source_model, rule_type, target_model, target_provider_id, priority, is_active FROM routing_rules ORDER BY priority DESC, id",
    ).all();
  },

  create_routing_rule(args) {
    const source = str(args.source_model);
    const action = str(args.action);
    if (!source || !["rewrite", "fallback"].includes(action)) {
      return { ok: false, error: "source_model & action(rewrite|fallback) required" };
    }
    if (action === "rewrite" && !str(args.target_model)) {
      return { ok: false, error: "target_model is required for rewrite" };
    }
    if (action === "fallback" && !str(args.target_provider_id)) {
      return { ok: false, error: "target_provider_id is required for fallback" };
    }
    const name = `${source} → ${str(args.target_model) || str(args.target_provider_id)}`;
    const res = query(
      `INSERT INTO routing_rules (name, source_model, rule_type, target_model, target_provider_id, priority)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      name,
      source,
      action,
      action === "rewrite" ? str(args.target_model) : null,
      action === "fallback" ? str(args.target_provider_id) : null,
      num(args.priority),
    );
    return { ok: true, id: Number((res as { lastInsertRowid?: number }).lastInsertRowid ?? 0) };
  },

  delete_routing_rule(args) {
    query("DELETE FROM routing_rules WHERE id = ?").run(num(args.id));
    return { ok: true };
  },

  allow_model(args) {
    const model = str(args.model_name);
    query("DELETE FROM model_allowlist WHERE model_name = ?").run(model);
    query(
      "INSERT INTO model_allowlist (model_name, action, reason) VALUES (?, 'allow', 'via mcp')",
    ).run(model);
    return { ok: true, model, allowed: true };
  },

  deny_model(args) {
    const model = str(args.model_name);
    query("DELETE FROM model_allowlist WHERE model_name = ?").run(model);
    query(
      "INSERT INTO model_allowlist (model_name, action, reason) VALUES (?, 'deny', ?)",
    ).run(model, str(args.reason) || "via mcp");
    return { ok: true, model, allowed: false };
  },

  check_model_allowed(args) {
    const guard = checkAllowlist(str(args.model_name));
    const rule = evaluateRules(str(args.model_name));
    return {
      model: str(args.model_name),
      allowed: guard.ok && rule.action !== "deny",
      via: guard.ok ? `allowlist/rule:${rule.action}` : `denied: ${guard.reason ?? ""}`,
    };
  },

  add_model(args) {
    const r = upsertProviderModel(
      str(args.provider_id),
      str(args.model_name),
      args.context_length != null ? num(args.context_length) : null,
      args.primary === true,
    );
    return { ok: true, ...r };
  },

  remove_model(args) {
    query(
      "UPDATE models SET is_active = 0 WHERE provider_id = ? AND model_name = ?",
    ).run(str(args.provider_id), str(args.model_name));
    reload(); // registry cache harus ikut berubah
    return { ok: true };
  },

  set_primary_model(args) {
    upsertProviderModel(
      str(args.provider_id),
      str(args.model_name),
      null,
      true,
    );
    return { ok: true };
  },

  sync_models(args) {
    return syncProviderModels(str(args.provider_id));
  },

  get_client_key(args) {
    const key = listClientKeys().find((k) => k.id === num(args.id));
    if (!key) return { ok: false, error: "not found" };
    return {
      id: key.id,
      name: key.name,
      prefix: key.key_prefix,
      active: !!key.is_active,
      blocked_at: key.blocked_at ?? null,
      allowed_models: key.allowed_models ?? null,
      quota: key.quota ?? null,
      budget: key.budget ?? null,
      expires_at: key.expires_at ?? null,
    };
  },

  set_key_budget(args) {
    const id = num(args.id);
    const usd = num(args.monthly_budget_usd);
    const budget = usd > 0 ? JSON.stringify({ monthly_budget_usd: usd }) : null;
    query("UPDATE client_api_keys SET budget = ? WHERE id = ?").run(budget, id);
    return { ok: true, id, monthly_budget_usd: usd > 0 ? usd : null };
  },

  rotate_client_key(args) {
    const rotated = rotateKey(num(args.id));
    return { ok: true, id: rotated.id, new_key: rotated.key, note: "shown once" };
  },

  assign_key_proxy(args) {
    const keyId = num(args.key_id);
    let poolId = num(args.pool_id) || 0;
    if (!poolId && args.proxy_id != null) {
      const pid = num(args.proxy_id);
      const name = `auto · client-key-${keyId} · single`;
      let pool = listPools().find((p) => p.name === name);
      if (pool) pool.proxy_ids = [pid];
      else pool = createPool({ name, proxy_ids: [pid] });
      query("UPDATE proxy_pools SET proxy_ids = ? WHERE id = ?").run(
        JSON.stringify([pid]),
        pool.id,
      );
      poolId = pool.id;
    }
    if (!poolId) return { ok: false, error: "pool_id or proxy_id required" };
    assignPool({
      proxyPoolId: poolId,
      targetType: "client_key",
      targetId: String(keyId),
    });
    return { ok: true, key_id: keyId, pool_id: poolId };
  },

  unassign_key_proxy(args) {
    const keyId = num(args.key_id);
    const rows = query(
      `SELECT a.proxy_pool_id AS pid FROM proxy_pool_assignments a
        JOIN proxy_pools p ON p.id = a.proxy_pool_id
       WHERE a.target_type='client_key' AND a.target_id=? AND p.name LIKE 'auto · client-key-%'`,
    ).all(String(keyId)) as Array<{ pid: number }>;
    for (const r of rows) {
      query("DELETE FROM proxy_pool_assignments WHERE proxy_pool_id = ?").run(r.pid);
      query("DELETE FROM proxy_pools WHERE id = ?").run(r.pid);
    }
    // assignment lain (pool manual) juga dilepas
    query(
      "DELETE FROM proxy_pool_assignments WHERE target_type='client_key' AND target_id=?",
    ).run(String(keyId));
    return { ok: true };
  },

  async test_compression(args) {
    const sample =
      str(args.sample) ||
      "Example prompt long enough to exercise the compressor pipeline.";
    const r = await testCompression(sample);
    return {
      output: r.output?.slice(0, 500) ?? null,
      usedFallback: r.usedFallback,
      durationMs: r.durationMs,
    };
  },

  recent_webhooks(args) {
    const limit = Math.min(num(args.limit) || 10, 100);
    return query(
      `SELECT id, event, url, attempts, status, next_retry_at, created_at
         FROM webhook_events ORDER BY id DESC LIMIT ?`,
    ).all(limit);
  },

  clear_logs(args) {
    const scope = str(args.scope);
    if (scope === "all") {
      const r1 = Number(
        (query("SELECT COUNT(*) AS c FROM request_logs").get() as { c: number })
          .c,
      );
      const p1 = Number(
        (query("SELECT COUNT(*) AS c FROM proxy_logs").get() as { c: number })
          .c,
      );
      query("DELETE FROM request_logs").run();
      query("DELETE FROM proxy_logs").run();
      return { ok: true, cleared: { request: r1, proxy: p1 } };
    }
    if (scope === "request") {
      query("DELETE FROM request_logs").run();
      return { ok: true, cleared: { request: true } };
    }
    if (scope === "proxy") {
      query("DELETE FROM proxy_logs").run();
      return { ok: true, cleared: { proxy: true } };
    }
    return { ok: false, error: "scope must be request, proxy or all" };
  },

  tunnel_status() {
    const raw = getTunnelSettings();
    const binaries = getAllTunnelToolsStatus({
      cloudflared: raw.cloudflared_binary_path,
      ngrok: raw.ngrok_binary_path,
      frpc: raw.frpc_binary_path,
      bore: raw.bore_binary_path,
    });
    return {
      runtime: getTunnelStatus(),
      settings: getPublicTunnelSettings(raw),
      binaries,
    };
  },

  async start_tunnel(args) {
    const rawProvider = str(args.provider);
    if (
      rawProvider &&
      !VALID_TUNNEL_PROVIDERS.has(rawProvider as TunnelProviderId)
    ) {
      return {
        ok: false,
        error: "provider must be cloudflared, ngrok, frpc, or bore",
      };
    }
    return startTunnel({
      provider: rawProvider ? (rawProvider as TunnelProviderId) : undefined,
      waitMs: 5000,
    });
  },

  stop_tunnel() {
    return stopTunnel();
  },
};

export async function executeTool(
  name: string,
  args: JsonValue,
): Promise<{ content: JsonValue[]; isError?: boolean }> {
  const handler = HANDLERS[name];
  if (!handler) {
    return {
      content: [{ type: "text", text: `Unknown tool: ${name}` }],
      isError: true,
    };
  }
  try {
    const result = await handler(args);
    return {
      content: [
        { type: "text", text: JSON.stringify(result, null, 2) },
      ],
    };
  } catch (err) {
    return {
      content: [
        {
          type: "text",
          text: err instanceof Error ? err.message : String(err),
        },
      ],
      isError: true,
    };
  }
}
