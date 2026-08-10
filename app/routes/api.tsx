import { Form } from "react-router";
import { Fragment, useState } from "react";
import type { Route } from "./+types/api";
import { KeyRound, Plus, Trash2 } from "lucide-react";
import { query } from "../.server/db";
import {
  createClientKey,
  deleteClientKey,
  isRequireApiKey,
  listClientKeys,
  setClientKeyActive,
  setRequireApiKey,
  updateClientKeyRules,
} from "../.server/client-key";
import { isModelsPublic, setModelsPublic } from "../.server/model-public";
import { getModelSuggestions, getProviderSuggestions } from "../.server/suggest";
import { Combobox } from "../components/combobox";

type AllowlistRow = {
  id: number;
  model_name: string;
  action: string;
  reason: string | null;
};

type RuleRow = {
  id: number;
  name: string;
  source_model: string;
  rule_type: string;
  target_model: string | null;
  target_provider_id: string | null;
  priority: number;
  is_active: number;
};

export function loader() {
  const allowlist = query(
    "SELECT id, model_name, action, reason FROM model_allowlist ORDER BY id DESC",
  ).all() as unknown as AllowlistRow[];
  const rules = query(
    "SELECT id, name, source_model, rule_type, target_model, target_provider_id, priority, is_active FROM routing_rules ORDER BY priority DESC, id DESC",
  ).all() as unknown as RuleRow[];
  const clientKeys = listClientKeys();
  const requireApiKey = isRequireApiKey();
  const modelsPublic = isModelsPublic();
  const modelSuggestions = getModelSuggestions();
  const providerSuggestions = getProviderSuggestions();
  return {
    allowlist,
    rules,
    clientKeys,
    requireApiKey,
    modelsPublic,
    modelSuggestions,
    providerSuggestions,
  };
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const section = String(form.get("section"));

  if (section === "settings") {
    const intent = String(form.get("intent"));
    if (intent === "models_public") {
      setModelsPublic(form.get("enabled") === "1");
      return null;
    }
  }

  if (section === "client-key") {
    const intent = String(form.get("intent"));
    if (intent === "create") {
      const { key } = createClientKey({
        name: String(form.get("name") ?? "").trim() || "Untitled",
        prefix: String(form.get("prefix") ?? "sk-").trim() || "sk-",
      });
      return { newlyCreatedKey: key, createName: String(form.get("name") ?? "") };
    }
    if (intent === "edit") {
      const id = Number(form.get("id"));
      const allowedRaw = String(form.get("allowed_models") ?? "").trim();
      const allowedModels = allowedRaw
        ? allowedRaw
            .split(/[\n,]+/)
            .map((s) => s.trim())
            .filter(Boolean)
        : null;
      updateClientKeyRules(id, {
        name: String(form.get("name") ?? "").trim(),
        allowedModels,
        modelOverride: String(form.get("model_override") ?? "").trim() || null,
        pinnedProviderId: String(form.get("pinned_provider_id") ?? "").trim() || null,
      });
      return null;
    }
    if (intent === "delete") {
      deleteClientKey(Number(form.get("id")));
      return null;
    }
    if (intent === "toggle") {
      setClientKeyActive(Number(form.get("id")), form.get("is_active") === "1");
      return null;
    }
    if (intent === "require") {
      setRequireApiKey(form.get("enabled") === "1");
      return null;
    }
    return null;
  }

  if (section === "allowlist") {
    const intent = String(form.get("intent"));
    if (intent === "delete") {
      query("DELETE FROM model_allowlist WHERE id = ?").run(
        Number(form.get("id")),
      );
      return null;
    }
    query(
      `INSERT INTO model_allowlist (model_name, action, reason)
       VALUES (?, ?, ?)
       ON CONFLICT(model_name, action) DO UPDATE SET reason = excluded.reason`,
    ).run(
      String(form.get("model_name")),
      String(form.get("action")),
      String(form.get("reason") ?? null),
    );
    return null;
  }

  const intent = String(form.get("intent"));
  const id = Number(form.get("id"));
  if (intent === "delete") {
    query("DELETE FROM routing_rules WHERE id = ?").run(id);
    return null;
  }
  if (intent === "toggle") {
    query("UPDATE routing_rules SET is_active = 1 - is_active WHERE id = ?").run(id);
    return null;
  }
  query(
    `INSERT INTO routing_rules
       (name, source_model, rule_type, target_model, target_provider_id, priority, is_active, description)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
  ).run(
    String(form.get("name")),
    String(form.get("source_model")),
    String(form.get("rule_type")),
    String(form.get("target_model") ?? null),
    String(form.get("target_provider_id") ?? null),
    Number(form.get("priority") ?? 0),
    String(form.get("description") ?? null),
  );
  return null;
}

function inputClass() {
  return "w-full rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-800 dark:text-white";
}

export default function Api({ loaderData, actionData }: Route.ComponentProps) {
  const {
    allowlist,
    rules,
    clientKeys,
    requireApiKey,
    modelsPublic,
    modelSuggestions,
    providerSuggestions,
  } = loaderData;

  const newKey = actionData
    ? (actionData as { newlyCreatedKey?: string; createName?: string }).newlyCreatedKey
      ? {
          key: (actionData as { newlyCreatedKey: string }).newlyCreatedKey,
          name: (actionData as { createName?: string }).createName ?? "",
        }
      : undefined
    : undefined;

  return (
    <div>
      <h1 className="mb-6 flex items-center gap-2 text-2xl font-bold text-gray-900 dark:text-white">
        <KeyRound size={24} /> API Management
      </h1>

      <ApiKeysTab
        requireApiKey={requireApiKey}
        keys={clientKeys}
        newKey={newKey}
        modelSuggestions={modelSuggestions}
        providerSuggestions={providerSuggestions}
      />

      <div className="mt-4 rounded-xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900">
        <Form method="post" className="flex items-center justify-between gap-4">
          <input type="hidden" name="section" value="settings" />
          <input type="hidden" name="intent" value="models_public" />
          <div>
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Public Models</h3>
            <p className="text-xs text-gray-500 dark:text-gray-400">
              Jika aktif, <code>/v1/models</code> bisa diakses tanpa auth dan hanya menampilkan model bertanda <em>public</em>.
            </p>
          </div>
          <button
            name="enabled"
            value={modelsPublic ? "0" : "1"}
            type="submit"
            className={`rounded-lg px-4 py-2 text-sm font-medium transition ${
              modelsPublic
                ? "bg-green-600 text-white hover:bg-green-700"
                : "bg-gray-200 text-gray-700 hover:bg-gray-300 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600"
            }`}
          >
            {modelsPublic ? "ON" : "OFF"}
          </button>
        </Form>
      </div>

      <div className="mt-4 rounded-xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900">
        <h2 className="mb-3 text-lg font-semibold text-gray-900 dark:text-white">
          Model Allowlist ({allowlist.length})
        </h2>
        <AllowlistForm modelSuggestions={modelSuggestions} />
          <div className="table-wrap">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs uppercase text-gray-400 dark:border-gray-700">
                <th className="py-2 pr-4">Model</th>
                <th className="py-2 pr-4">Action</th>
                <th className="py-2 pr-4">Reason</th>
                <th className="py-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {allowlist.map((row) => (
                <tr key={row.id} className="border-b border-gray-100 dark:border-gray-800">
                  <td className="py-2 pr-4 font-medium text-gray-900 dark:text-white">{row.model_name}</td>
                  <td className="py-2 pr-4">
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs ${
                        row.action === "deny"
                          ? "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300"
                          : "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300"
                      }`}
                    >
                      {row.action}
                    </span>
                  </td>
                  <td className="py-2 pr-4 text-gray-500 dark:text-gray-400">{row.reason}</td>
                  <td className="py-2">
                    <Form method="post">
                      <input type="hidden" name="section" value="allowlist" />
                      <input type="hidden" name="intent" value="delete" />
                      <input type="hidden" name="id" value={row.id} />
                      <button className="text-red-500 hover:underline dark:text-red-400">Delete</button>
                    </Form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>

      <div className="mt-4 rounded-xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900">
<h2 className="mb-3 text-lg font-semibold text-gray-900 dark:text-white">
          Routing Rules ({rules.length})
        </h2>
        <RulesForm
          modelSuggestions={modelSuggestions}
          providerSuggestions={providerSuggestions}
        />
          <div className="table-wrap">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs uppercase text-gray-400 dark:border-gray-700">
                <th className="py-3 pr-4">Name</th>
                <th className="py-3 pr-4">Source</th>
                <th className="py-3 pr-4">Type</th>
                <th className="py-3 pr-4">Target</th>
                <th className="py-3 pr-4">Priority</th>
                <th className="py-3 pr-4">Active</th>
                <th className="py-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rules.map((rule) => (
                <tr key={rule.id} className="border-b border-gray-100 dark:border-gray-800">
                  <td className="py-2 pr-4 font-medium text-gray-900 dark:text-white">{rule.name}</td>
                  <td className="py-2 pr-4 text-gray-800 dark:text-gray-200">{rule.source_model}</td>
                  <td className="py-2 pr-4">
                    <span className="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-700 dark:bg-gray-800 dark:text-gray-300">
                      {rule.rule_type}
                    </span>
                  </td>
                  <td className="py-2 pr-4 text-gray-500 dark:text-gray-400">
                    {rule.target_model ?? rule.target_provider_id ?? "-"}
                  </td>
                  <td className="py-2 pr-4 text-gray-800 dark:text-gray-200">{rule.priority}</td>
                  <td className="py-2 pr-4">
                    <Form method="post">
                      <input type="hidden" name="section" value="rules" />
                      <input type="hidden" name="intent" value="toggle" />
                      <input type="hidden" name="id" value={rule.id} />
                      <button
                        type="submit"
                        className={`rounded-full px-2 py-0.5 text-xs ${
                          rule.is_active
                            ? "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300"
                            : "bg-gray-200 text-gray-500 dark:bg-gray-700 dark:text-gray-400"
                        }`}
                      >
                        {rule.is_active ? "on" : "off"}
                      </button>
                    </Form>
                  </td>
                  <td className="py-2">
                    <Form method="post">
                      <input type="hidden" name="section" value="rules" />
                      <input type="hidden" name="intent" value="delete" />
                      <input type="hidden" name="id" value={rule.id} />
                      <button className="text-red-600 hover:underline dark:text-red-400">Delete</button>
                    </Form>
                  </td>
                </tr>
              ))}
              {rules.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-6 text-center text-gray-400 dark:text-gray-500">
                    Belum ada routing rule.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
          </div>
        </div>
    </div>
  );
}

