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
import { Combobox } from "../components/ui/combobox";
import { PageHeader } from "../components/ui/page-header";
import { Card } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input, Label, Select } from "../components/ui/field";
import { EmptyState } from "../components/ui/empty-state";
import { useConfirm } from "../components/ui/confirm-dialog";
import { query } from "../.server/db";

type ProviderOption = { id: string; name: string };
type ModelOption = { model_name: string; provider_id: string };
type AccountOption = { id: number; provider_id: string; label: string | null };

export function loader() {
  const combos = listCombos();
  const providers =
    (query("SELECT id, name FROM providers ORDER BY id").all() as unknown as ProviderOption[]) ??
    [];
  const modelRows =
    (query(
      "SELECT model_name, provider_id FROM models WHERE is_active = 1 ORDER BY model_name",
    ).all() as unknown as ModelOption[]) ?? [];
  const accounts =
    (query(
      "SELECT id, provider_id, label FROM provider_credentials WHERE is_active = 1 ORDER BY provider_id, id",
    ).all() as unknown as AccountOption[]) ?? [];
  return { combos, providers, modelRows, accounts };
}

type ActionMsg = { error?: string; saved?: string };

/** Resolve comma-separated account input ("key 1, key 2") into credential ids. */
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
        accountIds: providerId
          ? resolveAccountIds(providerId, String(form.get(`step_account_${i}`) ?? ""))
          : [],
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
        return { saved: `Combo "${combo.name}" created` } satisfies ActionMsg;
      }
      updateCombo(id!, input);
      return { saved: `Combo "${input.name}" updated` } satisfies ActionMsg;
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) } satisfies ActionMsg;
    }
  }

  return null;
}

const comboInputClass =
  "w-full rounded-lg border border-border bg-surface-2 px-3 text-sm text-foreground placeholder:text-muted-foreground transition-colors focus:border-primary focus:outline-none focus:ring-2 focus:ring-ring/40 disabled:opacity-50";

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

  // All models used across steps (prevents duplicates between steps).
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
        <h3 className="text-sm font-medium text-muted-foreground">
          Models in combo ({steps.length})
        </h3>
        <Button variant="outline" size="sm" onClick={addStep}>
          <Plus size={12} /> Step
        </Button>
      </div>

      {steps.map((s, i) => {
        const providerIds = providers.map((p) => p.id);
        const providerOpt = providers.find(
          (p) => p.id === s.provider || p.name === s.provider,
        );
        const providerId = providerOpt?.id ?? "";
        const availableModels = modelsForProvider(modelRows, providerId).filter(
          (m) => !taken.has(m),
        );
        const accountOpts = accountsForProvider(accounts, providerId);
        return (
          <Card key={i} padded={false} className="p-3">
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-2">
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-surface-2 text-xs font-semibold text-muted-foreground">
                  {i + 1}
                </span>
                <span className="text-xs font-medium text-muted-foreground">Step {i + 1}</span>
                {providerOpt ? (
                  <Badge tone="info" style="subtle">
                    {providerOpt.name || providerOpt.id}
                  </Badge>
                ) : null}
              </span>
              <div className="flex items-center gap-1">
                <Badge tone="neutral" style="subtle">
                  {s.models.length} {s.models.length === 1 ? "model" : "models"}
                </Badge>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-6 gap-1 px-2 text-xs text-danger"
                  onClick={() => removeStep(i)}
                  title="Delete this step"
                  aria-label="Delete this step"
                >
                  <Trash2 size={12} /> Delete
                </Button>
              </div>
            </div>

            <div className="mt-3 grid gap-3 md:grid-cols-3">
              <div>
                <Label htmlFor={`${prefix}_provider_${i}`}>Provider (search)</Label>
                <Combobox
                  id={`${prefix}_provider_${i}`}
                  name={`${prefix}_provider_${i}`}
                  options={providerIds}
                  value={s.provider}
                  onChange={(v) => updateStep(i, { provider: v, models: [], accountText: "" })}
                  placeholder="Type a provider name…"
                  className={comboInputClass}
                />
              </div>

              <div>
                <Label htmlFor={`${prefix}_models_${i}`}>Models (search, multi-select)</Label>
                <ModelAdder
                  id={`${prefix}_models_${i}`}
                  options={availableModels}
                  selected={s.models}
                  disabled={!providerId}
                  onAdd={(m) => updateStep(i, { models: [...s.models, m] })}
                  onRemove={(m) => updateStep(i, { models: s.models.filter((x) => x !== m) })}
                />
                {!providerId ? (
                  <p className="mt-1 text-xs text-warning">Select a provider first.</p>
                ) : null}
              </div>

              <div>
                <Label htmlFor={`${prefix}_account_${i}`}>
                  <UserRound size={11} className="mr-1 inline" /> Account (multi)
                </Label>
                <KeyAdder
                  id={`${prefix}_account_${i}`}
                  name={`${prefix}_account_${i}`}
                  options={accountOpts.map((a) => a.label || `#${a.id}`)}
                  value={s.accountText}
                  onChange={(v) => updateStep(i, { accountText: v })}
                  disabled={!providerId}
                  placeholder="Type an account, then press Enter…"
                />
                {accountOpts.length === 0 && providerId ? (
                  <p className="mt-1 text-xs text-warning">This provider has no accounts yet.</p>
                ) : null}
              </div>
            </div>

            <div className="mt-3">
              <Label htmlFor={`${prefix}_prompt_${i}`}>Step instructions (optional)</Label>
              <Input
                id={`${prefix}_prompt_${i}`}
                name={`${prefix}_prompt_${i}`}
                value={s.prompt}
                onChange={(e) => updateStep(i, { prompt: e.target.value })}
                placeholder="Review and fix previous output"
              />
            </div>
          </Card>
        );
      })}

      <input type="hidden" name="step_count" value={steps.length} />
      {/* Model ids are submitted as hidden inputs so form.getAll() works. */}
      {steps.map((s, i) =>
        s.models.map((m) => (
          <input key={`${i}-${m}`} type="hidden" name={`step_model_ids_${i}`} value={m} />
        )),
      )}
    </div>
  );
}

