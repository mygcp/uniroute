import { useMemo, useState } from "react";
import { Form, useActionData } from "react-router";
import type { Route } from "./+types/combo";
import {
  Link2,
  Plus,
  Trash2,
  Pencil,
  GitBranch,
  UserRound,
  X,
} from "lucide-react";
import {
  listCombos,
  createCombo,
  updateCombo,
  deleteCombo,
  validateComboInput,
  type ComboStep,
} from "../.server/combo";
import { Combobox } from "../components/combobox";
import { query } from "../.server/db";

type ProviderOption = { id: string; name: string };
type ModelOption = { model_name: string; provider_id: string };
type AccountOption = { id: number; provider_id: string; label: string | null };

export function loader() {
  const combos = listCombos();
  const providers = (
    query("SELECT id, name FROM providers ORDER BY id").all() as unknown as ProviderOption[]
  ) ?? [];
  const modelRows = (
    query(
      "SELECT model_name, provider_id FROM models WHERE is_active = 1 ORDER BY model_name",
    ).all() as unknown as ModelOption[]
  ) ?? [];
  const accounts = (
    query(
      "SELECT id, provider_id, label FROM provider_credentials WHERE is_active = 1 ORDER BY provider_id, id",
    ).all() as unknown as AccountOption[]
  ) ?? [];
  return { combos, providers, modelRows, accounts };
}

type ActionMsg = { error?: string; saved?: string };

/** Resolusi input akun multi-value ("key 1, key 2") → daftar credential id. */
function resolveAccountIds(providerId: string, raw: string | null): number[] {
  const text = (raw ?? "").trim();
  if (!text) return [];
  const lower = text.toLowerCase();
  if (lower === "dynamic" || lower === "auto" || lower === "all") return [];
  const ids: number[] = [];
  for (const token of text.split(",")) {
    const t = token.trim();
    if (!t) continue;
    if (/^#?\d+$/.test(t)) {
      ids.push(Number(t.replace("#", "")));
      continue;
    }
    const rows = query(
      "SELECT id FROM provider_credentials WHERE provider_id = ? AND label = ? AND is_active = 1",
    ).all(providerId, t) as { id: number }[];
    for (const r of rows) ids.push(r.id);
  }
  return [...new Set(ids)];
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const section = String(form.get("section"));

  if (section === "delete") {
    deleteCombo(Number(form.get("id")));
    return null;
  }

  if (section === "create" || section === "update") {
    const id = form.get("id") ? Number(form.get("id")) : undefined;
    const stepCount = Number(form.get("step_count") ?? 0);
    const steps = [];
    for (let i = 0; i < stepCount; i += 1) {
      const modelIds = form
        .getAll(`step_model_ids_${i}`)
        .map((m) => String(m).trim())
        .filter((m) => m.length > 0);
      if (modelIds.length === 0) continue;
      const providerId = String(form.get(`step_provider_${i}`) ?? "").trim() || null;
      steps.push({
        modelIds,
        providerId,
        accountIds: providerId ? resolveAccountIds(providerId, String(form.get(`step_account_${i}`) ?? "")) : [],
        prompt: String(form.get(`step_prompt_${i}`) ?? "").trim() || null,
      });
    }
    const input = {
      name: String(form.get("name") ?? "").trim(),
      strategy: String(form.get("strategy") ?? "priority") as "priority" | "pipeline",
      steps,
    };
    const error = validateComboInput(input);
    if (error) return { error } satisfies ActionMsg;
    try {
      if (section === "create") {
        const combo = createCombo(input);
        return { saved: `Combo combo:${combo.name} dibuat` } satisfies ActionMsg;
      }
      updateCombo(id!, input);
      return { saved: `Combo combo:${input.name} diperbarui` } satisfies ActionMsg;
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) } satisfies ActionMsg;
    }
  }

  return null;
}

const inputClass =
  "w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-800 dark:text-white";

