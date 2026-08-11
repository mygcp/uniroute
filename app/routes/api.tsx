import { Form } from "react-router";
import { useState } from "react";
import type { Route } from "./+types/api";
import { KeyRound } from "lucide-react";
import { query } from "../.server/db";
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
  const modelsPublic = isModelsPublic();
  const modelSuggestions = getModelSuggestions();
  const providerSuggestions = getProviderSuggestions();
  return {
    allowlist,
    rules,
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

export default function Api({ loaderData }: Route.ComponentProps) {
  const {
    allowlist,
    rules,
    modelsPublic,
    modelSuggestions,
    providerSuggestions,
  } = loaderData;

  return (
    <div>
      <h1 className="mb-6 flex items-center gap-2 text-2xl font-bold text-gray-900 dark:text-white">
        <KeyRound size={24} /> API Management
      </h1>

      <div className="mb-5 flex flex-wrap items-center gap-3 rounded-xl border border-blue-200 bg-blue-50 p-4 text-sm text-blue-900 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-100">
        <span>
          Kelola API key untuk klien, budget, quota, dan keamanan sekarang pindah ke halaman
          "API Manager".
        </span>
        <a
          href="/api-manager"
          className="rounded-lg bg-blue-600 px-3 py-1.5 font-medium text-white hover:bg-blue-700"
        >
          Buka API Manager →
        </a>
      </div>

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
