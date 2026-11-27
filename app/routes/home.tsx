import { useEffect, useRef, useState } from "react";
import { Link, useFetcher } from "react-router";
import {
  ArrowRight,
  ArrowUpCircle,
  Plus,
  Square,
} from "lucide-react";
import type { Route } from "./+types/home";
import pkg from "../../package.json";
import { requireLoaderSession, requireSession } from "../.server/auth";
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
import { MetricStrip } from "../components/ui/stat-card";
import { PageHeader } from "../components/ui/page-header";
import { Card, CardHeader, CardTitle } from "../components/ui/card";
import { Badge } from "../components/ui/badge";
import { Button, buttonClass } from "../components/ui/button";
import { CopyButton } from "../components/ui/copy-button";
import { EmptyState } from "../components/ui/empty-state";
import { Spinner } from "../components/ui/feedback";
import { useToast } from "../components/ui/toast";
import { UsageChart } from "../components/usage-chart";
import { fmtTs } from "../lib/log-format";

const APP_VERSION = pkg.version || "1.1.0";

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
  requireLoaderSession(request);
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
        subtitle="Live gateway traffic, endpoint routing, and provider readiness."
        actions={
          <Link to="/api-manager/create" className={buttonClass("primary", "sm")}>
            <Plus size={14} aria-hidden="true" />
            New API Key
          </Link>
        }
      />

      <MetricStrip
        className="mb-6"
        items={[
          {
            label: "Total requests",
            value: stats.total.toLocaleString(),
            detail: `${stats.today.toLocaleString()} today`,
          },
          {
            label: "Success rate",
            value: stats.total > 0 ? stats.successRate : "-",
            suffix: stats.total > 0 ? "%" : undefined,
            detail: `${stats.success.toLocaleString()} / ${stats.total.toLocaleString()} OK`,
            tone: stats.total > 0 && stats.successRate < 90 ? "warning" : "success",
          },
          {
            label: "Average latency",
            value: stats.total > 0 ? latency.value : "-",
            suffix: stats.total > 0 ? latency.suffix : undefined,
            detail: stats.total > 0 ? "Across logged requests" : "No requests yet",
          },
          {
            label: "Active providers",
            value: stats.activeProviders,
            detail: `of ${stats.totalProviders} configured · ${activeKeys} client key${activeKeys === 1 ? "" : "s"}`,
          },
        ]}
      />

      <div className="mb-6 flex flex-col justify-between gap-3 rounded-lg border border-border bg-surface px-4 py-3 sm:flex-row sm:items-center">
        <div className="flex min-w-0 flex-wrap items-center gap-2.5 text-xs">
          {liveTunnel.active ? (
            <Badge tone="success" dot>
              Tunnel ({liveTunnel.provider})
            </Badge>
          ) : (
            <Badge tone="neutral">Gateway endpoint</Badge>
          )}
          <code className="max-w-full truncate font-mono text-sm text-foreground">
            {liveGatewayUrl}
          </code>
          <CopyButton text={liveGatewayUrl} label="Copy gateway endpoint" />
        </div>

        <div className="flex shrink-0 items-center gap-2">
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
          ) : (
            <Link
              to="/tunnels"
              className="text-xs font-medium text-primary hover:underline"
            >
              Configure public tunnel
            </Link>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
        <div className="space-y-5 lg:col-span-8">
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
                <ArrowRight size={13} aria-hidden="true" />
              </Link>
            }
          />

          <Card>
            <CardHeader>
              <CardTitle>Recent requests</CardTitle>
              <Link
                to="/logs"
                prefetch="intent"
                className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
              >
                Open live logs
                <ArrowRight size={13} aria-hidden="true" />
              </Link>
            </CardHeader>
            {recent.length === 0 ? (
              <EmptyState
                title="No requests logged yet"
                description={`Send a chat completion request to ${liveGatewayUrl}/chat/completions to see live traffic here.`}
              />
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
                          <span className="hidden rounded border border-border bg-surface-2 px-1.5 py-0.5 text-[11px] text-muted-foreground sm:inline">
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

        <div className="space-y-5 lg:col-span-4">
          <Card>
            <CardHeader>
              <CardTitle>Providers</CardTitle>
              <Link
                to="/providers"
                prefetch="intent"
                className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
              >
                Manage all
                <ArrowRight size={13} aria-hidden="true" />
              </Link>
            </CardHeader>
            {providers.length === 0 ? (
              <EmptyState
                title="No providers configured"
                description="Add an upstream provider to start routing model requests."
                action={
                  <Link
                    to="/providers"
                    className={buttonClass("primary", "sm")}
                  >
                    <Plus size={14} aria-hidden="true" />
                    Add Provider
                  </Link>
                }
              />
            ) : (
              <div className="space-y-2">
                {providers.map((p) => (
                  <Link
                    key={p.id}
                    to={`/providers/${p.id}`}
                    prefetch="intent"
                    className="flex min-h-[44px] items-center justify-between gap-2 rounded-md border border-border bg-surface-2/60 px-3 py-2 transition-colors hover:border-border-strong hover:bg-surface-2"
                  >
                    <div className="flex min-w-0 items-center gap-2.5">
                      <span
                        aria-hidden="true"
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
                      <span className="rounded border border-border bg-surface px-1.5 py-0.5 tabular-nums">
                        {p.models}m
                      </span>
                      <span className="rounded border border-border bg-surface px-1.5 py-0.5 tabular-nums">
                        {p.keys}k
                      </span>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>System</CardTitle>
              <Badge tone="neutral">v{APP_VERSION}</Badge>
            </CardHeader>
            <div className="space-y-2.5 text-xs">
              <div className="flex items-center justify-between text-muted-foreground">
                <span>Client API keys</span>
                <span className="font-mono font-medium tabular-nums text-foreground">
                  {activeKeys} active
                </span>
              </div>
              <div className="flex items-center justify-between text-muted-foreground">
                <span>Tunnel status</span>
                <span className="font-mono font-medium text-foreground">
                  {liveTunnel.active ? liveTunnel.status : "inactive"}
                </span>
              </div>
              <div className="pt-2">
                <Link
                  to="/updates"
                  prefetch="intent"
                  className={buttonClass("outline", "sm", "w-full justify-between")}
                >
                  <span className="flex items-center gap-1.5">
                    <ArrowUpCircle size={14} aria-hidden="true" />
                    Check for updates
                  </span>
                  <ArrowRight size={13} aria-hidden="true" />
                </Link>
              </div>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
