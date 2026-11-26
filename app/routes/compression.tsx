import { useEffect, useRef, useState } from "react";
import { Form, useFetcher, useNavigation } from "react-router";
import type { Route } from "./+types/compression";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Download,
  ExternalLink,
  FileArchive,
  Play,
  RefreshCw,
  Save,
  ShieldCheck,
  Terminal,
  Trash2,
} from "lucide-react";
import { requireLoaderSession, requireSession } from "../.server/auth";
import {
  getSettings,
  getToolsStatus,
  saveSettings,
  testCompression,
  type TestCompressionResult,
} from "../.server/compressor";
import {
  downloadTool,
  managedBinaryPath,
  uninstallTool,
  type CompressorToolId,
  type DownloadToolResult,
  type ToolStatus,
} from "../.server/compressor-tools";
import {
  CAVEMAN_TYPES,
  CAVEMAN_VOICES,
  COMPRESSION_SCOPES,
  RTK_FILTERS,
  type CavemanVoice,
  type CompressionScope,
} from "../lib/compression-options";
import { PageHeader } from "../components/ui/page-header";
import { Card } from "../components/ui/card";
import { StatCard } from "../components/ui/stat-card";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { DownloadProgressBar } from "../components/download-progress-bar";
import { CopyButton } from "../components/ui/copy-button";
import { Input, Label, Select, Textarea } from "../components/ui/field";
import { Toggle } from "../components/ui/toggle";
import { Spinner } from "../components/ui/feedback";
import { useConfirm } from "../components/ui/confirm-dialog";
import { useToast } from "../components/ui/toast";

