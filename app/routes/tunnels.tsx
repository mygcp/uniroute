import { useCallback, useEffect, useRef, useState } from "react";
import { Form, useFetcher, useNavigation, useRevalidator } from "react-router";
import type { Route } from "./+types/tunnels";
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  ExternalLink,
  Globe,
  HardDrive,
  Play,
  RefreshCw,
  Save,
  ShieldCheck,
  Square,
  Terminal,
  Trash2,
  Zap,
} from "lucide-react";
import { requireLoaderSession, requireSession } from "../.server/auth";
import {
  clearTunnelError,
  clearTunnelLogs,
  getPublicTunnelSettings,
  getTunnelSettings,
  getTunnelStatus,
  saveTunnelSettings,
  startTunnel,
  stopTunnel,
  syncRunningTunnelDomain,
} from "../.server/tunnel";
import {
  downloadTunnelTool,
  getAllTunnelToolsStatus,
  managedTunnelBinaryPath,
  uninstallTunnelTool,
} from "../.server/tunnel-tools";
import {
  CLOUDFLARED_MODES,
  CLOUDFLARED_PROTOCOLS,
  FRPC_PROTOCOLS,
  NGROK_REGIONS,
  VALID_TUNNEL_PROVIDERS,
  type CloudflaredMode,
  type CloudflaredProtocol,
  type DownloadTunnelToolResult,
  type FrpcProtocol,
  type NgrokRegion,
  type TunnelProviderId,
  type TunnelRuntimeStatus,
  type TunnelToolStatus,
} from "../lib/tunnel-options";
import { PageHeader } from "../components/ui/page-header";
import { Card } from "../components/ui/card";
import { StatCard } from "../components/ui/stat-card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { DownloadProgressBar } from "../components/download-progress-bar";
import { CopyButton } from "../components/ui/copy-button";
import { Input, Label, Select } from "../components/ui/field";
import { Toggle } from "../components/ui/toggle";
import { Spinner } from "../components/ui/feedback";
import { useConfirm } from "../components/ui/confirm-dialog";
import { useToast } from "../components/ui/toast";

export function meta() {
  return [{ title: "Tunneling | UniRoute" }];
}

