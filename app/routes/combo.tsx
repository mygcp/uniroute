import { useState } from "react";
import type { Route } from "./+types/combo";
import { Form } from "react-router";
import { Link2 } from "lucide-react";
import { query } from "../.server/db";
import { reload } from "../.server/registry";

type ModelRow = {
  id: number;
  model_name: string;
  provider_id: string;
  context_length: number | null;
  is_primary: number;
  is_active: number;
};

type LbRow = {
  model_name: string;
  strategy: string;
  fallback_enabled: number;
  health_check_enabled: number;
  health_check_url: string | null;
  health_check_interval: number;
};

type PoolRow = {
  model_name: string;
  provider_id: string;
  weight: number;
  priority: number;
  current_connections: number;
  last_used_at: number;
};

export function loader() {
  const providers = query(
    "SELECT id, name FROM providers ORDER BY id",
  ).all() as unknown as { id: string; name: string }[];
  const models = query(
    "SELECT id, model_name, provider_id, context_length, is_primary, is_active FROM models ORDER BY id",
  ).all() as unknown as ModelRow[];
  const lb = query(
    "SELECT model_name, strategy, fallback_enabled, health_check_enabled, health_check_url, health_check_interval FROM load_balancing ORDER BY model_name",
  ).all() as unknown as LbRow[];
  const pool = query(
    `SELECT m.model_name, m.provider_id, p.weight, p.priority, p.current_connections, p.last_used_at
     FROM models m JOIN providers p ON p.id = m.provider_id
     ORDER BY m.model_name`,
  ).all() as unknown as PoolRow[];
  return { models, lb, pool, providers };
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const section = String(form.get("section"));

  if (section === "mapping") {
    const intent = String(form.get("intent"));
    if (intent === "delete") {
      query("DELETE FROM models WHERE id = ?").run(Number(form.get("id")));
      reload();
      return null;
    }
    query(
      `INSERT INTO models (model_name, provider_id, context_length, is_active, is_primary)
       VALUES (?, ?, ?, 1, ?)`,
    ).run(
      String(form.get("model_name")),
      String(form.get("provider_id")),
      form.get("context_length") ? Number(form.get("context_length")) : null,
      form.get("is_primary") === "1" ? 1 : 0,
    );
    reload();
    return null;
  }

  if (section === "pool") {
    const intent = String(form.get("intent"));
    if (intent === "update") {
      query(
        `UPDATE providers SET weight = ?, priority = ? WHERE id = ?`,
      ).run(
        Number(form.get("weight") ?? 1),
        Number(form.get("priority") ?? 0),
        String(form.get("provider_id")),
      );
    }
    if (intent === "add") {
      query(
        `INSERT INTO models (model_name, provider_id, context_length, is_active, is_primary)
         VALUES (?, ?, ?, 1, 0)
         ON CONFLICT(model_name, provider_id) DO NOTHING`,
      ).run(
        String(form.get("model_name")),
        String(form.get("provider_id")),
        form.get("context_length") ? Number(form.get("context_length")) : null,
      );
    }
    reload();
    return null;
  }

  // section === "balancing"
  query(
    `INSERT INTO load_balancing
       (model_name, strategy, fallback_enabled, health_check_enabled,
        health_check_url, health_check_interval, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, unixepoch())
     ON CONFLICT(model_name) DO UPDATE SET
       strategy = ?, fallback_enabled = ?, health_check_enabled = ?,
       health_check_url = ?, health_check_interval = ?, updated_at = unixepoch()`,
  ).run(
    String(form.get("model")),
    String(form.get("strategy") ?? "round_robin"),
    form.get("fallback_enabled") === "1" ? 1 : 0,
    form.get("health_check_enabled") === "1" ? 1 : 0,
    String(form.get("health_check_url") ?? null),
    Number(form.get("health_check_interval") ?? 60),
    String(form.get("strategy") ?? "round_robin"),
    form.get("fallback_enabled") === "1" ? 1 : 0,
    form.get("health_check_enabled") === "1" ? 1 : 0,
    String(form.get("health_check_url") ?? null),
    Number(form.get("health_check_interval") ?? 60),
  );
  return null;
}

