import { Form, Link } from "react-router";
import type { Route } from "./+types/api-manager.$id";
import { KeyRound, Copy, RotateCw, Trash2, Lock, LockOpen, ArrowLeft } from "lucide-react";
import { getClientKeyById } from "../.server/client-key";
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
    return { deleted: true };
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

function pct(value: number, total: number): number {
  if (!total) return 0;
  return Math.min(100, Math.round((value / total) * 100));
}

function shortAction(a: AuditEntry): string {
  return a.action === "REQUEST" ? "request" : a.action.toLowerCase();
}

export default function KeyDetail({ loaderData, actionData }: Route.ComponentProps) {
  const { key, month, today, status, audit, byDay, groups, health, budget } = loaderData;
  const rotated = (actionData as { newlyRotated?: { key: string } } | undefined)?.newlyRotated;
  const deleted = (actionData as { deleted?: boolean } | undefined)?.deleted;
  const st = STATUS_STYLE[status];
  const usagePct = budget && budget > 0 ? pct(month.cost, budget) : null;
  const success = audit.filter((a) => a.action === "REQUEST").length;
  const errors = health.checks.errors_last_hour;

  if (deleted) {
    return (
      <div className="rounded-xl border border-gray-200 bg-white p-8 text-center shadow-sm dark:border-gray-800 dark:bg-gray-900">
        <p className="text-gray-700 dark:text-gray-200">API key dihapus.</p>
        <Link to="/api-manager" className="mt-4 inline-block text-blue-600 hover:underline dark:text-blue-400">
          ← Kembali ke API Manager
        </Link>
      </div>
    );
  }

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
        <div className="flex items-center gap-2">
          <Form method="post">
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
            <Form method="post">
              <input type="hidden" name="intent" value="suspend" />
              <button className="flex items-center gap-1 rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-800">
                <Lock size={14} /> Suspend
              </button>
            </Form>
          )}
          <Form method="post">
            <input type="hidden" name="intent" value="delete" />
            <button className="flex items-center gap-1 rounded-lg bg-red-600 px-3 py-2 text-sm text-white hover:bg-red-700">
              <Trash2 size={14} /> Delete
            </button>
          </Form>
        </div>
      </div>

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
  const max = Math.max(1, ...data.map((d) => d.requests));
  const width = 560;
  const height = 120;
  const gap = 8;
  const barWidth = (width - gap * (data.length - 1)) / Math.max(1, data.length);
  return (
    <div className="mt-4">
      <h3 className="mb-2 text-sm font-semibold text-gray-700 dark:text-gray-200">
        Requests — 30 hari terakhir
      </h3>
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full" role="img">
        {data.map((d, i) => {
          const x = i * (barWidth + gap);
          const h = (d.requests / max) * (height - 24);
          return (
            <g key={d.date}>
              <rect x={x} y={height - 12 - h} width={barWidth} height={h} rx={2} fill="#3b82f6">
                <title>{`${d.date}: ${d.requests} req$${d.cost.toFixed(4)}`}</title>
              </rect>
            </g>
          );
        })}
      </svg>
    </div>
  );
}