function detectPortFromRequest(request: Request): number {
  const url = new URL(request.url);
  if (url.port) {
    const n = Number(url.port);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const envPort = Number(process.env.PORT ?? 3000);
  if (Number.isFinite(envPort) && envPort > 0) return envPort;
  return url.protocol === "https:" ? 443 : 80;
}

function configuredBinaryMap(
  settings: ReturnType<typeof getTunnelSettings>,
): Partial<Record<TunnelProviderId, string>> {
  return {
    cloudflared: settings.cloudflared_binary_path,
    ngrok: settings.ngrok_binary_path,
    frpc: settings.frpc_binary_path,
    bore: settings.bore_binary_path,
  };
}

export async function loader({ request }: Route.LoaderArgs) {
  requireLoaderSession(request);
  const raw = getTunnelSettings();
  const settings = getPublicTunnelSettings(raw);
  const status = getTunnelStatus();
  const tools = await getAllTunnelToolsStatus(configuredBinaryMap(raw));
  return {
    settings,
    status,
    tools,
    detectedPort: detectPortFromRequest(request),
    platform: process.platform,
    arch: process.arch,
  };
}

type ActionResult =
  | { ok: true; saved: true; restarted?: boolean; updatedUrl?: boolean }
  | { ok: true; downloaded: DownloadTunnelToolResult }
  | {
      ok: true;
      uninstalled: { tool: TunnelProviderId; path: string; removed: boolean };
    }
  | { ok: true; started: TunnelRuntimeStatus }
  | { ok: true; stopped: TunnelRuntimeStatus }
  | { ok: true; clearedLogs: true; status: TunnelRuntimeStatus }
  | { ok: true; clearedError: true; status: TunnelRuntimeStatus }
  | { ok: false; error: string; tool?: TunnelProviderId };

function saveSettingsFromForm(form: FormData) {
  const providerRaw = String(form.get("provider") ?? "cloudflared");
  if (!VALID_TUNNEL_PROVIDERS.has(providerRaw as TunnelProviderId)) {
    throw new Error("Unsupported tunnel provider.");
  }
  return saveTunnelSettings({
    provider: providerRaw as TunnelProviderId,
    auto_start: form.get("auto_start") === "1",
    auto_reconnect: form.get("auto_reconnect") === "1",
    local_host: String(form.get("local_host") ?? "127.0.0.1"),
    local_port: Number(form.get("local_port") ?? 0),
    custom_domain: String(form.get("custom_domain") ?? ""),
    prefer_https: form.get("prefer_https") === "1",
    cloudflared_mode: String(form.get("cloudflared_mode") ?? "quick") as CloudflaredMode,
    cloudflared_protocol: String(
      form.get("cloudflared_protocol") ?? "auto",
    ) as CloudflaredProtocol,
    cloudflared_token: String(form.get("cloudflared_token") ?? ""),
    clear_cloudflared_token: form.get("clear_cloudflared_token") === "1",
    cloudflared_binary_path: String(form.get("cloudflared_binary_path") ?? ""),
    ngrok_region: String(form.get("ngrok_region") ?? "auto") as NgrokRegion,
    ngrok_authtoken: String(form.get("ngrok_authtoken") ?? ""),
    clear_ngrok_authtoken: form.get("clear_ngrok_authtoken") === "1",
    ngrok_binary_path: String(form.get("ngrok_binary_path") ?? ""),
    frpc_server_addr: String(form.get("frpc_server_addr") ?? ""),
    frpc_server_port: Number(form.get("frpc_server_port") ?? 7000),
    frpc_protocol: String(form.get("frpc_protocol") ?? "http") as FrpcProtocol,
    frpc_subdomain: String(form.get("frpc_subdomain") ?? ""),
    frpc_token: String(form.get("frpc_token") ?? ""),
    clear_frpc_token: form.get("clear_frpc_token") === "1",
    frpc_binary_path: String(form.get("frpc_binary_path") ?? ""),
    bore_server: String(form.get("bore_server") ?? "bore.pub"),
    bore_remote_port: Number(form.get("bore_remote_port") ?? 0),
    bore_secret: String(form.get("bore_secret") ?? ""),
    clear_bore_secret: form.get("clear_bore_secret") === "1",
    bore_binary_path: String(form.get("bore_binary_path") ?? ""),
  });
}

const BINARY_SETTING_KEY: Record<TunnelProviderId, string> = {
  cloudflared: "cloudflared_binary_path",
  ngrok: "ngrok_binary_path",
  frpc: "frpc_binary_path",
  bore: "bore_binary_path",
};

export async function action({ request }: Route.ActionArgs) {
  const denied = requireSession(request);
  if (denied) return denied;

  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "download") {
    const rawTool = String(form.get("tool") ?? "");
    if (!VALID_TUNNEL_PROVIDERS.has(rawTool as TunnelProviderId)) {
      return Response.json(
        { ok: false, error: "Unknown tunnel binary." } satisfies ActionResult,
        { status: 400 },
      );
    }
    const tool = rawTool as TunnelProviderId;
    try {
      const downloaded = await downloadTunnelTool(tool);
      const cur = getTunnelSettings();
      const field = BINARY_SETTING_KEY[tool] as keyof typeof cur;
      if (!String(cur[field] ?? "").trim()) {
        saveTunnelSettings({ [field]: downloaded.binaryPath });
      }
      return { ok: true, downloaded } satisfies ActionResult;
    } catch (err) {
      return Response.json(
        {
          ok: false,
          tool,
          error: err instanceof Error ? err.message : "Download failed.",
        } satisfies ActionResult,
        { status: 500 },
      );
    }
  }

  if (intent === "uninstall") {
    const rawTool = String(form.get("tool") ?? "");
    if (!VALID_TUNNEL_PROVIDERS.has(rawTool as TunnelProviderId)) {
      return Response.json(
        { ok: false, error: "Unknown tunnel binary." } satisfies ActionResult,
        { status: 400 },
      );
    }
    const tool = rawTool as TunnelProviderId;
    try {
      const active = getTunnelStatus();
      if (active.status !== "stopped" && active.provider === tool) {
        stopTunnel();
      }
      const managed = managedTunnelBinaryPath(tool);
      const removed = uninstallTunnelTool(tool);
      const cur = getTunnelSettings();
      const field = BINARY_SETTING_KEY[tool] as keyof typeof cur;
      if (String(cur[field] ?? "").toLowerCase() === managed.toLowerCase()) {
        saveTunnelSettings({ [field]: "" });
      }
      return {
        ok: true,
        uninstalled: { tool, ...removed },
      } satisfies ActionResult;
    } catch (err) {
      return Response.json(
        {
          ok: false,
          tool,
          error: err instanceof Error ? err.message : "Uninstall failed.",
        } satisfies ActionResult,
        { status: 500 },
      );
    }
  }

  if (intent === "save") {
    try {
      const prev = getTunnelSettings();
      const next = saveSettingsFromForm(form);
      const sync = await syncRunningTunnelDomain(next, prev);
      return {
        ok: true,
        saved: true,
        restarted: sync.restarted,
        updatedUrl: sync.updatedUrl,
      } satisfies ActionResult;
    } catch (err) {
      return Response.json(
        {
          ok: false,
          error: err instanceof Error ? err.message : "Could not save settings.",
        } satisfies ActionResult,
        { status: 400 },
      );
    }
  }

  if (intent === "start") {
    try {
      if (form.get("save_first") === "1") {
        saveSettingsFromForm(form);
      }
      const status = await startTunnel({
        port: detectPortFromRequest(request),
        waitMs: 6000,
      });
      return { ok: true, started: status } satisfies ActionResult;
    } catch (err) {
      return Response.json(
        {
          ok: false,
          error: err instanceof Error ? err.message : "Failed to start tunnel.",
        } satisfies ActionResult,
        { status: 500 },
      );
    }
  }

  if (intent === "stop") {
    const status = stopTunnel();
    return { ok: true, stopped: status } satisfies ActionResult;
  }

  if (intent === "clear_logs") {
    clearTunnelLogs();
    return { ok: true, clearedLogs: true, status: getTunnelStatus() } satisfies ActionResult;
  }

  if (intent === "clear_error") {
    const status = clearTunnelError();
    return { ok: true, clearedError: true, status } satisfies ActionResult;
  }

  return Response.json(
    { ok: false, error: "Unknown intent." } satisfies ActionResult,
    { status: 400 },
  );
}