function ModelAdder({
  id,
  options,
  selected,
  disabled,
  onAdd,
  onRemove,
}: {
  id?: string;
  options: string[];
  selected: string[];
  disabled?: boolean;
  onAdd: (m: string) => void;
  onRemove: (m: string) => void;
}) {
  const [query, setQuery] = useState("");

  const handleChange = (v: string) => {
    const exact = options.find((o) => o.toLowerCase() === v.trim().toLowerCase());
    if (exact && !selected.includes(exact)) {
      onAdd(exact);
      setQuery("");
    } else {
      setQuery(v);
    }
  };

  return (
    <>
      {disabled ? (
        <Input id={id} value="" disabled placeholder="Select a provider first" />
      ) : (
        <Combobox
          id={id}
          options={options}
          value={query}
          onChange={handleChange}
          placeholder="Type a model, then press Enter…"
          className={comboInputClass}
        />
      )}
      {selected.length > 0 ? (
        <div className="mt-1 flex flex-wrap gap-1">
          {selected.map((m) => (
            <Badge key={m} tone="info" style="subtle" className="gap-1 font-mono">
              {m}
              <button
                type="button"
                onClick={() => onRemove(m)}
                className="text-info/70 hover:text-info"
                aria-label={`Remove ${m}`}
              >
                <X size={11} />
              </button>
            </Badge>
          ))}
        </div>
      ) : null}
    </>
  );
}