const STRATEGIES = [
  "round_robin",
  "random",
  "priority",
  "weighted",
  "least_conn",
  "first_available",
];

function inputClass() {
  return "rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-800 dark:text-white";
}

export default function Combo({ loaderData }: Route.ComponentProps) {
  const { models, lb, pool, providers } = loaderData;
  const [tab, setTab] = useState<"mapping" | "balancing" | "pool">("mapping");

  const nthTab = (label: string, id: "mapping" | "balancing" | "pool") => (
    <button
      type="button"
      onClick={() => setTab(id)}
      className={`flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium ${
        tab === id
          ? "bg-blue-600 text-white"
          : "bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
      }`}
    >
      {label}
    </button>
  );

  return (
    <div>
      <h1 className="mb-6 flex items-center gap-2 text-2xl font-bold text-gray-900 dark:text-white">
        <Link2 size={24} /> Combo
      </h1>
      <div className="tabs-scroll mb-6">
        {nthTab("Model Mapping", "mapping")}
        {nthTab("Load Balancing", "balancing")}
        {nthTab("Provider Pool", "pool")}
      </div>

      {tab === "mapping" ? (
        <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900">
          <Form method="post" className="mb-4 flex flex-wrap items-end gap-3">
            <input type="hidden" name="section" value="mapping" />
            <div>
              <label className="mb-1 block text-xs text-gray-500 dark:text-gray-400">Model</label>
              <input name="model_name" required placeholder="gpt-4o" className={inputClass()} />
            </div>
            <div>
              <label className="mb-1 block text-xs text-gray-500 dark:text-gray-400">Provider</label>
              <select name="provider_id" className={inputClass()}>
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.id}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs text-gray-500 dark:text-gray-400">Context</label>
              <input name="context_length" type="number" placeholder="128000" className={`${inputClass()} w-32`} />
            </div>
            <label className="flex items-center gap-2 pb-2 text-sm text-gray-700 dark:text-gray-300">
              <input name="is_primary" type="checkbox" value="1" className="h-4 w-4" />
              primary
            </label>
            <button className="rounded-lg bg-blue-600 px-4 py-2 text-sm text-white">Add</button>
          </Form>
          <div className="table-wrap">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase text-gray-400 dark:border-gray-700">
                  <th className="py-3 pr-4">Model</th>
                  <th className="py-3 pr-4">Provider</th>
                  <th className="py-3 pr-4">Context</th>
                  <th className="py-3 pr-4">Primary</th>
                  <th className="py-3">Actions</th>
                </tr>
              </thead>
              <tbody>
                {models.map((m) => (
                  <tr key={m.id} className="border-b border-gray-100 dark:border-gray-800">
                    <td className="py-2 pr-4 font-medium text-gray-900 dark:text-white">{m.model_name}</td>
                    <td className="py-2 pr-4 text-gray-800 dark:text-gray-200">{m.provider_id}</td>
                    <td className="py-2 pr-4 text-gray-800 dark:text-gray-200">{m.context_length ?? "-"}</td>
                    <td className="py-2 pr-4">
                      {m.is_primary ? (
                        <span className="rounded bg-blue-100 px-2 py-0.5 text-xs text-blue-700 dark:bg-blue-900/50 dark:text-blue-300">primary</span>
                      ) : null}
                    </td>
                    <td className="py-2">
                      <Form method="post">
                        <input type="hidden" name="section" value="mapping" />
                        <input type="hidden" name="intent" value="delete" />
                        <input type="hidden" name="id" value={m.id} />
                        <button className="text-red-500 hover:underline dark:text-red-400">Delete</button>
                      </Form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : tab === "balancing" ? (
        <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900">
          <div className="table-wrap">
            <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs uppercase text-gray-400 dark:border-gray-700">
                <th className="py-3 pr-4">Model</th>
                <th className="py-3 pr-4">Strategy</th>
                <th className="py-3 pr-4">Fallback</th>
                <th className="py-3 pr-4">Health Check</th>
                <th className="py-3">Interval</th>
              </tr>
            </thead>
            <tbody>
              {lb.map((row) => (
                <tr key={row.model_name} className="border-b border-gray-100 dark:border-gray-800">
                  <td colSpan={5}>
                    <Form method="post" className="flex flex-wrap items-center gap-3 py-1">
                      <input type="hidden" name="section" value="balancing" />
                      <input type="hidden" name="model" value={row.model_name} />
                      <span className="w-32 font-medium text-gray-900 dark:text-white">{row.model_name}</span>
                      <select name="strategy" defaultValue={row.strategy} className={inputClass()}>
                        {STRATEGIES.map((s) => (
                          <option key={s} value={s}>
                            {s}
                          </option>
                        ))}
                      </select>
                      <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                        <input
                          type="checkbox"
                          name="fallback_enabled"
                          value="1"
                          defaultChecked={!!row.fallback_enabled}
                          className="h-4 w-4"
                        />
                        fallback
                      </label>
                      <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                        <input
                          type="checkbox"
                          name="health_check_enabled"
                          value="1"
                          defaultChecked={!!row.health_check_enabled}
                          className="h-4 w-4"
                        />
                        health
                      </label>
                      <input
                        name="health_check_url"
                        defaultValue={row.health_check_url ?? ""}
                        placeholder="health url"
                        className={`${inputClass()} w-40`}
                      />
                      <input
                        name="health_check_interval"
                        type="number"
                        defaultValue={row.health_check_interval}
                        className={`${inputClass()} w-20`}
                      />
                      <button
                        type="submit"
                        className="rounded-lg bg-blue-600 px-3 py-1.5 text-xs text-white"
                      >
                        Save
                      </button>
                    </Form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>
      ) : (
        <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900">
          <Form method="post" className="mb-4 flex flex-wrap items-end gap-3">
            <input type="hidden" name="section" value="pool" />
            <input type="hidden" name="intent" value="add" />
            <div>
              <label className="mb-1 block text-xs text-gray-500 dark:text-gray-400">Model</label>
              <input name="model_name" required className={inputClass()} />
            </div>
            <div>
              <label className="mb-1 block text-xs text-gray-500 dark:text-gray-400">Provider</label>
              <select name="provider_id" className={inputClass()}>
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.id}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs text-gray-500 dark:text-gray-400">Context</label>
              <input name="context_length" type="number" className={`${inputClass()} w-32`} />
            </div>
            <button type="submit" className="rounded-lg bg-blue-600 px-4 py-2 text-sm text-white">
              Add to pool
            </button>
          </Form>
          <div className="table-wrap">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs uppercase text-gray-400 dark:border-gray-700">
                <th className="py-3 pr-4">Model</th>
                <th className="py-3 pr-4">Provider</th>
                <th className="py-3 pr-4">Weight</th>
                <th className="py-3 pr-4">Priority</th>
                <th className="py-3 pr-4">Connections</th>
                <th className="py-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {pool.map((row) => (
                <tr key={`${row.model_name}-${row.provider_id}`} className="border-b border-gray-100 dark:border-gray-800">
                  <td className="py-2 pr-4 font-medium text-gray-900 dark:text-white">{row.model_name}</td>
                  <td className="py-2 pr-4 text-gray-800 dark:text-gray-200">{row.provider_id}</td>
                  <td className="py-2 pr-4" colSpan={4}>
                    <Form method="post" className="flex items-center gap-3">
                      <input type="hidden" name="section" value="pool" />
                      <input type="hidden" name="intent" value="update" />
                      <input type="hidden" name="provider_id" value={row.provider_id} />
                      <input
                        name="weight"
                        type="number"
                        defaultValue={row.weight}
                        className={`${inputClass()} w-20`}
                      />
                      <input
                        name="priority"
                        type="number"
                        defaultValue={row.priority}
                        className={`${inputClass()} w-20`}
                      />
                      <span className="text-xs text-gray-400 dark:text-gray-500">{row.current_connections} conn</span>
                      <button
                        type="submit"
                        className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
                      >
                        Save
                      </button>
                    </Form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>
      )}
    </div>
  );
}