import { Form } from "react-router";
import { useState } from "react";
import type { Route } from "./+types/api";
import { query } from "../.server/db";

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
  return { allowlist, rules };
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const section = String(form.get("section"));

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
  return "w-full rounded-lg border border-gray-300 px-3 py-1.5 text-sm";
}

export default function Api({ loaderData }: Route.ComponentProps) {
  const { allowlist, rules } = loaderData;
  const [tab, setTab] = useState<"allowlist" | "rules">("allowlist");

  return (
    <div>
      <h1 className="mb-6 text-2xl font-bold">🔑 API Management</h1>
      <div className="mb-6 flex gap-2">
        <button
          type="button"
          onClick={() => setTab("allowlist")}
          className={`rounded-lg px-4 py-2 text-sm font-medium ${
            tab === "allowlist" ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-700"
          }`}
        >
          Model Allowlist
        </button>
        <button
          type="button"
          onClick={() => setTab("rules")}
          className={`rounded-lg px-4 py-2 text-sm font-medium ${
            tab === "rules" ? "bg-blue-600 text-white" : "bg-gray-100 text-gray-700"
          }`}
        >
          Routing Rules
        </button>
      </div>

      {tab === "allowlist" ? (
        <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
          <Form method="post" className="mb-4 flex flex-wrap items-end gap-3">
            <input type="hidden" name="section" value="allowlist" />
            <div>
              <label className="mb-1 block text-xs text-gray-500">Model</label>
              <input name="model_name" required placeholder="gpt-4o" className={inputClass()} />
            </div>
            <div>
              <label className="mb-1 block text-xs text-gray-500">Action</label>
              <select name="action" className={inputClass()}>
                <option value="allow">allow</option>
                <option value="deny">deny</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs text-gray-500">Reason</label>
              <input name="reason" className={inputClass()} />
            </div>
            <button
              type="submit"
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700"
            >
              Add
            </button>
          </Form>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs uppercase text-gray-400">
                <th className="py-2 pr-4">Model</th>
                <th className="py-2 pr-4">Action</th>
                <th className="py-2 pr-4">Reason</th>
                <th className="py-2">Actions</th>
              </tr>
            </thead>
            <tbody>
              {allowlist.map((row) => (
                <tr key={row.id} className="border-b border-gray-100">
                  <td className="py-2 pr-4 font-medium">{row.model_name}</td>
                  <td className="py-2 pr-4">
                    <span
                      className={`rounded-full px-2 py-0.5 text-xs ${
                        row.action === "deny"
                          ? "bg-red-100 text-red-700"
                          : "bg-green-100 text-green-700"
                      }`}
                    >
                      {row.action}
                    </span>
                  </td>
                  <td className="py-2 pr-4 text-gray-500">{row.reason}</td>
                  <td className="py-2">
                    <Form method="post">
                      <input type="hidden" name="section" value="allowlist" />
                      <input type="hidden" name="intent" value="delete" />
                      <input type="hidden" name="id" value={row.id} />
                      <button className="text-red-500 hover:underline">Delete</button>
                    </Form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
          <Form method="post" className="mb-4 grid grid-cols-1 items-end gap-3 sm:grid-cols-4">
            <input type="hidden" name="section" value="rules" />
            <div>
              <label className="mb-1 block text-xs text-gray-500">Name</label>
              <input name="name" required className={inputClass()} />
            </div>
            <div>
              <label className="mb-1 block text-xs text-gray-500">Source Model</label>
              <input name="source_model" required className={inputClass()} />
            </div>
            <div>
              <label className="mb-1 block text-xs text-gray-500">Type</label>
              <select name="rule_type" className={inputClass()}>
                <option value="rewrite">rewrite</option>
                <option value="deny">deny</option>
                <option value="fallback">fallback</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs text-gray-500">Priority</label>
              <input name="priority" type="number" defaultValue={0} className={inputClass()} />
            </div>
            <div>
              <label className="mb-1 block text-xs text-gray-500">Target Model</label>
              <input name="target_model" className={inputClass()} />
            </div>
            <div>
              <label className="mb-1 block text-xs text-gray-500">Target Provider</label>
              <input name="target_provider_id" className={inputClass()} />
            </div>
            <button
              type="submit"
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700"
            >
              Add
            </button>
          </Form>

          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs uppercase text-gray-400">
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
                <tr key={rule.id} className="border-b border-gray-100">
                  <td className="py-2 pr-4 font-medium">{rule.name}</td>
                  <td className="py-2 pr-4">{rule.source_model}</td>
                  <td className="py-2 pr-4">
                    <span className="rounded bg-gray-100 px-2 py-0.5 text-xs">
                      {rule.rule_type}
                    </span>
                  </td>
                  <td className="py-2 pr-4 text-gray-500">
                    {rule.target_model ?? rule.target_provider_id ?? "-"}
                  </td>
                  <td className="py-2 pr-4">{rule.priority}</td>
                  <td className="py-2 pr-4">
                    <Form method="post">
                      <input type="hidden" name="section" value="rules" />
                      <input type="hidden" name="intent" value="toggle" />
                      <input type="hidden" name="id" value={rule.id} />
                      <button
                        type="submit"
                        className={`rounded-full px-2 py-0.5 text-xs ${
                          rule.is_active
                            ? "bg-green-100 text-green-700"
                            : "bg-gray-200 text-gray-500"
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
                      <button className="text-red-600 hover:underline">Delete</button>
                    </Form>
                  </td>
                </tr>
              ))}
              {rules.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-6 text-center text-gray-400">
                    Belum ada routing rule.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}