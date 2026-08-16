import { Form, Link, redirect } from "react-router";
import { useState } from "react";
import type { Route } from "./+types/api-manager.$id";
import {
  ArrowLeft,
  Activity,
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
import { PageHeader } from "../components/ui/page-header";
import { Card, CardHeader, CardTitle } from "../components/ui/card";
import { Badge, type BadgeTone } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input, Label, Textarea, Checkbox } from "../components/ui/field";
import { CopyButton } from "../components/ui/copy-button";
import { EmptyState } from "../components/ui/empty-state";
import { Table, THead, THeadCell, TRow, TCell } from "../components/ui/table";
import { UsageBar } from "../components/ui/usage-bar";
import { useConfirm } from "../components/ui/confirm-dialog";

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

const STATUS_TONE: Record<KeyStatus, BadgeTone> = {
  active: "success",
  near_limit: "warning",
  suspended: "danger",
  expired: "neutral",
};

const STATUS_LABEL: Record<KeyStatus, string> = {
  active: "Active",
  near_limit: "Near Limit",
  suspended: "Locked",
  expired: "Expired",
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

function usageTone(p: number): "success" | "warning" | "danger" {
  return p >= 80 ? "danger" : p >= 50 ? "warning" : "success";
}

function shortAction(a: AuditEntry): string {
  return a.action === "REQUEST" ? "request" : a.action.toLowerCase();
}

export default function KeyDetail({ loaderData, actionData }: Route.ComponentProps) {
  const { key, month, today, status, audit, byDay, groups, health, budget } = loaderData;
  const [editing, setEditing] = useState(false);
  const rotated = (actionData as { newlyRotated?: { key: string } } | undefined)?.newlyRotated;
  const updated = (actionData as { updated?: boolean } | undefined)?.updated;
  const usagePct = budget && budget > 0 ? pct(month.cost, budget) : null;
  const success = audit.filter((a) => a.action === "REQUEST").length;
  const errors = health.checks.errors_last_hour;
  const { dialog, confirm } = useConfirm();

  const maskedKey = `${key.key_prefix}…${key.key_hash.slice(0, 6)}`;
  const subtitle = key.description ? `${maskedKey} — ${key.description}` : maskedKey;

  const handleRotate = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const ok = await confirm({
      title: "Rotate key?",
      description: "The old key stays valid for the grace period.",
      confirmLabel: "Rotate",
    });
    if (ok) form.submit();
  };

  const handleSuspend = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const ok = await confirm({
      title: "Suspend API key?",
      description: "Requests with this key will be rejected.",
      confirmLabel: "Suspend",
    });
    if (ok) form.submit();
  };

  const handleDelete = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const ok = await confirm({
      title: "Delete API key?",
      description: "This action cannot be undone.",
      confirmLabel: "Delete",
      variant: "danger",
    });
    if (ok) form.submit();
  };

  return (
    <div>
      <Link
        to="/api-manager"
        prefetch="render"
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft size={14} /> API Manager
      </Link>

      <PageHeader
        title={key.name}
        icon={<KeyRound size={20} />}
        subtitle={subtitle}
        actions={<Badge tone={STATUS_TONE[status]}>{STATUS_LABEL[status]}</Badge>}
      />

      <div className="mb-6 flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" onClick={() => setEditing((v) => !v)}>
          <Pencil size={14} /> {editing ? "Close Edit" : "Edit"}
        </Button>
        <a
          href={`/api-manager/${key.id}/export`}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm font-medium text-foreground hover:bg-muted"
        >
          <Download size={14} /> Download Logs
        </a>
        <Form method="post" onSubmit={handleRotate}>
          <input type="hidden" name="intent" value="rotate" />
          <Button type="submit" variant="outline">
            <RotateCw size={14} /> Rotate
          </Button>
        </Form>
        {status === "suspended" ? (
          <Form method="post">
            <input type="hidden" name="intent" value="reactivate" />
            <Button type="submit">
              <LockOpen size={14} /> Reactivate
            </Button>
          </Form>
        ) : (
          <Form method="post" onSubmit={handleSuspend}>
            <input type="hidden" name="intent" value="suspend" />
            <Button type="submit" variant="outline">
              <Lock size={14} /> Suspend
            </Button>
          </Form>
        )}
        <Form method="post" onSubmit={handleDelete}>
          <input type="hidden" name="intent" value="delete" />
          <Button type="submit" variant="danger">
            <Trash2 size={14} /> Delete
          </Button>
        </Form>
      </div>

      {updated ? (
        <div className="mb-4 rounded-lg border border-success/30 bg-success/10 p-3 text-sm text-foreground">
          API key updated.
        </div>
      ) : null}

      {editing ? <EditKeyForm data={key} /> : null}

      {rotated ? (
        <div className="mb-4 rounded-lg border border-warning/30 bg-warning/10 p-4 text-sm">
          <p className="font-semibold text-foreground">
            New key — copy it now (it won't be shown again):
          </p>
          <div className="mt-2 flex items-center gap-2">
            <code className="break-all rounded bg-surface-2 px-3 py-2 font-mono text-xs text-foreground">
              {rotated.key}
            </code>
            <CopyButton text={rotated.key} label="Copy" />
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
        <Card>
          <CardHeader>
            <CardTitle>Usage Overview</CardTitle>
          </CardHeader>
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
                <span className="text-muted-foreground">Monthly Budget</span>
                <span className="font-medium text-foreground">
                  ${month.cost.toFixed(2)} / ${budget!.toFixed(2)} ({usagePct}%)
                </span>
              </div>
              <UsageBar value={usagePct} max={100} tone={usageTone(usagePct)} />
            </div>
          ) : null}
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Permissions &amp; Security</CardTitle>
          </CardHeader>
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
        </Card>
      </div>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Recent Activity (audit trail)</CardTitle>
        </CardHeader>
        {audit.length === 0 ? (
          <EmptyState
            icon={<Activity size={20} />}
            title="No activity yet"
            description="No audit events recorded for this key."
          />
        ) : (
          <Table>
            <THead>
              <tr>
                <THeadCell>Time</THeadCell>
                <THeadCell>Action</THeadCell>
                <THeadCell>Model</THeadCell>
                <THeadCell>Provider</THeadCell>
                <THeadCell>Status</THeadCell>
                <THeadCell>Tokens</THeadCell>
                <THeadCell className="pr-0">Cost</THeadCell>
              </tr>
            </THead>
            <tbody>
              {audit.map((a) => (
                <TRow key={a.id}>
                  <TCell className="text-xs text-muted-foreground">{fmtTs(a.created_at)}</TCell>
                  <TCell className="text-foreground">{shortAction(a)}</TCell>
                  <TCell className="text-foreground">{a.model ?? "—"}</TCell>
                  <TCell className="text-foreground">{a.provider_id ?? "—"}</TCell>
                  <TCell className="text-foreground">{a.status ?? "—"}</TCell>
                  <TCell className="text-foreground">{a.tokens ?? "—"}</TCell>
                  <TCell className="pr-0 text-foreground">{a.cost != null ? `$${a.cost.toFixed(6)}` : "—"}</TCell>
                </TRow>
              ))}
            </tbody>
          </Table>
        )}
        {byDay.length > 0 ? (
          <DailyBar data={byDay} />
        ) : null}
      </Card>
      {dialog}
    </div>
  );
}

