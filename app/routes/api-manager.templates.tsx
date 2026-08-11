import { Form } from "react-router";
import type { Route } from "./+types/api-manager.templates";
import { LayoutTemplate, Trash2 } from "lucide-react";
import { listTemplates, createTemplate, deleteTemplate } from "../.server/key-templates";

export function loader() {
  return { templates: listTemplates() };
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const intent = String(form.get("intent"));
  if (intent === "delete") {
    deleteTemplate(Number(form.get("id")));
    return null;
  }
  if (intent === "create") {
    const parseList = (name: string): string[] | undefined => {
      const raw = String(form.get(name) ?? "").trim();
      const items = raw
        .split(/[\n,]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      return items.length > 0 ? items : undefined;
    };
    const num = (name: string): number | undefined => {
      const raw = String(form.get(name) ?? "").trim();
      if (!raw) return undefined;
      const n = Number(raw);
      return Number.isFinite(n) ? n : undefined;
    };
    createTemplate(
      String(form.get("name") ?? "").trim(),
      String(form.get("description") ?? "").trim() || null,
      {
        name: String(form.get("name") ?? "").trim(),
        allowedModels: parseList("allowed_models"),
        budget: { monthly: num("budget_monthly") },
        quota: { rpm: num("quota_rpm"), tpm: num("quota_tpm"), concurrent_requests: num("quota_concurrent") },
        scopes: [],
      },
    );
    return null;
  }
  return null;
}

const inputClass =
  "w-full rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-800 dark:text-white";
const labelClass = "mb-1 block text-xs font-medium text-gray-600 dark:text-gray-300";

export default function Templates({ loaderData }: Route.ComponentProps) {
  const { templates } = loaderData;
  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="mb-6 flex items-center gap-2 text-2xl font-bold text-gray-900 dark:text-white">
        <LayoutTemplate size={24} /> API Key Templates
      </h1>

      <Form
        method="post"
        className="mb-6 space-y-3 rounded-xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900"
      >
        <input type="hidden" name="intent" value="create" />
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelClass}>Name</label>
            <input name="name" required className={inputClass} placeholder="production-default" />
          </div>
          <div>
            <label className={labelClass}>Description</label>
            <input name="description" className={inputClass} />
          </div>
        </div>
        <div>
          <label className={labelClass}>Allowed Models (comma separated)</label>
          <input name="allowed_models" className={inputClass} placeholder="gpt-4o, claude-3.5" />
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className={labelClass}>Monthly Budget ($)</label>
            <input name="budget_monthly" type="number" step="any" className={inputClass} />
          </div>
          <div>
            <label className={labelClass}>Requests/Min</label>
            <input name="quota_rpm" type="number" className={inputClass} />
          </div>
          <div>
            <label className={labelClass}>Tokens/Min</label>
            <input name="quota_tpm" type="number" className={inputClass} />
          </div>
          <div>
            <label className={labelClass}>Concurrent</label>
            <input name="quota_concurrent" type="number" className={inputClass} />
          </div>
        </div>
        <button
          type="submit"
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          Create Template
        </button>
      </Form>

      <div className="table-wrap">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-left text-xs uppercase text-gray-400 dark:border-gray-700">
              <th className="py-2 pr-4">Name</th>
              <th className="py-2 pr-4">Description</th>
              <th className="py-2 pr-4">Models</th>
              <th className="py-2">Actions</th>
            </tr>
          </thead>
          <tbody>
            {templates.map((t) => (
              <tr key={t.id} className="border-b border-gray-100 dark:border-gray-800">
                <td className="py-2 pr-4 font-medium text-gray-900 dark:text-white">{t.name}</td>
                <td className="py-2 pr-4 text-gray-500 dark:text-gray-400">{t.description ?? "—"}</td>
                <td className="py-2 pr-4 text-xs text-gray-500 dark:text-gray-400">
                  {t.config.allowedModels?.join(", ") || "all"}
                </td>
                <td className="py-2">
                  <Form method="post">
                    <input type="hidden" name="intent" value="delete" />
                    <input type="hidden" name="id" value={t.id} />
                    <button className="rounded border border-red-200 p-1 text-red-500 hover:bg-red-50 dark:border-red-900">
                      <Trash2 size={14} />
                    </button>
                  </Form>
                </td>
              </tr>
            ))}
            {templates.length === 0 ? (
              <tr>
                <td colSpan={4} className="py-6 text-center text-gray-400 dark:text-gray-500">
                  Belum ada template.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}