import { Form, Link, redirect } from "react-router";
import { useState } from "react";
import type { Route } from "./+types/api-manager.$id";
import {
  ArrowLeft,
  Copy,
  Download,
  KeyRound,
  Pencil,
  RotateCw,
  Trash2,
  Lock,
  LockOpen,
} from "lucide-react";
import {
  getClientKeyById,
  updateClientKey,
  type AccessHoursConfig,
  type BudgetConfig,
  type ClientKey,
  type QuotaConfig,
} from "../.server/client-key";
import { computeStatus, type KeyStatus } from "../.server/key-enforce";
import { usageThisMonth, usageToday, usageByDay } from "../.server/key-usage";
import { listAudit, type AuditEntry } from "../.server/key-audit";
import {
  deleteKey,
  healthCheck,
  reactivateKey,
  rotateKey,
  suspendKey,
} from "../.server/key-ops";
import { groupsOfKey } from "../.server/key-groups";

export function loader({ params }: Route.LoaderArgs) {
  const id = Number(params.id);
  const key = getClientKeyById(id);
  if (!key) throw new Response("Not found", { status: 404 });

  const month = usageThisMonth(id);
  const today = usageToday(id);
  const status = computeStatus(key, month);
  const audit = listAudit(id, 50);
  const byDay = usageByDay(id, 30);
  const groups = groupsOfKey(id);
  const health = healthCheck(id);
  const budget = key.budget?.monthly;

  return { key, month, today, status, audit, byDay, groups, health, budget };
}

function parseList(form: FormData, name: string): string[] | null {
  const raw = String(form.get(name) ?? "").trim();
  if (!raw) return null;
  const items = raw
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length > 0 ? items : null;
}