function AllowlistForm({ modelSuggestions }: { modelSuggestions: string[] }) {
  const [model, setModel] = useState("");
  return (
    <Form method="post" className="mb-4 flex flex-wrap items-end gap-3">
      <input type="hidden" name="section" value="allowlist" />
      <div>
        <label className="mb-1 block text-xs text-gray-500 dark:text-gray-400">Model</label>
        <Combobox
          name="model_name"
          value={model}
          onChange={setModel}
          options={modelSuggestions}
          required
          placeholder="e.g. gpt-4o"
          className={inputClass()}
        />
      </div>
      <div>
        <label className="mb-1 block text-xs text-gray-500 dark:text-gray-400">Action</label>
        <select name="action" className={inputClass()}>
          <option value="allow">allow</option>
          <option value="deny">deny</option>
        </select>
      </div>
      <div>
        <label className="mb-1 block text-xs text-gray-500 dark:text-gray-400">Reason</label>
        <input name="reason" className={inputClass()} />
      </div>
      <button
        type="submit"
        className="rounded-lg bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700"
      >
        Add
      </button>
    </Form>
  );
}

function RulesForm({
  modelSuggestions,
  providerSuggestions,
}: {
  modelSuggestions: string[];
  providerSuggestions: string[];
}) {
  const [ruleType, setRuleType] = useState("rewrite");
  const [sourceModel, setSourceModel] = useState("");
  const [targetModel, setTargetModel] = useState("");
  const [targetProvider, setTargetProvider] = useState("");

  return (
    <>
      <p className="mb-3 text-xs text-gray-500 dark:text-gray-400">
        Routing rules are evaluated per request for the requested source model, in priority
        order:
        <span className="mt-1 block">
          <code>rewrite</code> — replace the requested model with <code>target model</code>
          {" · "}
          <code>deny</code> — block the model
          {" · "}
          <code>fallback</code> — reroute to <code>target provider</code> when the primary
          route fails
        </span>
      </p>
      <Form method="post" className="mb-4 grid grid-cols-1 items-end gap-3 sm:grid-cols-4">
        <input type="hidden" name="section" value="rules" />
        <div>
          <label className="mb-1 block text-xs text-gray-500 dark:text-gray-400">Name</label>
          <input name="name" required className={inputClass()} />
        </div>
        <div>
          <label className="mb-1 block text-xs text-gray-500 dark:text-gray-400">Source Model</label>
          <Combobox
            name="source_model"
            value={sourceModel}
            onChange={setSourceModel}
            options={modelSuggestions}
            required
            placeholder="e.g. gpt-4o"
            className={inputClass()}
          />
        </div>
        <div>
          <label className="mb-1 block text-xs text-gray-500 dark:text-gray-400">Type</label>
          <select
            name="rule_type"
            value={ruleType}
            onChange={(e) => setRuleType(e.target.value)}
            className={inputClass()}
          >
            <option value="rewrite">rewrite</option>
            <option value="deny">deny</option>
            <option value="fallback">fallback</option>
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs text-gray-500 dark:text-gray-400">Priority</label>
          <input name="priority" type="number" defaultValue={0} className={inputClass()} />
        </div>
        {ruleType === "rewrite" ? (
          <div>
            <label className="mb-1 block text-xs text-gray-500 dark:text-gray-400">Target Model</label>
            <Combobox
              name="target_model"
              value={targetModel}
              onChange={setTargetModel}
              options={modelSuggestions}
              placeholder="e.g. gpt-4o-mini"
              className={inputClass()}
            />
          </div>
        ) : null}
        {ruleType === "fallback" ? (
          <div>
            <label className="mb-1 block text-xs text-gray-500 dark:text-gray-400">Target Provider</label>
            <Combobox
              name="target_provider_id"
              value={targetProvider}
              onChange={setTargetProvider}
              options={providerSuggestions}
              placeholder="e.g. openai"
              className={inputClass()}
            />
          </div>
        ) : null}
        <button
          type="submit"
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700"
        >
          Add
        </button>
      </Form>
    </>
  );
}

