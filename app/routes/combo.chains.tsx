import { useState } from "react";
import { Form } from "react-router";
import type { Route } from "./+types/combo.chains";
import { Link2, Plus, Trash2, ListFilter } from "lucide-react";
import { listCombos, createCombo, deleteCombo, validateComboInput } from "../.server/combo";
import { query } from "../.server/db";

export function loader() {
  const combos = listCombos();
  const providers = (
    query("SELECT id, name FROM providers ORDER BY id").all() as unknown as {
      id: string;
      name: string;
    }[]
  ) ?? [];
  const models = (
    query("SELECT DISTINCT model_name AS name FROM models ORDER BY model_name").all() as unknown as {
      name: string;
    }[]
  ) ?? [];
  return { combos, providers, models };
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const section = String(form.get("section"));

  if (section === "delete") {
    deleteCombo(Number(form.get("id")));
    return null;
  }

  if (section === "create") {
    const stepCount = Number(form.get("step_count") ?? 0);
    const steps = [];
    for (let i = 0; i < stepCount; i += 1) {
      const modelId = String(form.get(`step_model_${i}`) ?? "").trim();
      if (!modelId) continue;
      steps.push({
        modelId,
        providerId: String(form.get(`step_provider_${i}`) ?? "").trim() || null,
        prompt: String(form.get(`step_prompt_${i}`) ?? "").trim() || null,
      });
    }
    const input = {
      name: String(form.get("name") ?? "").trim(),
      strategy: String(form.get("strategy") ?? "priority") as "priority" | "pipeline",
      steps,
    };
    const error = validateComboInput(input);
    if (error) return { error };
    try {
      const combo = createCombo(input);
      return { created: combo.name };
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  return null;
}

const inputClass =
  "w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100";

const STRATEGY_HINT: Record<string, string> = {
  priority: "Coba step 1; jika gagal → step 2, dst. (fallback chain)",
  pipeline: "Jalankan berurutan; tiap model menerima output model sebelumnya.",
};

export default function ComboChains({ loaderData, actionData }: Route.ComponentProps) {
  const { combos, providers, models } = loaderData;
  const [stepCount, setStepCount] = useState(2);
  const msg = actionData as { error?: string; created?: string } | undefined;

  return (
    <div>
      <h1 className="mb-6 flex items-center gap-2 text-2xl font-bold text-gray-900 dark:text-white">
        <Link2 size={24} /> Combo Chains
      </h1>

      <a
        href="/combo"
        className="mb-6 inline-flex items-center gap-2 rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-800"
      >
        <ListFilter size={16} /> Per-model routing (Combo)
      </a>

      {msg?.created ? (
        <div className="mb-4 rounded-lg border border-green-300 bg-green-50 p-4 text-sm text-green-800 dark:border-green-700 dark:bg-green-950/40 dark:text-green-200">
          Combo <code>{msg.created}</code> dibuat. Pakai model{" "}
          <code className="rounded bg-white px-1 py-0.5 font-mono text-xs dark:bg-gray-900">
            combo:{msg.created}
          </code>{" "}
          di endpoint /v1/*.
        </div>
      ) : null}
      {msg?.error ? (
        <div className="mb-4 rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-800 dark:border-red-700 dark:bg-red-950/40 dark:text-red-200">
          {msg.error}
        </div>
      ) : null}

      <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900">
        <h2 className="mb-3 text-lg font-semibold text-gray-900 dark:text-white">Buat Combo Baru</h2>
        <Form method="post" className="space-y-4">
          <input type="hidden" name="section" value="create" />
          <div className="grid gap-4 md:grid-cols-3">
            <div>
              <label className="mb-1 block text-xs text-gray-500 dark:text-gray-400">Nama Combo</label>
              <input name="name" required placeholder="coding-fallback" className={inputClass} />
              <p className="mt-1 text-xs text-gray-400">
                Dipanggil via model <code className="font-mono">combo:coding-fallback</code>
              </p>
            </div>
            <div>
              <label className="mb-1 block text-xs text-gray-500 dark:text-gray-400">Strategi</label>
              <select name="strategy" defaultValue="priority" className={inputClass}>
                <option value="priority">Priority (fallback chain)</option>
                <option value="pipeline">Pipeline (sequential)</option>
              </select>
              <p className="mt-1 text-xs text-gray-400">Pilih strategi untuk melihat hint.</p>
            </div>
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300">
                Steps ({stepCount})
              </h3>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setStepCount((c) => c + 1)}
                  className="flex items-center gap-1 rounded border border-gray-300 px-2 py-1 text-xs text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
                >
                  <Plus size={12} /> Step
                </button>
                <button
                  type="button"
                  onClick={() => setStepCount((c) => Math.max(1, c - 1))}
                  className="flex items-center gap-1 rounded border border-gray-300 px-2 py-1 text-xs text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
                >
                  <Trash2 size={12} /> Hapus
                </button>
              </div>
            </div>
            <input type="hidden" name="step_count" value={stepCount} />
            {Array.from({ length: stepCount }, (_, i) => (
              <div key={i} className="rounded-lg border border-gray-200 p-3 dark:border-gray-700">
                <div className="mb-2 flex items-center gap-2">
                  <span className="rounded bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700 dark:bg-blue-900/40 dark:text-blue-300">
                    Step {i + 1}
                  </span>
                  <span className="text-xs text-gray-400">
                    {i === 0 ? "pertama" : i === stepCount - 1 ? "final" : "lanjutan"}
                  </span>
                </div>
                <div className="grid gap-3 md:grid-cols-3">
                  <div>
                    <label className="mb-1 block text-xs text-gray-500 dark:text-gray-400">Model</label>
                    <input
                      name={`step_model_${i}`}
                      required
                      list="combo-chains-models"
                      placeholder="gpt-4o-mini"
                      className={inputClass}
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs text-gray-500 dark:text-gray-400">
                      Provider (opsional)
                    </label>
                    <input
                      name={`step_provider_${i}`}
                      list="combo-chains-providers"
                      placeholder="openai"
                      className={inputClass}
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs text-gray-500 dark:text-gray-400">
                      Instruksi step (opsional)
                    </label>
                    <input
                      name={`step_prompt_${i}`}
                      placeholder="Periksa & perbaiki hasil sebelumnya"
                      className={inputClass}
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>

          <button
            type="submit"
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
          >
            Simpan Combo
          </button>
        </Form>

        <datalist id="combo-chains-models">
          {models.map((m) => (
            <option key={m.name} value={m.name} />
          ))}
        </datalist>
        <datalist id="combo-chains-providers">
          {providers.map((p) => (
            <option key={p.id} value={p.id} />
          ))}
        </datalist>
      </div>

      <div className="mt-8 space-y-4">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white">Combo Terdaftar</h2>
        {combos.length === 0 ? (
          <p className="text-sm text-gray-500 dark:text-gray-400">Belum ada combo. Buat satu di atas.</p>
        ) : (
          combos.map((c) => (
            <div key={c.id} className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <span className="text-base font-semibold text-gray-900 dark:text-white">
                    <code className="font-mono">combo:{c.name}</code>
                  </span>
                  <span
                    className={`rounded px-2 py-0.5 text-xs font-medium ${
                      c.strategy === "pipeline"
                        ? "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300"
                        : "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300"
                    }`}
                  >
                    {c.strategy}
                  </span>
                </div>
                <Form method="post">
                  <input type="hidden" name="section" value="delete" />
                  <input type="hidden" name="id" value={c.id} />
                  <button
                    type="submit"
                    className="flex items-center gap-1 rounded border border-red-300 px-2 py-1 text-xs text-red-600 hover:bg-red-50 dark:border-red-700 dark:text-red-300 dark:hover:bg-red-950/40"
                    onClick={(e) => {
                      if (!confirm(`Hapus combo "${c.name}"?`)) e.preventDefault();
                    }}
                  >
                    <Trash2 size={12} /> Hapus
                  </button>
                </Form>
              </div>
              <ol className="mt-3 space-y-1">
                {c.steps.map((s, i) => (
                  <li key={s.id} className="flex flex-wrap items-center gap-2 text-sm text-gray-600 dark:text-gray-300">
                    <span className="text-xs text-gray-400">{i + 1}.</span>
                    <code className="rounded bg-gray-100 px-1.5 py-0.5 font-mono text-xs dark:bg-gray-800">
                      {s.modelId}
                    </code>
                    {s.providerId ? (
                      <span className="text-xs text-gray-500 dark:text-gray-400">@{s.providerId}</span>
                    ) : null}
                    {s.prompt ? (
                      <span className="text-xs italic text-gray-500 dark:text-gray-400">— {s.prompt}</span>
                    ) : null}
                  </li>
                ))}
              </ol>
            </div>
          ))
        )}
      </div>
    </div>
  );
}