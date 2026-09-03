import { Form, Link, redirect, useFetcher } from "react-router";
import { useEffect, useRef, useState } from "react";
import type { Route } from "./+types/providers.$id";
import { getRegistryEntry } from "~/registry";
import type { RegistryEntry } from "~/types";
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
import { Input, Label, Select } from "../components/ui/field";
import { Tabs } from "../components/ui/tabs";
import { Toggle } from "../components/ui/toggle";
import {
  ArrowLeft,
  Plug,
  Trash2,
  Plus,
  RefreshCw,
  Download,
  Send,
  Square,
  CheckCircle2,
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

export async function loader({ params }: Route.LoaderArgs) {
  const provider = query(
    "SELECT id, name, base_url, auth_type, is_active, prefix FROM providers WHERE id = ?",
  ).get(params.id) as ProviderRow | undefined;

  const keys = provider ? listApiKeys(provider.id) : [];
  let models: ModelRow[] = [];
  if (provider) {
    try {
      models = query(
        "SELECT id, model_name, display_name, context_length, is_active, is_primary FROM models WHERE provider_id = ? ORDER BY is_primary DESC, id",
      ).all(provider.id) as unknown as ModelRow[];
    } catch {
      // DB lama belum punya kolom display_name
      models = query(
        "SELECT id, model_name, context_length, is_active, is_primary FROM models WHERE provider_id = ? ORDER BY is_primary DESC, id",
      ).all(provider.id) as unknown as ModelRow[];
    }
  }

  const pools = listPools();
  const activeProxies = listProxies(true).length;
  const proxies = listProxies();
  const chatSessions = provider ? listSessions(provider.id) : [];

  // Assignment provider aktif: pool biasa atau singleton single-proxy.
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
      entry?.modelsUrl ??
      new URL("/v1/models", provider.base_url).toString();

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

  // Semua key provider ini memakai pool yang sama (level provider).
  // Nilai "proxy:<id>" berarti memakai SATU proxy langsung dari list —
  // dibungkus pool singleton agar pipeline routing tidak berubah.
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

  // Satu akun (provider_credentials) memakai pool sendiri.
  if (intent === "set-key-pool") {
    const keyId = Number(form.get("key_id"));
    const raw = String(form.get("pool_id") || "");
    setApiKeyProxyPool(keyId, raw ? Number(raw) : null);
    return {
      savedPool: true,
      notice: { ok: true, message: "Account proxy saved" },
    };
  }

  // Pilih SATU proxy spesifik untuk satu akun — disimpan sebagai pool
  // singleton "auto · <id> · key-<keyId>" agar pipeline routing lama tetap
  // berfungsi. Tanpa proxy_id = lepas assignment.
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

  // Distribusi otomatis: bagi proxy aktif (dari satu pool ATAU seluruh daftar
  // proxy) secara round-robin ke semua akun aktif provider. Pool otomatis
  // bernama "auto · <id> · acct-N" dibuat/diperbarui & ditautkan per akun.
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
    // Dynamic import: modul .server tidak boleh masuk graf client bundle.
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
      return { modelsAction: { ok: false, message: "DB belum mendukung display_name" } };
    }
    reload();
    return {
      modelsAction: { ok: true, message: customDisplay ? `Display name → ${customDisplay}` : "Display name dikosongkan (kembali ke prefix/nama)" },
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

    const { upsertProviderModel, fetchProviderModelsList } = await import(
      "../.server/provider-models"
    );
    const fetched = await fetchProviderModelsList(id);
    const contextById = new Map<string, number | null>();
    if (fetched.ok) {
      for (const m of fetched.models) contextById.set(m.id, m.contextLength);
    }

    let created = 0;
    let updated = 0;
    for (const name of selected) {
      const ctx = contextById.has(name)
        ? (contextById.get(name) ?? null)
        : parseContextLength(form.get(`context_${name}`));
      const result = upsertProviderModel(id, name, ctx ?? null, false);
      if (result.created) created += 1;
      else updated += 1;
    }
    reload();
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
      if (dup) return { providerUpdate: { ok: false, message: `prefix "${prefix}" sudah dipakai ${dup.id}` } };
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
    none: "border-border bg-muted text-muted-foreground hover:bg-glass-hover",
  };

  function proxyInfoFor(key: ApiKeyRow): {
    tone: Tone;
    detail: string;
    selectedId: number | null;
  } {
    if (!key.proxy_pool_id) {
      return { tone: "none", detail: "No proxy — click to pick one", selectedId: null };
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
  const [tab, setTab] = useState<"keys" | "models" | "chat">("keys");
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
  const [chatModel, setChatModel] = useState(() => {
    const first = models.find((m) => m.is_primary) ?? models[0];
    if (!first) return "";
    const pfx = (loaderData.provider?.prefix ?? "").replace(/^\/+|\/+$/g, "").trim();
    return (first.display_name ?? "").trim() || (pfx ? `${pfx}/${first.model_name}` : first.model_name);
  });
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
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const [autoSave, setAutoSave] = useState(() => {
    try {
      return localStorage.getItem("uniroute-chat-autosave") !== "0";
    } catch {
      return true;
    }
  });
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

  // Smart auto-scroll: pin ke bawah hanya bila user memang di dekat bawah.
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

  // Simpan respons: kunci session agar auto-save berikutnya UPDATE, bukan
  // membuat sesi duplikat.
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
        msgs.map((m) => ({ role: m.role, content: m.content, thinking: m.thinking ?? null })),
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

  // Commit giliran assistant tepat sekali ketika selesai + auto-save.
  useEffect(() => {
    if (!awaitingAssistantRef.current) return;
    if (!(stream.done || stream.error)) return;
    awaitingAssistantRef.current = false;
    const ms = streamStartRef.current
      ? Date.now() - streamStartRef.current
      : null;
    const assistantTurn: ChatMsg = {
      role: "assistant",
      content: stream.error ? `Error: ${stream.error}` : stream.response,
      model: chatModel,
      ms,
      thinking: stream.thinking || null,
    };
    const next: ChatMsg[] = [...historyRef.current, assistantTurn];
    setTurns(next);
    if (autoSave && !stream.error && assistantTurn.content !== "") {
      // Simpan DI LUAR updater state — updater bisa dieksekusi React
      // berkali-kali saat render konkuren → submit dobel = sesi kembar.
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
          next.map((m) => ({ role: m.role, content: m.content, thinking: m.thinking ?? null })),
        ),
      );
      chatSaveFetcher.submit(fd, { method: "post" });
    }
  }, [stream.done, stream.error]);

  const { dialog, confirm } = useConfirm();
  const { toast } = useToast();
  const lastNoticeRef = useRef<{ ok: boolean; message: string } | undefined>(
    undefined,
  );

  // Toast untuk aksi Form biasa (actionData.notice): key/model/pool/chat.
  useEffect(() => {
    const notice = (
      actionData as { notice?: { ok: boolean; message: string } } | undefined
    )?.notice;
    if (notice === lastNoticeRef.current) return;
    lastNoticeRef.current = notice;
    if (notice) {
      toast({
        title: notice.ok ? "Done" : "Action failed",
        description: notice.message,
        variant: notice.ok ? "success" : "error",
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

  // Prefix = nama saja, "/" otomatis. Samakan dengan server displayName().
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
      <a
        href="/providers"
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft size={16} />
        Back to providers
      </a>

      <PageHeader
        title={provider.name}
        subtitle={`${provider.id} · ${provider.base_url}${cleanPfx ? ` · prefix ${cleanPfx}/` : ""}`}
        actions={
          provider.is_active ? (
            <Badge tone="success">Active</Badge>
          ) : (
            <Badge tone="neutral">Inactive</Badge>
          )
        }
      />

      {/* Provider settings */}
      <Card className="mb-6">
        <details>
          <summary className="cursor-pointer text-sm font-medium text-foreground">Provider settings</summary>
          <Form method="post" className="mt-4 grid gap-3 sm:grid-cols-2">
            <input type="hidden" name="intent" value="update-provider" />
            <div>
              <Label htmlFor="edit-name">Display Name</Label>
              <Input id="edit-name" name="name" defaultValue={provider.name} required />
            </div>
            <div>
              <Label htmlFor="edit-base">Base URL</Label>
              <Input id="edit-base" name="base_url" defaultValue={provider.base_url} required />
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
              <Input id="edit-prefix" name="prefix" defaultValue={(provider.prefix ?? "").replace(/\/+$/g, "")} placeholder="e.g. openai" pattern="[a-zA-Z0-9._\-]{1,32}" title="Name only, without slash" />
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
            or pick a single proxy straight from the list. Applies to the whole provider
            — even with no (or a single) API key. Priority: client key pool → account
            pool → provider assignment → global → direct.
          </p>

          <div className="mb-4 flex flex-wrap gap-1.5">
            {(
              [
                { value: "pool", label: "From a pool" },
                { value: "list", label: "All proxies in list" },
              ] as const
            ).map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => setDistSource(opt.value)}
                className={`rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors ${
                  distSource === opt.value
                    ? "border-primary bg-primary/15 text-primary"
                    : "border-border text-muted-foreground hover:bg-muted"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <Form method="post" className="flex items-end gap-2">
              <input type="hidden" name="intent" value="set-provider-pool" />
              <div className="flex-1">
                <Label htmlFor="provider-pool">
                  Provider proxy / pool — all keys share
                </Label>
                <Select
                  key={providerSelected}
                  id="provider-pool"
                  name="pool_id"
                  defaultValue={providerSelected}
                >
                  <option value="">— None (direct) —</option>
                  {pools.map((p) => (
                    <option key={`pool-${p.id}`} value={p.id}>
                      [pool] {p.name} ({p.proxy_ids.length} · {p.strategy})
                    </option>
                  ))}
                  <option disabled>── or single proxy ──</option>
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

            <Form method="post" className="flex items-end gap-2">
              <input type="hidden" name="intent" value="distribute" />
              <input type="hidden" name="source_type" value={distSource} />
              <div className="flex-1">
                <Label htmlFor="distribute-source">
                  Distribute proxies across accounts
                </Label>
                {distSource === "pool" ? (
                  <Select id="distribute-source" name="pool_id" defaultValue="">
                    <option value="">— Select source pool —</option>
                    {pools.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} ({p.proxy_ids.length} proxies)
                      </option>
                    ))}
                  </Select>
                ) : (
                  <div className="flex h-9 items-center rounded-lg border border-glass-border bg-glass-strong px-3 text-xs text-muted-foreground">
                    All active proxies in the list ({activeProxies})
                  </div>
                )}
              </div>
              <Button type="submit" size="sm" variant="secondary">
                Distribute
              </Button>
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
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder="sk-..."
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
                  <Label htmlFor="custom-model-display">Custom display name (opsional)</Label>
                  <Input
                    id="custom-model-display"
                    name="display_name"
                    value={newModelDisplay}
                    onChange={(e) => setNewModelDisplay(e.target.value)}
                    placeholder={cleanPfx && newModelName.trim() ? `${cleanPfx}/${newModelName.trim()}` : "kosong = prefix/nama_model"}
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
                  <label className="flex items-center gap-2 text-sm text-foreground">
                    <input
                      type="checkbox"
                      name="is_primary"
                      value="1"
                      checked={newModelPrimary}
                      onChange={(e) => setNewModelPrimary(e.target.checked)}
                      className="size-4 rounded border-border"
                    />
                    Set as primary
                  </label>
                </div>
              </div>
              {newModelName.trim() ? (
                <p className="mt-2 text-xs text-muted-foreground">
                  Tampil sebagai:{" "}
                  <span className="font-mono text-foreground">
                    {newModelDisplay.trim() || (cleanPfx ? `${cleanPfx}/${newModelName.trim()}` : newModelName.trim())}
                  </span>
                  {newModelDisplay.trim() ? (
                    <span> (custom, bare upstream tetap <span className="font-mono">{newModelName.trim()}</span>)</span>
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
                  type="search"
                  value={importQuery}
                  onChange={(e) => setImportQuery(e.target.value)}
                  placeholder="Type to search models…"
                  className="h-8 text-xs"
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
                        <input
                          type="checkbox"
                          name="model_id"
                          value={m.id}
                          checked={Boolean(selectedRemote[m.id])}
                          onChange={(e) =>
                            setSelectedRemote((prev) => ({
                              ...prev,
                              [m.id]: e.target.checked,
                            }))
                          }
                          className="size-4 rounded border-border"
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
                          : "—"}
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

          {models.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No models yet. Add a custom model, import from the provider, or sync
              the registry.
            </p>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {models.map((m) => {
                const disp = modelDisplay(m);
                const isCustom = Boolean((m.display_name ?? "").trim());
                const showBare = disp !== m.model_name;
                return (
                <div
                  key={m.id}
                  className="rounded-lg border border-border p-3"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="break-all font-mono text-sm font-medium text-foreground">
                        {disp}
                        {isCustom ? (
                          <Badge tone="info" className="ml-1">custom</Badge>
                        ) : null}
                      </p>
                      {showBare ? (
                        <p className="mt-0.5 break-all font-mono text-xs text-muted-foreground">
                          upstream: {m.model_name}
                        </p>
                      ) : null}
                      <p className="mt-1 text-xs text-muted-foreground">
                        {m.context_length
                          ? `${Math.round(m.context_length / 1000)}k context`
                          : "Unknown context"}
                        {!m.is_active ? " · inactive" : ""}
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      {m.is_primary ? (
                        <Badge tone="info">primary</Badge>
                      ) : null}
                      {!m.is_active ? (
                        <Badge tone="neutral">inactive</Badge>
                      ) : null}
                    </div>
                  </div>
                  {editingDisplayId === m.id ? (
                    <Form method="post" className="mt-2 flex flex-wrap gap-1.5" onSubmit={() => setEditingDisplayId(null)}>
                      <input type="hidden" name="intent" value="set-model-display" />
                      <input type="hidden" name="model_id" value={m.id} />
                      <Input
                        name="display_name"
                        defaultValue={m.display_name ?? ""}
                        placeholder={cleanPfx ? `${cleanPfx}/${m.model_name}` : m.model_name}
                        className="h-8 font-mono text-xs"
                      />
                      <Button type="submit" size="sm">Save</Button>
                      <Button type="button" size="sm" variant="outline" onClick={() => setEditingDisplayId(null)}>
                        Cancel
                      </Button>
                    </Form>
                  ) : null}
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => setEditingDisplayId(editingDisplayId === m.id ? null : m.id)}
                    >
                      {isCustom ? "Edit display" : "Custom display"}
                    </Button>
                    {isCustom ? (
                      <Form method="post">
                        <input type="hidden" name="intent" value="set-model-display" />
                        <input type="hidden" name="model_id" value={m.id} />
                        <input type="hidden" name="display_name" value="" />
                        <Button type="submit" size="sm" variant="outline" title="Kembalikan ke prefix/nama_model">
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
                          Make primary
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
                        {m.is_active ? "Deactivate" : "Activate"}
                      </Button>
                    </Form>
                    <Form method="post">
                      <input type="hidden" name="intent" value="delete-model" />
                      <input type="hidden" name="model_id" value={m.id} />
                      <Button
                        type="submit"
                        size="sm"
                        variant="danger"
                        aria-label={`Delete ${m.model_name}`}
                      >
                        <Trash2 size={14} />
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
        <>
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <Label htmlFor="chat-model" className="mb-0 shrink-0 text-xs">
            Model
          </Label>
          <Select
            id="chat-model"
            value={chatModel}
            onChange={(e) => setChatModel(e.target.value)}
            className="h-8 w-auto max-w-[240px] text-xs"
          >
            {models.map((m) => (
              <option key={m.id} value={modelDisplay(m)}>
                {modelDisplay(m)}
              </option>
            ))}
          </Select>

          <label className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
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
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={stream.streaming}
            title="Start a fresh conversation (current chat is already auto-saved)"
            onClick={() => {
              setChatSessionId(null);
              setTurns([]);
              setPrompt("");
            }}
          >
            + New
          </Button>
        </div>

        <div className="grid gap-4 lg:grid-cols-[230px_minmax(0,1fr)]">
          <div className="max-h-44 overflow-y-auto rounded-xl border border-border bg-surface/50 p-2 lg:max-h-[560px]">
            <p className="px-1 pb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Saved chats ({loaderData.chatSessions.length})
            </p>
            {chatLoadFetcher.state !== "idle" ? (
              <div className="flex items-center gap-2 px-2 py-2 text-xs text-muted-foreground">
                <Spinner size={12} /> loading…
              </div>
            ) : null}
            {loaderData.chatSessions.length === 0 ? (
              <p className="px-1 py-3 text-xs text-muted-foreground">
                Nothing saved yet.
              </p>
            ) : (
              loaderData.chatSessions.map((sess) => {
                const active = sess.id === chatSessionId;
                return (
                  <div
                    key={sess.id}
                    className={`group mb-1 flex items-center gap-1 rounded-lg px-2 py-1.5 ${
                      active ? "bg-primary/15" : "hover:bg-muted"
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => loadChat(sess.id)}
                      className="min-w-0 flex-1 text-left"
                    >
                      <span
                        className={`block truncate text-xs ${
                          active ? "font-medium text-primary" : "text-foreground"
                        }`}
                      >
                        {sess.title}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {new Date(sess.updated_at * 1000).toLocaleString()}
                      </span>
                    </button>
                    <button
                      type="button"
                      aria-label={`Delete chat ${sess.title}`}
                      title="Delete chat"
                      onClick={() => void deleteChat(sess.id)}
                      className="shrink-0 rounded p-2 text-muted-foreground transition-colors hover:bg-danger/10 hover:text-danger"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                );
              })
            )}
          </div>

          <div className="flex h-[60vh] max-h-[560px] min-h-[420px] min-w-0 flex-col rounded-xl border border-border bg-surface/50">
            <div
              ref={chatScrollRef}
              className="flex-1 space-y-3 overflow-y-auto p-3 sm:p-4"
            >
              {history.length === 0 && !stream.streaming ? (
                <div className="flex h-full items-center justify-center text-center">
                  <p className="max-w-xs text-sm text-muted-foreground">
                    Send a message to start chatting with{" "}
                    <span className="font-medium text-foreground">
                      {chatModel || "this provider"}
                    </span>
                    .{autoSave ? " Conversations auto-save as you go." : ""}
                  </p>
                </div>
              ) : null}

              {history.map((m, idx) => {
                const isUser = m.role === "user";
                return (
                  <div
                    key={idx}
                    className={`flex ${isUser ? "justify-end" : "justify-start"}`}
                  >
                    <div
                      className={
                        isUser
                          ? "max-w-[85%] rounded-xl border border-primary/30 bg-primary/15 px-3 py-2 sm:max-w-[80%]"
                          : "min-w-0 max-w-full flex-1"
                      }
                    >
                      <>
                        {m.role === "assistant" && m.thinking ? (
                          <details className="mb-1.5 rounded-lg border border-info/25 bg-info/5 px-2.5 py-1.5">
                            <summary className="flex cursor-pointer items-center gap-1.5 text-xs font-medium text-info">
                              <Brain size={12} />
                              Thought process
                            </summary>
                            <div className="mt-1.5 max-h-48 overflow-y-auto text-xs leading-relaxed whitespace-pre-wrap break-words text-muted-foreground">
                              {m.thinking}
                            </div>
                          </details>
                        ) : null}
                        <Markdown text={m.content} />
                        {m.role === "assistant" ? (
                          <div className="mt-1 flex min-h-8 flex-wrap items-center gap-x-2 gap-y-0.5">
                            {(() => {
                              const secs = formatSecs(m.ms);
                              const tps = estimateTps(m.content.length, m.ms);
                              const clock = formatClock(
                                m.created_at != null ? m.created_at * 1000 : null,
                              );
                              const parts = [
                                m.model,
                                secs,
                                tps != null ? `≈ ${tps} tok/s` : null,
                                clock,
                              ].filter(Boolean);
                              return parts.length > 0 ? (
                                <p className="text-xs tabular-nums text-muted-foreground">
                                  {parts.join(" · ")}
                                </p>
                              ) : null;
                            })()}
                            <CopyButton
                              text={m.content}
                              label="Copy response"
                              className="h-8 w-8 shrink-0"
                            />
                          </div>
                        ) : null}
                      </>
                    </div>
                  </div>
                );
              })}

              {/* Bubble streaming live — selalu tampil saat generating */}
              {stream.streaming ? (
                <div className="flex justify-start">
                  <div className="min-w-0 max-w-full flex-1">
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

            <div className="border-t border-border p-3">
              <div className="flex items-end gap-2">
                <div className="min-w-0 flex-1">
                  <MessageInput
                    value={prompt}
                    onChange={setPrompt}
                    onSubmit={sendChat}
                    disabled={stream.streaming}
                    placeholder={
                      stream.streaming ? "Generating…" : `Message ${chatModel}…`
                    }
                  />
                  <p className="mt-1 hidden text-xs text-muted-foreground sm:block">
                    Enter to send · Shift+Enter for new line
                  </p>
                </div>
                {stream.streaming ? (
                  <Button
                    type="button"
                    variant="outline"
                    className="h-9 gap-1.5"
                    onClick={stream.stop}
                  >
                    <Square size={14} /> Stop
                  </Button>
                ) : (
                  <Button
                    type="button"
                    className="h-9 gap-1.5"
                    disabled={!prompt.trim()}
                    onClick={sendChat}
                  >
                    <Send size={14} /> Send
                  </Button>
                )}
              </div>
            </div>
          </div>
        </div>

        </>
      )}

      <Form method="post" className="mt-6 sm:mt-8" onSubmit={handleDelete}>
        <input type="hidden" name="intent" value="delete-provider" />
        <Button type="submit" variant="danger">
          <Trash2 size={16} />
          Delete provider
        </Button>
      </Form>
      {picker ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
          onClick={() => setPicker(null)}
        >
          <div
            className="flex max-h-[80vh] w-full max-w-lg flex-col rounded-xl border border-border bg-surface shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="border-b border-border px-4 py-3">
              <h3 className="text-sm font-semibold text-foreground">
                Pick proxy — {picker.label}
              </h3>
              <p className="mt-0.5 mb-2 text-xs text-muted-foreground">
                Click a proxy to assign it. Click the selected one again (or Clear)
                to deactivate.
              </p>
              <Input
                autoFocus
                type="search"
                value={pickerQuery}
                onChange={(e) => setPickerQuery(e.target.value)}
                placeholder="Search name / host:port…"
                className="h-8 text-xs"
              />
              {pickerQuery.trim() ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  {filteredProxies.length} of {proxies.length} proxies match
                </p>
              ) : null}
            </div>

            <div className="flex-1 overflow-y-auto p-2">
              {filteredProxies.map((p) => {
                const isSelected = pickerSelected === p.id;
                const usable = p.is_active;
                return (
                  <Form key={p.id} method="post">
                    <input type="hidden" name="intent" value="set-key-proxy" />
                    <input type="hidden" name="key_id" value={picker.keyId} />
                    <input type="hidden" name="proxy_id" value={p.id} />
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
                          : "border-transparent hover:bg-muted"
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
                    ? "No proxies yet — add some in the Proxies page first."
                    : `No proxies match “${pickerQuery.trim()}”.`}
                </p>
              ) : null}
            </div>

            <div className="flex items-center justify-between gap-2 border-t border-border px-4 py-3">
              <Form method="post" onSubmit={(e) => setTimeout(() => setPicker(null), 0)}>
                <input type="hidden" name="intent" value="set-key-proxy" />
                <input type="hidden" name="key_id" value={picker.keyId} />
                <input type="hidden" name="proxy_id" value="" />
                <Button type="submit" size="sm" variant="outline" className="text-danger">
                  Clear assignment
                </Button>
              </Form>
              <Button
                type="button"
                size="sm"
                variant="secondary"
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
  fetcher,
  keyId,
  result,
}: {
  fetcher: ReturnType<typeof useFetcher>;
  keyId: number;
  result?: { ok: boolean; message: string };
}) {
  const pending = fetcher.state === "submitting";
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
      <fetcher.Form method="post" className="w-full sm:w-auto">
        <input type="hidden" name="intent" value="test-key" />
        <input type="hidden" name="key_id" value={keyId} />
        <Button
          type="submit"
          variant="outline"
          size="sm"
          disabled={pending}
          className="h-9 w-full gap-1.5 px-3 sm:h-8 sm:w-auto sm:px-3"
        >
          {pending ? <Spinner size={14} /> : <Plug size={14} />}
          Test
        </Button>
      </fetcher.Form>
    </div>
  );
}