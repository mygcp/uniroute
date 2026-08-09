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
import {
  ArrowLeft,
  KeyRound,
  Plug,
  Trash2,
  Plus,
  MessageSquare,
  Boxes,
  RefreshCw,
  Loader2,
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
    if (!key) return { test: { ok: false, message: "Key tidak ditemukan" } };
    const provider = query(
      "SELECT base_url, auth_type FROM providers WHERE id = ?",
    ).get(id) as { base_url: string; auth_type: string } | undefined;
    if (!provider) return { test: { ok: false, message: "Provider tidak ada" } };

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
      const res = await fetch(modelsUrl, {
        headers,
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (res.ok) {
        return { test: { ok: true, okId: keyId, message: "Terhubung" } };
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
    query("DELETE FROM providers WHERE id = ?").run(id);
    query("DELETE FROM models WHERE provider_id = ?").run(id);
    query("DELETE FROM provider_credentials WHERE provider_id = ?").run(id);
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

function TabButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium ${
        active
          ? "bg-blue-600 text-white"
          : "bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
      }`}
    >
      {icon}
      {label}
    </button>
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

  if (!provider) {
    return (
      <div className="rounded-xl border border-gray-200 bg-white p-8 text-center dark:border-gray-800 dark:bg-gray-900">
        <p className="text-gray-600 dark:text-gray-300">Provider tidak ditemukan.</p>
        <a href="/providers" className="mt-4 inline-block text-blue-600 hover:underline">
          ← Kembali ke daftar
        </a>
      </div>
    );
  }

  const testResult = fetcher.data?.test;

  const handleAdd = () => {
    if (!apiKey.trim()) return;
    const form = document.getElementById("add-key-form") as HTMLFormElement | null;
    form?.requestSubmit();
  };

  return (
    <div>
      <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <a
            href="/providers"
            className="rounded-lg border border-gray-300 p-2 text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
          >
            <ArrowLeft size={18} />
          </a>
          <div>
            <h1 className="text-2xl font-bold text-gray-900 dark:text-white">{provider.name}</h1>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              {provider.id} · {provider.base_url}
            </p>
          </div>
        </div>
        <span
          className={`rounded-full px-3 py-1 text-xs font-medium ${
            provider.is_active
              ? "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300"
              : "bg-gray-200 text-gray-600 dark:bg-gray-800 dark:text-gray-400"
          }`}
        >
          {provider.is_active ? "Aktif" : "Non-aktif"}
        </span>
      </div>

      <div className="mb-6 flex gap-2">
        <TabButton
          active={tab === "keys"}
          onClick={() => setTab("keys")}
          icon={<KeyRound size={16} />}
          label="API Keys"
        />
        <TabButton
          active={tab === "models"}
          onClick={() => setTab("models")}
          icon={<Boxes size={16} />}
          label="Models"
        />
        <TabButton
          active={tab === "chat"}
          onClick={() => setTab("chat")}
          icon={<MessageSquare size={16} />}
          label="Chat Playground"
        />
      </div>

      {tab === "keys" ? (
        <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
              API Keys ({keys.length})
            </h2>
            <button
              type="button"
              onClick={() => setAddOpen(true)}
              className="flex items-center gap-2 rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700"
            >
              <Plus size={16} />
              Tambah API Key
            </button>
          </div>

          {addOpen ? (
            <Form
              id="add-key-form"
              method="post"
              onSubmit={() => {
                setAddOpen(false);
                setApiKey("");
                setLabel("");
              }}
              className="mb-4 rounded-lg border border-blue-200 bg-blue-50 p-4 dark:border-blue-900 dark:bg-blue-950/40"
            >
              <input type="hidden" name="intent" value="add-key" />
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <div>
                  <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-300">
                    Label (opsional)
                  </label>
                  <input
                    name="label"
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    placeholder="mis. akun-utama"
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 dark:border-gray-600 dark:bg-gray-800 dark:text-white"
                  />
                </div>
                <div className="sm:col-span-2">
                  <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-300">
                    API Key
                  </label>
                  <input
                    name="api_key"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    required
                    placeholder="sk-..."
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 dark:border-gray-600 dark:bg-gray-800 dark:text-white"
                  />
                </div>
              </div>
              <div className="mt-3 flex gap-2">
                <button
                  type="submit"
                  onClick={handleAdd}
                  className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
                >
                  Simpan
                </button>
                <button
                  type="button"
                  onClick={() => setAddOpen(false)}
                  className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
                >
                  Batal
                </button>
              </div>
            </Form>
          ) : null}

          {keys.length === 0 ? (
            <p className="py-8 text-center text-sm text-gray-400">
              Belum ada API key. Tambahkan untuk mengaktifkan provider ini.
            </p>
          ) : (
            <div className="space-y-3">
              {keys.map((key) => (
                <div
                  key={key.id}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-gray-200 p-4 dark:border-gray-700"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="font-medium text-gray-900 dark:text-white">
                        {key.label || `Key #${key.id}`}
                      </p>
                      {key.is_routing ? (
                        <span className="flex items-center gap-1 rounded bg-blue-100 px-2 py-0.5 text-[11px] text-blue-700 dark:bg-blue-900/50 dark:text-blue-300">
                          <ShieldCheck size={12} />
                          routing
                        </span>
                      ) : null}
                      {!key.is_active ? (
                        <span className="rounded bg-gray-200 px-2 py-0.5 text-[11px] text-gray-600 dark:bg-gray-700 dark:text-gray-300">
                          non-aktif
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-0.5 font-mono text-xs text-gray-500 dark:text-gray-400">
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
                      <button
                        type="submit"
                        disabled={Boolean(key.is_routing)}
                        className={`rounded-lg border px-3 py-1.5 text-xs ${
                          key.is_routing
                            ? "cursor-default border-blue-200 bg-blue-50 text-blue-600 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-300"
                            : "border-gray-300 text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
                        }`}
                      >
                        {key.is_routing ? "Routing aktif" : "Pakai untuk routing"}
                      </button>
                    </Form>

                    <Form method="post">
                      <input type="hidden" name="intent" value="active-key" />
                      <input type="hidden" name="key_id" value={key.id} />
                      <input type="hidden" name="is_active" value={key.is_active ? 0 : 1} />
                      <button
                        type="submit"
                        className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
                      >
                        {key.is_active ? "Non-aktifkan" : "Aktifkan"}
                      </button>
                    </Form>

                    <Form method="post">
                      <input type="hidden" name="intent" value="delete-key" />
                      <input type="hidden" name="key_id" value={key.id} />
                      <button
                        type="submit"
                        className="rounded-lg border border-red-200 px-3 py-1.5 text-xs text-red-600 hover:bg-red-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950/40"
                      >
                        <Trash2 size={14} />
                      </button>
                    </Form>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : tab === "models" ? (
        <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
              Models ({models.length})
            </h2>
            {missingModels.length > 0 ? (
              <Form method="post">
                <input type="hidden" name="intent" value="sync-models" />
                <button
                  type="submit"
                  className="flex items-center gap-2 rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700"
                >
                  <RefreshCw size={16} />
                  Sinkron dari registry ({missingModels.length})
                </button>
              </Form>
            ) : null}
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {models.map((m) => (
              <div
                key={m.id}
                className="rounded-lg border border-gray-200 p-3 dark:border-gray-700"
              >
                <div className="flex items-center justify-between gap-2">
                  <p className="font-mono text-sm font-medium text-gray-900 dark:text-white">
                    {m.model_name}
                  </p>
                  {m.is_primary ? (
                    <span className="rounded bg-blue-100 px-2 py-0.5 text-[11px] text-blue-700 dark:bg-blue-900/50 dark:text-blue-300">
                      primary
                    </span>
                  ) : null}
                </div>
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  {m.context_length
                    ? `${Math.round(m.context_length / 1000)}k context`
                    : "context tidak diketahui"}
                  {m.is_active ? "" : " · non-aktif"}
                </p>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900">
          <h2 className="mb-4 text-lg font-semibold text-gray-900 dark:text-white">
            Chat Playground
          </h2>
          {models.length === 0 ? (
            <p className="py-8 text-center text-sm text-gray-400">
              Belum ada model untuk provider ini. Sinkronkan model dari registry
              di tab Models.
            </p>
          ) : (
            <>
              <div className="mb-4">
                <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-300">
                  Model
                </label>
                <select
                  value={chatModel}
                  onChange={(e) => setChatModel(e.target.value)}
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-800 dark:text-white sm:w-72"
                >
                  {models.map((m) => (
                    <option key={m.id} value={m.model_name}>
                      {m.model_name}
                    </option>
                  ))}
                </select>
              </div>

              <MessageInput value={prompt} onChange={setPrompt} />

              <div className="mb-4 flex gap-2">
                <button
                  type="button"
                  onClick={() => {
                    if (!prompt.trim()) return;
                    const p = prompt;
                    setPrompt("");
                    stream.send(chatModel, p, true);
                  }}
                  disabled={stream.streaming}
                  className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {stream.streaming ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
                  Kirim
                </button>
                {stream.streaming ? (
                  <button
                    type="button"
                    onClick={stream.stop}
                    className="flex items-center gap-2 rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
                  >
                    <Square size={16} />
                    Stop
                  </button>
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
        </div>
      )}

      <Form method="post" className="mt-8">
        <input type="hidden" name="intent" value="delete-provider" />
        <button
          type="submit"
          onClick={() => confirm(`Hapus provider ${provider.id}?`)}
          className="rounded-lg border border-red-200 px-4 py-2 text-sm text-red-600 hover:bg-red-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950/40"
        >
          Hapus provider ini
        </button>
      </Form>
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
            result.ok
              ? "text-green-600 dark:text-green-400"
              : "text-red-600 dark:text-red-400"
          }`}
          title={result.message}
        >
          {result.ok ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
          {result.ok ? "OK" : "Gagal"}
        </span>
      ) : null}
      <fetcher.Form method="post">
        <input type="hidden" name="intent" value="test-key" />
        <input type="hidden" name="key_id" value={keyId} />
        <button
          type="submit"
          disabled={pending}
          className="flex items-center gap-1 rounded-lg border border-gray-300 px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
        >
          {pending ? <Loader2 size={14} className="animate-spin" /> : <Plug size={14} />}
          Test
        </button>
      </fetcher.Form>
    </div>
  );
}
