import { Form, Link, redirect, useFetcher, useSearchParams, useSubmit } from "react-router";
import { useEffect, useRef, useState } from "react";
import type { Route } from "./+types/providers.$id";
import { fmtTs } from "../lib/log-format";

export function meta({ loaderData }: Route.MetaArgs) {
  const name = loaderData?.provider?.name;
  return [{ title: name ? `${name} | UniRoute` : "Provider | UniRoute" }];
}
import { getRegistryEntry } from "~/registry";
import type { RegistryEntry } from "~/types";
import { requireLoaderSession, requireSession } from "../.server/auth";
import { query } from "../.server/db";
import {
  listSessions,
  getMessages,
  saveSession,
  deleteSession as deleteChatSession,
  type ChatMessage,
} from "../.server/chat-store";
import {
  addApiKey,
  deleteApiKeyById,
  listApiKeys,
  setApiKeyActive,
  setApiKeyProxyPool,
  setRoutingKey,
  type ApiKeyRow,
} from "../.server/credential";
import {
  assignPool,
  createPool,
  getPoolForProvider,
  getProxy,
  listPools,
  listProxies,
  unassignPool,
  updatePool,
} from "../.server/outbound-proxy";
import { reload } from "../.server/registry";
import { joinApiUrl } from "../.server/adapter";
import { useStreaming } from "../hooks/use-streaming";
import { MessageInput } from "../components/message-input";
import { Brain } from "../components/ui/feedback";
import { estimateTps, formatClock, formatSecs } from "../lib/format";
import { CopyButton } from "../components/ui/copy-button";
import { StreamingResponse } from "../components/streaming-response";
import { Markdown } from "../components/markdown";
import { useConfirm } from "../components/ui/confirm-dialog";
import { useToast } from "../components/ui/toast";
import { PageHeader } from "../components/ui/page-header";
import { Card, CardHeader, CardTitle } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Spinner } from "../components/ui/feedback";
import { Checkbox, Input, Label, Select } from "../components/ui/field";
import { Tabs } from "../components/ui/tabs";
import { Toggle } from "../components/ui/toggle";
import {
  ArrowLeft,
  MessageSquare,
  Plug,
  Trash2,
  Plus,
  RefreshCw,
  Download,
  Send,
  Square,
  CheckCircle2,
  X,
  XCircle,
  ShieldCheck,
  Globe,
} from "lucide-react";

type ProviderRow = {
  id: string;
  name: string;
  base_url: string;
  auth_type: string;
  is_active: number;
  prefix: string | null;
};

type ModelRow = {
  id: number;
  model_name: string;
  display_name: string | null;
  context_length: number | null;
  is_active: number;
  is_primary: number;
};

const TAB_ITEMS: { value: "keys" | "models" | "chat"; label: string }[] = [
  { value: "keys", label: "API Keys" },
  { value: "models", label: "Models" },
  { value: "chat", label: "Chat Playground" },
];

function dbSyncModels(providerId: string, entry: RegistryEntry): void {
  for (const [i, m] of entry.models.entries()) {
    query(
      `INSERT OR IGNORE INTO models (model_name, provider_id, context_length, is_active, is_primary)
       VALUES (?, ?, ?, 1, ?)`,
    ).run(m.id, providerId, m.contextLength ?? null, i === 0 ? 1 : 0);
  }
}

function parseContextLength(value: FormDataEntryValue | null): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n);
}

function maskCredentialKey(raw: string): string {
  if (raw.length <= 8) return "••••";
  return `${raw.slice(0, 6)}••••••••${raw.slice(-4)}`;
}

export async function loader({ request, params }: Route.LoaderArgs) {
  requireLoaderSession(request);
  const provider = query(
    "SELECT id, name, base_url, auth_type, is_active, prefix FROM providers WHERE id = ?",
  ).get(params.id) as ProviderRow | undefined;

  const keys = provider
    ? listApiKeys(provider.id).map((k) => ({ ...k, api_key: maskCredentialKey(k.api_key) }))
    : [];
  let models: ModelRow[] = [];
  if (provider) {
    try {
      models = query(
        "SELECT id, model_name, display_name, context_length, is_active, is_primary FROM models WHERE provider_id = ? ORDER BY is_primary DESC, id",
      ).all(provider.id) as unknown as ModelRow[];
    } catch {
      models = query(
        "SELECT id, model_name, context_length, is_active, is_primary FROM models WHERE provider_id = ? ORDER BY is_primary DESC, id",
      ).all(provider.id) as unknown as ModelRow[];
    }
  }

  const pools = listPools();
  const rawProxies = listProxies();
  const activeProxies = rawProxies.filter((p) => p.is_active).length;
  const proxies = rawProxies.map(({ password: _p, password_enc: _pe, ...rest }) => rest);
  const chatSessions = provider ? listSessions(provider.id) : [];

  // Active provider proxy assignment: regular pool or single-proxy singleton.
  let providerSelected = "";
  if (provider) {
    const pp = getPoolForProvider(provider.id);
    if (pp) {
      const singleName = `auto · ${provider.id} · provider-single`;
      providerSelected =
        pp.name === singleName && pp.proxy_ids.length === 1
          ? `proxy:${pp.proxy_ids[0]}`
          : String(pp.id);
    }
  }

  const entry = getRegistryEntry(params.id ?? "");
  const registryModelNames = (entry?.models ?? []).map((m) => m.id);
  const missingModels = provider
    ? registryModelNames.filter(
        (name) => !models.some((m) => m.model_name === name),
      )
    : [];

  return {
    provider: provider ?? null,
    keys,
    models,
    missingModels,
    entry: entry ?? null,
    pools,
    providerSelected,
    activeProxies,
    proxies,
    chatSessions,
  };
}

