import { useEffect, useRef, useState } from "react";
import { Link, useFetcher } from "react-router";
import {
  Activity,
  ArrowRight,
  Bot,
  CheckCircle2,
  Clock,
  Globe,
  Home as HomeIcon,
  KeySquare,
  Link2,
  Plug,
  Plus,
  ScrollText,
  Square,
  TrendingUp,
} from "lucide-react";
import type { Route } from "./+types/home";
import { requireSession } from "../.server/auth";
import {
  getStats,
  getUsageLast7Days,
  getUsageWeekSummary,
} from "../.server/stats";
import { query } from "../.server/db";
import {
  getTunnelStatus,
  resolveGatewayOrigin,
  stopTunnel,
} from "../.server/tunnel";
import type { TunnelRuntimeStatus } from "../lib/tunnel-options";
import { StatCard } from "../components/ui/stat-card";
import { PageHeader } from "../components/ui/page-header";
import { Card, CardHeader, CardTitle } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button, buttonClass } from "../components/ui/button";
import { CopyButton } from "../components/ui/copy-button";
import { Spinner } from "../components/ui/feedback";
import { useToast } from "../components/ui/toast";
import { UsageChart } from "../components/usage-chart";
import { fmtTs } from "../lib/log-format";

export function meta() {
  return [{ title: "Dashboard | UniRoute" }];
}

type RecentReq = {
  id: number;
  model: string | null;
  provider_id: string | null;
  status: string;
  duration_ms: number | null;
  created_at: number;
};

type ProviderSummary = {
  id: string;
  name: string;
  is_active: number;
  keys: number;
  models: number;
};

export function loader({ request }: Route.LoaderArgs) {
  const origin = resolveGatewayOrigin(request);
  const tunnelStatus = getTunnelStatus();
  const active =
    tunnelStatus.status === "running" ||
    tunnelStatus.status === "starting" ||
    tunnelStatus.status === "reconnecting";
  const recent = query(
    `SELECT id, model, provider_id, status, duration_ms, created_at
       FROM request_logs
      ORDER BY created_at DESC
      LIMIT 6`,
  ).all() as unknown as RecentReq[];

  const providers = query(
    `SELECT p.id, p.name, p.is_active,
            (SELECT COUNT(*) FROM provider_credentials c WHERE c.provider_id = p.id AND c.is_active = 1) AS keys,
            (SELECT COUNT(*) FROM models m WHERE m.provider_id = p.id AND m.is_active = 1) AS models
       FROM providers p
      ORDER BY p.is_active DESC, p.name
      LIMIT 6`,
  ).all() as unknown as ProviderSummary[];

  const keyCountRow = query(
    "SELECT COUNT(*) AS c FROM client_api_keys WHERE is_active = 1",
  ).get() as { c?: number } | undefined;

  return {
    stats: getStats(),
    usage: getUsageLast7Days(),
    week: getUsageWeekSummary(),
    recent,
    providers,
    activeKeys: Number(keyCountRow?.c ?? 0),
    gatewayUrl: `${origin}/v1`,
    tunnel: {
      active,
      status: tunnelStatus.status,
      provider: tunnelStatus.provider,
      publicUrl: tunnelStatus.publicUrl,
    },
  };
}

export async function action({ request }: Route.ActionArgs) {
  const denied = requireSession(request);
  if (denied) return denied;

  const form = await request.formData();
  if (String(form.get("intent") ?? "") === "stop_tunnel") {
    stopTunnel();
    return { ok: true, stopped: true };
  }
  return Response.json({ ok: false, error: "Unknown intent." }, { status: 400 });
}

