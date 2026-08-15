import { Form, useFetcher } from "react-router";
import { useState } from "react";
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
  const fetcher = useFetcher<{ test?: { ok: boolean; okId: number; message: string } }>();
  const [chatModel, setChatModel] = useState(
    models.find((m) => m.is_primary)?.model_name ?? models[0]?.model_name ?? "",
  );
  const [prompt, setPrompt] = useState("");
  const stream = useStreaming();
  const { dialog, confirm } = useConfirm();
  const { toast } = useToast();

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
        <a href="/providers" className="mt-4 inline-block text-primary hover:underline">
          ← Back to list
        </a>
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
            {missingModels.length > 0 ? (
              <Form method="post">
                <input type="hidden" name="intent" value="sync-models" />
                <Button type="submit" size="sm">
                  <RefreshCw size={16} />
                  Sync from registry ({missingModels.length})
                </Button>
              </Form>
            ) : null}
          </CardHeader>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {models.map((m) => (
              <div key={m.id} className="rounded-lg border border-border p-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="font-mono text-sm font-medium text-foreground">
                    {m.model_name}
                  </p>
                  {m.is_primary ? <Badge tone="info">primary</Badge> : null}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {m.context_length
                    ? `${Math.round(m.context_length / 1000)}k context`
                    : "Unknown context"}
                  {m.is_active ? "" : " · inactive"}
                </p>
              </div>
            ))}
          </div>
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