function parseNum(form: FormData, name: string): number | undefined {
  const raw = String(form.get(name) ?? "").trim();
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function parseDate(form: FormData, name: string): number | undefined {
  const raw = String(form.get(name) ?? "").trim();
  if (!raw) return undefined;
  const t = new Date(raw).getTime();
  return Number.isFinite(t) ? Math.floor(t / 1000) : undefined;
}

export async function action({ request, params }: Route.ActionArgs) {
  const form = await request.formData();
  const intent = String(form.get("intent"));
  const id = Number(params.id);
  if (intent === "rotate") {
    return { newlyRotated: rotateKey(id) };
  }
  if (intent === "suspend") suspendKey(id);
  if (intent === "reactivate") reactivateKey(id);
  if (intent === "delete") {
    deleteKey(id);
    return redirect("/api-manager");
  }
  if (intent === "update") {
    const accessHoursEnabled = form.get("access_enabled") === "1";
    const accessHours: AccessHoursConfig | undefined =
      accessHoursEnabled ||
      form.get("access_timezone") ||
      form.get("access_days") ||
      form.get("access_start") ||
      form.get("access_end")
        ? {
            enabled: accessHoursEnabled,
            timezone: String(form.get("access_timezone") ?? "").trim() || undefined,
            allowed_days: parseList(form, "access_days") ?? undefined,
            start_time: String(form.get("access_start") ?? "").trim() || undefined,
            end_time: String(form.get("access_end") ?? "").trim() || undefined,
          }
        : undefined;
    const budget: BudgetConfig | undefined = {
      monthly: parseNum(form, "budget_monthly"),
      daily: parseNum(form, "budget_daily"),
      per_request: parseNum(form, "budget_per_request"),
    };
    const quota: QuotaConfig | undefined = {
      tokens_per_month: parseNum(form, "quota_tokens"),
      requests_per_day: parseNum(form, "quota_req_day"),
      concurrent_requests: parseNum(form, "quota_concurrent"),
      rpm: parseNum(form, "quota_rpm"),
      tpm: parseNum(form, "quota_tpm"),
    };
    updateClientKey(id, {
      name: String(form.get("name") ?? "").trim(),
      description: String(form.get("description") ?? "").trim() || null,
      allowedModels: parseList(form, "allowed_models"),
      blockedModels: parseList(form, "blocked_models"),
      allowedProviders: parseList(form, "allowed_providers"),
      blockedProviders: parseList(form, "blocked_providers"),
      budget,
      quota,
      alertThreshold: parseNum(form, "alert_threshold"),
      autoBlock: form.get("auto_block") === "1",
      ipWhitelist: parseList(form, "ip_whitelist"),
      ipBlacklist: parseList(form, "ip_blacklist"),
      strictIp: form.get("strict_ip") === "1",
      accessHours,
      expiresAt: parseDate(form, "expires_at"),
      rotationIntervalDays: parseNum(form, "rotation_interval_days"),
      gracePeriodDays: parseNum(form, "grace_period_days"),
      webhookUrl: String(form.get("webhook_url") ?? "").trim() || null,
    });
    return { updated: true };
  }
  return null;
}

const STATUS_STYLE: Record<KeyStatus, { label: string; cls: string }> = {
  active: { label: "🟢 Active", cls: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300" },
  near_limit: { label: "🟡 Near Limit", cls: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-300" },
  suspended: { label: "🔒 Locked", cls: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300" },
  expired: { label: "⚠️ Expired", cls: "bg-gray-200 text-gray-600 dark:bg-gray-800 dark:text-gray-300" },
};

function fmtTs(ts: number | null | undefined): string {
  if (!ts) return "—";
  return new Date(ts * 1000).toLocaleString();
}

function toDateInput(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function pct(value: number, total: number): number {
  if (!total) return 0;
  return Math.min(100, Math.round((value / total) * 100));
}

function shortAction(a: AuditEntry): string {
  return a.action === "REQUEST" ? "request" : a.action.toLowerCase();
}

export default function KeyDetail({ loaderData, actionData }: Route.ComponentProps) {
  const { key, month, today, status, audit, byDay, groups, health, budget } = loaderData;
  const [editing, setEditing] = useState(false);
  const rotated = (actionData as { newlyRotated?: { key: string } } | undefined)?.newlyRotated;
  const updated = (actionData as { updated?: boolean } | undefined)?.updated;
  const st = STATUS_STYLE[status];
  const usagePct = budget && budget > 0 ? pct(month.cost, budget) : null;
  const success = audit.filter((a) => a.action === "REQUEST").length;
  const errors = health.checks.errors_last_hour;

  return (
    <div>
      <Link
        to="/api-manager"
        className="mb-4 inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
      >
        <ArrowLeft size={14} /> API Manager
      </Link>

      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold text-gray-900 dark:text-white">
            <KeyRound size={24} /> {key.name}
          </h1>
          <p className="mt-1 font-mono text-sm text-gray-500 dark:text-gray-400">
            {key.key_prefix}…{key.key_hash.slice(0, 6)}
            <span className={`ml-2 rounded-full px-2 py-0.5 text-xs font-sans font-medium ${st.cls}`}>{st.label}</span>
          </p>
          {key.description ? (
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">{key.description}</p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setEditing((v) => !v)}
            className="flex items-center gap-1 rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-800"
          >
            <Pencil size={14} /> {editing ? "Close Edit" : "Edit"}
          </button>
          <a
            href={`/api-manager/${key.id}/export`}
            className="flex items-center gap-1 rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-800"
          >
            <Download size={14} /> Download Logs
          </a>
          <Form
            method="post"
            onSubmit={(e) => {
              if (!window.confirm("Rotasi key ini? Key lama tetap valid selama grace period.")) e.preventDefault();
            }}
          >
            <input type="hidden" name="intent" value="rotate" />
            <button className="flex items-center gap-1 rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-800">
              <RotateCw size={14} /> Rotate
            </button>
          </Form>
          {status === "suspended" ? (
            <Form method="post">
              <input type="hidden" name="intent" value="reactivate" />
              <button className="flex items-center gap-1 rounded-lg bg-green-600 px-3 py-2 text-sm text-white hover:bg-green-700">
                <LockOpen size={14} /> Reactivate
              </button>
            </Form>
          ) : (
            <Form
              method="post"
              onSubmit={(e) => {
                if (!window.confirm("Suspend API key ini? Request dengan key ini akan ditolak.")) e.preventDefault();
              }}
            >
              <input type="hidden" name="intent" value="suspend" />
              <button className="flex items-center gap-1 rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-800">
                <Lock size={14} /> Suspend
              </button>
            </Form>
          )}
          <Form
            method="post"
            onSubmit={(e) => {
              if (!window.confirm("Delete this API key? This action cannot be undone.")) e.preventDefault();
            }}
          >
            <input type="hidden" name="intent" value="delete" />
            <button className="flex items-center gap-1 rounded-lg bg-red-600 px-3 py-2 text-sm text-white hover:bg-red-700">
              <Trash2 size={14} /> Delete
            </button>
          </Form>
        </div>
      </div>

      {updated ? (
        <div className="mb-4 rounded-lg border border-green-300 bg-green-50 p-3 text-sm text-green-800 dark:border-green-700 dark:bg-green-950/40 dark:text-green-200">
          API key diperbarui.
        </div>
      ) : null}

      {editing ? <EditKeyForm data={key} /> : null}

      {rotated ? (
        <div className="mb-4 rounded-lg border border-yellow-300 bg-yellow-50 p-4 text-sm dark:border-yellow-700 dark:bg-yellow-950/40">
          <p className="font-semibold text-yellow-800 dark:text-yellow-200">
            Key baru — salin sekarang (tidak tampil lagi):
          </p>
          <div className="mt-2 flex items-center gap-2">
            <code className="break-all rounded bg-white px-3 py-2 font-mono text-xs text-gray-800 dark:bg-gray-900 dark:text-gray-100">
              {rotated.key}
            </code>
            <button
              type="button"
              onClick={() => navigator.clipboard?.writeText(rotated.key)}
              className="flex items-center gap-1 rounded border border-gray-300 px-2 py-1 text-xs text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300"
            >
              <Copy size={12} /> Copy
            </button>
          </div>
        </div>
      ) : null}

      <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <InfoCard label="Created" value={fmtTs(key.created_at ?? null)} />
        <InfoCard label="Expires" value={fmtTs(key.expires_at)} />
        <InfoCard label="Health" value={health.checks.valid ? "healthy" : health.status} />
        <InfoCard label="Errors (last hour)" value={String(errors)} />
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <section className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900">
          <h2 className="mb-3 text-lg font-semibold text-gray-900 dark:text-white">Usage Overview</h2>
          <div className="space-y-2 text-sm">
            <Row label="Total Requests (month)" value={month.requests.toLocaleString()} />
            <Row label="Tokens (month)" value={(month.promptTokens + month.completionTokens).toLocaleString()} />
            <Row label="Cost (month)" value={`$${month.cost.toFixed(4)}`} />
            <Row label="Requests (today)" value={today.requests.toLocaleString()} />
            <Row label="Success requests (audit)" value={success.toLocaleString()} />
            <Row label="Avg cost/req" value={month.requests > 0 ? `$${(month.cost / month.requests).toFixed(6)}` : "—"} />
          </div>

          {usagePct !== null ? (
            <div className="mt-4">
              <div className="mb-1 flex items-center justify-between text-sm">
                <span className="text-gray-600 dark:text-gray-300">Monthly Budget</span>
                <span className="font-medium text-gray-900 dark:text-white">
                  ${month.cost.toFixed(2)} / ${budget!.toFixed(2)} ({usagePct}%)
                </span>
              </div>
              <div className="h-2.5 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
                <div
                  className={`h-full ${usagePct >= 80 ? "bg-red-500" : usagePct >= 50 ? "bg-yellow-500" : "bg-blue-500"}`}
                  style={{ width: `${usagePct}%` }}
                />
              </div>
            </div>
          ) : null}
        </section>

        <section className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900">
          <h2 className="mb-3 text-lg font-semibold text-gray-900 dark:text-white">Permissions &amp; Security</h2>
          <div className="space-y-2 text-sm">
            <Row label="Allowed models" value={key.allowed_models?.join(", ") || "all"} />
            <Row label="Blocked models" value={key.blocked_models?.join(", ") || "none"} />
            <Row label="Allowed providers" value={key.allowed_providers?.join(", ") || "all"} />
            <Row label="Blocked providers" value={key.blocked_providers?.join(", ") || "none"} />
            <Row label="IP whitelist" value={key.ip_whitelist?.join(", ") || "none"} />
            <Row label="IP blacklist" value={key.ip_blacklist?.join(", ") || "none"} />
            <Row label="Strict IP" value={key.strict_ip === 1 ? "on" : "off"} />
            <Row label="Access hours" value={key.access_hours?.enabled ? `${key.access_hours.start_time ?? "–"}–${key.access_hours.end_time ?? "–"} (${key.access_hours.timezone ?? "UTC"})` : "off"} />
            <Row label="Rotation" value={key.rotation_interval_days ? `every ${key.rotation_interval_days}d` : "off"} />
            <Row label="Grace" value={key.grace_period_days != null ? `${key.grace_period_days}d` : "—"} />
            <Row label="Webhook" value={key.webhook_url ?? "none"} />
            <Row label="Groups" value={groups.map((g) => g.name).join(", ") || "none"} />
          </div>
        </section>
      </div>

      <section className="mt-6 rounded-xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900">
        <h2 className="mb-3 text-lg font-semibold text-gray-900 dark:text-white">
          Recent Activity (audit trail)
        </h2>
        <div className="table-wrap">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left text-xs uppercase text-gray-400 dark:border-gray-700">
                <th className="py-2 pr-4">Time</th>
                <th className="py-2 pr-4">Action</th>
                <th className="py-2 pr-4">Model</th>
                <th className="py-2 pr-4">Provider</th>
                <th className="py-2 pr-4">Status</th>
                <th className="py-2 pr-4">Tokens</th>
                <th className="py-2">Cost</th>
              </tr>
            </thead>
            <tbody>
              {audit.map((a) => (
                <tr key={a.id} className="border-b border-gray-100 dark:border-gray-800">
                  <td className="py-2 pr-4 text-xs text-gray-500 dark:text-gray-400">{fmtTs(a.created_at)}</td>
                  <td className="py-2 pr-4">{shortAction(a)}</td>
                  <td className="py-2 pr-4">{a.model ?? "—"}</td>
                  <td className="py-2 pr-4">{a.provider_id ?? "—"}</td>
                  <td className="py-2 pr-4">{a.status ?? "—"}</td>
                  <td className="py-2 pr-4">{a.tokens ?? "—"}</td>
                  <td className="py-2">{a.cost != null ? `$${a.cost.toFixed(6)}` : "—"}</td>
                </tr>
              ))}
              {audit.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-6 text-center text-gray-400 dark:text-gray-500">
                    Belum ada aktivitas.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        {byDay.length > 0 ? (
          <DailyBar data={byDay} />
        ) : null}
      </section>
    </div>
  );
}

function InfoCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-800 dark:bg-gray-900">
      <p className="text-xs uppercase text-gray-400 dark:text-gray-500">{label}</p>
      <p className="mt-1 text-sm font-medium text-gray-900 dark:text-white">{value}</p>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-gray-500 dark:text-gray-400">{label}</span>
      <span className="text-right font-medium text-gray-900 dark:text-white">{value}</span>
    </div>
  );
}

function DailyBar({ data }: { data: Array<{ date: string; requests: number; cost: number }> }) {
  return (
    <div className="mt-4">
      <h3 className="mb-2 text-sm font-semibold text-gray-700 dark:text-gray-200">
        Requests — 30 hari terakhir
      </h3>
      <svg viewBox="0 0 560 120" className="w-full" role="img">
        {data.map((d, i) => {
          const max = Math.max(1, ...data.map((x) => x.requests));
          const h = (d.requests / max) * 96;
          return (
            <g key={d.date}>
              <rect x={i * 18} y={108 - h} width={12} height={h} rx={2} fill="#3b82f6">
                <title>{`${d.date}: ${d.requests} req $${d.cost.toFixed(4)}`}</title>
              </rect>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

const editInput =
  "w-full rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-800 dark:text-white";
const editLabel = "mb-1 block text-xs font-medium text-gray-600 dark:text-gray-300";

/** Form kelola (edit) API key — prefill dari data existing. */
function EditKeyForm({ data }: { data: ClientKey }) {
  return (
    <Form
      method="post"
      className="mb-6 grid grid-cols-1 gap-3 rounded-xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-900 sm:grid-cols-2"
    >
      <input type="hidden" name="intent" value="update" />
      <div>
        <label className={editLabel}>Name</label>
        <input name="name" className={editInput} defaultValue={data.name} />
      </div>
      <div>
        <label className={editLabel}>Description</label>
        <input name="description" className={editInput} defaultValue={data.description ?? ""} />
      </div>
      <div>
        <label className={editLabel}>Allowed Models (empty = all)</label>
        <textarea name="allowed_models" className={editInput} rows={2} defaultValue={data.allowed_models?.join(", ") ?? ""} />
      </div>
      <div>
        <label className={editLabel}>Blocked Models</label>
        <textarea name="blocked_models" className={editInput} rows={2} defaultValue={data.blocked_models?.join(", ") ?? ""} />
      </div>
      <div>
        <label className={editLabel}>Allowed Providers</label>
        <input name="allowed_providers" className={editInput} defaultValue={data.allowed_providers?.join(", ") ?? ""} />
      </div>
      <div>
        <label className={editLabel}>Blocked Providers</label>
        <input name="blocked_providers" className={editInput} defaultValue={data.blocked_providers?.join(", ") ?? ""} />
      </div>
      <div>
        <label className={editLabel}>Monthly Budget (USD)</label>
        <input name="budget_monthly" type="number" step="any" className={editInput} defaultValue={data.budget?.monthly ?? ""} />
      </div>
      <div>
        <label className={editLabel}>Daily Budget (USD)</label>
        <input name="budget_daily" type="number" step="any" className={editInput} defaultValue={data.budget?.daily ?? ""} />
      </div>
      <div>
        <label className={editLabel}>Per-request (USD)</label>
        <input name="budget_per_request" type="number" step="any" className={editInput} defaultValue={data.budget?.per_request ?? ""} />
      </div>
      <div>
        <label className={editLabel}>Tokens/Month</label>
        <input name="quota_tokens" type="number" className={editInput} defaultValue={data.quota?.tokens_per_month ?? ""} />
      </div>
      <div>
        <label className={editLabel}>Requests/Day</label>
        <input name="quota_req_day" type="number" className={editInput} defaultValue={data.quota?.requests_per_day ?? ""} />
      </div>
      <div>
        <label className={editLabel}>Concurrent</label>
        <input name="quota_concurrent" type="number" className={editInput} defaultValue={data.quota?.concurrent_requests ?? ""} />
      </div>
      <div>
        <label className={editLabel}>Requests/Min</label>
        <input name="quota_rpm" type="number" className={editInput} defaultValue={data.quota?.rpm ?? ""} />
      </div>
      <div>
        <label className={editLabel}>Tokens/Min</label>
        <input name="quota_tpm" type="number" className={editInput} defaultValue={data.quota?.tpm ?? ""} />
      </div>
      <div>
        <label className={editLabel}>Alert at (0..1)</label>
        <input name="alert_threshold" type="number" step="any" min="0" max="1" className={editInput} defaultValue={data.alert_threshold ?? ""} />
      </div>
      <div>
        <label className={editLabel}>Expires</label>
        <input name="expires_at" type="date" className={editInput} defaultValue={data.expires_at ? toDateInput(new Date(data.expires_at * 1000)) : ""} />
      </div>
      <div>
        <label className={editLabel}>Rotation interval (days)</label>
        <input name="rotation_interval_days" type="number" className={editInput} defaultValue={data.rotation_interval_days ?? ""} />
      </div>
      <div>
        <label className={editLabel}>Grace period (days)</label>
        <input name="grace_period_days" type="number" className={editInput} defaultValue={data.grace_period_days ?? ""} />
      </div>
      <div>
        <label className={editLabel}>Webhook URL</label>
        <input name="webhook_url" type="url" className={editInput} defaultValue={data.webhook_url ?? ""} />
      </div>
      <div>
        <label className={editLabel}>IP Whitelist</label>
        <input name="ip_whitelist" className={editInput} defaultValue={data.ip_whitelist?.join(", ") ?? ""} />
      </div>
      <div>
        <label className={editLabel}>IP Blacklist</label>
        <input name="ip_blacklist" className={editInput} defaultValue={data.ip_blacklist?.join(", ") ?? ""} />
      </div>
      <div className="sm:col-span-1">
        <label className={editLabel}>Access hours (HH:mm / timezone / days)</label>
        <div className="grid grid-cols-2 gap-2">
          <input name="access_start" type="time" className={editInput} defaultValue={data.access_hours?.start_time ?? ""} />
          <input name="access_end" type="time" className={editInput} defaultValue={data.access_hours?.end_time ?? ""} />
          <input name="access_timezone" className={editInput} placeholder="Timezone" defaultValue={data.access_hours?.timezone ?? ""} />
          <input name="access_days" className={editInput} placeholder="monday, tuesday, …" defaultValue={data.access_hours?.allowed_days?.join(", ") ?? ""} />
        </div>
      </div>
      <div className="flex flex-col gap-2 justify-start sm:col-span-2 sm:flex-row">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="auto_block" value="1" defaultChecked={data.auto_block === 1} /> Auto-block when budget exceeded
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="strict_ip" value="1" defaultChecked={data.strict_ip === 1} /> Strict IP
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="access_enabled" value="1" defaultChecked={data.access_hours?.enabled === true} /> Enable access hours
        </label>
      </div>
      <div className="sm:col-span-2 flex justify-end gap-2">
        <button
          type="submit"
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          Save Changes
        </button>
      </div>
    </Form>
  );
}