function InfoCard({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <p className="text-xs uppercase text-muted-foreground">{label}</p>
      <p className="mt-1 text-sm font-medium text-foreground">{value}</p>
    </Card>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-right font-medium text-foreground">{value}</span>
    </div>
  );
}

function DailyBar({ data }: { data: Array<{ date: string; requests: number; cost: number }> }) {
  return (
    <div className="mt-4">
      <h3 className="mb-2 text-sm font-semibold text-muted-foreground">
        Requests — last 30 days
      </h3>
      <svg
        viewBox="0 0 560 120"
        className="w-full"
        role="img"
        aria-label="Daily request volume for the last 30 days"
      >
        {data.map((d, i) => {
          const max = Math.max(1, ...data.map((x) => x.requests));
          const h = (d.requests / max) * 96;
          return (
            <g key={d.date}>
              <rect x={i * 18} y={108 - h} width={12} height={h} rx={2} className="fill-primary">
                <title>{`${d.date}: ${d.requests} req $${d.cost.toFixed(4)}`}</title>
              </rect>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function EditKeyForm({ data }: { data: ClientKey }) {
  return (
    <Form
      method="post"
      className="mb-6 grid grid-cols-1 gap-3 rounded-xl border border-border bg-surface p-5 shadow-sm sm:grid-cols-2"
    >
      <input type="hidden" name="intent" value="update" />
      <div>
        <Label htmlFor="edit-name">Name</Label>
        <Input id="edit-name" name="name" defaultValue={data.name} autoComplete="off" />
      </div>
      <div>
        <Label htmlFor="edit-description">Description</Label>
        <Input id="edit-description" name="description" defaultValue={data.description ?? ""} autoComplete="off" />
      </div>
      <div>
        <Label htmlFor="edit-allowed-models">Allowed Models (empty = all)</Label>
        <Textarea id="edit-allowed-models" name="allowed_models" rows={2} defaultValue={data.allowed_models?.join(", ") ?? ""} />
      </div>
      <div>
        <Label htmlFor="edit-blocked-models">Blocked Models</Label>
        <Textarea id="edit-blocked-models" name="blocked_models" rows={2} defaultValue={data.blocked_models?.join(", ") ?? ""} />
      </div>
      <div>
        <Label htmlFor="edit-allowed-providers">Allowed Providers</Label>
        <Input id="edit-allowed-providers" name="allowed_providers" defaultValue={data.allowed_providers?.join(", ") ?? ""} autoComplete="off" />
      </div>
      <div>
        <Label htmlFor="edit-blocked-providers">Blocked Providers</Label>
        <Input id="edit-blocked-providers" name="blocked_providers" defaultValue={data.blocked_providers?.join(", ") ?? ""} autoComplete="off" />
      </div>
      <div>
        <Label htmlFor="edit-budget-monthly">Monthly Budget (USD)</Label>
        <Input id="edit-budget-monthly" name="budget_monthly" type="number" step="any" defaultValue={data.budget?.monthly ?? ""} autoComplete="off" />
      </div>
      <div>
        <Label htmlFor="edit-budget-daily">Daily Budget (USD)</Label>
        <Input id="edit-budget-daily" name="budget_daily" type="number" step="any" defaultValue={data.budget?.daily ?? ""} autoComplete="off" />
      </div>
      <div>
        <Label htmlFor="edit-budget-per-request">Per-request (USD)</Label>
        <Input id="edit-budget-per-request" name="budget_per_request" type="number" step="any" defaultValue={data.budget?.per_request ?? ""} autoComplete="off" />
      </div>
      <div>
        <Label htmlFor="edit-quota-tokens">Tokens/Month</Label>
        <Input id="edit-quota-tokens" name="quota_tokens" type="number" defaultValue={data.quota?.tokens_per_month ?? ""} autoComplete="off" />
      </div>
      <div>
        <Label htmlFor="edit-quota-req-day">Requests/Day</Label>
        <Input id="edit-quota-req-day" name="quota_req_day" type="number" defaultValue={data.quota?.requests_per_day ?? ""} autoComplete="off" />
      </div>
      <div>
        <Label htmlFor="edit-quota-concurrent">Concurrent</Label>
        <Input id="edit-quota-concurrent" name="quota_concurrent" type="number" defaultValue={data.quota?.concurrent_requests ?? ""} autoComplete="off" />
      </div>
      <div>
        <Label htmlFor="edit-quota-rpm">Requests/Min</Label>
        <Input id="edit-quota-rpm" name="quota_rpm" type="number" defaultValue={data.quota?.rpm ?? ""} autoComplete="off" />
      </div>
      <div>
        <Label htmlFor="edit-quota-tpm">Tokens/Min</Label>
        <Input id="edit-quota-tpm" name="quota_tpm" type="number" defaultValue={data.quota?.tpm ?? ""} autoComplete="off" />
      </div>
      <div>
        <Label htmlFor="edit-alert-threshold">Alert at (0..1)</Label>
        <Input id="edit-alert-threshold" name="alert_threshold" type="number" step="any" min="0" max="1" defaultValue={data.alert_threshold ?? ""} autoComplete="off" />
      </div>
      <div>
        <Label htmlFor="edit-expires-at">Expires</Label>
        <Input id="edit-expires-at" name="expires_at" type="date" defaultValue={data.expires_at ? toDateInput(new Date(data.expires_at * 1000)) : ""} />
      </div>
      <div>
        <Label htmlFor="edit-rotation-interval">Rotation interval (days)</Label>
        <Input id="edit-rotation-interval" name="rotation_interval_days" type="number" defaultValue={data.rotation_interval_days ?? ""} autoComplete="off" />
      </div>
      <div>
        <Label htmlFor="edit-grace-period">Grace period (days)</Label>
        <Input id="edit-grace-period" name="grace_period_days" type="number" defaultValue={data.grace_period_days ?? ""} autoComplete="off" />
      </div>
      <div>
        <Label htmlFor="edit-webhook-url">Webhook URL</Label>
        <Input id="edit-webhook-url" name="webhook_url" type="url" defaultValue={data.webhook_url ?? ""} autoComplete="off" />
      </div>
      <div>
        <Label htmlFor="edit-ip-whitelist">IP Whitelist</Label>
        <Input id="edit-ip-whitelist" name="ip_whitelist" defaultValue={data.ip_whitelist?.join(", ") ?? ""} autoComplete="off" />
      </div>
      <div>
        <Label htmlFor="edit-ip-blacklist">IP Blacklist</Label>
        <Input id="edit-ip-blacklist" name="ip_blacklist" defaultValue={data.ip_blacklist?.join(", ") ?? ""} autoComplete="off" />
      </div>
      <div className="sm:col-span-1">
        <Label>Access hours (HH:mm / timezone / days)</Label>
        <div className="grid grid-cols-2 gap-2">
          <Input id="edit-access-start" name="access_start" type="time" defaultValue={data.access_hours?.start_time ?? ""} />
          <Input id="edit-access-end" name="access_end" type="time" defaultValue={data.access_hours?.end_time ?? ""} />
          <Input id="edit-access-timezone" name="access_timezone" placeholder="Timezone" defaultValue={data.access_hours?.timezone ?? ""} autoComplete="off" />
          <Input id="edit-access-days" name="access_days" placeholder="monday, tuesday, …" defaultValue={data.access_hours?.allowed_days?.join(", ") ?? ""} autoComplete="off" />
        </div>
      </div>
      <div className="flex flex-col gap-2 justify-start sm:col-span-2 sm:flex-row">
        <label className="flex items-center gap-2 text-sm">
          <Checkbox name="auto_block" value="1" defaultChecked={data.auto_block === 1} /> Auto-block when budget exceeded
        </label>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox name="strict_ip" value="1" defaultChecked={data.strict_ip === 1} /> Strict IP
        </label>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox name="access_enabled" value="1" defaultChecked={data.access_hours?.enabled === true} /> Enable access hours
        </label>
      </div>
      <div className="sm:col-span-2 flex justify-end gap-2">
        <Button type="submit">Save Changes</Button>
      </div>
    </Form>
  );
}