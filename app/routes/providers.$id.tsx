import { Form, Link, useFetcher } from "react-router";
import { useEffect, useRef, useState } from "react";
import type { Route } from "./+types/providers.$id";
import { getRegistryEntry } from "~/registry";
import type { RegistryEntry } from "~/types";
import { query } from "../.server/db";
import {
  addApiKey,
  deleteApiKeyById,
  listApiKeys,
  setApiKeyActive,
  setRoutingKey,
  type ApiKeyRow,
} from "../.server/credential";
import { reload } from "../.server/registry";
import { useStreaming } from "../hooks/use-streaming";
import { MessageInput } from "../components/message-input";
import { StreamingResponse } from "../components/streaming-response";
import { useConfirm } from "../components/ui/confirm-dialog";
import { useToast } from "../components/ui/toast";
import { PageHeader } from "../components/ui/page-header";
import { Card, CardHeader, CardTitle } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Spinner } from "../components/ui/feedback";
import { Input, Label, Select } from "../components/ui/field";
import { Tabs } from "../components/ui/tabs";
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
} from "lucide-react";

type ProviderRow = {
  id: string;
  name: string;
  base_url: string;
  auth_type: string;
  is_active: number;
};

type ModelRow = {
  id: number;
  model_name: string;
  context_length: number | null;
  is_active: number;
  is_primary: number;
};

const TAB_ITEMS: { value: "keys" | "models" | "chat"; label: string }[] = [
  { value: "keys", label: "API Keys" },
  { value: "models", label: "Models" },
  { value: "chat", label: "Chat Playground" },
];

function upsertProviderModel(
  providerId: string,
  modelName: string,
  contextLength: number | null,
  makePrimary = false,
) {
  const existing = query(
    "SELECT id, is_primary FROM models WHERE model_name = ? AND provider_id = ?",
  ).get(modelName, providerId) as { id: number; is_primary: number } | undefined;

  if (existing) {
    query(
      "UPDATE models SET context_length = COALESCE(?, context_length), is_active = 1 WHERE id = ?",
    ).run(contextLength, existing.id);
    if (makePrimary) {
      query("UPDATE models SET is_primary = 0 WHERE provider_id = ?").run(providerId);
      query("UPDATE models SET is_primary = 1 WHERE id = ?").run(existing.id);
    }
    return { id: existing.id, created: false };
  }

  if (makePrimary) {
    query("UPDATE models SET is_primary = 0 WHERE provider_id = ?").run(providerId);
  }

  const hasPrimary = query(
    "SELECT 1 AS ok FROM models WHERE provider_id = ? AND is_primary = 1",
  ).get(providerId) as { ok: number } | undefined;

  const isPrimary = makePrimary || !hasPrimary ? 1 : 0;
  const result = query(
    `INSERT INTO models (model_name, provider_id, context_length, is_active, is_primary)
     VALUES (?, ?, ?, 1, ?)`,
  ).run(modelName, providerId, contextLength, isPrimary) as {
    lastInsertRowid: number | bigint;
  };

  return { id: Number(result.lastInsertRowid), created: true };
}

function parseContextLength(value: FormDataEntryValue | null): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n);
}

async function fetchProviderModelsList(
  providerId: string,
): Promise<
  | { ok: true; models: { id: string; contextLength: number | null }[] }
  | { ok: false; message: string }
