import { Form } from "react-router";
import { useRef, type ReactNode } from "react";
import type { Route } from "./+types/api-manager.create";
import { KeyRound, Copy } from "lucide-react";
import { createClientKey, type CreateClientKeyInput } from "../.server/client-key";
import { enqueueWebhook } from "../.server/webhook";
import { getModelSuggestions, getProviderSuggestions } from "../.server/suggest";
import { listTemplates, type KeyTemplate } from "../.server/key-templates";

export function loader() {
  return {
    modelSuggestions: getModelSuggestions(),
    providerSuggestions: getProviderSuggestions(),
    templates: listTemplates().map((t) => ({ id: t.id, name: t.name, description: t.description, config: t.config })),
  };
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const parseList = (name: string): string[] | null => {
    const raw = String(form.get(name) ?? "").trim();
    if (!raw) return null;
    const items = raw
      .split(/[\n,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    return items.length > 0 ? items : null;
  };
  const num = (name: string): number | undefined => {
    const raw = String(form.get(name) ?? "").trim();
    if (!raw) return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  };
  const date = (name: string): number | undefined => {
    const raw = String(form.get(name) ?? "").trim();
    if (!raw) return undefined;
    const t = new Date(raw).getTime();
    return Number.isFinite(t) ? Math.floor(t / 1000) : undefined;
  };

  const accessHoursEnabled = form.get("access_enabled") === "1";
  const accessHours =
    accessHoursEnabled || form.get("access_timezone") || form.get("access_days") || form.get("access_start") || form.get("access_end")
      ? {
          enabled: accessHoursEnabled,
          timezone: String(form.get("access_timezone") ?? "").trim() || undefined,
          allowed_days: parseList("access_days") ?? undefined,
          start_time: String(form.get("access_start") ?? "").trim() || undefined,
          end_time: String(form.get("access_end") ?? "").trim() || undefined,
        }
      : undefined;

  const scopesRaw = parseListUnchecked(form, "scopes");
  const manageScope = form.get("manage_scope") === "1";

  const input: CreateClientKeyInput = {
    name: String(form.get("name") ?? "").trim() || "Untitled",
    prefix: String(form.get("prefix") ?? "").trim() || "sk-",
    description: String(form.get("description") ?? "").trim() || null,
    allowedModels: parseList("allowed_models"),
    modelOverride: String(form.get("model_override") ?? "").trim() || null,
    pinnedProviderId: String(form.get("pinned_provider_id") ?? "").trim() || null,
    blockedModels: parseList("blocked_models"),
    allowedProviders: parseList("allowed_providers"),
    blockedProviders: parseList("blocked_providers"),
    budget: {
      monthly: num("budget_monthly"),
      daily: num("budget_daily"),
      per_request: num("budget_per_request"),
    },
    quota: {
      tokens_per_month: num("quota_tokens"),
      requests_per_day: num("quota_req_day"),
      concurrent_requests: num("quota_concurrent"),
      rpm: num("quota_rpm"),
      tpm: num("quota_tpm"),
    },
    alertThreshold: num("alert_threshold"),
    autoBlock: form.get("auto_block") === "1",
    ipWhitelist: parseList("ip_whitelist"),
    ipBlacklist: parseList("ip_blacklist"),
    strictIp: form.get("strict_ip") === "1",
    accessHours,
    expiresAt: date("expires_at"),
    rotationIntervalDays: num("rotation_interval_days"),
    gracePeriodDays: num("grace_period_days"),
    webhookUrl: String(form.get("webhook_url") ?? "").trim() || null,
    scopes:
      manageScope && !scopesRaw.includes("manage")
        ? [...scopesRaw, "manage"]
        : scopesRaw.length > 0
          ? scopesRaw
          : manageScope
            ? ["manage"]
            : null,
  };

  const { key, id } = createClientKey(input);
  if (input.webhookUrl) {
    enqueueWebhook({
      keyId: id,
      event: "created",
      url: input.webhookUrl,
      payload: { event: "created", key_id: id, key_prefix: input.prefix ?? "sk-", at: Date.now() },
    });
  }
  return { newlyCreatedKey: key, id, name: input.name };
}

function parseListUnchecked(form: FormData, name: string): string[] {
  const raw = String(form.get(name) ?? "").trim();
  if (!raw) return [];
  return raw
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const inputClass =
  "w-full rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-800 dark:text-white";
const labelClass = "mb-1 block text-xs font-medium text-gray-600 dark:text-gray-300";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900">
      <legend className="px-2 text-sm font-semibold text-gray-700 dark:text-gray-200">{title}</legend>
      <div className="mt-2">{children}</div>
    </fieldset>
  );
}

function CopyButton({ value }: { value: string }) {
  return (
    <button
      type="button"
      onClick={() => navigator.clipboard?.writeText(value)}
      className="flex items-center gap-1 rounded border border-gray-300 px-2 py-1 text-xs text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300"
    >
      <Copy size={12} /> Copy
    </button>
  );
}

export default function CreateKey({ loaderData, actionData }: Route.ComponentProps) {
  const { modelSuggestions, providerSuggestions, templates } = loaderData;
  const formRef = useRef<HTMLFormElement>(null);
  const created = actionData as { newlyCreatedKey?: string; name?: string } | undefined;

  const applyTemplate = (template: KeyTemplate["config"]) => {
    const el = formRef.current;
    if (!el) return;
    const set = (name: string, value: string | undefined) => {
      const field = el.elements.namedItem(name) as HTMLInputElement | HTMLTextAreaElement | null;
      if (field && value != null) field.value = value;
    };
    set("name", template.name);
    set("description", template.description ?? "");
    set("allowed_models", template.allowedModels?.join(", ") ?? "");
    set("budget_monthly", template.budget?.monthly != null ? String(template.budget.monthly) : "");
    set("budget_daily", template.budget?.daily != null ? String(template.budget.daily) : "");
    set("budget_per_request", template.budget?.per_request != null ? String(template.budget.per_request) : "");
    set("quota_tokens", template.quota?.tokens_per_month != null ? String(template.quota.tokens_per_month) : "");
    set("quota_req_day", template.quota?.requests_per_day != null ? String(template.quota.requests_per_day) : "");
    set("quota_concurrent", template.quota?.concurrent_requests != null ? String(template.quota.concurrent_requests) : "");
    set("quota_rpm", template.quota?.rpm != null ? String(template.quota.rpm) : "");
    set("quota_tpm", template.quota?.tpm != null ? String(template.quota.tpm) : "");
    set("ip_whitelist", template.ipWhitelist?.join(", ") ?? "");
    set("ip_blacklist", template.ipBlacklist?.join(", ") ?? "");
    set("webhook_url", template.webhookUrl ?? "");
    set("allowed_providers", template.allowedProviders?.join(", ") ?? "");
    set("blocked_providers", template.blockedProviders?.join(", ") ?? "");
    set("blocked_models", template.blockedModels?.join(", ") ?? "");
  };

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="mb-6 flex items-center gap-2 text-2xl font-bold text-gray-900 dark:text-white">
        <KeyRound size={24} /> Create New API Key
      </h1>

      {created?.newlyCreatedKey ? (
        <div className="mb-6 rounded-lg border border-yellow-300 bg-yellow-50 p-4 text-sm dark:border-yellow-700 dark:bg-yellow-950/40">
          <p className="font-semibold text-yellow-800 dark:text-yellow-200">
            Key berhasil dibuat — salin sekarang, tidak akan tampil lagi.
          </p>
          <div className="mt-2 flex items-start gap-2">
            <code className="break-all rounded bg-white px-3 py-2 font-mono text-xs text-gray-800 dark:bg-gray-900 dark:text-gray-100">
              {created.newlyCreatedKey}
            </code>
            <CopyButton value={created.newlyCreatedKey} />
          </div>
        </div>
      ) : null}

      <div className="mb-4 flex items-center gap-2">
        <label className={labelClass}>Create from Template:</label>
        <select
          className={inputClass}
          onChange={(e) => {
            const t = templates.find((x) => x.id === Number(e.target.value));
            if (t) applyTemplate(t.config);
          }}
        >
          <option value="">— none —</option>
          {templates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </div>

      <Form
        ref={formRef}
        method="post"
        className="space-y-4"
      >
        <Section title="Informasi">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className={labelClass}>Key Name</label>
              <input name="name" className={inputClass} required placeholder="e.g. production-client" />
            </div>
            <div>
              <label className={labelClass}>Description</label>
              <input name="description" className={inputClass} placeholder="Optional" />
            </div>
            <div>
              <label className={labelClass}>Prefix</label>
              <input name="prefix" className={inputClass} defaultValue="sk-" />
            </div>
          </div>
        </Section>

        <Section title="Permissions">
          <div className="flex flex-wrap gap-4 text-sm">
            {[
              ["chat", "Chat Completions", true],
              ["embeddings", "Embeddings"],
              ["image", "Image Generation"],
              ["audio", "Audio Transcription"],
              ["rerank", "Reranking"],
            ].map(([id, label]) => (
              <label key={id as string} className="flex items-center gap-2">
                <input type="checkbox" name="scopes" value={id as string} defaultChecked={Boolean(label === "Chat Completions")} />
                {label}
              </label>
            ))}
          </div>
          <label className="mt-3 flex items-center gap-2 text-sm">
            <input type="checkbox" name="manage_scope" value="1" />
            Management API Access (manage scope)
          </label>
        </Section>

        <Section title="Model Access">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className={labelClass}>Allowed Models (empty = all)</label>
              <textarea name="allowed_models" className={inputClass} rows={3} placeholder="gpt-4o, claude-3.5, gemini-1.5-pro" />
            </div>
            <div>
              <label className={labelClass}>Blocked Models</label>
              <textarea name="blocked_models" className={inputClass} rows={3} placeholder="gpt-4o-mini, llama-3-8b" />
            </div>
            <div>
              <label className={labelClass}>Allowed Providers (empty = all)</label>
              <input name="allowed_providers" className={inputClass} placeholder="openai, anthropic" />
            </div>
            <div>
              <label className={labelClass}>Blocked Providers</label>
              <input name="blocked_providers" className={inputClass} placeholder="deepseek" />
            </div>
            <div>
              <label className={labelClass}>Model Override (advanced)</label>
              <input name="model_override" className={inputClass} list="model-suggestions" placeholder="e.g. gpt-4o-mini" />
            </div>
            <div>
              <label className={labelClass}>Pinned Provider (advanced)</label>
              <input name="pinned_provider_id" className={inputClass} list="provider-suggestions" placeholder="e.g. openai" />
            </div>
          </div>
          <datalist id="model-suggestions">
            {modelSuggestions.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
          <datalist id="provider-suggestions">
            {providerSuggestions.map((p) => (
              <option key={p} value={p} />
            ))}
          </datalist>
        </Section>

        <Section title="Budget & Quota">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {[
              ["budget_monthly", "Monthly Budget (USD)"],
              ["budget_daily", "Daily Budget (USD)"],
              ["budget_per_request", "Per-request (USD)"],
              ["quota_tokens", "Tokens/Month"],
              ["quota_req_day", "Requests/Day"],
              ["quota_concurrent", "Concurrent"],
              ["quota_rpm", "Requests/Min"],
              ["quota_tpm", "Tokens/Min"],
              ["alert_threshold", "Alert at (0..1)"],
            ].map(([name, label]) => (
              <div key={name as string}>
                <label className={labelClass}>{label}</label>
                <input name={name} type="number" step="any" className={inputClass} />
              </div>
            ))}
          </div>
          <label className="mt-3 flex items-center gap-2 text-sm">
            <input type="checkbox" name="auto_block" value="1" defaultChecked />
            Auto-block when budget exceeded
          </label>
        </Section>

        <Section title="Security">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className={labelClass}>Expires</label>
              <input name="expires_at" type="date" className={inputClass} />
            </div>
            <div>
              <label className={labelClass}>Rotation interval (days)</label>
              <input name="rotation_interval_days" type="number" className={inputClass} placeholder="e.g. 30" />
            </div>
            <div>
              <label className={labelClass}>Grace period (days)</label>
              <input name="grace_period_days" type="number" className={inputClass} placeholder="e.g. 7" />
            </div>
            <div>
              <label className={labelClass}>Webhook URL</label>
              <input name="webhook_url" type="url" className={inputClass} placeholder="https://my-app.com/webhook" />
            </div>
            <div>
              <label className={labelClass}>IP Whitelist (CIDR / IP)</label>
              <input name="ip_whitelist" className={inputClass} placeholder="192.168.1.0/24, 10.0.0.1" />
            </div>
            <div>
              <label className={labelClass}>IP Blacklist</label>
              <input name="ip_blacklist" className={inputClass} placeholder="203.0.113.0/24" />
            </div>
          </div>
          <label className="mt-3 flex items-center gap-2 text-sm">
            <input type="checkbox" name="strict_ip" value="1" />
            Strict IP — hanya IP whitelist yang boleh akses
          </label>
        </Section>

        <Section title="Time-Based Access">
          <label className="mb-2 flex items-center gap-2 text-sm">
            <input type="checkbox" name="access_enabled" value="1" defaultChecked />
            Enable access hours
          </label>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div>
              <label className={labelClass}>Timezone</label>
              <input name="access_timezone" className={inputClass} placeholder="Asia/Jakarta" />
            </div>
            <div>
              <label className={labelClass}>Allowed days</label>
              <input name="access_days" className={inputClass} placeholder="monday, tuesday,…" />
            </div>
            <div>
              <label className={labelClass}>Start (HH:mm)</label>
              <input name="access_start" type="time" className={inputClass} defaultValue="08:00" />
            </div>
            <div>
              <label className={labelClass}>End (HH:mm)</label>
              <input name="access_end" type="time" className={inputClass} defaultValue="18:00" />
            </div>
          </div>
        </Section>

        <div className="flex items-center justify-end gap-3">
          <a href="/api-manager" className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-800">
            Cancel
          </a>
          <button type="submit" className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">
            Create API Key
          </button>
        </div>
      </Form>
    </div>
  );
}