export default function Home({ loaderData }: Route.ComponentProps) {
  const { stats, usage, week, recent, providers, activeKeys, gatewayUrl, tunnel } =
    loaderData;
  const tunnelFetcher = useFetcher<{ ok: boolean; stopped?: boolean }>();
  const { toast } = useToast();
  const lastStopRef = useRef<unknown>(undefined);

  const [liveTunnel, setLiveTunnel] = useState(tunnel);
  const [liveGatewayUrl, setLiveGatewayUrl] = useState(gatewayUrl);

  useEffect(() => {
    setLiveTunnel(tunnel);
  }, [tunnel]);

  useEffect(() => {
    setLiveGatewayUrl(gatewayUrl);
  }, [gatewayUrl]);

  useEffect(() => {
    if (
      tunnelFetcher.state !== "idle" ||
      !tunnelFetcher.data ||
      lastStopRef.current === tunnelFetcher.data
    ) {
      return;
    }
    lastStopRef.current = tunnelFetcher.data;
    if (tunnelFetcher.data.stopped) {
      toast({ title: "Tunnel stopped", variant: "success" });
    }
  }, [tunnelFetcher.state, tunnelFetcher.data, toast]);

  useEffect(() => {
    if (!liveTunnel.active || liveTunnel.publicUrl) return;
    const iv = setInterval(async () => {
      try {
        const res = await fetch("/api/tunnel/status");
        if (!res.ok) return;
        const next = (await res.json()) as TunnelRuntimeStatus;
        const nextActive =
          next.status === "running" ||
          next.status === "starting" ||
          next.status === "reconnecting";
        setLiveTunnel({
          active: nextActive,
          status: next.status,
          provider: next.provider,
          publicUrl: next.publicUrl,
        });
        if (next.publicUrl) {
          setLiveGatewayUrl(`${next.publicUrl.replace(/\/+$/, "")}/v1`);
        }
      } catch {
        // Ignore transient status poll error.
      }
    }, 2500);
    return () => clearInterval(iv);
  }, [liveTunnel.active, liveTunnel.publicUrl]);

  const stoppingTunnel = tunnelFetcher.state !== "idle";
  const latency =
    stats.avgLatency >= 1000
      ? { value: (stats.avgLatency / 1000).toFixed(1), suffix: "s" }
      : { value: String(stats.avgLatency), suffix: "ms" };

  return (
    <div>
      <PageHeader
        title="Dashboard"
        icon={<HomeIcon size={20} />}
        subtitle="Real-time overview of your AI gateway traffic, providers, and keys."
        actions={
          <>
            <div className="flex items-center gap-1.5 rounded-lg border border-border bg-surface px-2.5 py-1 text-xs">
              {liveTunnel.active ? (
                <Link
                  to="/tunnels"
                  title={`Active ${liveTunnel.provider} tunnel (${liveTunnel.status})`}
                  className="inline-flex items-center gap-1.5 text-success hover:underline"
                >
                  <span className="h-2 w-2 rounded-full bg-success" aria-hidden="true" />
                  Tunnel
                </Link>
              ) : (
                <span className="text-muted-foreground">Endpoint</span>
              )}
              <code className="max-w-[190px] truncate font-mono text-foreground sm:max-w-none">
                {liveGatewayUrl}
              </code>
              <CopyButton text={liveGatewayUrl} label="Copy gateway endpoint" />
            </div>
            {liveTunnel.active ? (
              <tunnelFetcher.Form method="post">
                <input type="hidden" name="intent" value="stop_tunnel" />
                <Button
                  type="submit"
                  size="sm"
                  variant="danger"
                  disabled={stoppingTunnel}
                >
                  {stoppingTunnel ? (
                    <Spinner size={13} />
                  ) : (
                    <Square size={13} aria-hidden="true" />
                  )}
                  Stop Tunnel
                </Button>
              </tunnelFetcher.Form>
            ) : null}
            <Link to="/api-manager/create" className={buttonClass("primary", "sm")}>
              <Plus size={14} />
              New API Key
            </Link>
          </>
        }
      />

      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          title="Total Requests"
          value={stats.total.toLocaleString()}
          icon={<Activity size={16} />}
          subline={`${stats.today.toLocaleString()} today`}
        />
        <StatCard
          title="Success Rate"
          value={stats.total > 0 ? stats.successRate : "-"}
          suffix={stats.total > 0 ? "%" : undefined}
          accent="bg-success"
          icon={<CheckCircle2 size={16} />}
          subline={`${stats.success.toLocaleString()} / ${stats.total.toLocaleString()} OK`}
        />
        <StatCard
          title="Avg Latency"
          value={stats.total > 0 ? latency.value : "-"}
          suffix={stats.total > 0 ? latency.suffix : undefined}
          accent="bg-warning"
          icon={<Clock size={16} />}
          subline={stats.total > 0 ? "Across all logged requests" : "No requests yet"}
        />
        <StatCard
          title="Active Providers"
          value={stats.activeProviders}
          accent="bg-info"
          icon={<Plug size={16} />}
          subline={`of ${stats.totalProviders} configured · ${activeKeys} client key${activeKeys === 1 ? "" : "s"}`}
        />
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <UsageChart
            data={usage}
            summary={week}
            action={
              <Link
                to="/analytics/usage"
                prefetch="intent"
                className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
              >
                Full analytics
                <ArrowRight size={13} />
              </Link>
            }
          />

          <Card>
            <CardHeader>
              <CardTitle>Recent Requests</CardTitle>
              <Link
                to="/logs"
                prefetch="intent"
                className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
              >
                Open live logs
                <ArrowRight size={13} />
              </Link>
            </CardHeader>
            {recent.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                No requests logged yet. Send a request to{" "}
                <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-xs">
                  {liveGatewayUrl}/chat/completions
                </code>{" "}
                to see traffic here.
              </p>
            ) : (
              <div className="divide-y divide-border/70">
                {recent.map((r) => {
                  const ok = r.status === "success";
                  return (
                    <div
                      key={r.id}
                      className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-xs first:pt-0 last:pb-0"
                    >
                      <div className="flex min-w-0 items-center gap-2.5">
                        <Badge tone={ok ? "success" : "danger"} dot>
                          {ok ? "OK" : r.status}
                        </Badge>
                        <span className="truncate font-mono font-medium text-foreground">
                          {r.model || "unknown"}
                        </span>
                        {r.provider_id ? (
                          <span className="hidden rounded bg-surface-2 px-1.5 py-0.5 text-[11px] text-muted-foreground sm:inline">
                            {r.provider_id}
                          </span>
                        ) : null}
                      </div>
                      <div className="flex shrink-0 items-center gap-3 tabular-nums text-muted-foreground">
                        <span>{r.duration_ms != null ? `${r.duration_ms}ms` : "-"}</span>
                        <span className="hidden sm:inline">{fmtTs(r.created_at)}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>
        </div>

        <div className="space-y-5">
          <Card>
            <CardHeader>
              <CardTitle>Quick Actions</CardTitle>
            </CardHeader>
            <div className="grid grid-cols-1 gap-2">
              {[
                { to: "/providers", label: "Configure Providers", desc: "Add models & upstream keys", icon: Plug },
                { to: "/api-manager/create", label: "Issue Client API Key", desc: "Scoped key with budgets", icon: KeySquare },
                { to: "/combo", label: "Model Combos", desc: "Failover & fallback chains", icon: Link2 },
                { to: "/tunnels", label: "Public Tunneling", desc: "cloudflared, ngrok, frpc, custom domain", icon: Globe },
                { to: "/agents", label: "Connect AI Agents", desc: "Claude Code, Codex, OpenCode", icon: Bot },
                { to: "/logs", label: "Inspect Live Traffic", desc: "Realtime request stream", icon: ScrollText },
                { to: "/analytics/usage", label: "Token & Cost Breakdown", desc: "Usage by provider & model", icon: TrendingUp },
              ].map((item) => {
                const Icon = item.icon;
                return (
                  <Link
                    key={item.to}
                    to={item.to}
                    prefetch="intent"
                    className="group flex items-center justify-between gap-3 rounded-xl border border-border/80 bg-surface-2/40 px-3 py-2.5 transition-all hover:border-primary/35 hover:bg-glass-hover"
                  >
                    <div className="flex min-w-0 items-center gap-2.5">
                      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-border bg-surface text-muted-foreground transition-colors group-hover:border-primary/30 group-hover:text-primary">
                        <Icon size={15} />
                      </span>
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-foreground">
                          {item.label}
                        </p>
                        <p className="truncate text-xs text-muted-foreground">
                          {item.desc}
                        </p>
                      </div>
                    </div>
                    <ArrowRight
                      size={14}
                      className="shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-primary"
                    />
                  </Link>
                );
              })}
            </div>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Providers</CardTitle>
              <Link
                to="/providers"
                prefetch="intent"
                className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
              >
                Manage all
                <ArrowRight size={13} />
              </Link>
            </CardHeader>
            {providers.length === 0 ? (
              <div className="py-4 text-center">
                <p className="text-sm text-muted-foreground">No providers configured.</p>
                <Link
                  to="/providers"
                  className={buttonClass("primary", "sm", "mt-3")}
                >
                  <Plus size={14} />
                  Add Provider
                </Link>
              </div>
            ) : (
              <div className="space-y-2">
                {providers.map((p) => (
                  <Link
                    key={p.id}
                    to={`/providers/${p.id}`}
                    prefetch="intent"
                    className="flex items-center justify-between gap-2 rounded-xl border border-border/70 bg-surface-2/40 px-3 py-2 transition-colors hover:border-primary/35 hover:bg-glass-hover"
                  >
                    <div className="flex min-w-0 items-center gap-2.5">
                      <span
                        className={`h-2 w-2 shrink-0 rounded-full ${
                          p.is_active ? "bg-success" : "bg-muted-foreground/40"
                        }`}
                      />
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-foreground">
                          {p.name}
                        </p>
                        <p className="truncate font-mono text-[11px] text-muted-foreground">
                          {p.id}
                        </p>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground">
                      <span className="rounded bg-surface px-1.5 py-0.5 tabular-nums">
                        {p.models}m
                      </span>
                      <span className="rounded bg-surface px-1.5 py-0.5 tabular-nums">
                        {p.keys}k
                      </span>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