function fmtBytes(n: number | null): string {
  if (n == null) return "-";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function sourceLabel(tool: TunnelToolStatus): string {
  switch (tool.source) {
    case "managed":
      return "Downloaded (~/.uniroute/bin)";
    case "path":
      return "Detected on system PATH";
    case "custom":
      return "Custom binary path";
    case "missing":
      return "Not downloaded yet";
  }
}

function statusBadgeMeta(status: TunnelRuntimeStatus["status"]): {
  tone: "success" | "warning" | "danger" | "neutral" | "info";
  label: string;
} {
  switch (status) {
    case "running":
      return { tone: "success", label: "Running" };
    case "starting":
      return { tone: "info", label: "Starting" };
    case "reconnecting":
      return { tone: "warning", label: "Reconnecting" };
    case "error":
      return { tone: "danger", label: "Error" };
    case "stopped":
      return { tone: "neutral", label: "Stopped" };
  }
}

function TunnelToolCard({
  tool,
  selected,
  onSelectProvider,
  confirm,
}: {
  tool: TunnelToolStatus;
  selected: boolean;
  onSelectProvider: (id: TunnelProviderId) => void;
  confirm: (opts: {
    title: string;
    description?: string;
    confirmLabel?: string;
    variant?: "primary" | "danger";
  }) => Promise<boolean>;
}) {
  const fetcher = useFetcher<ActionResult>();
  const { toast } = useToast();
  const lastDataRef = useRef<ActionResult | undefined>(undefined);
  const busy = fetcher.state !== "idle";
  const activeIntent = busy ? String(fetcher.formData?.get("intent") ?? "") : null;

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    if (lastDataRef.current === fetcher.data) return;
    lastDataRef.current = fetcher.data;
    const d = fetcher.data;
    if (d.ok && "downloaded" in d) {
      toast({
        title: d.downloaded.upToDate
          ? `${tool.name} is already up to date`
          : `${tool.name} downloaded`,
        description: d.downloaded.upToDate
          ? `Version ${d.downloaded.version ?? d.downloaded.tag} is already the latest release.`
          : `${d.downloaded.tag} installed to ${d.downloaded.binaryPath}${d.downloaded.checksumVerified ? " (SHA-256 verified)" : ""}`,
        variant: "success",
      });
    } else if (d.ok && "uninstalled" in d) {
      toast({
        title: `${tool.name} removed`,
        description: `Deleted ${d.uninstalled.path}`,
        variant: "success",
      });
    } else if (!d.ok) {
      toast({
        title: `${tool.name} operation failed`,
        description: d.error,
        variant: "error",
      });
    }
  }, [fetcher.state, fetcher.data, tool.name, toast]);

  const badgeTone = tool.installed
    ? tool.source === "custom"
      ? "info"
      : "success"
    : "neutral";

  const badgeText = tool.installed
    ? tool.version
      ? `Installed v${tool.version}`
      : "Installed"
    : "Not installed";

  return (
    <Card className="flex flex-col justify-between gap-4">
      <div>
        <div className="mb-2 flex flex-nowrap items-start justify-between gap-2">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold text-foreground">{tool.name}</h2>
            <Badge tone={badgeTone} dot={tool.installed}>
              {badgeText}
            </Badge>
            <Badge tone="neutral">{tool.license}</Badge>
          </div>
          <a
            href={tool.docsUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            Docs <ExternalLink size={12} aria-hidden="true" />
          </a>
        </div>

        <p className="text-xs leading-relaxed text-muted-foreground">{tool.tagline}</p>

        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          {tool.supportsQuick ? <Badge tone="info">Quick HTTPS</Badge> : null}
          {tool.supportsDomain ? <Badge tone="success">Custom Domain</Badge> : null}
          {tool.supportsSelfHosted ? <Badge tone="neutral">Self-Hosted</Badge> : null}
        </div>

        <div className="mt-3 rounded-lg border border-border bg-surface-2/40 px-3 py-2.5 text-xs">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-medium text-foreground">{sourceLabel(tool)}</span>
            {tool.sizeBytes != null && tool.installed ? (
              <span className="font-mono text-[11px] text-muted-foreground">
                {fmtBytes(tool.sizeBytes)}
              </span>
            ) : null}
          </div>
          <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">
            {tool.resolvedPath ?? tool.managedPath}
          </p>
        </div>
      </div>

      <div className="space-y-3 border-t border-border pt-3">
        <DownloadProgressBar
          progressKey={`tunnel:${tool.id}`}
          active={activeIntent === "download"}
        />
        <div className="flex flex-wrap items-center gap-2">
          <fetcher.Form method="post">
            <input type="hidden" name="intent" value="download" />
            <input type="hidden" name="tool" value={tool.id} />
            <Button
              type="submit"
              size="sm"
              variant={tool.installed ? "secondary" : "primary"}
              disabled={busy}
            >
              {activeIntent === "download" ? (
                <Spinner size={13} />
              ) : tool.installed ? (
                <RefreshCw size={13} aria-hidden="true" />
              ) : (
                <Download size={13} aria-hidden="true" />
              )}
              {activeIntent === "download"
                ? "Downloading..."
                : tool.isManaged
                  ? "Update binary"
                  : "Download binary"}
            </Button>
          </fetcher.Form>

          <Button
            type="button"
            size="sm"
            variant={selected ? "primary" : "secondary"}
            onClick={() => onSelectProvider(tool.id)}
          >
            {selected ? "Selected" : "Use provider"}
          </Button>

          {tool.isManaged ? (
            <Button
              type="button"
              size="sm"
              variant="danger"
              disabled={busy}
              onClick={async () => {
                const ok = await confirm({
                  title: `Remove downloaded ${tool.name}?`,
                  description: `Deletes ${tool.managedPath} from disk. Any active tunnel using this binary will stop.`,
                  confirmLabel: "Uninstall",
                  variant: "danger",
                });
                if (!ok) return;
                fetcher.submit(
                  { intent: "uninstall", tool: tool.id },
                  { method: "post" },
                );
              }}
            >
              {activeIntent === "uninstall" ? (
                <Spinner size={13} />
              ) : (
                <Trash2 size={13} aria-hidden="true" />
              )}
              Uninstall
            </Button>
          ) : null}
        </div>

        <details className="rounded-lg border border-border bg-surface-2/30 px-3 py-2 text-xs">
          <summary className="flex cursor-pointer items-center gap-1.5 font-medium text-muted-foreground hover:text-foreground">
            <Terminal size={12} aria-hidden="true" />
            Install manually on system PATH
          </summary>
          <div className="mt-2.5 space-y-2">
            {tool.installCommands.map((cmd) => (
              <div
                key={cmd.label}
                className="flex items-center justify-between gap-2 rounded-md border border-border bg-surface px-2.5 py-1.5"
              >
                <div className="min-w-0">
                  <p className="text-[11px] font-medium text-muted-foreground">
                    {cmd.label}
                  </p>
                  <code className="block truncate font-mono text-[11px] text-foreground">
                    {cmd.command}
                  </code>
                </div>
                <CopyButton text={cmd.command} label={`Copy ${cmd.label}`} />
              </div>
            ))}
          </div>
        </details>
      </div>
    </Card>
  );
}