type ClientKeyRow = {
  id: number;
  name: string;
  key_prefix: string;
  allowed_models: string[] | null;
  model_override: string | null;
  pinned_provider_id: string | null;
  is_active: number;
};

function ApiKeysTab({
  requireApiKey,
  keys,
  newKey,
  modelSuggestions,
  providerSuggestions,
}: {
  requireApiKey: boolean;
  keys: ClientKeyRow[];
  newKey?: { key: string; name: string };
  modelSuggestions: string[];
  providerSuggestions: string[];
}) {
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState("");
  const [editingId, setEditingId] = useState<number | null>(null);

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
          API Keys ({keys.length})
        </h2>
        <button
          type="button"
          onClick={() => setShowCreate((v) => !v)}
          className="flex items-center gap-2 rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          <Plus size={16} />
          Tambah Key
        </button>
      </div>

      {newKey ? (
        <div className="mb-4 rounded-lg border border-yellow-300 bg-yellow-50 p-4 text-sm dark:border-yellow-700 dark:bg-yellow-950/40">
          <p className="font-semibold text-yellow-800 dark:text-yellow-200">
            Key berhasil dibuat — salin sekarang, tidak akan ditampilkan lagi.
          </p>
          <code className="mt-2 block break-all rounded bg-white px-3 py-2 font-mono text-xs text-gray-800 dark:bg-gray-900 dark:text-gray-100">
            {newKey.key}
          </code>
        </div>
      ) : null}

      <Form method="post" className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-gray-200 p-3 dark:border-gray-700">
        <input type="hidden" name="section" value="client-key" />
        <input type="hidden" name="intent" value="require" />
        <input type="hidden" name="enabled" value={requireApiKey ? 0 : 1} />
        <span className="text-sm font-medium text-gray-700 dark:text-gray-300">Wajib API key</span>
        <button
          type="submit"
          className={`relative h-5 w-9 shrink-0 rounded-full transition-colors after:absolute after:left-0.5 after:top-0.5 after:h-4 after:w-4 after:rounded-full after:bg-white after:shadow after:transition-transform ${
            requireApiKey
              ? "bg-green-600 after:translate-x-4"
              : "bg-gray-300 after:translate-x-0 dark:bg-gray-600"
          }`}
          title={requireApiKey ? "Matikan" : "Aktifkan"}
        />
        <span className="w-full text-xs text-gray-500 dark:text-gray-400 sm:w-auto">
          {requireApiKey
            ? "Request tanpa key akan ditolak (401)"
            : "Request tanpa key masih diizinkan"}
        </span>
      </Form>

      {showCreate ? (
        <Form
          method="post"
          className="mb-4 rounded-lg border border-blue-200 bg-blue-50 p-4 dark:border-blue-900 dark:bg-blue-950/40"
        >
          <input type="hidden" name="section" value="client-key" />
          <input type="hidden" name="intent" value="create" />
          <div className="mb-2 grid grid-cols-2 gap-2">
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-300">
                Label
              </label>
              <input
                name="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                placeholder="mis. Frontend Web"
                className={inputClass()}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-300">
                Prefix key
              </label>
              <input
                name="prefix"
                defaultValue="sk-"
                placeholder="sk-"
                className={inputClass()}
              />
            </div>
          </div>
          <button
            type="submit"
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
          >
            Buat
          </button>
        </Form>
      ) : null}

      {keys.length === 0 ? (
        <p className="py-8 text-center text-sm text-gray-400">Belum ada API key.</p>
      ) : (
        <div className="table-wrap">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs uppercase text-gray-400 dark:border-gray-700">
                <th className="py-2 pr-4">Nama</th>
                <th className="py-2 pr-4">Key</th>
                <th className="py-2 pr-4">Rules</th>
                <th className="py-2 pr-4">Aktif</th>
                <th className="py-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => (
                <Fragment key={k.id}>
                  <tr className="border-b border-gray-100 dark:border-gray-800">
                  <td className="py-2 pr-4 font-medium text-gray-900 dark:text-white">{k.name}</td>
                  <td className="py-2 pr-4 font-mono text-xs text-gray-500 dark:text-gray-400">
                    {k.key_prefix}…
                  </td>
                  <td className="py-2 pr-4 text-xs text-gray-500 dark:text-gray-400">
                    {[
                      k.allowed_models && k.allowed_models.length > 0
                        ? `models: ${k.allowed_models.join(", ")}`
                        : null,
                      k.model_override ? `→ ${k.model_override}` : null,
                      k.pinned_provider_id ? `pin: ${k.pinned_provider_id}` : null,
                    ].filter(Boolean).join(" · ") || "semua model"}
                  </td>
                  <td className="py-2 pr-4">
                    <Form method="post">
                      <input type="hidden" name="section" value="client-key" />
                      <input type="hidden" name="intent" value="toggle" />
                      <input type="hidden" name="id" value={k.id} />
                      <input type="hidden" name="is_active" value={k.is_active ? 0 : 1} />
                      <button
                        type="submit"
                        className={`rounded-full px-2 py-0.5 text-xs ${
                          k.is_active
                            ? "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300"
                            : "bg-gray-200 text-gray-500 dark:bg-gray-700 dark:text-gray-400"
                        }`}
                      >
                        {k.is_active ? "on" : "off"}
                      </button>
                    </Form>
                  </td>
                  <td className="py-2">
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setEditingId(editingId === k.id ? null : k.id)}
                        className={`rounded border px-2 py-1 text-xs ${
                          editingId === k.id
                            ? "border-blue-300 bg-blue-50 text-blue-700 dark:border-blue-700 dark:bg-blue-950/50 dark:text-blue-300"
                            : "border-gray-300 text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
                        }`}
                      >
                        Manage
                      </button>
                      <Form method="post">
                        <input type="hidden" name="section" value="client-key" />
                        <input type="hidden" name="intent" value="delete" />
                        <input type="hidden" name="id" value={k.id} />
                        <button
                          type="submit"
                          className="text-red-600 hover:underline dark:text-red-400"
                          title="Hapus key"
                        >
                          <Trash2 size={14} />
                        </button>
                      </Form>
                    </div>
                  </td>
                </tr>
                {editingId === k.id ? (
                  <tr>
                    <td colSpan={5} className="bg-gray-50 py-4 dark:bg-gray-900/50">
                      <EditKeyForm
                      row={k}
                      onDone={() => setEditingId(null)}
                      modelSuggestions={modelSuggestions}
                      providerSuggestions={providerSuggestions}
                    />
                    </td>
                  </tr>
                ) : null}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function EditKeyForm({
  row,
  onDone,
  modelSuggestions,
  providerSuggestions,
}: {
  row: ClientKeyRow;
  onDone: () => void;
  modelSuggestions: string[];
  providerSuggestions: string[];
}) {
  const [modelOverride, setModelOverride] = useState(row.model_override ?? "");
  const [pinnedProvider, setPinnedProvider] = useState(row.pinned_provider_id ?? "");
  return (
    <Form method="post" className="mx-2 rounded-lg border border-gray-200 bg-white p-3 shadow-sm dark:border-gray-700 dark:bg-gray-900 sm:mx-5 sm:p-4">
      <input type="hidden" name="section" value="client-key" />
      <input type="hidden" name="intent" value="edit" />
      <input type="hidden" name="id" value={row.id} />
      <div className="mb-4 flex items-center justify-between">
        <p className="text-sm font-semibold text-gray-900 dark:text-white">
          Manage: {row.key_prefix}…
        </p>
        <button
          type="button"
          onClick={onDone}
          className="rounded border border-gray-300 px-2 py-1 text-xs text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
        >
          Tutup
        </button>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-300">
            Nama
          </label>
          <input
            name="name"
            defaultValue={row.name}
            required
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 dark:border-gray-600 dark:bg-gray-800 dark:text-white"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-300">
            Model override (kosongkan untuk menonaktifkan)
          </label>
          <Combobox
            name="model_override"
            value={modelOverride}
            onChange={setModelOverride}
            options={modelSuggestions}
            placeholder="e.g. gpt-4o-mini"
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 dark:border-gray-600 dark:bg-gray-800 dark:text-white"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-300">
            Pinned provider (kosong = ikut routing)
          </label>
          <Combobox
            name="pinned_provider_id"
            value={pinnedProvider}
            onChange={setPinnedProvider}
            options={providerSuggestions}
            placeholder="e.g. local"
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 dark:border-gray-600 dark:bg-gray-800 dark:text-white"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-medium text-gray-600 dark:text-gray-300">
            Allowed models — satu prefix per baris atau pisah koma (kosong = semua)
          </label>
          <textarea
            name="allowed_models"
            defaultValue={(row.allowed_models ?? []).join("\n")}
            rows={3}
            placeholder={"gpt-\nclaude-\no3-"}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 placeholder-gray-400 dark:border-gray-600 dark:bg-gray-800 dark:text-white"
          />
        </div>
      </div>
      <div className="mt-4 flex items-center justify-between gap-3">
        <p className="text-xs text-gray-500 dark:text-gray-400">
          Aturan diterapkan saat request memakai key ini. Model diminta harus cocok
          prefix di bawah (startsWith), lalu override & pin dipakai saat routing.
        </p>
        <button
          type="submit"
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          Simpan
        </button>
      </div>
    </Form>
  );
}