export async function action({ request, params }: Route.ActionArgs) {
  const denied = requireSession(request);
  if (denied) return denied;
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const id = params.id ?? "";

  if (intent === "test-key") {
    const keyId = Number(form.get("key_id"));
    const key = listApiKeys(id).find((k) => k.id === keyId);
    if (!key) return { test: { ok: false, message: "Key not found" } };
    const provider = query(
      "SELECT base_url, auth_type FROM providers WHERE id = ?",
    ).get(id) as { base_url: string; auth_type: string } | undefined;
    if (!provider) return { test: { ok: false, message: "Provider not found" } };

    const entry = getRegistryEntry(id);
    const modelsUrl =
      entry?.modelsUrl ?? joinApiUrl(provider.base_url, "/v1/models");

    const headers = new Headers({ "Content-Type": "application/json" });
    if (provider.auth_type === "bearer") {
      headers.set("Authorization", `Bearer ${key.api_key}`);
    } else if (provider.auth_type === "apikey") {
      headers.set("x-goog-api-key", key.api_key);
    }
    if (entry?.headers) {
      for (const [k, v] of Object.entries(entry.headers)) {
        headers.set(k, v);
      }
    }

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      const res = await fetch(
        modelsUrl,
        { headers, signal: controller.signal },
      );
      clearTimeout(timer);
      if (res.ok) {
        return { test: { ok: true, okId: keyId, message: "Connected" } };
      }
      const text = (await res.text()).slice(0, 300);
      return {
        test: {
          ok: false,
          okId: keyId,
          message: `HTTP ${res.status}: ${text}`,
        },
      };
    } catch (err) {
      return {
        test: {
          ok: false,
          okId: keyId,
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }

  // ---- Outbound proxy assignment ------------------------------------------

  // All keys for this provider share the provider-level pool.
  // "proxy:<id>" wraps a single proxy in a singleton pool to reuse the routing pipeline.
  if (intent === "set-provider-pool") {
    const raw = String(form.get("pool_id") || "");
    if (!raw) {
      unassignPool("provider", id);
      return {
        savedPool: true,
        notice: { ok: true, message: "Provider proxy removed (direct)" },
      };
    }
    let poolId: number;
    if (raw.startsWith("proxy:")) {
      const proxyId = Number(raw.slice(6));
      const name = `auto · ${id} · provider-single`;
      let pool = listPools().find((p) => p.name === name);
      if (pool) updatePool(pool.id, { proxy_ids: [proxyId] });
      else pool = createPool({ name, proxy_ids: [proxyId] });
      poolId = pool.id;
    } else {
      poolId = Number(raw);
    }
    unassignPool("provider", id);
    assignPool({
      proxyPoolId: poolId,
      targetType: "provider",
      targetId: id,
    });
    return {
      savedPool: true,
      notice: { ok: true, message: "Provider proxy saved" },
    };
  }

  // Single account uses its own pool.
  if (intent === "set-key-pool") {
    const keyId = Number(form.get("key_id"));
    const raw = String(form.get("pool_id") || "");
    setApiKeyProxyPool(keyId, raw ? Number(raw) : null);
    return {
      savedPool: true,
      notice: { ok: true, message: "Account proxy saved" },
    };
  }

  // Assign a specific proxy to one account via a singleton pool; empty proxy_id unassigns it.
  if (intent === "set-key-proxy") {
    const keyId = Number(form.get("key_id"));
    const key = listApiKeys(id).find((k) => k.id === keyId);
    if (!key) {
      return { distribute: { ok: false, message: "Key not found", rows: [] } };
    }
    const proxyIdRaw = String(form.get("proxy_id") || "");
    if (!proxyIdRaw) {
      setApiKeyProxyPool(keyId, null);
      return {
        savedPool: true,
        notice: { ok: true, message: "Account proxy removed" },
      };
    }
    const proxyId = Number(proxyIdRaw);
    const name = `auto · ${id} · key-${keyId}`;
    let pool = listPools().find((p) => p.name === name);
    if (pool) updatePool(pool.id, { proxy_ids: [proxyId] });
    else pool = createPool({ name, proxy_ids: [proxyId] });
    setApiKeyProxyPool(keyId, pool.id);
    return {
      savedPool: true,
      notice: { ok: true, message: "Account proxy saved" },
    };
  }

  // Round-robin distribute active proxies across all active accounts for this provider.
  if (intent === "distribute") {
    const sourceType =
      String(form.get("source_type")) === "list" ? "list" : "pool";
    const accounts = listApiKeys(id).filter((k) => k.is_active);

    let proxies: number[] = [];
    let sourceLabel = "";
    if (sourceType === "list") {
      proxies = listProxies(true).map((p) => p.id);
      sourceLabel = "proxy list";
    } else {
      const source = listPools().find(
        (p) => p.id === Number(form.get("pool_id")),
      );
      if (!source) {
        return {
          distribute: { ok: false, message: "Pool not found", rows: [] },
        };
      }
      proxies = source.proxy_ids
        .map((pid) => getProxy(pid))
        .filter((p) => p && p.is_active)
        .map((p) => p!.id);
      sourceLabel = `pool “${source.name}”`;
    }

    if (accounts.length === 0) {
      return {
        distribute: {
          ok: false,
          message: "No active API keys on this provider",
          rows: [],
        },
      };
    }
    if (proxies.length === 0) {
      return {
        distribute: {
          ok: false,
          message: `No active proxies found in ${sourceLabel}`,
          rows: [],
        },
      };
    }

    const rows = accounts.map((k, i) => {
      const ids = proxies.filter((_, j) => j % accounts.length === i);
      const name = `auto · ${id} · acct-${i + 1}`;
      let pool = listPools().find((p) => p.name === name);
      if (pool) updatePool(pool.id, { proxy_ids: ids });
      else pool = createPool({ name, proxy_ids: ids });
      setApiKeyProxyPool(k.id, pool.id);
      return `${k.label || `Key #${k.id}`} → ${name} (${ids.length} proxies)`;
    });

    return {
      distribute: {
        ok: true,
        message: `${accounts.length} accounts · ${proxies.length} active proxies from ${sourceLabel} distributed`,
        rows,
      },
    };
  }

  // ---- Chat playground persistence ----------------------------------------

  if (intent === "chat-save") {
    const providerId = params.id ?? "";
    let msgs: ChatMessage[] = [];
    try {
      const parsed = JSON.parse(String(form.get("messages") || "[]")) as ChatMessage[];
      msgs = Array.isArray(parsed) ? parsed : [];
    } catch {
      return { chat: { ok: false, sessionId: null, message: "Invalid messages payload" } };
    }
    const clean = msgs
      .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .map((m) => ({
        role: m.role,
        content: m.content,
        model: m.model ?? null,
        latency_ms: m.latency_ms ?? null,
        thinking: typeof m.thinking === "string" && m.thinking !== "" ? m.thinking : null,
      }));
    if (clean.length === 0) {
      return { chat: { ok: false, sessionId: null, message: "Nothing to save" } };
    }
    const sidRaw = Number(form.get("session_id")) || 0;
    const firstUser = clean.find((m) => m.role === "user");
    const title =
      String(form.get("title") || "").trim() ||
      (firstUser ? firstUser.content.slice(0, 60) : "New chat");
    const { sessionId } = saveSession(
      providerId,
      sidRaw || null,
      title,
      String(form.get("model") || "") || null,
      clean,
    );
    return { chat: { ok: true, sessionId, message: null } };
  }

  if (intent === "chat-load") {
    const sid = Number(form.get("session_id"));
    const rows = getMessages(sid) as ChatMessage[];
    return {
      chatLoad: {
        ok: rows.length > 0,
        sessionId: sid,
        messages: rows.map((m) => ({
          role: m.role as "user" | "assistant",
          content: m.content,
          model: m.model ?? null,
          ms: m.latency_ms ?? null,
          thinking: m.thinking ?? null,
          created_at: m.created_at ?? null,
        })),
      },
    };
  }

  if (intent === "chat-delete") {
    deleteChatSession(Number(form.get("session_id")));
    return {
      chatDeleted: Number(form.get("session_id")),
      notice: { ok: true, message: "Chat deleted" },
    };
  }

  if (intent === "add-key") {
    const apiKey = String(form.get("api_key") ?? "").trim();
    if (apiKey) {
      addApiKey(        id,
        apiKey,
        String(form.get("label") ?? "").trim() || null,
        true,
      );
      return { notice: { ok: true, message: "API key added" } };
    }
    return null;
  }

  if (intent === "delete-key") {
    deleteApiKeyById(Number(form.get("key_id")));
    return { notice: { ok: true, message: "API key deleted" } };
  }

  if (intent === "route-key") {
    setRoutingKey(Number(form.get("key_id")));
    return { notice: { ok: true, message: "Routing key updated" } };
  }

  if (intent === "active-key") {
    const active = form.get("is_active") === "1";
    setApiKeyActive(Number(form.get("key_id")), active);
    return { notice: { ok: true, message: `API key ${active ? "activated" : "deactivated"}` } };
  }

  if (intent === "sync-models") {
    const entry = getRegistryEntry(id);
    if (entry) {
      dbSyncModels(id, entry);
      reload();
      return { notice: { ok: true, message: "Models synced from registry" } };
    }
    return { notice: { ok: false, message: "No registry entry for this provider" } };
  }

  if (intent === "add-model") {
    const modelName = String(form.get("model_name") ?? "").trim();
    if (!modelName) {
      return { modelsAction: { ok: false, message: "Model name is required" } };
    }
    const customDisplay = String(form.get("display_name") ?? "").trim() || null;
    const contextLength = parseContextLength(form.get("context_length"));
    const makePrimary =
      form.get("is_primary") === "1" || form.get("is_primary") === "on";
    // Dynamic import keeps .server modules out of the client bundle.
    const { upsertProviderModel } = await import("../.server/provider-models");
    upsertProviderModel(id, modelName, contextLength, makePrimary, customDisplay);
    reload();
    return {
      modelsAction: { ok: true, message: `Added ${modelName}` },
    };
  }

  if (intent === "set-model-display") {
    const modelId = Number(form.get("model_id"));
    const customDisplay = String(form.get("display_name") ?? "").trim() || null;
    try {
      query("UPDATE models SET display_name = ? WHERE id = ? AND provider_id = ?").run(
        customDisplay,
        modelId,
        id,
      );
    } catch {
      return { modelsAction: { ok: false, message: "Database does not support display_name yet" } };
    }
    reload();
    return {
      modelsAction: { ok: true, message: customDisplay ? `Display name set to ${customDisplay}` : "Display name cleared (reverted to prefix/model)" },
    };
  }

  if (intent === "import-models") {
    const selected = form
      .getAll("model_id")
      .map((v) => String(v).trim())
      .filter(Boolean);
    if (selected.length === 0) {
      return {
        modelsAction: {
          ok: false,
          message: "Select at least one model to import",
        },
      };
    }

    const { upsertProviderModelsBatch, fetchProviderModelsList } = await import(
      "../.server/provider-models"
    );
    const fetched = await fetchProviderModelsList(id);
    const contextById = new Map<string, number | null>();
    if (fetched.ok) {
      for (const m of fetched.models) contextById.set(m.id, m.contextLength);
    }

    const items = selected.map((name) => ({
      modelName: name,
      contextLength: contextById.has(name)
        ? (contextById.get(name) ?? null)
        : (parseContextLength(form.get(`context_${name}`)) ?? null),
    }));
    const { created, updated } = upsertProviderModelsBatch(id, items);
    return {
      modelsAction: {
        ok: true,
        message: `Imported ${created} new, updated ${updated}`,
      },
    };
  }

  if (intent === "fetch-remote-models") {
    const { fetchProviderModelsList } = await import(
      "../.server/provider-models"
    );
    const fetched = await fetchProviderModelsList(id);
    if (!fetched.ok) {
      return {
        remoteModels: {
          ok: false as const,
          message: fetched.message,
          models: [],
        },
      };
    }
    const existing = new Set(
      (
        query("SELECT model_name FROM models WHERE provider_id = ?").all(id) as {
          model_name: string;
        }[]
      ).map((r) => r.model_name),
    );
    return {
      remoteModels: {
        ok: true as const,
        message: `Found ${fetched.models.length} models`,
        models: fetched.models.map((m) => ({
          id: m.id,
          contextLength: m.contextLength,
          alreadyAdded: existing.has(m.id),
        })),
      },
    };
  }

  if (intent === "toggle-model") {
    const modelId = Number(form.get("model_id"));
    const active = form.get("is_active") === "1";
    query(
      "UPDATE models SET is_active = ? WHERE id = ? AND provider_id = ?",
    ).run(active ? 1 : 0, modelId, id);
    reload();
    return { notice: { ok: true, message: `Model ${active ? "activated" : "deactivated"}` } };
  }

  if (intent === "set-primary-model") {
    const modelId = Number(form.get("model_id"));
    query("UPDATE models SET is_primary = 0 WHERE provider_id = ?").run(id);
    query(
      "UPDATE models SET is_primary = 1, is_active = 1 WHERE id = ? AND provider_id = ?",
    ).run(modelId, id);
    reload();
    return { notice: { ok: true, message: "Primary model updated" } };
  }

  if (intent === "delete-model") {
    const modelId = Number(form.get("model_id"));
    query("DELETE FROM models WHERE id = ? AND provider_id = ?").run(modelId, id);
    reload();
    return { notice: { ok: true, message: "Model deleted" } };
  }

  if (intent === "delete-provider") {
    query("DELETE FROM provider_credentials WHERE provider_id = ?").run(id);
    query("DELETE FROM models WHERE provider_id = ?").run(id);
    query("DELETE FROM providers WHERE id = ?").run(id);
    reload();
    return redirect("/providers");
  }

  if (intent === "update-provider") {
    const name = String(form.get("name") ?? "").trim();
    const baseUrl = String(form.get("base_url") ?? "").trim();
    const authType = String(form.get("auth_type") ?? "bearer");
    let prefix: string | null = null;
    try {
      const { normalizePrefix } = await import("../.server/provider-prefix");
      prefix = normalizePrefix(String(form.get("prefix") ?? ""));
    } catch (e) {
      return { providerUpdate: { ok: false, message: e instanceof Error ? e.message : "invalid prefix" } };
    }
    if (prefix) {
      const dup = query("SELECT id FROM providers WHERE prefix = ? AND id != ?").get(prefix, id) as { id: string } | undefined;
      if (dup) return { providerUpdate: { ok: false, message: `Prefix "${prefix}" is already used by ${dup.id}` } };
    }
    if (!name || !baseUrl) return { providerUpdate: { ok: false, message: "name & base_url required" } };
    query("UPDATE providers SET name = ?, base_url = ?, auth_type = ?, prefix = ? WHERE id = ?").run(name, baseUrl, authType, prefix, id);
    reload();
    return { providerUpdate: { ok: true, message: "Provider updated" } };
  }

  return null;
}

function MaskedKey({ value }: { value: string }) {
  if (value.length <= 8) return <span>••••</span>;
  return (
    <span>
      {value.slice(0, 6)}••••••••{value.slice(-4)}
    </span>
  );
}

export default function ProviderDetail({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const { pools, providerSelected, activeProxies, proxies } = loaderData;
  const [distSource, setDistSource] = useState<"pool" | "list">("pool");
  const [picker, setPicker] = useState<{ keyId: number; label: string } | null>(
    null,
  );
  const [pickerQuery, setPickerQuery] = useState("");

  const proxiesById = new Map(proxies.map((p) => [p.id, p]));
  const autoPoolByName = (name: string) => pools.find((p) => p.name === name);

  type Tone = "ok" | "error" | "none";
  const PROXY_TONE_CLASS: Record<Tone, string> = {
    ok: "border-success/40 bg-success/15 text-success hover:bg-success/25",
    error: "border-danger/40 bg-danger/15 text-danger hover:bg-danger/25",
    none: "border-border bg-muted text-muted-foreground hover:bg-surface-2",
  };

  function proxyInfoFor(key: ApiKeyRow): {
    tone: Tone;
    detail: string;
    selectedId: number | null;
  } {
    if (!key.proxy_pool_id) {
      return { tone: "none", detail: "No proxy - click to pick one", selectedId: null };
    }
    const pool =
      pools.find((p) => p.id === key.proxy_pool_id) ??
      autoPoolByName(`auto · ${loaderData.provider?.id ?? ""} · key-${key.id}`);
    if (!pool || pool.proxy_ids.length === 0) {
      return { tone: "error", detail: `Pool missing/inactive`, selectedId: null };
    }
    const ps = pool.proxy_ids
      .map((pid) => proxiesById.get(pid))
      .filter(Boolean)
      .map((p) => p!);
    const activeCount = ps.filter((p) => p.is_active).length;
    const hosts = ps.map((p) => `${p.host}:${p.port}`).join(", ");
    return {
      tone: activeCount > 0 ? "ok" : "error",
      detail:
        activeCount > 0
          ? `${pool.name} → ${hosts}`
          : `All proxies in ${pool.name} are disabled (${hosts})`,
      selectedId: ps.length === 1 ? ps[0]!.id : null,
    };
  }

  const pickerKey =
    picker && "keys" in loaderData
      ? loaderData.keys.find((k) => k.id === picker.keyId) ?? null
      : null;
  const pickerSelected =
    pickerKey && pickerKey.proxy_pool_id
      ? (proxyInfoFor(pickerKey).selectedId ?? -1)
      : null;

  const q = pickerQuery.trim().toLowerCase();
  const filteredProxies = q
    ? proxies.filter((p) =>
        `${p.name} ${p.host}:${p.port} ${p.type}`.toLowerCase().includes(q),
      )
    : proxies;

  const { provider, keys, models, missingModels, entry } = loaderData;
  const [searchParams, setSearchParams] = useSearchParams();
  const submit = useSubmit();
  const rawTab = searchParams.get("tab");
  const tab: "keys" | "models" | "chat" =
    rawTab === "models" || rawTab === "chat" ? rawTab : "keys";
  const setTab = (next: "keys" | "models" | "chat") => {
    setSearchParams(
      (prev) => {
        const copy = new URLSearchParams(prev);
        if (next === "keys") copy.delete("tab");
        else copy.set("tab", next);
        return copy;
      },
      { replace: true },
    );
  };
  const [modelFilter, setModelFilter] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [label, setLabel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [addModelOpen, setAddModelOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [newModelName, setNewModelName] = useState("");
  const [newModelContext, setNewModelContext] = useState("");
  const [newModelPrimary, setNewModelPrimary] = useState(false);
  const [selectedRemote, setSelectedRemote] = useState<Record<string, boolean>>(
    {},
  );
  const [importQuery, setImportQuery] = useState("");
  const [newModelDisplay, setNewModelDisplay] = useState("");
  const [editingDisplayId, setEditingDisplayId] = useState<number | null>(null);
  const fetcher = useFetcher<{
    test?: { ok: boolean; okId: number; message: string };
    modelsAction?: { ok: boolean; message: string };
    remoteModels?: {
      ok: boolean;
      message: string;
      models: {
        id: string;
        contextLength: number | null;
        alreadyAdded: boolean;
      }[];
    };
  }>();
  const lastFetcherDataRef = useRef<typeof fetcher.data>(undefined);
  const defaultChatModel = (() => {
    const first = models.find((m) => m.is_primary) ?? models[0];
    if (!first) return "";
    const pfx = (loaderData.provider?.prefix ?? "").replace(/^\/+|\/+$/g, "").trim();
    return (first.display_name ?? "").trim() || (pfx ? `${pfx}/${first.model_name}` : first.model_name);
  })();
  const [chatModel, setChatModel] = useState(defaultChatModel);
  const [prompt, setPrompt] = useState("");
  const stream = useStreaming();

  // ---- Chat playground state ----------------------------------------------
  type ChatMsg = {
    role: "user" | "assistant";
    content: string;
    model?: string | null;
    ms?: number | null;
    thinking?: string | null;
    created_at?: number | null;
  };
  const [history, setHistory] = useState<ChatMsg[]>([]);
  const historyRef = useRef<ChatMsg[]>([]);
  const setTurns = (next: ChatMsg[]) => {
    historyRef.current = next;
    setHistory(next);
  };
  const [chatSessionId, setChatSessionId] = useState<number | null>(null);
  const providerIdRef = useRef(loaderData.provider?.id ?? "");
  useEffect(() => {
    const pid = loaderData.provider?.id ?? "";
    if (providerIdRef.current !== pid) {
      providerIdRef.current = pid;
      setTurns([]);
      setChatSessionId(null);
      setChatModel(defaultChatModel);
      return;
    }
    const pfx = (loaderData.provider?.prefix ?? "").replace(/^\/+|\/+$/g, "").trim();
    const validModels = models.map(
      (m) => (m.display_name ?? "").trim() || (pfx ? `${pfx}/${m.model_name}` : m.model_name),
    );
    if ((!chatModel || !validModels.includes(chatModel)) && defaultChatModel) {
      setChatModel(defaultChatModel);
    }
  }, [loaderData.provider?.id, loaderData.provider?.prefix, models, defaultChatModel, chatModel]);
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const [autoSave, setAutoSave] = useState(true);
  useEffect(() => {
    try {
      setAutoSave(localStorage.getItem("uniroute-chat-autosave") !== "0");
    } catch {
      /* ignore */
    }
  }, []);
  useEffect(() => {
    if (!picker) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPicker(null);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [picker]);
  const chatSaveFetcher = useFetcher<{
    chat?: {
      ok: boolean;
      sessionId: number | null;
      message?: string | null;
    };
  }>();
  const chatLoadFetcher = useFetcher<{
    chatLoad?: { ok: boolean; sessionId: number; messages: ChatMsg[] };
  }>();
  const chatDeleteFetcher = useFetcher();

  const streamStartRef = useRef(0);
  const awaitingAssistantRef = useRef(false);

  // Pin scroll to bottom only when already near the bottom.
  useEffect(() => {
    const el = chatScrollRef.current;
    if (!el) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 90) {
      el.scrollTop = el.scrollHeight;
    }
  }, [stream.response, stream.streaming, history.length]);

  useEffect(() => {
    const d = chatLoadFetcher.data?.chatLoad;
    if (!d) return;
    setTurns(
      d.messages.map((m) => ({
        role: m.role,
        content: m.content,
        model: m.model ?? null,
        ms: m.ms ?? null,
        thinking: m.thinking ?? null,
        created_at: m.created_at ?? null,
      })),
    );
    setChatSessionId(d.sessionId);
    requestAnimationFrame(() => {
      const el = chatScrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }, [chatLoadFetcher.data]);

  // Lock session ID after save so subsequent auto-saves update instead of duplicating.
  useEffect(() => {
    const d = chatSaveFetcher.data?.chat;
    if (!d) return;
    if (d.ok && d.sessionId && chatSessionId !== d.sessionId) {
      setChatSessionId(d.sessionId);
    }
    if (d.ok === false && d.message) {
      toast({ title: "Save failed", description: d.message, variant: "error" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatSaveFetcher.data]);

  const saveChat = (msgs: ChatMsg[]) => {
    if (msgs.length === 0) return;
    const fd = new FormData();
    fd.set("intent", "chat-save");
    fd.set("provider_id", loaderData.provider?.id ?? "");
    fd.set("session_id", chatSessionId ? String(chatSessionId) : "");
    fd.set("model", chatModel);
    fd.set(
      "title",
      msgs.find((m) => m.role === "user")?.content.slice(0, 60) ?? "New chat",
    );
    fd.set(
      "messages",
      JSON.stringify(
        msgs.map((m) => ({
          role: m.role,
          content: m.content,
          thinking: m.thinking ?? null,
          model: m.model ?? null,
          latency_ms: m.ms ?? null,
        })),
      ),
    );
    chatSaveFetcher.submit(fd, { method: "post" });
  };

  const loadChat = (sessionId: number) => {
    if (stream.streaming) return;
    const fd = new FormData();
    fd.set("intent", "chat-load");
    fd.set("session_id", String(sessionId));
    chatLoadFetcher.submit(fd, { method: "post" });
  };

  const deleteChat = async (sessionId: number) => {
    const ok = await confirm({
      title: "Delete this chat?",
      description:
        "The conversation and its messages will be permanently removed.",
      variant: "danger",
    });
    if (!ok) return;
    const fd = new FormData();
    fd.set("intent", "chat-delete");
    fd.set("session_id", String(sessionId));
    chatDeleteFetcher.submit(fd, { method: "post" });
    if (chatSessionId === sessionId) {
      setChatSessionId(null);
      setTurns([]);
    }
  };

  const pushTurn = (turn: ChatMsg) => {
    historyRef.current = [...historyRef.current, turn];
    setHistory(historyRef.current);
  };

  const sendChat = () => {
    const p = prompt.trim();
    if (!p || stream.streaming) return;
    setPrompt("");
    pushTurn({ role: "user", content: p });
    streamStartRef.current = Date.now();
    awaitingAssistantRef.current = true;
    stream.send(chatModel, p, true, {
      history: history.map((m) => ({ role: m.role, content: m.content })),
    });
  };

  // Commit assistant turn once when finished and auto-save; truncated output stays a normal turn.
  useEffect(() => {
    if (!awaitingAssistantRef.current) return;
    if (!(stream.done || stream.truncated || stream.error)) return;
    awaitingAssistantRef.current = false;
    const ms = streamStartRef.current
      ? Date.now() - streamStartRef.current
      : null;
    const isTruncated = !!(stream as { truncated?: boolean }).truncated;
    const hasPartial = stream.response !== "";
    const assistantTurn: ChatMsg = {
      role: "assistant",
      content:
        stream.error && !hasPartial
          ? `Error: ${stream.error}`
          : stream.response +
            (isTruncated ? "\n\n…(truncated - continue)" : ""),
      model: chatModel,
      ms,
      thinking: stream.thinking || null,
    };
    const next: ChatMsg[] = [...historyRef.current, assistantTurn];
    setTurns(next);
    if (autoSave && !stream.error && assistantTurn.content !== "") {
      // Submit outside React state updater to avoid duplicate saves under concurrent renders.
      const fd = new FormData();
      fd.set("intent", "chat-save");
      fd.set("provider_id", loaderData.provider?.id ?? "");
      fd.set("session_id", chatSessionId ? String(chatSessionId) : "");
      fd.set("model", chatModel);
      fd.set(
        "title",
        next.find((m) => m.role === "user")?.content.slice(0, 60) ?? "New chat",
      );
      fd.set(
        "messages",
        JSON.stringify(
          next.map((m) => ({
            role: m.role,
            content: m.content,
            thinking: m.thinking ?? null,
            model: m.model ?? null,
            latency_ms: m.ms ?? null,
          })),
        ),
      );
      chatSaveFetcher.submit(fd, { method: "post" });
    }
  }, [stream.done, stream.truncated, stream.error]);

  const { dialog, confirm } = useConfirm();
  const { toast } = useToast();
  const lastNoticeRef = useRef<{ ok: boolean; message: string } | undefined>(
    undefined,
  );
  const lastActionModelsRef = useRef<{ ok: boolean; message: string } | undefined>(
    undefined,
  );

  // Show toast for standard form actions.
  useEffect(() => {
    const ad = actionData as
      | {
          notice?: { ok: boolean; message: string };
          modelsAction?: { ok: boolean; message: string };
        }
      | undefined;
    const notice = ad?.notice;
    if (notice && notice !== lastNoticeRef.current) {
      lastNoticeRef.current = notice;
      toast({
        title: notice.ok ? "Done" : "Action failed",
        description: notice.message,
        variant: notice.ok ? "success" : "error",
      });
    }
    const modelsAction = ad?.modelsAction;
    if (modelsAction && modelsAction !== lastActionModelsRef.current) {
      lastActionModelsRef.current = modelsAction;
      toast({
        title: modelsAction.ok ? "Models updated" : "Models action failed",
        description: modelsAction.message,
        variant: modelsAction.ok ? "success" : "error",
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actionData]);

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    if (lastFetcherDataRef.current === fetcher.data) return;
    lastFetcherDataRef.current = fetcher.data;

    const action = fetcher.data.modelsAction;
    if (action) {
      toast({
        title: action.ok ? "Models updated" : "Models action failed",
        description: action.message,
        variant: action.ok ? "success" : "error",
      });
    }

    const remote = fetcher.data.remoteModels;
    if (remote) {
      if (!remote.ok) {
        toast({
          title: "Import failed",
          description: remote.message,
          variant: "error",
        });
        return;
      }
      setImportOpen(true);
      const initial: Record<string, boolean> = {};
      for (const m of remote.models) {
        if (!m.alreadyAdded) initial[m.id] = true;
      }
      setSelectedRemote(initial);
    }
  }, [fetcher.state, fetcher.data]);


  const handleDelete = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const ok = await confirm({
      title: "Delete provider?",
      description: "This permanently removes the provider and its models.",
      confirmLabel: "Delete",
      variant: "danger",
    });
    if (ok) form.submit();
  };

  const handleDeleteKey = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const ok = await confirm({
      title: "Delete API key?",
      description: "This permanently removes the key. Requests using it will stop working.",
      confirmLabel: "Delete",
      variant: "danger",
    });
    if (ok) form.submit();
  };

  const handleAddSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    if (!apiKey.trim()) {
      e.preventDefault();
      toast({
        title: "API key required",
        description: "Enter an API key before saving.",
        variant: "error",
      });
      return;
    }
    setAddOpen(false);
    setApiKey("");
    setLabel("");
  };

  if (!provider) {
    return (
      <Card padded={false} className="p-8 text-center">
        <p className="text-muted-foreground">Provider not found.</p>
        <Link to="/providers" prefetch="render" className="mt-4 inline-block text-primary hover:underline">
          ← Back to list
        </Link>
      </Card>
    );
  }

  const testResult = fetcher.data?.test;

  // Prefix is name-only; "/" separator is added automatically to match server displayName().
  const cleanPfx = (provider?.prefix ?? "").replace(/^\/+|\/+$/g, "").trim();
  const modelDisplay = (m: { model_name: string; display_name: string | null }) =>
    (m.display_name ?? "").trim() || (cleanPfx ? `${cleanPfx}/${m.model_name}` : m.model_name);
  const remoteModels = fetcher.data?.remoteModels?.models ?? [];
  const iq = importQuery.trim().toLowerCase();
  const filteredRemote = iq
    ? remoteModels.filter((m) => m.id.toLowerCase().includes(iq))
    : remoteModels;

  return (
    <div>
      <PageHeader
        title={provider.name}
        icon={<Plug size={20} />}
        subtitle={`${provider.id} · ${provider.base_url}${cleanPfx ? ` · prefix ${cleanPfx}/` : ""}`}
        backTo="/providers"
        backLabel="Back to Providers"
        badge={
          provider.is_active ? (
            <Badge tone="success" dot>Active</Badge>
          ) : (
            <Badge tone="neutral" dot>Inactive</Badge>
          )
        }
      />

      {/* Provider settings */}
      <Card className="mb-6">
        <details>
          <summary className="cursor-pointer text-sm font-medium text-foreground">
            Provider settings &amp; danger zone
          </summary>
          <Form key={provider.id} method="post" className="mt-4 grid gap-3 sm:grid-cols-2">
            <input type="hidden" name="intent" value="update-provider" />
            <div>
              <Label htmlFor="edit-name">Display Name</Label>
              <Input id="edit-name" name="name" defaultValue={provider.name} required />
            </div>
            <div>
              <Label htmlFor="edit-base">Base URL</Label>
              <Input id="edit-base" name="base_url" defaultValue={provider.base_url} required className="font-mono" />
            </div>
            <div>
              <Label htmlFor="edit-auth">Auth Type</Label>
              <Select id="edit-auth" name="auth_type" defaultValue={provider.auth_type}>
                <option value="none">none</option>
                <option value="bearer">bearer</option>
                <option value="apikey">apikey</option>
              </Select>
            </div>
            <div>
              <Label htmlFor="edit-prefix">Prefix (optional)</Label>
              <Input id="edit-prefix" name="prefix" defaultValue={(provider.prefix ?? "").replace(/\/+$/g, "")} placeholder="e.g. openai" pattern="[a-zA-Z0-9._\-]{1,32}" title="Name only, without slash" className="font-mono" />
            </div>
            <div className="sm:col-span-2">
              <Button type="submit" size="sm">Save provider</Button>
            </div>
          </Form>
          {actionData && "providerUpdate" in actionData && (actionData as { providerUpdate: { ok: boolean; message: string } }).providerUpdate ? (
            <p className={`mt-2 text-xs ${(actionData as { providerUpdate: { ok: boolean } }).providerUpdate.ok ? "text-success" : "text-danger"}`}>
              {(actionData as { providerUpdate: { message: string } }).providerUpdate.message}
            </p>
          ) : null}
          <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
            <div>
              <p className="text-xs font-semibold text-danger">Danger Zone</p>
              <p className="text-xs text-muted-foreground">
                Permanently remove this provider, its keys, and its model registrations.
              </p>
            </div>
            <Form method="post" onSubmit={handleDelete}>
              <input type="hidden" name="intent" value="delete-provider" />
              <Button type="submit" size="sm" variant="danger">
                <Trash2 size={14} />
                Delete provider
              </Button>
            </Form>
          </div>
        </details>
      </Card>

      <Tabs
        tabs={TAB_ITEMS.map((t) => t.label)}
        active={TAB_ITEMS.find((t) => t.value === tab)?.label ?? "API Keys"}
        onChange={(label) => {
          const item = TAB_ITEMS.find((t) => t.label === label);
          if (item) setTab(item.value);
        }}
        className="mb-6"
      />

      {tab === "keys" ? (
        <>
        <Card className="mb-6">
          <CardHeader>
            <CardTitle>Outbound Proxy</CardTitle>
          </CardHeader>
          <p className="mb-4 text-xs text-muted-foreground">
            Assign a whole pool (grouping + auto-management: distribute &amp; rotation)
            or pick a single proxy straight from the list. Applies to the whole provider,
            even with no (or a single) API key. Priority: client key pool → account
            pool → provider assignment → global → direct.
          </p>

          <div className="grid gap-4 md:grid-cols-2">
            <Form method="post" className="flex items-end gap-2">
              <input type="hidden" name="intent" value="set-provider-pool" />
              <div className="min-w-0 flex-1">
                <Label htmlFor="provider-pool">
                  Provider proxy / pool (all keys share)
                </Label>
                <Select
                  key={providerSelected}
                  id="provider-pool"
                  name="pool_id"
                  defaultValue={providerSelected}
                >
                  <option value="">None (direct)</option>
                  {pools.map((p) => (
                    <option key={`pool-${p.id}`} value={p.id}>
                      [pool] {p.name} ({p.proxy_ids.length} · {p.strategy})
                    </option>
                  ))}
                  <option disabled>--- or single proxy ---</option>
                  {proxies.map((p) => (
                    <option key={`px-${p.id}`} value={`proxy:${p.id}`}>
                      [proxy] {p.host}:{p.port}
                      {p.is_active ? "" : " (inactive)"}
                    </option>
                  ))}
                </Select>
              </div>
              <Button type="submit" size="sm">Save</Button>
            </Form>

            <Form method="post" className="flex flex-col gap-2">
              <input type="hidden" name="intent" value="distribute" />
              <input type="hidden" name="source_type" value={distSource} />
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Label htmlFor="distribute-source" className="mb-0">
                  Distribute proxies across accounts
                </Label>
                <div className="inline-flex rounded-lg border border-border bg-surface-2/70 p-0.5 text-[11px]">
                  {(
                    [
                      { value: "pool", label: "Pool" },
                      { value: "list", label: "All active" },
                    ] as const
                  ).map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => setDistSource(opt.value)}
                      className={`cursor-pointer rounded-md px-2 py-0.5 font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 ${
                        distSource === opt.value
                          ? "bg-surface text-foreground shadow-xs"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex items-end gap-2">
                <div className="min-w-0 flex-1">
                  {distSource === "pool" ? (
                    <Select id="distribute-source" name="pool_id" defaultValue="">
                      <option value="">Select source pool</option>
                      {pools.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name} ({p.proxy_ids.length} proxies)
                        </option>
                      ))}
                    </Select>
                  ) : (
                    <div className="flex h-9 items-center rounded-lg border border-border bg-surface-2/60 px-3 text-xs text-muted-foreground">
                      All active proxies in list ({activeProxies})
                    </div>
                  )}
                </div>
                <Button type="submit" size="sm" variant="secondary">
                  Distribute
                </Button>
              </div>
            </Form>
          </div>

          {actionData && "distribute" in actionData && actionData.distribute ? (
            <div
              className={`mt-4 rounded-lg px-3 py-2 text-xs ${
                actionData.distribute.ok
                  ? "bg-success/10 text-success"
                  : "bg-danger/10 text-danger"
              }`}
            >
              <p className="font-medium">{actionData.distribute.message}</p>
              {actionData.distribute.rows.length > 0 ? (
                <ul className="mt-1 list-disc pl-4 font-mono">
                  {actionData.distribute.rows.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>API Keys ({keys.length})</CardTitle>
            <Button type="button" onClick={() => setAddOpen(true)}>
              <Plus size={16} />
              Add API Key
            </Button>
          </CardHeader>

          {addOpen ? (
            <Form
              id="add-key-form"
              method="post"
              onSubmit={handleAddSubmit}
              className="mb-4 rounded-lg border border-primary/30 bg-primary/5 p-4"
            >
              <input type="hidden" name="intent" value="add-key" />
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div>
                  <Label htmlFor="add-key-label">Label (optional)</Label>
                  <Input
                    id="add-key-label"
                    name="label"
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    placeholder="e.g. primary-account"
                  />
                </div>
                <div className="sm:col-span-2">
                  <Label htmlFor="add-key-value">API Key</Label>
                  <Input
                    id="add-key-value"
                    name="api_key"
                    type="password"
                    autoComplete="new-password"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder="sk-..."
                    className="font-mono"
                  />
                </div>
              </div>
              <div className="mt-3 flex gap-2">
                <Button type="submit">Save</Button>
                <Button type="button" variant="outline" onClick={() => setAddOpen(false)}>
                  Cancel
                </Button>
              </div>
            </Form>
          ) : null}

          {keys.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No API keys yet. Add one to activate this provider.
            </p>
          ) : (
            <div className="space-y-3">
              {keys.map((key) => (
                <div
                  key={key.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-4"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="font-medium text-foreground">
                        {key.label || `Key #${key.id}`}
                      </p>
                      {key.is_routing ? (
                        <Badge tone="info">
                          <ShieldCheck size={12} />
                          routing
                        </Badge>
                      ) : null}
                      {!key.is_active ? <Badge tone="neutral">inactive</Badge> : null}
                    </div>
                    <p className="mt-0.5 font-mono text-xs text-muted-foreground">
                      <MaskedKey value={key.api_key} />
                    </p>
                  </div>

                  <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
                    <KeyTestButton
                      fetcher={fetcher}
                      keyId={key.id}
                      result={testResult && testResult.okId === key.id ? testResult : undefined}
                    />

                    {key.is_routing ? null : (
                      <Form method="post" className="w-full sm:w-auto">
                        <input type="hidden" name="intent" value="route-key" />
                        <input type="hidden" name="key_id" value={key.id} />
                        <Button
                          type="submit"
                          variant="outline"
                          className="h-9 w-full gap-1.5 px-3 text-xs sm:h-8 sm:w-auto sm:px-3"
                          title="Make this key the routing credential"
                        >
                          Set as routing
                        </Button>
                      </Form>
                    )}

                    <Form method="post" className="w-full sm:w-auto">
                      <input type="hidden" name="intent" value="active-key" />
                      <input type="hidden" name="key_id" value={key.id} />
                      <input type="hidden" name="is_active" value={key.is_active ? 0 : 1} />
                      <Button
                        type="submit"
                        variant="outline"
                        className="h-9 w-full gap-1.5 px-3 text-xs sm:h-8 sm:w-auto sm:px-3"
                      >
                        {key.is_active ? "Deactivate" : "Activate"}
                      </Button>
                    </Form>

                    <div className="flex w-full items-center gap-2 sm:ml-auto sm:w-auto">
                      <button
                        type="button"
                        title={proxyInfoFor(key).detail}
                        aria-label={`Proxy for ${key.label || `key #${key.id}`}`}
                        onClick={() => {
                          setPickerQuery("");
                          setPicker({
                            keyId: key.id,
                            label: key.label || `Key #${key.id}`,
                          });
                        }}
                        className={`inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-lg border text-xs font-medium transition-colors sm:h-8 sm:w-8 sm:text-sm ${
                          PROXY_TONE_CLASS[proxyInfoFor(key).tone]
                        }`}
                      >
                        <Globe size={14} />
                        <span className="sm:hidden">
                          {proxyInfoFor(key).tone === "ok"
                            ? "Proxy"
                            : proxyInfoFor(key).tone === "error"
                              ? "Proxy error"
                              : "Set proxy"}
                        </span>
                      </button>
                      <Form
                        method="post"
                        className="w-full sm:w-auto"
                        onSubmit={handleDeleteKey}
                      >
                        <input type="hidden" name="intent" value="delete-key" />
                        <input type="hidden" name="key_id" value={key.id} />
                        <Button
                          type="submit"
                          variant="danger"
                          className="h-9 w-full gap-1 px-3 text-xs sm:h-8 sm:w-auto sm:px-2"
                          aria-label={`Delete key #${key.id}`}
                        >
                          <Trash2 size={14} />
                          <span className="sm:hidden">Delete</span>
                        </Button>
                      </Form>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
        </>
      ) : tab === "models" ? (
        <Card>
          <CardHeader>
            <CardTitle>Models ({models.length})</CardTitle>
            <div className="flex flex-wrap items-center gap-2">
              {missingModels.length > 0 ? (
                <Form method="post">
                  <input type="hidden" name="intent" value="sync-models" />
                  <Button type="submit" size="sm" variant="outline">
                    <RefreshCw size={16} />
                    Sync registry ({missingModels.length})
                  </Button>
                </Form>
              ) : null}
              <fetcher.Form method="post">
                <input type="hidden" name="intent" value="fetch-remote-models" />
                <Button
                  type="submit"
                  size="sm"
                  variant="outline"
                  disabled={fetcher.state !== "idle"}
                >
                  {fetcher.state !== "idle" &&
                  fetcher.formData?.get("intent") === "fetch-remote-models" ? (
                    <Spinner size={16} />
                  ) : (
                    <Download size={16} />
                  )}
                  Import available
                </Button>
              </fetcher.Form>
              <Button
                type="button"
                size="sm"
                onClick={() => setAddModelOpen((v) => !v)}
              >
                <Plus size={16} />
                Add custom
              </Button>
            </div>
          </CardHeader>

          {addModelOpen ? (
            <fetcher.Form
              method="post"
              className="mb-4 rounded-lg border border-primary/30 bg-primary/5 p-4"
              onSubmit={() => {
                setAddModelOpen(false);
                setNewModelName("");
                setNewModelContext("");
                setNewModelPrimary(false);
                setNewModelDisplay("");
              }}
            >
              <input type="hidden" name="intent" value="add-model" />
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="sm:col-span-1">
                  <Label htmlFor="custom-model-name">Model name (upstream)</Label>
                  <Input
                    id="custom-model-name"
                    name="model_name"
                    value={newModelName}
                    onChange={(e) => setNewModelName(e.target.value)}
                    placeholder="e.g. gpt-4o-mini"
                    required
                  />
                </div>
                <div>
                  <Label htmlFor="custom-model-display">Custom display name (optional)</Label>
                  <Input
                    id="custom-model-display"
                    name="display_name"
                    value={newModelDisplay}
                    onChange={(e) => setNewModelDisplay(e.target.value)}
                    placeholder={cleanPfx && newModelName.trim() ? `${cleanPfx}/${newModelName.trim()}` : "Leave blank for default"}
                  />
                </div>
                <div>
                  <Label htmlFor="custom-model-context">Context length</Label>
                  <Input
                    id="custom-model-context"
                    name="context_length"
                    type="number"
                    min={1}
                    value={newModelContext}
                    onChange={(e) => setNewModelContext(e.target.value)}
                    placeholder="e.g. 128000"
                  />
                </div>
                <div className="flex items-end pb-1">
                  <label className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
                    <Checkbox
                      name="is_primary"
                      value="1"
                      checked={newModelPrimary}
                      onChange={(e) => setNewModelPrimary(e.target.checked)}
                    />
                    Set as primary
                  </label>
                </div>
              </div>
              {newModelName.trim() ? (
                <p className="mt-2 text-xs text-muted-foreground">
                  Exposed as:{" "}
                  <span className="font-mono text-foreground">
                    {newModelDisplay.trim() || (cleanPfx ? `${cleanPfx}/${newModelName.trim()}` : newModelName.trim())}
                  </span>
                  {newModelDisplay.trim() ? (
                    <span> (custom alias; upstream ID remains <span className="font-mono">{newModelName.trim()}</span>)</span>
                  ) : null}
                </p>
              ) : null}
              <div className="mt-3 flex gap-2">
                <Button type="submit" disabled={!newModelName.trim()}>
                  Save model
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setAddModelOpen(false)}
                >
                  Cancel
                </Button>
              </div>
            </fetcher.Form>
          ) : null}

          {importOpen && fetcher.data?.remoteModels?.ok ? (
            <fetcher.Form
              method="post"
              className="mb-4 rounded-lg border border-border bg-muted/30 p-4"
              onSubmit={() => {
                setImportOpen(false);
                setSelectedRemote({});
                setImportQuery("");
              }}
            >
              <input type="hidden" name="intent" value="import-models" />
              {Object.entries(selectedRemote)
                .filter(([, checked]) => checked)
                .map(([mid]) => (
                  <input key={mid} type="hidden" name="model_id" value={mid} />
                ))}
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-sm font-medium text-foreground">
                    Available models
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {fetcher.data.remoteModels.message}. Select models to add to
                    this provider.
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      const next: Record<string, boolean> = {};
                      for (const m of filteredRemote) {
                        if (!m.alreadyAdded) next[m.id] = true;
                      }
                      setSelectedRemote((prev) => ({ ...prev, ...next }));
                    }}
                  >
                    Select new
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => setSelectedRemote({})}
                  >
                    Clear
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => setImportOpen(false)}
                  >
                    Close
                  </Button>
                </div>
              </div>
              <div className="mb-2">
                <Input
                  controlSize="sm"
                  type="search"
                  value={importQuery}
                  onChange={(e) => setImportQuery(e.target.value)}
                  placeholder="Type to search models…"
                />
                {iq ? (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {filteredRemote.length} of {remoteModels.length} match
                  </p>
                ) : null}
              </div>
              <div className="mb-3 max-h-64 space-y-2 overflow-y-auto rounded-md border border-border p-2">
                {remoteModels.length === 0 ? (
                  <p className="py-4 text-center text-sm text-muted-foreground">
                    No models returned by provider.
                  </p>
                ) : filteredRemote.length === 0 ? (
                  <p className="py-4 text-center text-sm text-muted-foreground">
                    No models match “{importQuery.trim()}”.
                  </p>
                ) : (
                  filteredRemote.map((m) => (
                    <label
                      key={m.id}
                      className="flex cursor-pointer items-center justify-between gap-3 rounded-md px-2 py-1.5 hover:bg-background"
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <Checkbox
                          checked={Boolean(selectedRemote[m.id])}
                          onChange={(e) =>
                            setSelectedRemote((prev) => ({
                              ...prev,
                              [m.id]: e.target.checked,
                            }))
                          }
                        />
                        <span className="truncate font-mono text-sm text-foreground">
                          {m.id}
                        </span>
                        {m.alreadyAdded ? (
                          <Badge tone="neutral">added</Badge>
                        ) : null}
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {m.contextLength
                          ? `${Math.round(m.contextLength / 1000)}k`
                          : "-"}
                      </span>
                    </label>
                  ))
                )}
              </div>
              <Button
                type="submit"
                size="sm"
                disabled={
                  !Object.values(selectedRemote).some(Boolean) ||
                  fetcher.state !== "idle"
                }
              >
                <Download size={16} />
                Import selected (
                {Object.values(selectedRemote).filter(Boolean).length})
              </Button>
            </fetcher.Form>
          ) : null}

          {models.length > 0 ? (
            <div className="mb-4 flex items-center gap-2">
              <Input
                controlSize="sm"
                type="search"
                value={modelFilter}
                onChange={(e) => setModelFilter(e.target.value)}
                placeholder={`Filter ${models.length} models…`}
                className="max-w-xs"
              />
              {modelFilter ? (
                <Button type="button" size="sm" variant="ghost" onClick={() => setModelFilter("")}>
                  Clear
                </Button>
              ) : null}
            </div>
          ) : null}

          {models.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No models yet. Add a custom model, import from the provider, or sync
              the registry.
            </p>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {models
                .filter((m) => {
                  const mq = modelFilter.trim().toLowerCase();
                  if (!mq) return true;
                  return (
                    modelDisplay(m).toLowerCase().includes(mq) ||
                    m.model_name.toLowerCase().includes(mq)
                  );
                })
                .map((m) => {
                const disp = modelDisplay(m);
                const isCustom = Boolean((m.display_name ?? "").trim());
                const showBare = disp !== m.model_name;
                return (
                <div
                  key={m.id}
                  className="flex flex-col justify-between rounded-lg border border-border bg-surface-2/40 p-3.5"
                >
                  <div>
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1">
                        <p
                          title={disp}
                          className="truncate font-mono text-sm font-semibold text-foreground"
                        >
                          {disp}
                        </p>
                        {showBare ? (
                          <p
                            title={m.model_name}
                            className="mt-0.5 truncate font-mono text-xs text-muted-foreground"
                          >
                            upstream: {m.model_name}
                          </p>
                        ) : null}
                        <p className="mt-1 text-xs text-muted-foreground">
                          {m.context_length
                            ? `${Math.round(m.context_length / 1000)}k context`
                            : "Unknown context"}
                        </p>
                      </div>
                      <div className="flex shrink-0 flex-col items-end gap-1">
                        {m.is_primary ? (
                          <Badge tone="info">primary</Badge>
                        ) : null}
                        {isCustom ? (
                          <Badge tone="primary">alias</Badge>
                        ) : null}
                        {!m.is_active ? (
                          <Badge tone="neutral">inactive</Badge>
                        ) : null}
                      </div>
                    </div>
                    {editingDisplayId === m.id ? (
                      <Form method="post" className="mt-2.5 flex flex-wrap gap-1.5" onSubmit={() => setEditingDisplayId(null)}>
                        <input type="hidden" name="intent" value="set-model-display" />
                        <input type="hidden" name="model_id" value={m.id} />
                        <Input
                          controlSize="sm"
                          name="display_name"
                          defaultValue={m.display_name ?? ""}
                          placeholder={cleanPfx ? `${cleanPfx}/${m.model_name}` : m.model_name}
                          className="font-mono"
                        />
                        <Button type="submit" size="sm">Save</Button>
                        <Button type="button" size="sm" variant="outline" onClick={() => setEditingDisplayId(null)}>
                          Cancel
                        </Button>
                      </Form>
                    ) : null}
                  </div>
                  <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-border/60 pt-2.5">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => setEditingDisplayId(editingDisplayId === m.id ? null : m.id)}
                    >
                      {isCustom ? "Edit alias" : "Alias"}
                    </Button>
                    {isCustom ? (
                      <Form method="post">
                        <input type="hidden" name="intent" value="set-model-display" />
                        <input type="hidden" name="model_id" value={m.id} />
                        <input type="hidden" name="display_name" value="" />
                        <Button type="submit" size="sm" variant="outline" title="Reset to default prefix/model_name">
                          Reset
                        </Button>
                      </Form>
                    ) : null}
                    {!m.is_primary ? (
                      <Form method="post">
                        <input
                          type="hidden"
                          name="intent"
                          value="set-primary-model"
                        />
                        <input type="hidden" name="model_id" value={m.id} />
                        <Button type="submit" size="sm" variant="outline">
                          Primary
                        </Button>
                      </Form>
                    ) : null}
                    <Form method="post">
                      <input type="hidden" name="intent" value="toggle-model" />
                      <input type="hidden" name="model_id" value={m.id} />
                      <input
                        type="hidden"
                        name="is_active"
                        value={m.is_active ? 0 : 1}
                      />
                      <Button type="submit" size="sm" variant="outline">
                        {m.is_active ? "Disable" : "Enable"}
                      </Button>
                    </Form>
                    <Form
                      method="post"
                      className="ml-auto"
                      onSubmit={(e) => {
                        e.preventDefault();
                        const form = e.currentTarget;
                        void confirm({
                          title: "Remove model?",
                          description: `Remove "${disp}" from ${provider.name}?`,
                          confirmLabel: "Remove",
                          variant: "danger",
                        }).then((ok) => {
                          if (ok) submit(form);
                        });
                      }}
                    >
                      <input type="hidden" name="intent" value="delete-model" />
                      <input type="hidden" name="model_id" value={m.id} />
                      <Button
                        type="submit"
                        size="icon"
                        variant="danger"
                        aria-label={`Delete ${m.model_name}`}
                        title={`Delete ${m.model_name}`}
                      >
                        <Trash2 size={13} />
                      </Button>
                    </Form>
                  </div>
                </div>
                );
              })}
            </div>
          )}
        </Card>
      ) : (
        <div className="glass-panel grid min-h-[480px] overflow-hidden lg:h-[calc(100vh-310px)] lg:min-h-[440px] lg:max-h-[680px] lg:grid-cols-[260px_minmax(0,1fr)]">
          {/* Left rail: saved conversations */}
          <aside className="flex flex-col border-b border-border bg-surface-2/40 lg:border-r lg:border-b-0">
            <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2.5">
              <div className="flex items-center gap-2">
                <MessageSquare size={14} className="text-muted-foreground" aria-hidden="true" />
                <span className="text-xs font-semibold text-foreground">
                  Conversations
                </span>
                <span className="rounded bg-surface px-1.5 py-0.5 font-mono text-[11px] tabular-nums text-muted-foreground">
                  {loaderData.chatSessions.length}
                </span>
              </div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={stream.streaming}
                title="Start a fresh conversation"
                onClick={() => {
                  setChatSessionId(null);
                  setTurns([]);
                  setPrompt("");
                }}
              >
                <Plus size={13} aria-hidden="true" />
                New
              </Button>
            </div>

            <div className="slim-scroll max-h-40 flex-1 overflow-y-auto p-2 lg:max-h-none">
              {chatLoadFetcher.state !== "idle" ? (
                <div className="flex items-center gap-2 px-2 py-2 text-xs text-muted-foreground">
                  <Spinner size={12} /> Loading conversation...
                </div>
              ) : null}
              {loaderData.chatSessions.length === 0 ? (
                <p className="px-2 py-6 text-center text-xs text-muted-foreground">
                  No saved conversations yet. Send a message to start one.
                </p>
              ) : (
                <div className="space-y-1">
                  {loaderData.chatSessions.map((sess) => {
                    const active = sess.id === chatSessionId;
                    return (
                      <div
                        key={sess.id}
                        className={`group flex items-center gap-1 rounded-lg border px-2.5 py-2 transition-colors ${
                          active
                            ? "border-primary/35 bg-primary/10"
                            : "border-transparent hover:border-border hover:bg-surface"
                        }`}
                      >
                        <button
                          type="button"
                          onClick={() => loadChat(sess.id)}
                          className="min-w-0 flex-1 text-left"
                        >
                          <span
                            className={`block truncate text-xs ${
                              active
                                ? "font-semibold text-primary"
                                : "font-medium text-foreground"
                            }`}
                          >
                            {sess.title}
                          </span>
                          <span className="mt-0.5 block truncate font-mono text-[11px] text-muted-foreground">
                            {fmtTs(sess.updated_at)}
                          </span>
                        </button>
                        <button
                          type="button"
                          aria-label={`Delete chat ${sess.title}`}
                          title="Delete chat"
                          onClick={() => void deleteChat(sess.id)}
                          className="grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted-foreground opacity-70 transition-colors hover:bg-danger/12 hover:text-danger hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                        >
                          <Trash2 size={13} aria-hidden="true" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </aside>

          {/* Right main pane: toolbar + stream + docked composer */}
          <div className="flex min-h-[420px] min-w-0 flex-col bg-surface">
            {/* Integrated chat toolbar */}
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-surface-2/30 px-4 py-2.5">
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <Label htmlFor="chat-model" className="mb-0 shrink-0 text-xs">
                  Model
                </Label>
                <Select
                  id="chat-model"
                  controlSize="sm"
                  value={chatModel}
                  onChange={(e) => setChatModel(e.target.value)}
                  className="max-w-[280px] font-mono"
                >
                  {models.length === 0 ? (
                    <option value="">No models configured</option>
                  ) : (
                    models.map((m) => (
                      <option key={m.id} value={modelDisplay(m)}>
                        {modelDisplay(m)}
                      </option>
                    ))
                  )}
                </Select>
              </div>

              <div className="flex shrink-0 items-center gap-3">
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  Auto-save
                  <Toggle
                    checked={autoSave}
                    label="Auto-save chats"
                    onChange={() => {
                      const next = !autoSave;
                      setAutoSave(next);
                      try {
                        localStorage.setItem("uniroute-chat-autosave", next ? "1" : "0");
                      } catch {
                        /* ignore */
                      }
                    }}
                  />
                </label>
                {history.length > 0 && !stream.streaming ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      setChatSessionId(null);
                      setTurns([]);
                    }}
                  >
                    Clear view
                  </Button>
                ) : null}
              </div>
            </div>

            {/* Messages viewport */}
            <div
              ref={chatScrollRef}
              className="slim-scroll flex-1 space-y-5 overflow-y-auto px-4 py-5 sm:px-6"
            >
              {history.length === 0 && !stream.streaming ? (
                <div className="mx-auto flex h-full max-w-md flex-col items-center justify-center py-8 text-center">
                  <div className="grid h-11 w-11 place-items-center rounded-lg border border-border bg-surface-2 text-primary">
                    <MessageSquare size={20} aria-hidden="true" />
                  </div>
                  <h3 className="mt-3 text-sm font-semibold text-foreground">
                    Test {chatModel || provider.name}
                  </h3>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    Send a live completion request routed through this provider.
                    {autoSave ? " Conversations save automatically." : ""}
                  </p>
                  {models.length > 0 ? (
                    <div className="mt-4 flex flex-wrap justify-center gap-2">
                      {[
                        "Reply with OK and confirm your model name.",
                        "Write a concise TypeScript debounce helper.",
                        "Summarize SSE streaming response chunks in 3 bullets.",
                      ].map((sample) => (
                        <button
                          key={sample}
                          type="button"
                          onClick={() => setPrompt(sample)}
                          className="rounded-lg border border-border bg-surface-2/60 px-3 py-1.5 text-left text-xs text-foreground transition-colors hover:border-border-strong hover:bg-surface-2"
                        >
                          {sample}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}

              {history.map((m, idx) => {
                const isUser = m.role === "user";
                if (isUser) {
                  return (
                    <div key={idx} className="flex justify-end">
                      <div className="max-w-[85%] rounded-lg rounded-br-sm border border-primary-solid-border bg-primary-solid px-4 py-2.5 text-sm leading-relaxed text-primary-foreground sm:max-w-[76%]">
                        <p className="whitespace-pre-wrap break-words">{m.content}</p>
                      </div>
                    </div>
                  );
                }

                const secs = formatSecs(m.ms);
                const tps = estimateTps(m.content.length, m.ms);
                const clock = formatClock(
                  m.created_at != null ? m.created_at * 1000 : null,
                );
                const metaParts = [
                  m.model,
                  secs,
                  tps != null ? `~${tps} tok/s` : null,
                  clock,
                ].filter(Boolean);

                return (
                  <div key={idx} className="flex justify-start">
                    <div className="min-w-0 max-w-full flex-1 rounded-lg border border-border bg-surface-2/40 px-4 py-3">
                      <div className="mb-2 flex items-center justify-between gap-2 border-b border-border/60 pb-1.5">
                        <span className="font-mono text-[11px] font-medium text-muted-foreground">
                          {m.model || chatModel || provider.name}
                        </span>
                        <CopyButton
                          text={m.content}
                          label="Copy response"
                          className="h-7 w-7 shrink-0"
                        />
                      </div>
                      {m.thinking ? (
                        <details className="mb-2.5 rounded-lg border border-info/25 bg-info/8 px-3 py-2">
                          <summary className="flex items-center gap-1.5 text-xs font-medium text-info">
                            <Brain size={12} />
                            Thought process
                          </summary>
                          <div className="mt-1.5 max-h-48 overflow-y-auto whitespace-pre-wrap break-words text-xs leading-relaxed text-muted-foreground">
                            {m.thinking}
                          </div>
                        </details>
                      ) : null}
                      <Markdown text={m.content} />
                      {metaParts.length > 0 ? (
                        <p className="mt-2.5 border-t border-border/50 pt-1.5 font-mono text-[11px] tabular-nums text-muted-foreground">
                          {metaParts.join(" · ")}
                        </p>
                      ) : null}
                    </div>
                  </div>
                );
              })}

              {stream.streaming ? (
                <div className="flex justify-start">
                  <div className="min-w-0 max-w-full flex-1 rounded-lg border border-primary/35 bg-surface-2/40 px-4 py-3">
                    <div className="mb-2 flex items-center gap-2 border-b border-border/60 pb-1.5">
                      <Spinner size={12} />
                      <span className="font-mono text-[11px] font-medium text-primary">
                        {chatModel || provider.name}
                      </span>
                    </div>
                    <StreamingResponse
                      content={stream.response}
                      streaming={stream.streaming}
                      done={stream.done}
                      error={stream.error}
                      thinking={stream.thinking}
                      usage={stream.usage}
                      latencyMs={
                        streamStartRef.current
                          ? Date.now() - streamStartRef.current
                          : null
                      }
                    />
                  </div>
                </div>
              ) : null}
            </div>

            {/* Unified docked composer */}
            <div className="border-t border-border bg-surface-2/25 p-3 sm:p-4">
              <div className="overflow-hidden rounded-lg border border-border bg-surface transition-colors focus-within:border-primary focus-within:ring-2 focus-within:ring-ring/25">
                <MessageInput
                  id="chat-composer"
                  embedded
                  value={prompt}
                  onChange={setPrompt}
                  onSubmit={sendChat}
                  disabled={stream.streaming || models.length === 0}
                  placeholder={
                    models.length === 0
                      ? "Add at least one model to start chatting..."
                      : stream.streaming
                        ? "Generating response..."
                        : `Send a message to ${chatModel || provider.name}...`
                  }
                />
                <div className="flex items-center justify-between gap-2 border-t border-border/60 bg-surface-2/40 px-3 py-2">
                  <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                    <span className="hidden sm:inline">
                      <kbd className="rounded border border-border bg-surface px-1 py-0.5 font-mono text-[10px]">
                        Enter
                      </kbd>{" "}
                      to send,{" "}
                      <kbd className="rounded border border-border bg-surface px-1 py-0.5 font-mono text-[10px]">
                        Shift+Enter
                      </kbd>{" "}
                      for newline
                    </span>
                    {prompt.length > 0 ? (
                      <span className="font-mono tabular-nums">
                        {prompt.length.toLocaleString()} chars
                      </span>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-2">
                    {stream.streaming ? (
                      <Button
                        type="button"
                        variant="danger"
                        size="sm"
                        onClick={stream.stop}
                      >
                        <Square size={12} aria-hidden="true" />
                        Stop
                      </Button>
                    ) : (
                      <Button
                        type="button"
                        variant="primary"
                        size="sm"
                        disabled={!prompt.trim() || models.length === 0}
                        onClick={sendChat}
                      >
                        <Send size={13} aria-hidden="true" />
                        Send
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {picker ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`Pick proxy - ${picker.label}`}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-4 backdrop-blur-[2px]"
          onClick={() => setPicker(null)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setPicker(null);
          }}
        >
          <div
            className="dialog-pop flex max-h-[80vh] w-full max-w-lg flex-col overflow-hidden rounded-lg border border-border-strong bg-surface shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="border-b border-border bg-surface-2/40 px-4 py-3.5">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <h3 className="text-sm font-semibold text-foreground">
                    Pick proxy - {picker.label}
                  </h3>
                  <p className="mt-0.5 mb-2.5 text-xs text-muted-foreground">
                    Click a proxy to assign it. Click the active one again (or Clear) to
                    unassign.
                  </p>
                </div>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  aria-label="Close modal"
                  onClick={() => setPicker(null)}
                  className="-mt-1 -mr-1 shrink-0"
                >
                  <X size={15} aria-hidden="true" />
                </Button>
              </div>
              <Input
                controlSize="sm"
                autoFocus
                type="search"
                value={pickerQuery}
                onChange={(e) => setPickerQuery(e.target.value)}
                placeholder="Search name / host:port..."
              />
              {pickerQuery.trim() ? (
                <p className="mt-1.5 text-xs text-muted-foreground">
                  {filteredProxies.length} of {proxies.length} proxies match
                </p>
              ) : null}
            </div>

            <div className="slim-scroll flex-1 overflow-y-auto p-2">
              {filteredProxies.map((p) => {
                const isSelected = pickerSelected === p.id;
                const usable = p.is_active;
                return (
                  <Form
                    key={p.id}
                    method="post"
                    onSubmit={() => setTimeout(() => setPicker(null), 0)}
                  >
                    <input type="hidden" name="intent" value="set-key-proxy" />
                    <input type="hidden" name="key_id" value={picker.keyId} />
                    <input
                      type="hidden"
                      name="proxy_id"
                      value={isSelected ? "" : p.id}
                    />
                    <button
                      type="submit"
                      disabled={!usable && !isSelected}
                      title={
                        p.is_active
                          ? `${p.type} · ${p.success_count} ok / ${p.fail_count} fail`
                          : "Proxy is inactive"
                      }
                      className={`mb-1 flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                        isSelected
                          ? "border-primary bg-primary/10"
                          : "border-transparent hover:bg-surface-2"
                      } ${!usable ? "opacity-50" : ""}`}
                    >
                      <span
                        className={`inline-block h-2 w-2 shrink-0 rounded-full ${
                          p.is_active ? "bg-success" : "bg-danger"
                        }`}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-mono text-xs text-foreground">
                          {p.host}:{p.port}
                        </span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {p.type}
                          {p.last_latency_ms != null
                            ? ` · ${p.last_latency_ms}ms`
                            : ""}
                          {p.last_error ? ` · ${p.last_error.slice(0, 60)}` : ""}
                        </span>
                      </span>
                      {!p.is_active ? (
                        <Badge tone="danger">disabled</Badge>
                      ) : null}
                      {isSelected ? (
                        <CheckCircle2 size={16} className="shrink-0 text-primary" />
                      ) : null}
                    </button>
                  </Form>
                );
              })}
              {filteredProxies.length === 0 ? (
                <p className="py-6 text-center text-xs text-muted-foreground">
                  {proxies.length === 0
                    ? "No proxies yet. Add some in the Proxies page first."
                    : `No proxies match "${pickerQuery.trim()}".`}
                </p>
              ) : null}
            </div>

            <div className="flex items-center justify-between gap-2 border-t border-border bg-surface-2/40 px-4 py-3">
              <Form method="post" onSubmit={() => setTimeout(() => setPicker(null), 0)}>
                <input type="hidden" name="intent" value="set-key-proxy" />
                <input type="hidden" name="key_id" value={picker.keyId} />
                <input type="hidden" name="proxy_id" value="" />
                <Button type="submit" size="sm" variant="danger">
                  Clear assignment
                </Button>
              </Form>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setPicker(null)}
              >
                Done
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {dialog}
    </div>
  );
}

function KeyTestButton({
  keyId,
  result: externalResult,
}: {
  fetcher?: ReturnType<typeof useFetcher>;
  keyId: number;
  result?: { ok: boolean; message: string };
}) {
  const localFetcher = useFetcher<{
    test?: { ok: boolean; okId: number; message: string };
  }>();
  const pending = localFetcher.state !== "idle";
  const result =
    localFetcher.data?.test?.okId === keyId
      ? { ok: localFetcher.data.test.ok, message: localFetcher.data.test.message }
      : externalResult;
  return (
    <div className="flex items-center gap-2">
      {result ? (
        <span
          className={`flex items-center gap-1 text-xs ${
            result.ok ? "text-success" : "text-danger"
          }`}
          title={result.message}
        >
          {result.ok ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
          {result.ok ? "OK" : "Failed"}
        </span>
      ) : null}
      <localFetcher.Form method="post" className="w-full sm:w-auto">
        <input type="hidden" name="intent" value="test-key" />
        <input type="hidden" name="key_id" value={keyId} />
        <Button
          type="submit"
          variant="outline"
          size="sm"
          disabled={pending}
          className="w-full gap-1.5 sm:w-auto"
        >
          {pending ? <Spinner size={14} /> : <Plug size={14} />}
          Test
        </Button>
      </localFetcher.Form>
    </div>
  );
}