export default function TunnelsPage({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const { settings, status: initialStatus, tools, detectedPort, platform, arch } =
    loaderData;
  const { dialog, confirm } = useConfirm();
  const { toast } = useToast();
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const consoleFetcher = useFetcher<ActionResult>();

  const [liveStatus, setLiveStatus] = useState<TunnelRuntimeStatus>(initialStatus);
  const [provider, setProvider] = useState<TunnelProviderId>(settings.provider);
  const [autoStart, setAutoStart] = useState(settings.auto_start);
  const [autoReconnect, setAutoReconnect] = useState(settings.auto_reconnect);
  const [localHost, setLocalHost] = useState(settings.local_host);
  const [localPort, setLocalPort] = useState(String(settings.local_port));
  const [customDomain, setCustomDomain] = useState(settings.custom_domain);
  const [preferHttps, setPreferHttps] = useState(settings.prefer_https);

  const [cfMode, setCfMode] = useState<CloudflaredMode>(settings.cloudflared_mode);
  const [cfProtocol, setCfProtocol] = useState<CloudflaredProtocol>(
    settings.cloudflared_protocol,
  );
  const [cfToken, setCfToken] = useState("");
  const [clearCfToken, setClearCfToken] = useState(false);
  const [cfBinaryPath, setCfBinaryPath] = useState(settings.cloudflared_binary_path);

  const [ngrokRegion, setNgrokRegion] = useState<NgrokRegion>(settings.ngrok_region);
  const [ngrokAuthtoken, setNgrokAuthtoken] = useState("");
  const [clearNgrokToken, setClearNgrokToken] = useState(false);
  const [ngrokBinaryPath, setNgrokBinaryPath] = useState(settings.ngrok_binary_path);

  const [frpcServerAddr, setFrpcServerAddr] = useState(settings.frpc_server_addr);
  const [frpcServerPort, setFrpcServerPort] = useState(String(settings.frpc_server_port));
  const [frpcProtocol, setFrpcProtocol] = useState<FrpcProtocol>(settings.frpc_protocol);
  const [frpcSubdomain, setFrpcSubdomain] = useState(settings.frpc_subdomain);
  const [frpcToken, setFrpcToken] = useState("");
  const [clearFrpcToken, setClearFrpcToken] = useState(false);
  const [frpcBinaryPath, setFrpcBinaryPath] = useState(settings.frpc_binary_path);

  const [boreServer, setBoreServer] = useState(settings.bore_server);
  const [boreRemotePort, setBoreRemotePort] = useState(String(settings.bore_remote_port));
  const [boreSecret, setBoreSecret] = useState("");
  const [clearBoreSecret, setClearBoreSecret] = useState(false);
  const [boreBinaryPath, setBoreBinaryPath] = useState(settings.bore_binary_path);

  const configSectionRef = useRef<HTMLDivElement>(null);
  const lastActionRef = useRef<ActionResult | undefined>(undefined);

  useEffect(() => {
    setLiveStatus(initialStatus);
  }, [initialStatus]);

  useEffect(() => {
    setProvider(settings.provider);
    setAutoStart(settings.auto_start);
    setAutoReconnect(settings.auto_reconnect);
    setLocalHost(settings.local_host);
    setLocalPort(String(settings.local_port));
    setCustomDomain(settings.custom_domain);
    setPreferHttps(settings.prefer_https);
    setCfMode(settings.cloudflared_mode);
    setCfProtocol(settings.cloudflared_protocol);
    setCfBinaryPath(settings.cloudflared_binary_path);
    setNgrokRegion(settings.ngrok_region);
    setNgrokBinaryPath(settings.ngrok_binary_path);
    setFrpcServerAddr(settings.frpc_server_addr);
    setFrpcServerPort(String(settings.frpc_server_port));
    setFrpcProtocol(settings.frpc_protocol);
    setFrpcSubdomain(settings.frpc_subdomain);
    setFrpcBinaryPath(settings.frpc_binary_path);
    setBoreServer(settings.bore_server);
    setBoreRemotePort(String(settings.bore_remote_port));
    setBoreBinaryPath(settings.bore_binary_path);
    setCfToken("");
    setClearCfToken(false);
    setNgrokAuthtoken("");
    setClearNgrokToken(false);
    setFrpcToken("");
    setClearFrpcToken(false);
    setBoreSecret("");
    setClearBoreSecret(false);
  }, [settings]);

  useEffect(() => {
    if (!actionData || lastActionRef.current === actionData) return;
    lastActionRef.current = actionData;
    const d = actionData as ActionResult;
    if (d.ok && "saved" in d) {
      toast({
        title: "Tunnel settings saved",
        description: d.restarted
          ? "Updated domain and restarted the active tunnel."
          : d.updatedUrl
            ? "Updated active tunnel URL for the new custom domain."
            : "Updated tunnel, auto-tunneling, and custom domain configuration.",
        variant: "success",
      });
    } else if (d.ok && "started" in d) {
      setLiveStatus(d.started);
      toast({
        title:
          d.started.publicUrl ? "Tunnel connected" : "Tunnel process started",
        description: d.started.publicUrl ?? `Forwarding ${d.started.localTarget ?? ""}`,
        variant: "success",
      });
    } else if (d.ok && "stopped" in d) {
      setLiveStatus(d.stopped);
      toast({
        title: "Tunnel stopped",
        variant: "success",
      });
    } else if (!d.ok) {
      toast({
        title: "Tunnel action failed",
        description: d.error,
        variant: "error",
      });
    }
  }, [actionData, toast]);

  useEffect(() => {
    const d = consoleFetcher.data;
    if (d && d.ok && "clearedLogs" in d) {
      setLiveStatus(d.status);
    }
  }, [consoleFetcher.data]);

  const pollStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/tunnel/status");
      if (!res.ok) return;
      const next = (await res.json()) as TunnelRuntimeStatus;
      setLiveStatus(next);
    } catch {
      // Ignore transient poll network error.
    }
  }, []);

  const isActiveState =
    liveStatus.status === "starting" ||
    liveStatus.status === "running" ||
    liveStatus.status === "reconnecting";

  useEffect(() => {
    if (!isActiveState) return;
    const iv = setInterval(() => {
      void pollStatus();
    }, 2500);
    return () => clearInterval(iv);
  }, [isActiveState, pollStatus]);

  const isBusy = navigation.state === "submitting";
  const formIntent = isBusy ? String(navigation.formData?.get("intent") ?? "") : "";
  const installedCount = tools.filter((t) => t.installed).length;
  const badge = statusBadgeMeta(liveStatus.status);
  const selectedTool = tools.find((t) => t.id === provider);
  const targetPortLabel =
    Number(localPort) > 0 ? localPort : `${detectedPort} (auto)`;

  const handleSelectProvider = (id: TunnelProviderId) => {
    setProvider(id);
    configSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  };

  const renderAllHiddenFields = () => (
    <>
      <input type="hidden" name="provider" value={provider} />
      <input type="hidden" name="auto_start" value={autoStart ? "1" : "0"} />
      <input type="hidden" name="auto_reconnect" value={autoReconnect ? "1" : "0"} />
      <input type="hidden" name="prefer_https" value={preferHttps ? "1" : "0"} />
      <input type="hidden" name="local_host" value={localHost} />
      <input type="hidden" name="local_port" value={localPort} />
      <input type="hidden" name="custom_domain" value={customDomain} />

      <input type="hidden" name="cloudflared_mode" value={cfMode} />
      <input type="hidden" name="cloudflared_protocol" value={cfProtocol} />
      <input type="hidden" name="cloudflared_token" value={cfToken} />
      <input
        type="hidden"
        name="clear_cloudflared_token"
        value={clearCfToken ? "1" : "0"}
      />
      <input type="hidden" name="cloudflared_binary_path" value={cfBinaryPath} />

      <input type="hidden" name="ngrok_region" value={ngrokRegion} />
      <input type="hidden" name="ngrok_authtoken" value={ngrokAuthtoken} />
      <input
        type="hidden"
        name="clear_ngrok_authtoken"
        value={clearNgrokToken ? "1" : "0"}
      />
      <input type="hidden" name="ngrok_binary_path" value={ngrokBinaryPath} />

      <input type="hidden" name="frpc_server_addr" value={frpcServerAddr} />
      <input type="hidden" name="frpc_server_port" value={frpcServerPort} />
      <input type="hidden" name="frpc_protocol" value={frpcProtocol} />
      <input type="hidden" name="frpc_subdomain" value={frpcSubdomain} />
      <input type="hidden" name="frpc_token" value={frpcToken} />
      <input type="hidden" name="clear_frpc_token" value={clearFrpcToken ? "1" : "0"} />
      <input type="hidden" name="frpc_binary_path" value={frpcBinaryPath} />

      <input type="hidden" name="bore_server" value={boreServer} />
      <input type="hidden" name="bore_remote_port" value={boreRemotePort} />
      <input type="hidden" name="bore_secret" value={boreSecret} />
      <input
        type="hidden"
        name="clear_bore_secret"
        value={clearBoreSecret ? "1" : "0"}
      />
      <input type="hidden" name="bore_binary_path" value={boreBinaryPath} />
    </>
  );

  return (
    <div className="space-y-6">
      {dialog}

      <PageHeader
        title="Tunneling"
        icon={<Globe size={18} aria-hidden="true" />}
        subtitle={`Expose UniRoute over public HTTPS or a custom domain using external binaries (${platform}/${arch}). Zero binaries are bundled with UniRoute.`}
        badge={
          <Badge tone={badge.tone} dot>
            {badge.label}
          </Badge>
        }
        actions={
          <Form method="post">
            {isActiveState ? (
              <>
                <input type="hidden" name="intent" value="stop" />
                <Button type="submit" size="sm" variant="danger" disabled={isBusy}>
                  {formIntent === "stop" ? (
                    <Spinner size={13} />
                  ) : (
                    <Square size={13} aria-hidden="true" />
                  )}
                  Stop Tunnel
                </Button>
              </>
            ) : (
              <>
                <input type="hidden" name="intent" value="start" />
                <Button type="submit" size="sm" variant="primary" disabled={isBusy}>
                  {formIntent === "start" ? (
                    <Spinner size={13} />
                  ) : (
                    <Play size={13} aria-hidden="true" />
                  )}
                  Start Tunnel
                </Button>
              </>
            )}
          </Form>
        }
      />

      {/* Top KPI strip */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          title="Tunnel Status"
          value={badge.label}
          accent={
            liveStatus.status === "running"
              ? "bg-success"
              : liveStatus.status === "error"
                ? "bg-danger"
                : isActiveState
                  ? "bg-warning"
                  : "bg-primary"
          }
          icon={<Zap size={16} aria-hidden="true" />}
          subline={
            liveStatus.localTarget
              ? `${liveStatus.provider} -> ${liveStatus.localTarget}`
              : `${settings.provider} -> ${localHost}:${targetPortLabel}`
          }
        />
        <StatCard
          title="Public URL"
          value={liveStatus.publicUrl ? "Active" : settings.custom_domain || "Not set"}
          accent={liveStatus.publicUrl ? "bg-success" : "bg-info"}
          icon={<Globe size={16} aria-hidden="true" />}
          subline={
            liveStatus.publicUrl
              ? liveStatus.publicUrl
              : settings.custom_domain
                ? "Configured custom domain (tunnel stopped)"
                : "Start quick or named tunnel"
          }
        />
        <StatCard
          title="Installed Binaries"
          value={`${installedCount} / ${tools.length}`}
          accent={installedCount > 0 ? "bg-primary" : "bg-warning"}
          icon={<HardDrive size={16} aria-hidden="true" />}
          subline="Downloaded separately to ~/.uniroute/bin"
        />
        <StatCard
          title="Auto-Tunneling"
          value={autoStart ? "Auto-start On" : "Manual start"}
          accent={autoStart ? "bg-success" : "bg-primary"}
          icon={<ShieldCheck size={16} aria-hidden="true" />}
          subline={
            autoReconnect ? "Auto-reconnect with backoff On" : "Auto-reconnect Off"
          }
        />
      </div>

      {/* Live endpoints strip when public URL exists */}
      {liveStatus.publicUrl ? (
        <Card className="border-success/35 bg-success/5">
          <div className="flex flex-wrap items-center justify-between gap-2 pb-3">
            <div className="flex items-center gap-2">
              <CheckCircle2 size={16} className="text-success" aria-hidden="true" />
              <h2 className="text-sm font-semibold text-foreground">
                Public Endpoints Ready
              </h2>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <a
                href={liveStatus.publicUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
              >
                Open Dashboard <ExternalLink size={12} aria-hidden="true" />
              </a>
              <Form method="post">
                <input type="hidden" name="intent" value="stop" />
                <Button type="submit" size="sm" variant="danger" disabled={isBusy}>
                  {formIntent === "stop" ? (
                    <Spinner size={13} />
                  ) : (
                    <Square size={13} aria-hidden="true" />
                  )}
                  Stop Tunnel
                </Button>
              </Form>
            </div>
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            {[
              { label: "OpenAI-Compatible API", url: `${liveStatus.publicUrl}/v1` },
              { label: "Remote MCP Endpoint", url: `${liveStatus.publicUrl}/api/mcp` },
              { label: "Gateway Dashboard", url: liveStatus.publicUrl },
            ].map((item) => (
              <div
                key={item.label}
                className="flex items-center justify-between gap-2 rounded-lg border border-border bg-surface px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="text-[11px] font-medium text-muted-foreground">
                    {item.label}
                  </p>
                  <code className="block truncate font-mono text-xs text-foreground">
                    {item.url}
                  </code>
                </div>
                <CopyButton text={item.url} label={`Copy ${item.label}`} />
              </div>
            ))}
          </div>
        </Card>
      ) : null}

      {liveStatus.lastError ? (
        <Card className="border-danger/35 bg-danger/10">
          <div className="flex items-start justify-between gap-3 text-xs text-danger">
            <div className="flex min-w-0 items-start gap-2.5">
              <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
              <div className="min-w-0">
                <p className="font-semibold">Last Tunnel Error</p>
                <p className="mt-0.5 break-words">{liveStatus.lastError}</p>
              </div>
            </div>
            <Form method="post" onSubmit={() => setLiveStatus((s) => ({ ...s, lastError: null }))}>
              <input type="hidden" name="intent" value="clear_error" />
              <Button type="submit" size="sm" variant="ghost" className="shrink-0 text-danger hover:bg-danger/15">
                Dismiss
              </Button>
            </Form>
          </div>
        </Card>
      ) : null}

      {/* External Tunnel Binaries */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold text-foreground">
              External Tunnel Binaries
            </h2>
            <p className="text-xs text-muted-foreground">
              Downloaded directly from official releases into ~/.uniroute/bin without GitHub API OAuth.
            </p>
          </div>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => revalidator.revalidate()}
          >
            <RefreshCw size={13} aria-hidden="true" />
            Refresh detection
          </Button>
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {tools.map((tool) => (
            <TunnelToolCard
              key={tool.id}
              tool={tool}
              selected={provider === tool.id}
              onSelectProvider={handleSelectProvider}
              confirm={confirm}
            />
          ))}
        </div>
      </section>

      {/* Tunnel & Domain Configuration */}
      <div ref={configSectionRef}>
        <Card>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2 border-b border-border pb-3">
            <div>
              <h2 className="text-sm font-semibold text-foreground">
                Tunnel & Domain Configuration
              </h2>
              <p className="text-xs text-muted-foreground">
                Configure auto-tunneling on boot, custom domain routing, and credentials for{" "}
                <span className="font-medium text-foreground">
                  {selectedTool?.name ?? provider}
                </span>
                .
              </p>
            </div>
            {selectedTool && !selectedTool.installed ? (
              <Badge tone="warning">Binary not installed yet</Badge>
            ) : null}
          </div>

          <Form method="post" className="space-y-5">
            {renderAllHiddenFields()}

            {/* Core routing & auto-tunneling */}
            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <div>
                <Label htmlFor="tunnel-provider">Active Tunnel Provider</Label>
                <Select
                  id="tunnel-provider"
                  value={provider}
                  onChange={(e) => setProvider(e.target.value as TunnelProviderId)}
                >
                  <option value="cloudflared">Cloudflare Tunnel (cloudflared)</option>
                  <option value="ngrok">ngrok</option>
                  <option value="frpc">FRP Client (frpc, self-hosted VPS)</option>
                  <option value="bore">bore (TCP / bore.pub)</option>
                </Select>
              </div>

              <div>
                <Label htmlFor="tunnel-local-host">Local Gateway Host</Label>
                <Input
                  id="tunnel-local-host"
                  value={localHost}
                  onChange={(e) => setLocalHost(e.target.value)}
                  placeholder="127.0.0.1"
                />
              </div>

              <div>
                <Label htmlFor="tunnel-local-port">Local Port (0 = auto-detect)</Label>
                <Input
                  id="tunnel-local-port"
                  type="number"
                  min={0}
                  max={65535}
                  value={localPort}
                  onChange={(e) => setLocalPort(e.target.value)}
                  placeholder="0"
                />
              </div>
            </div>

            {/* Auto-tunneling switches */}
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-surface-2/35 px-3.5 py-2.5">
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-foreground">
                    Auto-start on boot
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    Start tunnel automatically when server launches
                  </p>
                </div>
                <Toggle
                  checked={autoStart}
                  onChange={setAutoStart}
                  label="Auto-start tunnel on server boot"
                />
              </div>

              <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-surface-2/35 px-3.5 py-2.5">
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-foreground">
                    Auto-reconnect
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    Restart with exponential backoff if connection drops
                  </p>
                </div>
                <Toggle
                  checked={autoReconnect}
                  onChange={setAutoReconnect}
                  label="Auto-reconnect dropped tunnel"
                />
              </div>

              <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-surface-2/35 px-3.5 py-2.5">
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-foreground">
                    HTTPS public URL
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    Format custom domain endpoints using https://
                  </p>
                </div>
                <Toggle
                  checked={preferHttps}
                  onChange={setPreferHttps}
                  label="Use HTTPS scheme for public URL"
                />
              </div>
            </div>

            {/* Custom Domain */}
            <div className="rounded-xl border border-border bg-surface-2/25 p-4">
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <div>
                  <Label htmlFor="tunnel-custom-domain">
                    Custom Domain (optional)
                  </Label>
                  <Input
                    id="tunnel-custom-domain"
                    value={customDomain}
                    onChange={(e) => setCustomDomain(e.target.value)}
                    placeholder="ai.yourdomain.com"
                  />
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    Used as hostname for ngrok (--url), frpc (customDomains), and Cloudflare Named Tunnels.
                  </p>
                </div>

                <div>
                  <Label htmlFor="tunnel-custom-bin">
                    Custom Binary Path Override ({provider})
                  </Label>
                  <Input
                    id="tunnel-custom-bin"
                    value={
                      provider === "cloudflared"
                        ? cfBinaryPath
                        : provider === "ngrok"
                          ? ngrokBinaryPath
                          : provider === "frpc"
                            ? frpcBinaryPath
                            : boreBinaryPath
                    }
                    onChange={(e) => {
                      const v = e.target.value;
                      if (provider === "cloudflared") setCfBinaryPath(v);
                      else if (provider === "ngrok") setNgrokBinaryPath(v);
                      else if (provider === "frpc") setFrpcBinaryPath(v);
                      else setBoreBinaryPath(v);
                    }}
                    placeholder="Leave blank to use ~/.uniroute/bin or PATH"
                  />
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    Optional path if you keep the binary outside ~/.uniroute/bin.
                  </p>
                </div>
              </div>
            </div>

            {/* Provider-specific fields */}
            {provider === "cloudflared" ? (
              <div className="space-y-4 rounded-xl border border-border bg-surface-2/25 p-4">
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <div>
                    <Label htmlFor="cf-mode">Cloudflare Tunnel Mode</Label>
                    <Select
                      id="cf-mode"
                      value={cfMode}
                      onChange={(e) => setCfMode(e.target.value as CloudflaredMode)}
                    >
                      {CLOUDFLARED_MODES.map((m) => (
                        <option key={m.value} value={m.value}>
                          {m.label}
                        </option>
                      ))}
                    </Select>
                  </div>

                  <div>
                    <Label htmlFor="cf-protocol">Transport Protocol</Label>
                    <Select
                      id="cf-protocol"
                      value={cfProtocol}
                      onChange={(e) =>
                        setCfProtocol(e.target.value as CloudflaredProtocol)
                      }
                    >
                      {CLOUDFLARED_PROTOCOLS.map((p) => (
                        <option key={p.value} value={p.value}>
                          {p.label}
                        </option>
                      ))}
                    </Select>
                  </div>
                </div>

                {cfMode === "token" ? (
                  <div>
                    <div className="mb-1 flex items-center gap-2">
                      <Label htmlFor="cf-token">Zero Trust Tunnel Token</Label>
                      {settings.has_cloudflared_token ? (
                        <Badge tone="success">Saved</Badge>
                      ) : null}
                    </div>
                    <Input
                      id="cf-token"
                      type="password"
                      autoComplete="off"
                      value={cfToken}
                      onChange={(e) => setCfToken(e.target.value)}
                      placeholder={
                        settings.has_cloudflared_token
                          ? "Leave blank to keep existing saved token"
                          : "Paste token from Cloudflare Zero Trust -> Networks -> Tunnels"
                      }
                    />
                    {settings.has_cloudflared_token ? (
                      <label className="mt-2 inline-flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
                        <input
                          type="checkbox"
                          checked={clearCfToken}
                          onChange={(e) => setClearCfToken(e.target.checked)}
                        />
                        Clear saved Cloudflare token
                      </label>
                    ) : null}
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Quick Tunnel generates a free ephemeral *.trycloudflare.com HTTPS URL with zero Cloudflare account or token setup.
                  </p>
                )}
              </div>
            ) : null}

            {provider === "ngrok" ? (
              <div className="grid grid-cols-1 gap-4 rounded-xl border border-border bg-surface-2/25 p-4 md:grid-cols-2">
                <div>
                  <Label htmlFor="ngrok-region">ngrok Region</Label>
                  <Select
                    id="ngrok-region"
                    value={ngrokRegion}
                    onChange={(e) => setNgrokRegion(e.target.value as NgrokRegion)}
                  >
                    {NGROK_REGIONS.map((r) => (
                      <option key={r.value} value={r.value}>
                        {r.label}
                      </option>
                    ))}
                  </Select>
                </div>

                <div>
                  <div className="mb-1 flex items-center gap-2">
                    <Label htmlFor="ngrok-authtoken">ngrok Authtoken</Label>
                    {settings.has_ngrok_authtoken ? (
                      <Badge tone="success">Saved</Badge>
                    ) : null}
                  </div>
                  <Input
                    id="ngrok-authtoken"
                    type="password"
                    autoComplete="off"
                    value={ngrokAuthtoken}
                    onChange={(e) => setNgrokAuthtoken(e.target.value)}
                    placeholder={
                      settings.has_ngrok_authtoken
                        ? "Leave blank to keep saved authtoken"
                        : "Paste authtoken from dashboard.ngrok.com"
                    }
                  />
                  {settings.has_ngrok_authtoken ? (
                    <label className="mt-2 inline-flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
                      <input
                        type="checkbox"
                        checked={clearNgrokToken}
                        onChange={(e) => setClearNgrokToken(e.target.checked)}
                      />
                      Clear saved ngrok authtoken
                    </label>
                  ) : null}
                </div>
              </div>
            ) : null}

            {provider === "frpc" ? (
              <div className="space-y-4 rounded-xl border border-border bg-surface-2/25 p-4">
                <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                  <div>
                    <Label htmlFor="frpc-server">FRP Server Address (frps host)</Label>
                    <Input
                      id="frpc-server"
                      value={frpcServerAddr}
                      onChange={(e) => setFrpcServerAddr(e.target.value)}
                      placeholder="vps.example.com"
                    />
                  </div>
                  <div>
                    <Label htmlFor="frpc-port">FRP Server Port</Label>
                    <Input
                      id="frpc-port"
                      type="number"
                      min={1}
                      max={65535}
                      value={frpcServerPort}
                      onChange={(e) => setFrpcServerPort(e.target.value)}
                      placeholder="7000"
                    />
                  </div>
                  <div>
                    <Label htmlFor="frpc-proto">Proxy Protocol</Label>
                    <Select
                      id="frpc-proto"
                      value={frpcProtocol}
                      onChange={(e) => setFrpcProtocol(e.target.value as FrpcProtocol)}
                    >
                      {FRPC_PROTOCOLS.map((p) => (
                        <option key={p.value} value={p.value}>
                          {p.label}
                        </option>
                      ))}
                    </Select>
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <div>
                    <Label htmlFor="frpc-sub">Subdomain (optional if Custom Domain set)</Label>
                    <Input
                      id="frpc-sub"
                      value={frpcSubdomain}
                      onChange={(e) => setFrpcSubdomain(e.target.value)}
                      placeholder="uniroute"
                    />
                  </div>
                  <div>
                    <div className="mb-1 flex items-center gap-2">
                      <Label htmlFor="frpc-token">FRP Auth Token (optional)</Label>
                      {settings.has_frpc_token ? (
                        <Badge tone="success">Saved</Badge>
                      ) : null}
                    </div>
                    <Input
                      id="frpc-token"
                      type="password"
                      autoComplete="off"
                      value={frpcToken}
                      onChange={(e) => setFrpcToken(e.target.value)}
                      placeholder={
                        settings.has_frpc_token
                          ? "Leave blank to keep saved token"
                          : "Shared auth.token configured on frps"
                      }
                    />
                    {settings.has_frpc_token ? (
                      <label className="mt-2 inline-flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
                        <input
                          type="checkbox"
                          checked={clearFrpcToken}
                          onChange={(e) => setClearFrpcToken(e.target.checked)}
                        />
                        Clear saved FRP token
                      </label>
                    ) : null}
                  </div>
                </div>
              </div>
            ) : null}

            {provider === "bore" ? (
              <div className="grid grid-cols-1 gap-4 rounded-xl border border-border bg-surface-2/25 p-4 md:grid-cols-3">
                <div>
                  <Label htmlFor="bore-server">Bore Server</Label>
                  <Input
                    id="bore-server"
                    value={boreServer}
                    onChange={(e) => setBoreServer(e.target.value)}
                    placeholder="bore.pub"
                  />
                </div>
                <div>
                  <Label htmlFor="bore-port">Remote Port (0 = random)</Label>
                  <Input
                    id="bore-port"
                    type="number"
                    min={0}
                    max={65535}
                    value={boreRemotePort}
                    onChange={(e) => setBoreRemotePort(e.target.value)}
                    placeholder="0"
                  />
                </div>
                <div>
                  <div className="mb-1 flex items-center gap-2">
                    <Label htmlFor="bore-secret">Bore Secret (optional)</Label>
                    {settings.has_bore_secret ? (
                      <Badge tone="success">Saved</Badge>
                    ) : null}
                  </div>
                  <Input
                    id="bore-secret"
                    type="password"
                    autoComplete="off"
                    value={boreSecret}
                    onChange={(e) => setBoreSecret(e.target.value)}
                    placeholder={
                      settings.has_bore_secret
                        ? "Leave blank to keep saved secret"
                        : "Server authentication secret"
                    }
                  />
                  {settings.has_bore_secret ? (
                    <label className="mt-2 inline-flex cursor-pointer items-center gap-2 text-xs text-muted-foreground">
                      <input
                        type="checkbox"
                        checked={clearBoreSecret}
                        onChange={(e) => setClearBoreSecret(e.target.checked)}
                      />
                      Clear saved secret
                    </label>
                  ) : null}
                </div>
              </div>
            ) : null}

            <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
              <Button
                type="submit"
                name="intent"
                value="save"
                size="sm"
                variant="secondary"
                disabled={isBusy}
              >
                {formIntent === "save" ? <Spinner size={13} /> : <Save size={13} aria-hidden="true" />}
                Save Configuration
              </Button>
              <Button
                type="submit"
                name="intent"
                value="start"
                size="sm"
                variant="primary"
                disabled={isBusy}
              >
                {formIntent === "start" ? <Spinner size={13} /> : <Play size={13} aria-hidden="true" />}
                Save & Start Tunnel
              </Button>
              {isActiveState ? (
                <Button
                  type="submit"
                  name="intent"
                  value="stop"
                  size="sm"
                  variant="danger"
                  disabled={isBusy}
                >
                  {formIntent === "stop" ? <Spinner size={13} /> : <Square size={13} aria-hidden="true" />}
                  Stop Tunnel
                </Button>
              ) : null}
              <input type="hidden" name="save_first" value="1" />
            </div>
          </Form>
        </Card>
      </div>

      {/* Live Tunnel Console */}
      <Card>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold text-foreground">
              Live Tunnel Console
            </h2>
            <p className="text-xs text-muted-foreground">
              {liveStatus.pid
                ? `Process PID ${liveStatus.pid} (auto-refreshes every 2.5s while active)`
                : "Recent output from tunnel processes (tokens redacted)"}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => void pollStatus()}
            >
              <RefreshCw size={13} aria-hidden="true" />
              Refresh
            </Button>
            <consoleFetcher.Form method="post">
              <input type="hidden" name="intent" value="clear_logs" />
              <Button
                type="submit"
                size="sm"
                variant="ghost"
                disabled={liveStatus.logs.length === 0}
              >
                <Trash2 size={13} aria-hidden="true" />
                Clear
              </Button>
            </consoleFetcher.Form>
          </div>
        </div>

        {liveStatus.logs.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border bg-surface-2/25 px-4 py-8 text-center text-xs text-muted-foreground">
            No tunnel log output yet. Download a binary above and click Start Tunnel to see live connection logs.
          </div>
        ) : (
          <div className="max-h-72 overflow-y-auto rounded-lg border border-border bg-surface-2/40 p-3 font-mono text-[11px] leading-relaxed">
            {liveStatus.logs.map((entry, idx) => (
              <div key={`${entry.ts}-${idx}`} className="flex gap-2 break-all">
                <span className="shrink-0 text-muted-foreground/70">
                  {entry.ts.slice(11, 19)}
                </span>
                <span
                  className={
                    entry.stream === "stderr"
                      ? "text-warning"
                      : entry.stream === "system"
                        ? "text-info"
                        : "text-foreground"
                  }
                >
                  {entry.line}
                </span>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