> {
  const provider = query(
    "SELECT base_url, auth_type FROM providers WHERE id = ?",
  ).get(providerId) as { base_url: string; auth_type: string } | undefined;
  if (!provider) return { ok: false, message: "Provider not found" };

  const keys = listApiKeys(providerId).filter((k) => k.is_active);
  const key = keys.find((k) => k.is_routing) ?? keys[0];
  if (!key && provider.auth_type !== "none") {
    return { ok: false, message: "No active API key to import models" };
  }

  const entry = getRegistryEntry(providerId);
  const modelsUrl =
    entry?.modelsUrl ?? new URL("/v1/models", provider.base_url).toString();

  const headers = new Headers({ "Content-Type": "application/json" });
  if (key) {
    if (provider.auth_type === "bearer") {
      headers.set("Authorization", `Bearer ${key.api_key}`);
    } else if (provider.auth_type === "apikey") {
      headers.set("x-goog-api-key", key.api_key);
    }
  }
  if (entry?.headers) {
    for (const [k, v] of Object.entries(entry.headers)) headers.set(k, v);
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const res = await fetch(modelsUrl, {
      headers,
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      const text = (await res.text()).slice(0, 300);
      return { ok: false, message: `HTTP ${res.status}: ${text}` };
    }
    type RemoteModelItem = {
      id?: string;
      name?: string;
      context_length?: number;
      contextLength?: number;
      max_model_len?: number;
    };
    const body = (await res.json()) as {
      data?: RemoteModelItem[];
      models?: RemoteModelItem[];
    };
    const raw: RemoteModelItem[] = Array.isArray(body?.data)
      ? body.data
      : Array.isArray(body?.models)
        ? body.models
        : Array.isArray(body)
          ? (body as RemoteModelItem[])
          : [];
    const models = raw
      .map((m) => {
        const id = String(m.id ?? m.name ?? "").trim();
        if (!id) return null;
        const contextLength =
          typeof m.context_length === "number"
            ? m.context_length
            : typeof m.contextLength === "number"
              ? m.contextLength
              : typeof m.max_model_len === "number"
                ? m.max_model_len
                : null;
        return { id, contextLength };
      })
      .filter((m): m is { id: string; contextLength: number | null } => m != null);
    return { ok: true, models };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

function dbSyncModels(providerId: string, entry: RegistryEntry): void {
  for (const [i, m] of entry.models.entries()) {
    query(
      `INSERT OR IGNORE INTO models (model_name, provider_id, context_length, is_active, is_primary)
       VALUES (?, ?, ?, 1, ?)`,
    ).run(m.id, providerId, m.contextLength ?? null, i === 0 ? 1 : 0);
  }
}

export async function loader({ params }: Route.LoaderArgs) {
  const provider = query(
    "SELECT id, name, base_url, auth_type, is_active FROM providers WHERE id = ?",
  ).get(params.id) as ProviderRow | undefined;

  const keys = provider ? listApiKeys(provider.id) : [];
  const models = provider
    ? (query(
        "SELECT id, model_name, context_length, is_active, is_primary FROM models WHERE provider_id = ? ORDER BY is_primary DESC, id",
      ).all(provider.id) as unknown as ModelRow[])
    : [];

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

  if (intent === "add-key") {
    const apiKey = String(form.get("api_key") ?? "").trim();
    if (apiKey) {
      addApiKey(
        id,
        apiKey,
        String(form.get("label") ?? "").trim() || null,
        true,
      );
    }
    return null;
  }

  if (intent === "delete-key") {
    deleteApiKeyById(Number(form.get("key_id")));
    return null;
  }

  if (intent === "route-key") {
    setRoutingKey(Number(form.get("key_id")));
    return null;
  }

  if (intent === "active-key") {
    setApiKeyActive(Number(form.get("key_id")), form.get("is_active") === "1");
    return null;
  }

  if (intent === "sync-models") {
    const entry = getRegistryEntry(id);
    if (entry) {
      dbSyncModels(id, entry);
      reload();
    }
    return null;
  }

  if (intent === "add-model") {
    const modelName = String(form.get("model_name") ?? "").trim();
    if (!modelName) {
      return { modelsAction: { ok: false, message: "Model name is required" } };
    }
    const contextLength = parseContextLength(form.get("context_length"));
    const makePrimary =
      form.get("is_primary") === "1" || form.get("is_primary") === "on";
    upsertProviderModel(id, modelName, contextLength, makePrimary);
    reload();
    return {
      modelsAction: { ok: true, message: `Added ${modelName}` },
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
    const isActive = form.get("is_active") === "1";
    query(
      "UPDATE models SET is_active = ? WHERE id = ? AND provider_id = ?",
    ).run(isActive ? 1 : 0, modelId, id);
    reload();
    return null;
  }

  if (intent === "set-primary-model") {
    const modelId = Number(form.get("model_id"));
    query("UPDATE models SET is_primary = 0 WHERE provider_id = ?").run(id);
    query(
      "UPDATE models SET is_primary = 1, is_active = 1 WHERE id = ? AND provider_id = ?",
    ).run(modelId, id);
    reload();
    return null;
  }

  if (intent === "delete-model") {
    const modelId = Number(form.get("model_id"));
    query("DELETE FROM models WHERE id = ? AND provider_id = ?").run(modelId, id);
    reload();
    return null;
  }

  if (intent === "delete-provider") {
    query("DELETE FROM provider_credentials WHERE provider_id = ?").run(id);
    query("DELETE FROM models WHERE provider_id = ?").run(id);
    query("DELETE FROM providers WHERE id = ?").run(id);
    reload();
    return { deleted: true };
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

export default function ProviderDetail({ loaderData }: Route.ComponentProps) {
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
  const [chatModel, setChatModel] = useState(
    models.find((m) => m.is_primary)?.model_name ?? models[0]?.model_name ?? "",
  );
  const [prompt, setPrompt] = useState("");
  const stream = useStreaming();
  const { dialog, confirm } = useConfirm();
  const { toast } = useToast();

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
        subtitle={`${provider.id} · ${provider.base_url}`}
        actions={
          provider.is_active ? (
            <Badge tone="success">Active</Badge>
          ) : (
            <Badge tone="neutral">Inactive</Badge>
          )
        }
      />

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

                  <div className="flex flex-wrap items-center gap-2">
                    <KeyTestButton
                      fetcher={fetcher}
                      keyId={key.id}
                      result={testResult && testResult.okId === key.id ? testResult : undefined}
                    />

                    <Form method="post">
                      <input type="hidden" name="intent" value="route-key" />
                      <input type="hidden" name="key_id" value={key.id} />
                      <Button
                        type="submit"
                        size="sm"
                        variant="outline"
                        disabled={Boolean(key.is_routing)}
                        className={
                          key.is_routing
                            ? "cursor-default border-primary/30 bg-primary/15 text-primary"
                            : ""
                        }
                      >
                        {key.is_routing ? "Routing active" : "Use for routing"}
                      </Button>
                    </Form>

                    <Form method="post">
                      <input type="hidden" name="intent" value="active-key" />
                      <input type="hidden" name="key_id" value={key.id} />
                      <input type="hidden" name="is_active" value={key.is_active ? 0 : 1} />
                      <Button type="submit" variant="outline" size="sm">
                        {key.is_active ? "Deactivate" : "Activate"}
                      </Button>
                    </Form>

                    <Form method="post" onSubmit={handleDeleteKey}>
                      <input type="hidden" name="intent" value="delete-key" />
                      <input type="hidden" name="key_id" value={key.id} />
                      <Button
                        type="submit"
                        variant="danger"
                        size="sm"
                        aria-label={`Delete key #${key.id}`}
                      >
                        <Trash2 size={14} />
                      </Button>
                    </Form>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
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
              }}
            >
              <input type="hidden" name="intent" value="add-model" />
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div className="sm:col-span-1">
                  <Label htmlFor="custom-model-name">Model name</Label>
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
                      for (const m of fetcher.data?.remoteModels?.models ?? []) {
                        if (!m.alreadyAdded) next[m.id] = true;
                      }
                      setSelectedRemote(next);
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
              <div className="mb-3 max-h-64 space-y-2 overflow-y-auto rounded-md border border-border p-2">
                {(fetcher.data.remoteModels.models ?? []).length === 0 ? (
                  <p className="py-4 text-center text-sm text-muted-foreground">
                    No models returned by provider.
                  </p>
                ) : (
                  fetcher.data.remoteModels.models.map((m) => (
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
              {models.map((m) => (
                <div
                  key={m.id}
                  className="rounded-lg border border-border p-3"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="break-all font-mono text-sm font-medium text-foreground">
                        {m.model_name}
                      </p>
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
                  <div className="mt-3 flex flex-wrap gap-1.5">
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
              ))}
            </div>
          )}
        </Card>
      ) : (
        <Card>
          <CardTitle className="mb-4">Chat Playground</CardTitle>
          {models.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No models for this provider yet. Sync models from the registry in the Models tab.
            </p>
          ) : (
            <>
              <div className="mb-4">
                <Label htmlFor="chat-model">Model</Label>
                <Select
                  id="chat-model"
                  value={chatModel}
                  onChange={(e) => setChatModel(e.target.value)}
                  className="sm:w-72"
                >
                  {models.map((m) => (
                    <option key={m.id} value={m.model_name}>
                      {m.model_name}
                    </option>
                  ))}
                </Select>
              </div>

              <MessageInput value={prompt} onChange={setPrompt} />

              <div className="mb-4 flex gap-2">
                <Button
                  type="button"
                  onClick={() => {
                    if (!prompt.trim()) return;
                    const p = prompt;
                    setPrompt("");
                    stream.send(chatModel, p, true);
                  }}
                  disabled={stream.streaming}
                >
                  {stream.streaming ? <Spinner size={16} /> : <Send size={16} />}
                  Send
                </Button>
                {stream.streaming ? (
                  <Button type="button" variant="outline" onClick={stream.stop}>
                    <Square size={16} />
                    Stop
                  </Button>
                ) : null}
              </div>

              <StreamingResponse
                content={stream.response}
                streaming={stream.streaming}
                done={stream.done}
                error={stream.error}
              />
            </>
          )}
        </Card>
      )}

      <Form method="post" className="mt-6 sm:mt-8" onSubmit={handleDelete}>
        <input type="hidden" name="intent" value="delete-provider" />
        <Button type="submit" variant="danger">
          <Trash2 size={16} />
          Delete provider
        </Button>
      </Form>
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
      <fetcher.Form method="post">
        <input type="hidden" name="intent" value="test-key" />
        <input type="hidden" name="key_id" value={keyId} />
        <Button type="submit" variant="outline" size="sm" disabled={pending}>
          {pending ? <Spinner size={14} /> : <Plug size={14} />}
          Test
        </Button>
      </fetcher.Form>
    </div>
  );
}