export function meta() {
  return [{ title: "Compression | UniRoute" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  requireLoaderSession(request);
  const settings = getSettings();
  const tools = await getToolsStatus();
  return {
    settings,
    tools,
    platform: process.platform,
    arch: process.arch,
  };
}

type ActionResult =
  | { ok: true; saved: true }
  | { ok: true; downloaded: DownloadToolResult }
  | { ok: true; uninstalled: { tool: CompressorToolId; path: string; removed: boolean } }
  | { ok: true; test: TestCompressionResult; sample: string }
  | { ok: false; error: string; tool?: CompressorToolId };

export async function action({ request }: Route.ActionArgs) {
  const denied = requireSession(request);
  if (denied) return denied;

  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "download") {
    const rawTool = String(form.get("tool") ?? "");
    if (rawTool !== "rtk" && rawTool !== "caveman") {
      return Response.json(
        { ok: false, error: "Unknown compressor tool." } satisfies ActionResult,
        { status: 400 },
      );
    }
    try {
      const downloaded = await downloadTool(rawTool);
      // Point DB path to the freshly downloaded external binary so any legacy
      // stub path (./bin/rtk) is immediately upgraded.
      if (rawTool === "rtk") {
        saveSettings({ rtk_binary_path: downloaded.binaryPath });
      } else {
        saveSettings({ caveman_binary_path: downloaded.binaryPath });
      }
      return { ok: true, downloaded } satisfies ActionResult;
    } catch (err) {
      return Response.json(
        {
          ok: false,
          tool: rawTool,
          error: err instanceof Error ? err.message : "Download failed.",
        } satisfies ActionResult,
        { status: 500 },
      );
    }
  }

  if (intent === "uninstall") {
    const rawTool = String(form.get("tool") ?? "");
    if (rawTool !== "rtk" && rawTool !== "caveman") {
      return Response.json(
        { ok: false, error: "Unknown compressor tool." } satisfies ActionResult,
        { status: 400 },
      );
    }
    try {
      const managed = managedBinaryPath(rawTool);
      const removed = uninstallTool(rawTool);
      const cur = getSettings();
      if (
        rawTool === "rtk" &&
        cur.rtk_binary_path.toLowerCase() === managed.toLowerCase()
      ) {
        saveSettings({ rtk_binary_path: "", rtk_enabled: false });
      } else if (
        rawTool === "caveman" &&
        cur.caveman_binary_path.toLowerCase() === managed.toLowerCase()
      ) {
        saveSettings({ caveman_binary_path: "", caveman_enabled: false });
      }
      return {
        ok: true,
        uninstalled: { tool: rawTool, ...removed },
      } satisfies ActionResult;
    } catch (err) {
      return Response.json(
        {
          ok: false,
          tool: rawTool,
          error: err instanceof Error ? err.message : "Uninstall failed.",
        } satisfies ActionResult,
        { status: 500 },
      );
    }
  }

  if (intent === "test") {
    const sample = String(form.get("sample") ?? "");
    const result = await testCompression(sample);
    return { ok: true, test: result, sample } satisfies ActionResult;
  }

  if (intent === "save") {
    saveSettings({
      rtk_enabled: form.get("rtk_enabled") === "1",
      caveman_enabled: form.get("caveman_enabled") === "1",
      rtk_binary_path: String(form.get("rtk_binary_path") ?? "").trim(),
      caveman_binary_path: String(form.get("caveman_binary_path") ?? "").trim(),
      rtk_filter: String(form.get("rtk_filter") ?? "auto"),
      caveman_type: String(form.get("caveman_type") ?? "auto"),
      caveman_voice: String(form.get("caveman_voice") ?? "off") as CavemanVoice,
      scope: String(form.get("scope") ?? "tool_and_last") as CompressionScope,
      min_chars: Number(form.get("min_chars") ?? 400),
      timeout_ms: Number(form.get("timeout_ms") ?? 5000),
      never_worse: form.get("never_worse") === "1",
    });
    return { ok: true, saved: true } satisfies ActionResult;
  }

  return Response.json(
    { ok: false, error: "Unknown intent." } satisfies ActionResult,
    { status: 400 },
  );
}

/* ------------------------------- Presets ---------------------------------- */

const SAMPLE_PRESETS: { id: string; label: string; sample: string }[] = [
  {
    id: "json",
    label: "JSON Tool Output",
    sample: JSON.stringify(
      {
        status: "ok",
        service: "uniroute-gateway",
        timestamp: "2026-11-24T08:00:00Z",
        items: Array.from({ length: 14 }, (_, i) => ({
          id: `req_${1000 + i}`,
          provider: i % 2 === 0 ? "openai" : "anthropic",
          model: i % 2 === 0 ? "gpt-5.4-mini" : "claude-sonnet-4-6",
          region: "us-east-1",
          status: i === 11 ? "rate_limited" : "success",
          latency_ms: 145 + i * 19,
          prompt_tokens: 1200 + i * 40,
          completion_tokens: 280 + i * 15,
          cached: i % 3 === 0,
          retries: i === 11 ? 2 : 0,
          metadata: {
            environment: "production",
            cluster: "edge-primary-01",
            compression_enabled: true,
          },
        })),
      },
      null,
      2,
    ),
  },
  {
    id: "pytest",
    label: "Test Runner Log",
    sample: [
      "============================= test session starts ==============================",
      "platform linux -- Python 3.12.3, pytest-8.3.2, pluggy-1.5.0",
      "rootdir: /workspace/uniroute-sdk",
      "collected 12 items",
      "",
      "tests/test_router.py ........                                            [ 66%]",
      "tests/test_auth.py ...F                                                  [100%]",
      "",
      "=================================== FAILURES ===================================",
      "_________________________ test_expired_token_rejected __________________________",
      "",
      "    def test_expired_token_rejected():",
      "        res = client.post('/v1/chat/completions', headers={'Authorization': 'Bearer sk-expired'})",
      ">       assert res.status_code == 403",
      "E       AssertionError: assert 401 == 403",
      "E        +  where 401 = <Response [401 Unauthorized]>.status_code",
      "",
      "tests/test_auth.py:48: AssertionError",
      "=========================== short test summary info ============================",
      "FAILED tests/test_auth.py::test_expired_token_rejected - AssertionError: assert 401 == 403",
      "========================= 1 failed, 11 passed in 1.82s =========================",
    ].join("\n"),
  },
  {
    id: "logs",
    label: "Application Logs",
    sample: [
      "2026-11-24T08:01:01.102Z INFO  [gateway] Request started id=101 provider=openai model=gpt-5.4",
      "2026-11-24T08:01:01.114Z DEBUG [pool] Selected upstream proxy 10.0.4.12:8080 (round_robin)",
      "2026-11-24T08:01:01.422Z INFO  [gateway] Request completed id=101 status=200 latency=320ms",
      "2026-11-24T08:01:02.011Z INFO  [gateway] Request started id=102 provider=openai model=gpt-5.4",
      "2026-11-24T08:01:02.020Z DEBUG [pool] Selected upstream proxy 10.0.4.13:8080 (round_robin)",
      "2026-11-24T08:01:02.318Z INFO  [gateway] Request completed id=102 status=200 latency=307ms",
      "2026-11-24T08:01:03.110Z INFO  [gateway] Request started id=103 provider=openai model=gpt-5.4",
      "2026-11-24T08:01:03.118Z DEBUG [pool] Selected upstream proxy 10.0.4.14:8080 (round_robin)",
      "2026-11-24T08:01:03.402Z INFO  [gateway] Request completed id=103 status=200 latency=292ms",
      "2026-11-24T08:01:04.500Z ERROR [upstream] Timeout waiting for response from 10.0.4.15:8080 after 5000ms",
      "2026-11-24T08:01:04.501Z WARN  [combo] Falling back from primary step 1 to step 2 (anthropic)",
      "2026-11-24T08:01:04.980Z INFO  [gateway] Request completed id=104 status=200 latency=5480ms",
    ].join("\n"),
  },
  {
    id: "grep",
    label: "Grep Matches",
    sample: [
      "app/.server/proxy-handler.ts:17:import { compress, isEnabled } from './compressor';",
      "app/.server/proxy-handler.ts:302:const compression = isEnabled();",
      "app/.server/proxy-handler.ts:310:const { output, usedFallback, durationMs } = await compress(text);",
      "app/.server/compressor.ts:124:export function getSettings(): CompressionSettings {",
      "app/.server/compressor.ts:152:export function saveSettings(patch: Partial<CompressionSettings>) {",
      "app/.server/compressor.ts:365:export async function compress(prompt: string): Promise<CompressResult> {",
      "app/.server/compressor.ts:375:export async function testCompression(sample: string): Promise<TestCompressionResult> {",
      "app/routes/compression.tsx:41:export function loader() {",
      "app/routes/compression.tsx:61:export async function action({ request }: Route.ActionArgs) {",
    ].join("\n"),
  },
];

function fmtBytes(n: number | null): string {
  if (n == null) return "-";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function sourceLabel(tool: ToolStatus): string {
  switch (tool.source) {
    case "managed":
      return "Downloaded (~/.uniroute/bin)";
    case "path":
      return "Detected on system PATH";
    case "custom":
      return "Custom binary path";
    case "stub":
      return "Legacy mock stub (passthrough only)";
    case "missing":
      return "Not downloaded yet";
  }
}

/* ------------------------------- ToolCard --------------------------------- */

function ToolCard({
  tool,
  confirm,
}: {
  tool: ToolStatus;
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
    ? tool.kind === "custom"
      ? "info"
      : "success"
    : tool.isStub
      ? "warning"
      : "neutral";

  const badgeText = tool.installed
    ? tool.version
      ? `Installed v${tool.version}`
      : "Installed"
    : tool.isStub
      ? "Mock stub"
      : "Not installed";

  return (
    <Card className="flex flex-col justify-between gap-4">
      <div>
        <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-semibold text-foreground">{tool.name}</h2>
            <Badge tone={badgeTone} dot={tool.installed}>
              {badgeText}
            </Badge>
            <Badge tone="neutral">{tool.license}</Badge>
          </div>
          <a
            href={tool.repoUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            GitHub <ExternalLink size={12} aria-hidden="true" />
          </a>
        </div>

        <p className="text-xs leading-relaxed text-muted-foreground">{tool.tagline}</p>

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

        {tool.isStub ? (
          <div className="mt-3 flex items-start gap-2 rounded-lg border border-warning/35 bg-warning/10 px-3 py-2 text-xs text-warning">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
            <span>
              Currently pointing at the legacy mock stub ({tool.configuredPath}), which passes
              text through unchanged. Download the official binary below to enable real compression.
            </span>
          </div>
        ) : null}
      </div>

      <div className="space-y-3 border-t border-border pt-3">
        <DownloadProgressBar
          progressKey={`compressor:${tool.id}`}
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
                  : "Download from GitHub"}
            </Button>
          </fetcher.Form>

          {tool.isManaged ? (
            <Button
              type="button"
              size="sm"
              variant="danger"
              disabled={busy}
              onClick={async () => {
                const ok = await confirm({
                  title: `Remove downloaded ${tool.name}?`,
                  description: `Deletes ${tool.managedPath} from your machine. You can download it again anytime.`,
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

          <a
            href={tool.releasesUrl}
            target="_blank"
            rel="noreferrer"
            className="ml-auto inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            Releases <ExternalLink size={11} aria-hidden="true" />
          </a>
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
                  <p className="text-[11px] font-medium text-muted-foreground">{cmd.label}</p>
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

/* ------------------------------ Main Page --------------------------------- */

export default function Compression({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const { settings, tools, platform, arch } = loaderData;
  const { dialog, confirm } = useConfirm();
  const { toast } = useToast();
  const navigation = useNavigation();
  const testFetcher = useFetcher<ActionResult>();

  const [rtkEnabled, setRtkEnabled] = useState(settings.rtk_enabled);
  const [cavemanEnabled, setCavemanEnabled] = useState(settings.caveman_enabled);
  const [rtkPath, setRtkPath] = useState(settings.rtk_binary_path);
  const [cavemanPath, setCavemanPath] = useState(settings.caveman_binary_path);
  const [rtkFilter, setRtkFilter] = useState(settings.rtk_filter);
  const [cavemanType, setCavemanType] = useState(settings.caveman_type);
  const [cavemanVoice, setCavemanVoice] = useState<CavemanVoice>(
    settings.caveman_voice,
  );
  const [scope, setScope] = useState<CompressionScope>(settings.scope);
  const [minChars, setMinChars] = useState(String(settings.min_chars));
  const [timeoutMs, setTimeoutMs] = useState(String(settings.timeout_ms));
  const [neverWorse, setNeverWorse] = useState(settings.never_worse);
  const [sample, setSample] = useState(SAMPLE_PRESETS[0]!.sample);

  useEffect(() => {
    setRtkEnabled(settings.rtk_enabled);
    setCavemanEnabled(settings.caveman_enabled);
    setRtkPath(settings.rtk_binary_path);
    setCavemanPath(settings.caveman_binary_path);
    setRtkFilter(settings.rtk_filter);
    setCavemanType(settings.caveman_type);
    setCavemanVoice(settings.caveman_voice);
    setScope(settings.scope);
    setMinChars(String(settings.min_chars));
    setTimeoutMs(String(settings.timeout_ms));
    setNeverWorse(settings.never_worse);
  }, [
    settings.rtk_enabled,
    settings.caveman_enabled,
    settings.rtk_binary_path,
    settings.caveman_binary_path,
    settings.rtk_filter,
    settings.caveman_type,
    settings.caveman_voice,
    settings.scope,
    settings.min_chars,
    settings.timeout_ms,
    settings.never_worse,
  ]);

  const saving =
    navigation.state !== "idle" && navigation.formData?.get("intent") === "save";
  const testing = testFetcher.state !== "idle";
  const testData =
    testFetcher.data && testFetcher.data.ok && "test" in testFetcher.data
      ? testFetcher.data.test
      : null;

  const lastActionRef = useRef<unknown>(null);
  useEffect(() => {
    if (!actionData || lastActionRef.current === actionData) return;
    lastActionRef.current = actionData;
    if (actionData.ok && "saved" in actionData) {
      toast({ title: "Compression pipeline saved", variant: "success" });
    } else if (!actionData.ok && "error" in actionData) {
      toast({
        title: "Save failed",
        description: String(actionData.error),
        variant: "error",
      });
    }
  }, [actionData, toast]);

  const activeStages: string[] = [];
  if (settings.rtk_enabled) activeStages.push("RTK");
  if (settings.caveman_enabled) activeStages.push("Caveman");
  if (settings.caveman_voice !== "off") activeStages.push(`Voice:${settings.caveman_voice}`);
  const pipelineSummary =
    activeStages.length > 0 ? activeStages.join(" + ") : "Disabled";

  return (
    <div>
      <PageHeader
        title="Compression"
        icon={<FileArchive size={20} />}
        subtitle="Download RTK and Caveman Engine directly (no GitHub API auth required, VPS-safe) and apply prompt + output compression globally."
      />

      {/* Top Status KPIs */}
      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard
          title="Global Pipeline"
          value={pipelineSummary}
          accent={
            activeStages.length > 0 ? "bg-success" : "bg-muted-foreground/40"
          }
          icon={<ShieldCheck size={16} />}
          subline={`Applies globally · ${platform}/${arch} (not bundled)`}
        />
        <StatCard
          title="RTK Binary"
          value={
            tools.rtk.installed
              ? tools.rtk.version
                ? `v${tools.rtk.version}`
                : "Installed"
              : tools.rtk.isStub
                ? "Mock stub"
                : "Not installed"
          }
          accent={
            tools.rtk.installed
              ? "bg-success"
              : tools.rtk.isStub
                ? "bg-warning"
                : "bg-muted-foreground/40"
          }
          icon={<CheckCircle2 size={16} />}
          subline={sourceLabel(tools.rtk)}
        />
        <StatCard
          title="Caveman Engine"
          value={
            tools.caveman.installed
              ? tools.caveman.version
                ? `v${tools.caveman.version}`
                : "Installed"
              : tools.caveman.isStub
                ? "Mock stub"
                : "Not installed"
          }
          accent={
            tools.caveman.installed
              ? "bg-success"
              : tools.caveman.isStub
                ? "bg-warning"
                : "bg-muted-foreground/40"
          }
          icon={<CheckCircle2 size={16} />}
          subline={sourceLabel(tools.caveman)}
        />
      </div>

      {/* External Binaries Download & Management */}
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          External Binaries (Direct Releases · No GitHub API / Auth · SHA-256 Verified)
        </p>
        <span className="font-mono text-[11px] text-muted-foreground">
          Managed dir: {tools.toolsDir}
        </span>
      </div>
      <div className="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ToolCard tool={tools.rtk} confirm={confirm} />
        <ToolCard tool={tools.caveman} confirm={confirm} />
      </div>

      {/* Pipeline Configuration */}
      <Card className="mb-6">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold text-foreground">
              Global Gateway Compression Pipeline
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Applies globally to all requests on{" "}
              <code className="font-mono">/v1/chat/completions</code>,{" "}
              <code className="font-mono">/v1/messages</code>,{" "}
              <code className="font-mono">/v1/responses</code>, and Model Combos. Timeouts or binary
              errors always fail open to the original prompt.
            </p>
          </div>
          <div className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface-2/50 px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
            <span>Prompt</span>
            <ArrowRight size={11} aria-hidden="true" />
            <span className={rtkEnabled ? "text-foreground" : ""}>RTK</span>
            <ArrowRight size={11} aria-hidden="true" />
            <span className={cavemanEnabled ? "text-foreground" : ""}>Caveman</span>
            <ArrowRight size={11} aria-hidden="true" />
            <span className={cavemanVoice !== "off" ? "text-foreground" : ""}>Voice</span>
            <ArrowRight size={11} aria-hidden="true" />
            <span>Upstream</span>
          </div>
        </div>

        <Form method="post" className="space-y-4">
          <input type="hidden" name="intent" value="save" />
          <input type="hidden" name="rtk_enabled" value={rtkEnabled ? "1" : "0"} />
          <input type="hidden" name="caveman_enabled" value={cavemanEnabled ? "1" : "0"} />
          <input type="hidden" name="never_worse" value={neverWorse ? "1" : "0"} />

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {/* Stage 1: RTK */}
            <div className="space-y-3 rounded-xl border border-border bg-surface-2/35 p-4">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Stage 1 · Input Filter
                  </p>
                  <p className="text-sm font-semibold text-foreground">RTK Pipe Filter</p>
                </div>
                <Toggle
                  checked={rtkEnabled}
                  label="Enable RTK"
                  onChange={setRtkEnabled}
                />
              </div>

              {rtkEnabled && !tools.rtk.installed ? (
                <p className="rounded-lg border border-warning/35 bg-warning/10 px-2.5 py-1.5 text-xs text-warning">
                  RTK is enabled, but no official binary is installed yet. Download RTK above or set a valid path.
                </p>
              ) : null}

              <div>
                <Label htmlFor="rtk_filter">RTK pipe filter mode (24 filters)</Label>
                <Select
                  id="rtk_filter"
                  name="rtk_filter"
                  controlSize="sm"
                  value={rtkFilter}
                  onChange={(e) => setRtkFilter(e.target.value)}
                >
                  {RTK_FILTERS.map((f) => (
                    <option key={f.value} value={f.value}>
                      {f.label}
                    </option>
                  ))}
                </Select>
              </div>

              <div>
                <Label htmlFor="rtk_path">Binary path override (optional)</Label>
                <Input
                  id="rtk_path"
                  name="rtk_binary_path"
                  controlSize="sm"
                  value={rtkPath}
                  onChange={(e) => setRtkPath(e.target.value)}
                  placeholder="Leave blank to auto-detect (~/.uniroute/bin or PATH)"
                  className="font-mono"
                />
              </div>
            </div>

            {/* Stage 2: Caveman */}
            <div className="space-y-3 rounded-xl border border-border bg-surface-2/35 p-4">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Stage 2 · Context &amp; Output
                  </p>
                  <p className="text-sm font-semibold text-foreground">Caveman Engine &amp; Voice</p>
                </div>
                <Toggle
                  checked={cavemanEnabled}
                  label="Enable Caveman Engine"
                  onChange={setCavemanEnabled}
                />
              </div>

              {cavemanEnabled && !tools.caveman.installed ? (
                <p className="rounded-lg border border-warning/35 bg-warning/10 px-2.5 py-1.5 text-xs text-warning">
                  Caveman Engine is enabled, but no official binary is installed yet. Download Caveman above or set a valid path.
                </p>
              ) : null}

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <Label htmlFor="caveman_type">Input compressor type</Label>
                  <Select
                    id="caveman_type"
                    name="caveman_type"
                    controlSize="sm"
                    value={cavemanType}
                    onChange={(e) => setCavemanType(e.target.value)}
                  >
                    {CAVEMAN_TYPES.map((t) => (
                      <option key={t.value} value={t.value}>
                        {t.label}
                      </option>
                    ))}
                  </Select>
                </div>

                <div>
                  <Label htmlFor="caveman_voice">Output voice directive</Label>
                  <Select
                    id="caveman_voice"
                    name="caveman_voice"
                    controlSize="sm"
                    value={cavemanVoice}
                    onChange={(e) => setCavemanVoice(e.target.value as CavemanVoice)}
                  >
                    {CAVEMAN_VOICES.map((v) => (
                      <option key={v.value} value={v.value}>
                        {v.label}
                      </option>
                    ))}
                  </Select>
                </div>
              </div>

              <div>
                <Label htmlFor="caveman_path">Binary path override (optional)</Label>
                <Input
                  id="caveman_path"
                  name="caveman_binary_path"
                  controlSize="sm"
                  value={cavemanPath}
                  onChange={(e) => setCavemanPath(e.target.value)}
                  placeholder="Leave blank to auto-detect (~/.uniroute/bin or PATH)"
                  className="font-mono"
                />
              </div>
            </div>
          </div>

          {/* Global Scope & Guardrails */}
          <div className="rounded-xl border border-border bg-surface-2/25 p-4">
            <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Global Scope &amp; Guardrails
            </p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div className="sm:col-span-2">
                <Label htmlFor="compression_scope">Messages compressed per request</Label>
                <Select
                  id="compression_scope"
                  name="scope"
                  controlSize="sm"
                  value={scope}
                  onChange={(e) => setScope(e.target.value as CompressionScope)}
                >
                  {COMPRESSION_SCOPES.map((s) => (
                    <option key={s.value} value={s.value}>
                      {s.label}
                    </option>
                  ))}
                </Select>
              </div>
              <div>
                <Label htmlFor="min_chars">Min chars threshold</Label>
                <Input
                  id="min_chars"
                  name="min_chars"
                  type="number"
                  min={0}
                  max={100000}
                  step={50}
                  controlSize="sm"
                  value={minChars}
                  onChange={(e) => setMinChars(e.target.value)}
                />
              </div>
              <div>
                <Label htmlFor="timeout_ms">Timeout per stage (ms)</Label>
                <Input
                  id="timeout_ms"
                  name="timeout_ms"
                  type="number"
                  min={1000}
                  max={30000}
                  step={500}
                  controlSize="sm"
                  value={timeoutMs}
                  onChange={(e) => setTimeoutMs(e.target.value)}
                />
              </div>
            </div>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border/70 pt-3">
              <div>
                <p className="text-xs font-medium text-foreground">Never-worse guard</p>
                <p className="text-[11px] text-muted-foreground">
                  Automatically keep the original message whenever compressed output is not smaller.
                </p>
              </div>
              <Toggle
                checked={neverWorse}
                label="Never-worse guard"
                onChange={setNeverWorse}
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" disabled={saving}>
              {saving ? <Spinner size={14} /> : <Save size={14} aria-hidden="true" />}
              {saving ? "Saving..." : "Save pipeline settings"}
            </Button>
            {(rtkPath || cavemanPath) ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setRtkPath("");
                  setCavemanPath("");
                }}
              >
                Reset paths to auto-detect
              </Button>
            ) : null}
          </div>
        </Form>
      </Card>

      {/* Compression Test Lab */}
      <Card>
        <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-foreground">Compression Test Lab</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Run realistic payloads through your saved pipeline and inspect exact character/token savings per stage.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {SAMPLE_PRESETS.map((preset) => (
              <Button
                key={preset.id}
                type="button"
                size="sm"
                variant="outline"
                onClick={() => setSample(preset.sample)}
              >
                {preset.label}
              </Button>
            ))}
          </div>
        </div>

        <testFetcher.Form method="post">
          <input type="hidden" name="intent" value="test" />
          <Label htmlFor="sample">Sample payload ({sample.length.toLocaleString()} chars)</Label>
          <Textarea
            id="sample"
            name="sample"
            rows={6}
            value={sample}
            onChange={(e) => setSample(e.target.value)}
            className="font-mono text-xs"
          />
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button type="submit" variant="secondary" disabled={testing || !sample.trim()}>
              {testing ? <Spinner size={14} /> : <Play size={14} aria-hidden="true" />}
              {testing ? "Running pipeline..." : "Run compression test"}
            </Button>
            <span className="text-xs text-muted-foreground">
              Tests against currently saved settings ({pipelineSummary}).
            </span>
          </div>
        </testFetcher.Form>

        {testData ? (
          <div className="mt-4 space-y-3 rounded-xl border border-border bg-surface-2/40 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2">
                {!testData.settings.rtk_enabled && !testData.settings.caveman_enabled ? (
                  <Badge tone="neutral" dot>
                    Bypassed (pipeline disabled)
                  </Badge>
                ) : testData.usedFallback ? (
                  <Badge tone="warning" dot>
                    Fallback used
                  </Badge>
                ) : testData.savedChars > 0 ? (
                  <Badge tone="success" dot>
                    Compressed (-{testData.savedPct}%)
                  </Badge>
                ) : (
                  <Badge tone="info" dot>
                    No reduction (passthrough)
                  </Badge>
                )}
                <Badge tone="neutral">{testData.durationMs}ms</Badge>
                <span className="font-mono text-xs text-muted-foreground">
                  {testData.inputChars.toLocaleString()} -&gt; {testData.outputChars.toLocaleString()} chars
                </span>
              </div>
              <CopyButton text={testData.output} label="Copy output" />
            </div>

            {testData.error ? (
              <p className="rounded-lg border border-warning/35 bg-warning/10 px-3 py-2 text-xs text-warning">
                {testData.error}
              </p>
            ) : null}

            {testData.stages.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {testData.stages.map((st) => (
                  <div
                    key={st.tool}
                    className="rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs"
                  >
                    <span className="font-semibold uppercase text-foreground">{st.tool}</span>
                    <span className="mx-1.5 text-muted-foreground">
                      ({st.detectedType || st.mode})
                    </span>
                    <span className="font-mono text-muted-foreground">
                      {st.tokensBefore != null && st.tokensAfter != null
                        ? `${st.tokensBefore} -> ${st.tokensAfter} tok`
                        : `${st.inputChars} -> ${st.outputChars} chars`}
                    </span>
                    {st.savedPct > 0 ? (
                      <span className="ml-1.5 font-mono font-semibold text-success">
                        -{st.savedPct}%
                      </span>
                    ) : null}
                    <span className="ml-1.5 text-[11px] text-muted-foreground">
                      · {st.durationMs}ms
                    </span>
                  </div>
                ))}
              </div>
            ) : null}

            {testData.voiceDirective ? (
              <div className="rounded-lg border border-primary/30 bg-primary/10 px-3 py-2 text-xs">
                <p className="font-semibold text-primary">
                  Active Caveman Output Voice ({testData.settings.caveman_voice})
                </p>
                <p className="mt-0.5 text-muted-foreground">
                  Injected globally into system prompt: {testData.voiceDirective}
                </p>
              </div>
            ) : null}

            <pre className="slim-scroll max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-surface p-3 font-mono text-xs text-foreground">
              {testData.output}
            </pre>
          </div>
        ) : null}
      </Card>

      {dialog}
    </div>
  );
}