function modelsForProvider(modelRows: ModelOption[], providerId: string): string[] {
  return modelRows.filter((m) => m.provider_id === providerId).map((m) => m.model_name);
}
function accountsForProvider(accounts: AccountOption[], providerId: string): AccountOption[] {
  return accounts.filter((a) => a.provider_id === providerId);
}

type StepDraft = {
  provider: string;
  models: string[];
  accountText: string;
  prompt: string;
};

function draftFromStep(step: ComboStep | undefined, accounts: AccountOption[]): StepDraft {
  if (!step) return { provider: "", models: [], accountText: "", prompt: "" };
  const accs = accountsForProvider(accounts, step.providerId ?? "");
  const labels = step.accountIds.map(
    (aid) => accs.find((a) => a.id === aid)?.label ?? `#${aid}`,
  );
  return {
    provider: step.providerId ?? "",
    models: step.modelIds,
    accountText: labels.join(", ") || "dynamic",
    prompt: step.prompt ?? "",
  };
}

function StepEditor({
  prefix,
  providers,
  modelRows,
  accounts,
  initialSteps,
}: {
  prefix: string;
  providers: ProviderOption[];
  modelRows: ModelOption[];
  accounts: AccountOption[];
  initialSteps?: ComboStep[];
}) {
  const [steps, setSteps] = useState<StepDraft[]>(() => {
    const base = initialSteps && initialSteps.length > 0 ? initialSteps : [undefined];
    return base.map((s) => draftFromStep(s, accounts));
  });

  // Semua model terpakai di seluruh step (untuk mencegah duplikat antar step).
  const taken = useMemo(() => {
    const set = new Set<string>();
    for (const s of steps) for (const m of s.models) set.add(m);
    return set;
  }, [steps]);

  const updateStep = (i: number, patch: Partial<StepDraft>) => {
    setSteps((prev) => prev.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));
  };

  const addStep = () => {
    setSteps((prev) => [...prev, { provider: "", models: [], accountText: "", prompt: "" }]);
  };
  const removeStep = (i: number) => {
    setSteps((prev) => (prev.length <= 1 ? prev : prev.filter((_, idx) => idx !== i)));
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-gray-700 dark:text-gray-300">
          Models in combo ({steps.length})
        </h3>
        <button
          type="button"
          onClick={addStep}
          className="flex items-center gap-1 rounded border border-gray-300 px-2 py-1 text-xs text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
        >
          <Plus size={12} /> Step
        </button>
      </div>

      {steps.map((s, i) => {
        const providerIds = providers.map((p) => p.id);
        const providerOpt = providers.find(
          (p) => p.id === s.provider || p.name === s.provider,
        );
        const providerId = providerOpt?.id ?? "";
        const modelOpts = modelsForProvider(modelRows, providerId);
        // Model yang sudah dipakai step lain tidak boleh dipilih lagi.
        const thisStepTaken = s.models;
        const availableModels = modelOpts.filter(
          (m) => thisStepTaken.includes(m) || (!taken.has(m)),
        );
        const accountOpts = accountsForProvider(accounts, providerId);

        return (
          <div key={i} className="rounded-lg border border-gray-200 p-3 dark:border-gray-700">
            <div className="mb-2 flex items-center justify-between">
              <span className="flex items-center gap-2">
                <span className="rounded bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700 dark:bg-blue-900/40 dark:text-blue-300">
                  Step {i + 1}
                </span>
                {providerOpt ? (
                  <span className="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-600 dark:bg-gray-800 dark:text-gray-300">
                    {providerOpt.name || providerOpt.id}
                  </span>
                ) : null}
              </span>
              <div className="flex items-center gap-1">
                <span className="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-600 dark:bg-gray-800 dark:text-gray-300">
                  {s.models.length} model
                </span>
                <button
                  type="button"
                  onClick={() => removeStep(i)}
                  title="Hapus step ini"
                  className="flex items-center gap-1 rounded border border-red-300 px-2 py-1 text-xs text-red-600 hover:bg-red-50 dark:border-red-700 dark:text-red-300 dark:hover:bg-red-950/40"
                >
                  <Trash2 size={12} /> Delete
                </button>
              </div>
            </div>

            <div className="grid gap-3 md:grid-cols-3">
              <div>
                <label className="mb-1 block text-xs text-gray-500 dark:text-gray-400">
                  Provider (search)
                </label>
                <Combobox
                  name={`${prefix}_provider_${i}`}
                  options={providerIds}
                  value={s.provider}
                  onChange={(v) => updateStep(i, { provider: v, models: [], accountText: "" })}
                  placeholder="ketik nama provider…"
                  className={inputClass}
                />
              </div>

              <div>
                <label className="mb-1 block text-xs text-gray-500 dark:text-gray-400">
                  Models (search, multi)
                </label>
                <ModelAdder
                  options={availableModels}
                  selected={s.models}
                  disabled={!providerId}
                  onAdd={(m) => updateStep(i, { models: [...s.models, m] })}
                  onRemove={(m) => updateStep(i, { models: s.models.filter((x) => x !== m) })}
                />
                {!providerId ? (
                  <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                    Pilih provider dulu.
                  </p>
                ) : null}
              </div>

              <div>
                <label className="mb-1 block text-xs text-gray-500 dark:text-gray-400">
                  <UserRound size={11} className="mr-1 inline" />
                  Account (multi)
                </label>
                <KeyAdder
                  name={`${prefix}_account_${i}`}
                  options={accountOpts.map((a) => a.label || `#${a.id}`)}
                  value={s.accountText}
                  onChange={(v) => updateStep(i, { accountText: v })}
                  disabled={!providerId}
                  placeholder={providerId ? "ketik akun lalu Enter…" : "pilih provider dulu"}
                />
                {accountOpts.length === 0 && providerId ? (
                  <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                    Provider ini belum punya akun.
                  </p>
                ) : null}
              </div>
            </div>

            <div className="mt-3">
              <label className="mb-1 block text-xs text-gray-500 dark:text-gray-400">
                Instruksi step (opsional)
              </label>
              <input
                name={`${prefix}_prompt_${i}`}
                value={s.prompt}
                onChange={(e) => updateStep(i, { prompt: e.target.value })}
                placeholder="Periksa & perbaiki hasil sebelumnya"
                className={inputClass}
              />
            </div>
          </div>
        );
      })}

      <input type="hidden" name="step_count" value={steps.length} />
      {/* Model ids dikirim sebagai checkbox hidden agar form.getAll() bekerja. */}
      {steps.map((s, i) =>
        s.models.map((m) => (
          <input
            key={`${i}-${m}`}
            type="hidden"
            name={`step_model_ids_${i}`}
            value={m}
          />
        )),
      )}
    </div>
  );
}