function KeyAdder({
  id,
  options,
  value,
  onChange,
  name,
  disabled,
  placeholder,
}: {
  id?: string;
  options: string[];
  value: string;
  onChange: (v: string) => void;
  name: string;
  disabled?: boolean;
  placeholder?: string;
}) {
  const [query, setQuery] = useState("");

  const parts = value
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0 && t.toLowerCase() !== "dynamic");

  const handleChange = (v: string) => {
    const exact = options.find((o) => o.toLowerCase() === v.trim().toLowerCase());
    if (exact && !parts.includes(exact)) {
      onChange([...parts, exact].join(", "));
      setQuery("");
    } else {
      setQuery(v);
    }
  };

  const remove = (label: string) => {
    const next = parts.filter((p) => p !== label);
    onChange(next.length === 0 ? "dynamic" : next.join(", "));
  };

  return (
    <>
      <input type="hidden" name={name} value={value || "dynamic"} />
      {disabled ? (
        <Input id={id} value="" disabled placeholder="Select a provider first" />
      ) : (
        <Combobox
          id={id}
          options={options}
          value={query}
          onChange={handleChange}
          placeholder={placeholder}
          className={comboInputClass}
        />
      )}
      {parts.length > 0 ? (
        <div className="mt-1 flex flex-wrap gap-1">
          {parts.map((p) => (
            <Badge key={p} tone="info" style="subtle" className="gap-1">
              {p}
              <button
                type="button"
                onClick={() => remove(p)}
                className="text-info/70 hover:text-info"
                aria-label={`Remove ${p}`}
              >
                <X size={11} />
              </button>
            </Badge>
          ))}
        </div>
      ) : (
        <p className="mt-1 text-xs text-muted-foreground">dynamic = use all accounts.</p>
      )}
    </>
  );
}