function ModelAdder({
  options,
  selected,
  disabled,
  onAdd,
  onRemove,
}: {
  options: string[];
  selected: string[];
  disabled?: boolean;
  onAdd: (m: string) => void;
  onRemove: (m: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const matches = options
    .filter((m) => m.toLowerCase().includes(query.trim().toLowerCase()))
    .slice(0, 30);

  const commit = (raw: string) => {
    const val = raw.trim();
    if (!val || selected.includes(val)) return;
    if (options.includes(val) || options.some((o) => o.toLowerCase() === val.toLowerCase())) {
      const exact = options.find((o) => o.toLowerCase() === val.toLowerCase()) ?? val;
      onAdd(exact);
    }
    setQuery("");
  };

  return (
    <div>
      <div className="relative">
        <input
          value={query}
          disabled={disabled}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              commit(query);
            } else if (e.key === "Backspace" && !query && selected.length > 0) {
              onRemove(selected[selected.length - 1]);
            } else if (e.key === "Escape") {
              setOpen(false);
            }
          }}
          placeholder={disabled ? "pilih provider dulu" : "ketik model lalu Enter…"}
          className={inputClass}
        />
        {open && !disabled && matches.length > 0 ? (
          <ul className="absolute z-20 mt-1 max-h-48 w-full overflow-auto rounded-lg border border-gray-300 bg-white py-1 text-sm shadow-lg dark:border-gray-600 dark:bg-gray-800">
            {matches.map((m) => (
              <li key={m}>
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => commit(m)}
                  className="block w-full px-3 py-1.5 text-left font-mono text-xs text-gray-900 hover:bg-blue-50 dark:text-white dark:hover:bg-blue-950/50"
                >
                  {m}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {selected.length > 0 ? (
        <div className="mt-1 flex flex-wrap gap-1">
          {selected.map((m) => (
            <span
              key={m}
              className="flex items-center gap-1 rounded bg-blue-100 px-2 py-0.5 font-mono text-xs text-blue-700 dark:bg-blue-900/40 dark:text-blue-300"
            >
              {m}
              <button
                type="button"
                onClick={() => onRemove(m)}
                className="text-blue-500 hover:text-blue-700 dark:text-blue-300 dark:hover:text-blue-100"
              >
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function KeyAdder({
  options,
  value,
  onChange,
  name,
  disabled,
  placeholder,
}: {
  options: string[];
  value: string;
  onChange: (v: string) => void;
  name: string;
  disabled?: boolean;
  placeholder?: string;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);

  const parts = value
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0 && t.toLowerCase() !== "dynamic");
  const matches = options
    .filter((o) => o.toLowerCase().includes(query.trim().toLowerCase()))
    .slice(0, 30);

  const commit = (raw: string) => {
    const val = raw.trim();
    if (!val) return;
    const exact = options.find((o) => o.toLowerCase() === val.toLowerCase()) ?? val;
    if (!parts.includes(exact)) {
      onChange([...parts, exact].join(", "));
    }
    setQuery("");
  };
  const remove = (label: string) => {
    const next = parts.filter((p) => p !== label);
    onChange(next.length === 0 ? "dynamic" : next.join(", "));
  };

  return (
    <div>
      <input type="hidden" name={name} value={value || "dynamic"} />
      <div className="relative">
        <input
          value={query}
          disabled={disabled}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              commit(query);
            } else if (e.key === "Backspace" && !query && parts.length > 0) {
              remove(parts[parts.length - 1]);
            } else if (e.key === "Escape") {
              setOpen(false);
            }
          }}
          placeholder={
            placeholder ?? (disabled ? "pilih provider dulu" : "ketik akun lalu Enter…")
          }
          className={inputClass}
        />
        {open && !disabled && matches.length > 0 ? (
          <ul className="absolute z-20 mt-1 max-h-48 w-full overflow-auto rounded-lg border border-gray-300 bg-white py-1 text-sm shadow-lg dark:border-gray-600 dark:bg-gray-800">
            {matches.map((o) => (
              <li key={o}>
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    commit(o);
                    setOpen(false);
                  }}
                  className="block w-full px-3 py-1.5 text-left text-xs text-gray-900 hover:bg-blue-50 dark:text-white dark:hover:bg-blue-950/50"
                >
                  {o}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {parts.length > 0 ? (
        <div className="mt-1 flex flex-wrap gap-1">
          {parts.map((p) => (
            <span
              key={p}
              className="flex items-center gap-1 rounded bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700 dark:bg-blue-900/40 dark:text-blue-300"
            >
              {p}
              <button
                type="button"
                onClick={() => remove(p)}
                className="text-blue-500 hover:text-blue-700 dark:text-blue-300 dark:hover:text-blue-100"
              >
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
      ) : (
        <p className="mt-1 text-xs text-gray-400">dynamic = semua akun otomatis.</p>
      )}
    </div>
  );
}

export default function Combo({ loaderData }: Route.ComponentProps) {
  const { combos, providers, modelRows, accounts } = loaderData;
  const msg = useActionData<ActionMsg>();
  const [editingId, setEditingId] = useState<number | null>(null);
  const [showAdd, setShowAdd] = useState(false);

  const renderEditForm = (c: (typeof combos)[number]) => {
    return (
      <div className="mt-4 rounded-lg border border-blue-200 bg-blue-50/50 p-4 dark:border-blue-900 dark:bg-blue-950/20">
        <h3 className="mb-3 text-sm font-semibold text-gray-800 dark:text-gray-200">
          Edit <code className="font-mono">combo:{c.name}</code>
        </h3>
        <Form method="post" className="space-y-4">
          <input type="hidden" name="section" value="update" />
          <input type="hidden" name="id" value={c.id} />
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs text-gray-500 dark:text-gray-400">Combo Name</label>
              <input name="name" required defaultValue={c.name} className={inputClass} />
            </div>
            <div>
              <label className="mb-1 block text-xs text-gray-500 dark:text-gray-400">
                Rotation Method
              </label>
              <select name="strategy" defaultValue={c.strategy} className={inputClass}>
                <option value="priority">Priority (fallback chain)</option>
                <option value="pipeline">Pipeline (sequential chaining)</option>
              </select>
            </div>
          </div>
          <StepEditor
            prefix="step"
            initialSteps={c.steps}
            providers={providers}
            modelRows={modelRows}
            accounts={accounts}
          />
          <div className="flex gap-2">
            <button
              type="submit"
              className="flex items-center gap-1 rounded-lg bg-blue-600 px-4 py-2 text-sm text-white"
            >
              Simpan Perubahan
            </button>
            <button
              type="button"
              onClick={() => setEditingId(null)}
              className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
            >
              Batal
            </button>
          </div>
        </Form>
      </div>
    );
  };

  return (
    <div>
      <h1 className="mb-6 flex items-center gap-2 text-2xl font-bold text-gray-900 dark:text-white">
        <GitBranch size={24} /> Combo
      </h1>

      {msg?.saved ? (
        <div className="mb-4 rounded-lg border border-green-300 bg-green-50 p-4 text-sm text-green-800 dark:border-green-700 dark:bg-green-950/40 dark:text-green-200">
          {msg.saved}
        </div>
      ) : null}
      {msg?.error ? (
        <div className="mb-4 rounded-lg border border-red-300 bg-red-50 p-4 text-sm text-red-800 dark:border-red-700 dark:bg-red-950/40 dark:text-red-200">
          {msg.error}
        </div>
      ) : null}

      <p className="mb-6 max-w-2xl text-sm text-gray-600 dark:text-gray-400">
        Combo menggabungkan beberapa model menjadi satu model sintetis via{" "}
        <code className="font-mono">combo:&lt;nama&gt;</code>. Setiap step: pilih provider →
        pilih 1+ model milik provider itu → atur akun (dynamic = semua akun, atau isi
        "key 1, key 2" untuk akun tertentu). Model tidak bisa dipakai di dua step
        berbeda. <strong>Priority</strong> = fallback otomatis; <strong>Pipeline</strong> =
        output step diteruskan ke step berikutnya.
      </p>

      {/* Daftar semua combo — tampil pertama */}
      <div className="mb-6 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
          All Combos ({combos.length})
        </h2>
        <button
          type="button"
          onClick={() => setShowAdd((s) => !s)}
          className="flex items-center gap-1 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          <Plus size={16} /> {showAdd ? "Close Form" : "Add Combo"}
        </button>
      </div>

      {showAdd ? (
        <div className="mb-8 rounded-xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900">
          <h2 className="mb-3 text-lg font-semibold text-gray-900 dark:text-white">Add Combo</h2>
          <Form method="post" className="space-y-4">
            <input type="hidden" name="section" value="create" />
            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <label className="mb-1 block text-xs text-gray-500 dark:text-gray-400">Combo Name</label>
                <input name="name" required placeholder="coding-fallback" className={inputClass} />
                <p className="mt-1 text-xs text-gray-400">
                  Dipanggil via model <code className="font-mono">combo:coding-fallback</code>
                </p>
              </div>
              <div>
                <label className="mb-1 block text-xs text-gray-500 dark:text-gray-400">
                  Rotation Method
                </label>
                <select name="strategy" defaultValue="priority" className={inputClass}>
                  <option value="priority">Priority (fallback chain)</option>
                  <option value="pipeline">Pipeline (sequential chaining)</option>
                </select>
                <p className="mt-1 text-xs text-gray-400">
                  Pilih metode rotasi antar step/model di dalam combo.
                </p>
              </div>
            </div>

            <StepEditor
              prefix="step"
              providers={providers}
              modelRows={modelRows}
              accounts={accounts}
            />

            <div className="flex items-center justify-end gap-2">
              <button
                type="submit"
                className="flex items-center gap-1 rounded-lg bg-blue-600 px-4 py-2 text-sm text-white"
              >
                <Plus size={15} /> Simpan Combo
              </button>
            </div>
          </Form>
        </div>
      ) : null}

      {combos.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-300 bg-white p-10 text-center shadow-sm dark:border-gray-700 dark:bg-gray-900">
          <Link2 size={32} className="mx-auto mb-3 text-gray-300 dark:text-gray-600" />
          <p className="text-gray-500 dark:text-gray-400">
            Belum ada combo. Buat satu via "Add Combo".
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {combos.map((c) => (
            <div
              key={c.id}
              className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900"
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-3">
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
                    {c.strategy === "pipeline" ? "pipeline" : "priority"}
                  </span>
                  <span className="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-600 dark:bg-gray-800 dark:text-gray-300">
                    {c.steps.reduce((n, s) => n + s.modelIds.length, 0)} model
                  </span>
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setEditingId(editingId === c.id ? null : c.id)}
                    className="flex items-center gap-1 rounded border border-gray-300 px-2 py-1 text-xs text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
                  >
                    <Pencil size={12} /> Edit
                  </button>
                  <Form
                    method="post"
                    onSubmit={(e) => {
                      if (!confirm(`Hapus combo ${c.name}?`)) e.preventDefault();
                    }}
                  >
                    <input type="hidden" name="section" value="delete" />
                    <input type="hidden" name="id" value={c.id} />
                    <button
                      type="submit"
                      className="flex items-center gap-1 rounded border border-red-300 px-2 py-1 text-xs text-red-600 hover:bg-red-50 dark:border-red-700 dark:text-red-300 dark:hover:bg-red-950/40"
                    >
                      <Trash2 size={12} /> Delete
                    </button>
                  </Form>
                </div>
              </div>

              <div className="mt-3 space-y-2">
                {c.steps.map((s, i) => {
                  const accs = accountsForProvider(accounts, s.providerId ?? "");
                  return (
                    <div
                      key={s.id}
                      className="flex flex-wrap items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-700 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300"
                    >
                      <span className="font-semibold">{i + 1}.</span>
                      <span className="rounded bg-blue-100 px-1.5 py-0.5 font-medium text-blue-700 dark:bg-blue-900/40 dark:text-blue-300">
                        {s.providerId || "any"}
                      </span>
                      <code className="font-mono">{s.modelIds.join(", ")}</code>
                      <span className="flex items-center gap-1 text-gray-500 dark:text-gray-400">
                        <UserRound size={11} />
                        {s.accountIds.length === 0
                          ? "dynamic"
                          : s.accountIds
                              .map((aid) => accs.find((a) => a.id === aid)?.label ?? `#${aid}`)
                              .join(", ")}
                      </span>
                      {s.prompt ? (
                        <span className="max-w-xs truncate italic text-gray-400" title={s.prompt}>
                          "{s.prompt}"
                        </span>
                      ) : null}
                      {i < c.steps.length - 1 ? (
                        <span className="text-gray-300 dark:text-gray-600">
                          {c.strategy === "pipeline" ? "→" : "|"}
                        </span>
                      ) : null}
                    </div>
                  );
                })}
              </div>

              {editingId === c.id ? renderEditForm(c) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}