export default function Combo({ loaderData }: Route.ComponentProps) {
  const { combos, providers, modelRows, accounts } = loaderData;
  const msg = useActionData<ActionMsg>();
  const [editingId, setEditingId] = useState<number | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const { dialog, confirm } = useConfirm();

  const renderEditForm = (c: (typeof combos)[number]) => {
    return (
      <div className="mt-4 rounded-lg border border-primary/30 bg-primary/5 p-4">
        <h3 className="mb-3 text-sm font-semibold text-foreground">
          Edit <code className="font-mono">combo:{c.name}</code>
        </h3>
        <Form method="post" className="space-y-4">
          <input type="hidden" name="section" value="update" />
          <input type="hidden" name="id" value={c.id} />
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <Label htmlFor="edit-name">Combo Name</Label>
              <Input id="edit-name" name="name" required defaultValue={c.name} />
            </div>
            <div>
              <Label htmlFor={`edit-strategy-${c.id}`}>Rotation Method</Label>
              <Select
                id={`edit-strategy-${c.id}`}
                name="strategy"
                defaultValue={c.strategy}
              >
                <option value="priority">Priority (fallback chain)</option>
                <option value="pipeline">Pipeline (sequential chaining)</option>
              </Select>
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
            <Button type="submit" className="items-center gap-1">
              Save Changes
            </Button>
            <Button type="button" variant="outline" onClick={() => setEditingId(null)}>
              Cancel
            </Button>
          </div>
        </Form>
      </div>
    );
  };

  return (
    <div>
      <PageHeader
        title="Combo"
        icon={<GitBranch size={24} />}
        subtitle="Combine multiple models into a single synthetic model."
      />

      {msg?.saved ? (
        <p className="mb-4 rounded-lg border border-success/30 bg-success/10 p-4 text-sm text-success">
          {msg.saved}
        </p>
      ) : null}
      {msg?.error ? (
        <p className="mb-4 rounded-lg border border-danger/30 bg-danger/10 p-4 text-sm text-danger">
          {msg.error}
        </p>
      ) : null}

      <p className="mb-6 max-w-2xl text-sm text-muted-foreground">
        Combos combine several models into one synthetic model reached via{" "}
        <code className="font-mono">combo:&lt;name&gt;</code>. Each step: pick a provider →
        pick 1+ of that provider's models → set accounts ("dynamic" = all accounts, or enter
        "key 1, key 2" for specific accounts). A model cannot be reused across steps.{" "}
        <strong>Priority</strong> = automatic fallback; <strong>Pipeline</strong> = each step's
        output is forwarded to the next step.
      </p>

      <div className="mb-6 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-foreground">
          All Combos ({combos.length})
        </h2>
        <Button onClick={() => setShowAdd((s) => !s)} className="items-center gap-1">
          <Plus size={16} /> {showAdd ? "Close Form" : "Add Combo"}
        </Button>
      </div>

      {showAdd ? (
        <Card className="mb-8">
          <h2 className="mb-3 text-lg font-semibold text-foreground">Add Combo</h2>
          <Form method="post" className="space-y-4">
            <input type="hidden" name="section" value="create" />
            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <Label htmlFor="add-name">Combo Name</Label>
                <Input id="add-name" name="name" required placeholder="coding-fallback" />
                <p className="mt-1 text-xs text-muted-foreground">
                  Called via model <code className="font-mono">combo:coding-fallback</code>
                </p>
              </div>
              <div>
                <Label htmlFor="add-strategy">Rotation Method</Label>
                <Select id="add-strategy" name="strategy" defaultValue="priority">
                  <option value="priority">Priority (fallback chain)</option>
                  <option value="pipeline">Pipeline (sequential chaining)</option>
                </Select>
                <p className="mt-1 text-xs text-muted-foreground">
                  Choose the rotation method between the steps/models in the combo.
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
              <Button type="submit" className="items-center gap-1">
                <Plus size={15} /> Save Combo
              </Button>
            </div>
          </Form>
        </Card>
      ) : null}

      {combos.length === 0 ? (
        <Card padded={false}>
          <EmptyState
            icon={<Link2 size={32} />}
            title="No combos yet"
            description='Create one with "Add Combo".'
          />
        </Card>
      ) : (
        <div className="space-y-4">
          {combos.map((c) => (
            <Card key={c.id}>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="text-base font-semibold text-foreground">
                    <code className="font-mono">combo:{c.name}</code>
                  </span>
                  <Badge tone={c.strategy === "pipeline" ? "primary" : "info"} style="subtle">
                    {c.strategy === "pipeline" ? "pipeline" : "priority"}
                  </Badge>
                  <Badge tone="neutral" style="subtle">
                    {c.steps.reduce((n, s) => n + s.modelIds.length, 0)}{" "}
                    {c.steps.reduce((n, s) => n + s.modelIds.length, 0) === 1 ? "model" : "models"}
                  </Badge>
                </div>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    className="gap-1"
                    onClick={() => setEditingId(editingId === c.id ? null : c.id)}
                  >
                    <Pencil size={12} /> Edit
                  </Button>
                  <Form
                    method="post"
                    onSubmit={async (e) => {
                      if (
                        !(await confirm({
                          title: "Delete combo?",
                          description: `combo:${c.name} will be permanently removed.`,
                          confirmLabel: "Delete",
                          variant: "danger",
                        }))
                      )
                        e.preventDefault();
                    }}
                  >
                    <input type="hidden" name="section" value="delete" />
                    <input type="hidden" name="id" value={c.id} />
                    <Button type="submit" size="sm" variant="danger" className="gap-1">
                      <Trash2 size={12} /> Delete
                    </Button>
                  </Form>
                </div>
              </div>

              <div className="mt-3 space-y-2">
                {c.steps.map((s, i) => {
                  const accs = accountsForProvider(accounts, s.providerId ?? "");
                  return (
                    <div
                      key={s.id}
                      className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface-2/50 px-3 py-2 text-xs text-muted-foreground"
                    >
                      <span className="font-semibold text-foreground">{i + 1}.</span>
                      <Badge tone="info" style="subtle">
                        {s.providerId || "any"}
                      </Badge>
                      <code className="font-mono">{s.modelIds.join(", ")}</code>
                      <span className="flex items-center gap-1">
                        <UserRound size={11} />
                        {s.accountIds.length === 0
                          ? "dynamic"
                          : s.accountIds
                              .map((aid) => accs.find((a) => a.id === aid)?.label ?? `#${aid}`)
                              .join(", ")}
                      </span>
                      {s.prompt ? (
                        <span className="max-w-xs truncate italic" title={s.prompt}>
                          &ldquo;{s.prompt}&rdquo;
                        </span>
                      ) : null}
                      {i < c.steps.length - 1 ? (
                        <span>{c.strategy === "pipeline" ? "→" : "|"}</span>
                      ) : null}
                    </div>
                  );
                })}
              </div>

              {editingId === c.id ? renderEditForm(c) : null}
            </Card>
          ))}
        </div>
      )}

      {dialog}
    </div>
  );
}