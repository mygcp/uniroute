import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useFetcher, useLoaderData } from "react-router";
import type { Route } from "./+types/mcp";
import {
  Cable,
  ExternalLink,
  Eye,
  EyeOff,
  Globe,
  KeyRound,
  Play,
  RotateCw,
  Search,
  Server,
  Terminal,
  Wrench,
} from "lucide-react";
import { PageHeader } from "../components/ui/page-header";
import { Card } from "../components/ui/card";
import { MetricStrip } from "../components/ui/stat-card";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import { Input, Select } from "../components/ui/field";
import { Tabs } from "../components/ui/tabs";
import { Toggle } from "../components/ui/toggle";
import { CopyButton } from "../components/ui/copy-button";
import { Spinner } from "../components/ui/feedback";
import { Table, TCell, THead, THeadCell, TRow } from "../components/ui/table";
import { useConfirm } from "../components/ui/confirm-dialog";
import { useToast } from "../components/ui/toast";

export function meta() {
  return [{ title: "MCP Server | UniRoute" }];
}

/* --------------------------------- loader --------------------------------- */

type ToolInfo = {
  name: string;
  description: string;
  category: string;
  args: string[];
};

const CATEGORY_BY_TOOL: Record<string, string> = {
  gateway_stats: "Monitoring",
  usage_summary: "Monitoring",
  recent_requests: "Monitoring",
  recent_proxy_logs: "Monitoring",
  recent_webhooks: "Monitoring",
  compression_settings: "Monitoring",
  list_providers: "Providers & models",
  get_provider: "Providers & models",
  create_provider: "Providers & models",
  update_provider: "Providers & models",
  delete_provider: "Providers & models",
  list_provider_keys: "Providers & models",
  add_provider_key: "Providers & models",
  delete_provider_key: "Providers & models",
  set_provider_routing_key: "Providers & models",
  toggle_provider_key: "Providers & models",
  toggle_provider: "Providers & models",
  test_provider_connection: "Providers & models",
  list_models: "Providers & models",
  add_model: "Providers & models",
  remove_model: "Providers & models",
  set_primary_model: "Providers & models",
  sync_models: "Providers & models",
  create_routing_rule: "Providers & models",
  list_routing_rules: "Providers & models",
  delete_routing_rule: "Providers & models",
  allow_model: "Providers & models",
  deny_model: "Providers & models",
  check_model_allowed: "Providers & models",
  list_proxies: "Proxy engine",
  add_proxy: "Proxy engine",
  toggle_proxy: "Proxy engine",
  delete_proxy: "Proxy engine",
  update_pool: "Proxy engine",
  delete_pool: "Proxy engine",
  assign_provider_proxy: "Proxy engine",
  unassign_provider_proxy: "Proxy engine",
  assign_key_proxy: "Proxy engine",
  unassign_key_proxy: "Proxy engine",
  list_client_keys: "Client keys",
  create_client_key: "Client keys",
  toggle_client_key: "Client keys",
  get_client_key: "Client keys",
  set_key_budget: "Client keys",
  rotate_client_key: "Client keys",
  chat_completion: "Other",
  set_compression: "Other",
  test_compression: "Other",
  get_prompt_guard: "Other",
  set_prompt_guard: "Other",
  test_prompt_guard: "Other",
  clear_logs: "Other",
  tunnel_status: "Tunneling",
  start_tunnel: "Tunneling",
  stop_tunnel: "Tunneling",
};

const CATEGORY_ORDER = [
  "Monitoring",
  "Providers & models",
  "Proxy engine",
  "Client keys",
  "Tunneling",
  "Other",
];

export async function loader({ request }: Route.LoaderArgs) {
  const { requireLoaderSession } = await import("../.server/auth");
  requireLoaderSession(request);
  const [
    { HARNESS_REGISTRY, defaultMcpCommand, isMcpInstalled },
    { TOOLS },
    { getRemoteMcpStatus },
    { getActiveTunnelUrl, resolveGatewayOrigin },
  ] = await Promise.all([
    import("../.server/agents-config"),
    import("../.server/mcp-tools"),
    import("../.server/mcp-http"),
    import("../.server/tunnel"),
  ]);
  const command = defaultMcpCommand();
  const cmdStr = command
    .map((part) => (/\s/.test(part) ? `"${part.replace(/"/g, '\\"')}"` : part))
    .join(" ");
  const tunnelUrl = getActiveTunnelUrl();
  const origin = resolveGatewayOrigin(request);
  const remoteEndpoint = `${origin}/api/mcp`;
  const reqUrl = new URL(request.url);
  const localPort = Number(process.env.PORT ?? reqUrl.port) || 3000;
  const localEndpoint = `http://127.0.0.1:${localPort}/api/mcp`;
  const remote = getRemoteMcpStatus();

  const tools: ToolInfo[] = TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    category: CATEGORY_BY_TOOL[t.name] ?? "Other",
    args: Object.keys(t.inputSchema?.properties ?? {}),
  }));

  return {
    cmdStr,
    tunnelUrl,
    remoteEndpoint,
    localEndpoint,
    remote,
    tools,
    harnesses: Object.values(HARNESS_REGISTRY).map((h) => ({
      id: h.id,
      name: h.name,
      configPath: h.configPath,
      docsUrl: h.docsUrl,
      installed: isMcpInstalled(h.id),
    })),
    localSnippets: {
      claude: `claude mcp add uniroute -- ${cmdStr}`,
      opencode: JSON.stringify(
        { mcp: { servers: { uniroute: { type: "local", command } } } },
        null,
        2,
      ),
      codex: `[mcp_servers.uniroute]\ncommand = "${(command[0] ?? "bun").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"\nargs = [${command
        .slice(1)
        .map((a) => `"${a.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`)
        .join(", ")}]`,
    },
  };
}

/* --------------------------------- action --------------------------------- */

export async function action({ request }: Route.ActionArgs) {
  const { requireSession } = await import("../.server/auth");
  const denied = requireSession(request);
  if (denied) return denied;

  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "remote-toggle") {
    const { setRemoteMcpEnabled } = await import("../.server/mcp-http");
    const enabled = form.get("enabled") === "1";
    const result = setRemoteMcpEnabled(enabled);
    return {
      ok: true,
      intent,
      enabled: result.enabled,
      revealedToken: result.generatedToken,
    };
  }

  if (intent === "remote-auth") {
    const { setRemoteMcpAuthRequired } = await import("../.server/mcp-http");
    const required = form.get("required") === "1";
    setRemoteMcpAuthRequired(required);
    return { ok: true, intent, required };
  }

  if (intent === "remote-reveal") {
    const { getRemoteMcpToken } = await import("../.server/mcp-http");
    const { token } = getRemoteMcpToken();
    return { ok: true, intent, revealedToken: token };
  }

  if (intent === "remote-rotate") {
    const { rotateRemoteMcpToken } = await import("../.server/mcp-http");
    try {
      const token = rotateRemoteMcpToken();
      return { ok: true, intent, revealedToken: token };
    } catch (err) {
      return Response.json(
        {
          ok: false,
          error: err instanceof Error ? err.message : "Failed to rotate token",
        },
        { status: 400 },
      );
    }
  }

  if (intent === "remote-test") {
    const { getRemoteMcpToken, handleMcpHttpRequest } = await import(
      "../.server/mcp-http"
    );
    const start = Date.now();
    const { token } = getRemoteMcpToken();
    const headers = new Headers({ "Content-Type": "application/json" });
    if (token) headers.set("Authorization", `Bearer ${token}`);
    const probeReq = new Request("http://internal/api/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
      }),
    });
    const res = await handleMcpHttpRequest(probeReq);
    const durationMs = Date.now() - start;
    const payload = (await res.json().catch(() => null)) as
      | { result?: { tools?: unknown[] }; error?: string | { message?: string } }
      | null;
    if (!res.ok) {
      const errMsg =
        typeof payload?.error === "string"
          ? payload.error
          : payload?.error?.message ?? `HTTP ${res.status}`;
      return {
        ok: false,
        intent,
        error: errMsg,
        status: res.status,
        durationMs,
      };
    }
    return {
      ok: true,
      intent,
      status: res.status,
      durationMs,
      toolCount: payload?.result?.tools?.length ?? 0,
    };
  }

  const harness = String(form.get("harness") ?? "");
  const { defaultMcpCommand, installMcp, isHarnessId, removeMcp } =
    await import("../.server/agents-config");
  if (!isHarnessId(harness)) {
    return Response.json({ ok: false, error: "unknown harness" }, { status: 400 });
  }
  try {
    if (intent === "mcp-install") installMcp(harness, defaultMcpCommand());
    else if (intent === "mcp-remove") removeMcp(harness);
    else return Response.json({ ok: false, error: "unknown intent" }, { status: 400 });
    return { ok: true, intent, harness };
  } catch (err) {
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : "Operation failed" },
      { status: 400 },
    );
  }
}

/* ---------------------------------- UI ------------------------------------ */

type SnippetTab =
  | "Claude Code (Remote)"
  | "Codex CLI (Remote)"
  | "OpenCode (Remote)"
  | "Cursor / JSON"
  | "cURL"
  | "Local Stdio";

const SNIPPET_TABS: SnippetTab[] = [
  "Claude Code (Remote)",
  "Codex CLI (Remote)",
  "OpenCode (Remote)",
  "Cursor / JSON",
  "cURL",
  "Local Stdio",
];

type FetcherPayload = {
  ok?: boolean;
  intent?: string;
  harness?: string;
  enabled?: boolean;
  required?: boolean;
  revealedToken?: string | null;
  status?: number;
  durationMs?: number;
  toolCount?: number;
  error?: string;
};

export default function McpPage() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<FetcherPayload>();
  const remoteFetcher = useFetcher<FetcherPayload>();
  const [snippetTab, setSnippetTab] = useState<SnippetTab>("Claude Code (Remote)");
  const [revealedToken, setRevealedToken] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    message: string;
    durationMs: number;
  } | null>(null);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string>("all");
  const { dialog, confirm } = useConfirm();
  const { toast } = useToast();
  const lastMcpRef = useRef<unknown>(undefined);
  const lastRemoteRef = useRef<unknown>(undefined);

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;
    if (lastMcpRef.current === fetcher.data) return;
    lastMcpRef.current = fetcher.data;
    const d = fetcher.data;
    if (!d || typeof d.ok !== "boolean") return;
    if (!d.ok) {
      toast({
        title: "MCP update failed",
        description: d.error ?? "Unknown error",
        variant: "error",
      });
      return;
    }
    if (d.intent === "mcp-install" || d.intent === "mcp-remove") {
      toast({
        title: d.intent === "mcp-install" ? "MCP registered" : "MCP removed",
        description: d.harness ? `Client: ${d.harness}` : undefined,
        variant: "success",
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.data, fetcher.state]);

  useEffect(() => {
    if (remoteFetcher.state !== "idle" || !remoteFetcher.data) return;
    if (lastRemoteRef.current === remoteFetcher.data) return;
    lastRemoteRef.current = remoteFetcher.data;
    const d = remoteFetcher.data;
    if (!d) return;

    if (d.intent === "remote-test") {
      setTestResult({
        ok: Boolean(d.ok),
        message: d.ok
          ? `HTTP ${d.status} OK · ${d.toolCount} tools returned`
          : d.error ?? "Endpoint check failed",
        durationMs: d.durationMs ?? 0,
      });
      return;
    }

    if (d.ok === false) {
      toast({
        title: "Remote MCP action failed",
        description: d.error ?? "Unknown error",
        variant: "error",
      });
      return;
    }

    if (d.intent === "remote-toggle") {
      if (d.revealedToken) setRevealedToken(d.revealedToken);
      toast({
        title: d.enabled
          ? "Remote MCP HTTP server enabled"
          : "Remote MCP HTTP server disabled",
        description: d.enabled ? data.remoteEndpoint : undefined,
        variant: "success",
      });
    } else if (d.intent === "remote-auth") {
      toast({
        title: d.required
          ? "Bearer token authentication enabled"
          : "Bearer token authentication disabled",
        variant: d.required ? "success" : "warning",
      });
    } else if (d.intent === "remote-reveal") {
      setRevealedToken(d.revealedToken ?? null);
    } else if (d.intent === "remote-rotate") {
      if (d.revealedToken) setRevealedToken(d.revealedToken);
      toast({
        title: "MCP bearer token rotated",
        description: "Update remote agent configs with the new token.",
        variant: "success",
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remoteFetcher.data, remoteFetcher.state]);

  const busyHarness =
    fetcher.state !== "idle"
      ? String(fetcher.formData?.get("harness") ?? "")
      : null;
  const remoteBusy = remoteFetcher.state !== "idle";
  const remoteIntent = remoteBusy
    ? String(remoteFetcher.formData?.get("intent") ?? "")
    : null;

  const registeredCount = data.harnesses.filter((h) => h.installed).length;
  const tokenForSnippet = data.remote.requireAuth
    ? revealedToken ?? "<YOUR_MCP_TOKEN>"
    : null;

  const activeSnippet = useMemo(() => {
    const endpoint = data.remoteEndpoint;
    if (snippetTab === "Claude Code (Remote)") {
      const headerFlag = tokenForSnippet
        ? ` --header "Authorization: Bearer ${tokenForSnippet}"`
        : "";
      return {
        hint: "Connect Claude Code from any remote machine over HTTP (works with VPS / reverse proxy).",
        lang: "bash",
        code: `claude mcp add --transport http uniroute ${endpoint}${headerFlag}`,
      };
    }
    if (snippetTab === "Codex CLI (Remote)") {
      const authLines = tokenForSnippet
        ? `\nhttp_headers = { Authorization = "Bearer ${tokenForSnippet}" }`
        : "";
      return {
        hint: "Add to ~/.codex/config.toml on any machine to connect to this UniRoute server.",
        lang: "toml",
        code: `[mcp_servers.uniroute]\nurl = "${endpoint}"${authLines}`,
      };
    }
    if (snippetTab === "OpenCode (Remote)") {
      const entry: Record<string, unknown> = {
        type: "remote",
        url: endpoint,
      };
      if (tokenForSnippet) {
        entry.headers = { Authorization: `Bearer ${tokenForSnippet}` };
      }
      return {
        hint: "Merge into opencode.json on your laptop/workstation to reach UniRoute remotely.",
        lang: "json",
        code: JSON.stringify({ mcp: { uniroute: entry } }, null, 2),
      };
    }
    if (snippetTab === "Cursor / JSON") {
      const entry: Record<string, unknown> = { url: endpoint };
      if (tokenForSnippet) {
        entry.headers = { Authorization: `Bearer ${tokenForSnippet}` };
      }
      return {
        hint: "Generic Streamable HTTP MCP config for Cursor, Windsurf, Cline, or custom clients.",
        lang: "json",
        code: JSON.stringify({ mcpServers: { uniroute: entry } }, null, 2),
      };
    }
    if (snippetTab === "cURL") {
      const authArg = tokenForSnippet
        ? ` \\\n  -H "Authorization: Bearer ${tokenForSnippet}"`
        : "";
      return {
        hint: "Quick JSON-RPC smoke test against the built-in Remote MCP endpoint.",
        lang: "bash",
        code: `curl -X POST ${endpoint} \\\n  -H "Content-Type: application/json"${authArg} \\\n  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`,
      };
    }
    return {
      hint: "Local Stdio commands (only when the coding agent runs on the same machine as UniRoute).",
      lang: "shell",
      code: [
        `# Direct stdio command:`,
        data.cmdStr,
        "",
        `# Claude Code (local):`,
        data.localSnippets.claude,
      ].join("\n"),
    };
  }, [snippetTab, data, tokenForSnippet]);

  const filteredTools = useMemo(() => {
    const q = query.trim().toLowerCase();
    return data.tools.filter(
      (t) =>
        (category === "all" || t.category === category) &&
        (q === "" ||
          t.name.toLowerCase().includes(q) ||
          t.description.toLowerCase().includes(q) ||
          t.args.some((a) => a.toLowerCase().includes(q))),
    );
  }, [data.tools, query, category]);

  return (
    <div>
      <PageHeader
        title="MCP Server"
        icon={<Cable size={20} />}
        subtitle="Expose UniRoute administration and gateway tools to local or remote coding agents over Model Context Protocol."
      />

      <MetricStrip
        className="mb-6"
        items={[
          {
            label: "Remote HTTP server",
            value: data.remote.enabled ? "Online" : "Disabled",
            detail: data.remote.enabled
              ? `${data.remoteEndpoint} (${data.remote.requireAuth ? "Bearer auth" : "Open"})`
              : "Enable below for remote or VPS agents",
            tone: data.remote.enabled ? "success" : "default",
          },
          {
            label: "Exposed tools",
            value: data.tools.length,
            detail: `${CATEGORY_ORDER.length} tool categories`,
            tone: "info",
          },
          {
            label: "Local clients",
            value: `${registeredCount} / ${data.harnesses.length}`,
            detail: "Same-machine stdio configs detected",
            tone: registeredCount > 0 ? "success" : "default",
          },
        ]}
      />

      {/* Built-in Remote HTTP MCP Server (VPS / Cross-machine ready) */}
      <Card className="mb-6">
        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-border pb-4">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <Globe size={16} className="text-primary" aria-hidden="true" />
              <h2 className="text-sm font-semibold text-foreground">
                Remote MCP HTTP Server (Built-in)
              </h2>
              <Badge tone={data.remote.enabled ? "success" : "neutral"} dot>
                {data.remote.enabled ? "Enabled" : "Disabled"}
              </Badge>
            </div>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              Serves MCP Streamable HTTP directly on UniRoute&apos;s main port (no extra VPS firewall
              ports required), so coding agents on other computers can connect over HTTPS.
            </p>
          </div>
          <div className="shrink-0">
            <Toggle
              checked={data.remote.enabled}
              label="Enable Remote MCP"
              disabled={remoteBusy}
              onChange={(checked) => {
                remoteFetcher.submit(
                  { intent: "remote-toggle", enabled: checked ? "1" : "0" },
                  { method: "post" },
                );
              }}
            />
          </div>
        </div>

        <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
          {/* Endpoint URL + Live Test */}
          <div className="space-y-2.5 rounded-lg border border-border bg-surface-2/35 p-3.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-muted-foreground">
                Remote endpoint URL
              </span>
              <div className="flex items-center gap-1.5">
                {data.tunnelUrl ? (
                  <Link to="/tunnels">
                    <Badge tone="success">Via Tunnel</Badge>
                  </Link>
                ) : (
                  <Link
                    to="/tunnels"
                    className="text-[11px] font-medium text-primary hover:underline"
                  >
                    Expose via Tunnel
                  </Link>
                )}
                <Badge tone="info">POST / GET</Badge>
              </div>
            </div>
            <div className="flex items-center justify-between gap-2 rounded-lg border border-border bg-surface px-3 py-2">
              <code className="truncate font-mono text-xs text-foreground">
                {data.remoteEndpoint}
              </code>
              <CopyButton text={data.remoteEndpoint} label="Copy endpoint URL" />
            </div>
            {data.tunnelUrl ? (
              <div className="flex items-center justify-between gap-2 rounded-lg border border-border bg-surface/60 px-3 py-1.5">
                <div className="min-w-0">
                  <span className="text-xs font-medium text-muted-foreground">
                    Local HTTP (still active)
                  </span>
                  <code className="block truncate font-mono text-[11px] text-foreground">
                    {data.localEndpoint}
                  </code>
                </div>
                <CopyButton text={data.localEndpoint} label="Copy local endpoint URL" />
              </div>
            ) : null}
            <div className="flex flex-wrap items-center gap-2 pt-0.5">
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={remoteBusy}
                onClick={() =>
                  remoteFetcher.submit({ intent: "remote-test" }, { method: "post" })
                }
              >
                {remoteIntent === "remote-test" ? (
                  <Spinner size={13} />
                ) : (
                  <Play size={13} aria-hidden="true" />
                )}
                Test endpoint
              </Button>
              {testResult ? (
                <span
                  className={`text-xs font-medium ${
                    testResult.ok ? "text-success" : "text-danger"
                  }`}
                >
                  {testResult.message} ({testResult.durationMs}ms)
                </span>
              ) : null}
            </div>
          </div>

          {/* Bearer Token Security */}
          <div className="space-y-2.5 rounded-lg border border-border bg-surface-2/35 p-3.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <KeyRound size={13} aria-hidden="true" /> Bearer authentication
              </span>
              <Toggle
                checked={data.remote.requireAuth}
                label="Require token"
                disabled={remoteBusy}
                onChange={(checked) => {
                  remoteFetcher.submit(
                    { intent: "remote-auth", required: checked ? "1" : "0" },
                    { method: "post" },
                  );
                }}
              />
            </div>

            <div className="flex items-center justify-between gap-2 rounded-lg border border-border bg-surface px-3 py-2">
              <code className="truncate font-mono text-xs text-foreground">
                {!data.remote.hasToken
                  ? "No token yet (auto-generated on enable)"
                  : revealedToken ?? data.remote.tokenMasked}
              </code>
              {revealedToken ? (
                <CopyButton text={revealedToken} label="Copy bearer token" />
              ) : null}
            </div>

            <div className="flex flex-wrap items-center gap-2 pt-0.5">
              {data.remote.hasToken ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={remoteBusy}
                  onClick={() => {
                    if (revealedToken) {
                      setRevealedToken(null);
                    } else {
                      remoteFetcher.submit(
                        { intent: "remote-reveal" },
                        { method: "post" },
                      );
                    }
                  }}
                >
                  {revealedToken ? (
                    <EyeOff size={13} aria-hidden="true" />
                  ) : (
                    <Eye size={13} aria-hidden="true" />
                  )}
                  {revealedToken ? "Hide token" : "Reveal token"}
                </Button>
              ) : null}

              {data.remote.tokenSource !== "env" ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={remoteBusy}
                  onClick={async () => {
                    if (data.remote.hasToken) {
                      const ok = await confirm({
                        title: "Rotate MCP bearer token?",
                        description:
                          "Existing remote agents using the old token will fail authentication until updated.",
                        confirmLabel: "Rotate token",
                        variant: "danger",
                      });
                      if (!ok) return;
                    }
                    remoteFetcher.submit(
                      { intent: "remote-rotate" },
                      { method: "post" },
                    );
                  }}
                >
                  {remoteIntent === "remote-rotate" ? (
                    <Spinner size={13} />
                  ) : (
                    <RotateCw size={13} aria-hidden="true" />
                  )}
                  {data.remote.hasToken ? "Rotate token" : "Generate token"}
                </Button>
              ) : (
                <span className="text-[11px] text-muted-foreground">
                  Locked by UNIROUTE_MCP_TOKEN env var
                </span>
              )}
            </div>
          </div>
        </div>
      </Card>

      {/* Tabbed Remote & Local Setup Snippets */}
      <Card className="mb-6">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Terminal size={16} className="text-muted-foreground" aria-hidden="true" />
            <div>
              <h2 className="text-sm font-semibold text-foreground">
                Client Configuration Snippets
              </h2>
              <p className="text-xs text-muted-foreground">{activeSnippet.hint}</p>
            </div>
          </div>
          <Tabs
            tabs={SNIPPET_TABS}
            active={snippetTab}
            onChange={(t) => setSnippetTab(t as SnippetTab)}
          />
        </div>

        <div className="overflow-hidden rounded-lg border border-border bg-surface-2/50">
          <div className="flex items-center justify-between border-b border-border bg-surface-2/80 px-3.5 py-2">
            <span className="font-mono text-xs font-medium text-muted-foreground">
              {snippetTab} · {activeSnippet.lang}
            </span>
            <CopyButton text={activeSnippet.code} label={`Copy ${snippetTab} snippet`} />
          </div>
          <pre className="slim-scroll overflow-x-auto whitespace-pre-wrap break-all px-4 py-3 font-mono text-xs leading-relaxed text-foreground">
            {activeSnippet.code}
          </pre>
        </div>
      </Card>

      {/* 1-Click local client registration (same machine only) */}
      <div className="mb-6">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold text-foreground">
              One-Click Local Registration (Same Machine Only)
            </h2>
            <p className="text-xs text-muted-foreground">
              Writes a local Stdio MCP entry into CLI configs on this host with automatic backup
              (works directly over local SQLite even while a tunnel is active).
              For agents on a different machine, use the Remote HTTP Server above.
            </p>
          </div>
        </div>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          {data.harnesses.map((h) => (
            <Card key={h.id} className="flex flex-col justify-between gap-4">
              <div>
                <div className="flex items-start justify-between gap-2">
                  <h3 className="text-sm font-semibold text-foreground">{h.name}</h3>
                  <Badge tone={h.installed ? "success" : "neutral"} dot>
                    {h.installed ? "Registered" : "Not registered"}
                  </Badge>
                </div>
                <p className="mt-2 break-all rounded-md border border-border bg-surface-2/50 px-2.5 py-1.5 font-mono text-[11px] text-muted-foreground">
                  {h.configPath}
                </p>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/70 pt-3">
                <fetcher.Form method="post">
                  <input type="hidden" name="harness" value={h.id} />
                  {h.installed ? (
                    <Button
                      type="button"
                      variant="danger"
                      size="sm"
                      disabled={busyHarness === h.id}
                      onClick={async () => {
                        const ok = await confirm({
                          title: `Remove MCP from ${h.name}?`,
                          description: `UniRoute will be unregistered from ${h.configPath}.`,
                          confirmLabel: "Remove",
                          variant: "danger",
                        });
                        if (!ok) return;
                        fetcher.submit(
                          { harness: h.id, intent: "mcp-remove" },
                          { method: "post" },
                        );
                      }}
                    >
                      {busyHarness === h.id ? <Spinner size={13} /> : null}
                      Remove
                    </Button>
                  ) : (
                    <Button
                      type="submit"
                      name="intent"
                      value="mcp-install"
                      variant="primary"
                      size="sm"
                      disabled={busyHarness === h.id}
                    >
                      {busyHarness === h.id ? <Spinner size={13} /> : null}
                      Register
                    </Button>
                  )}
                </fetcher.Form>
                <a
                  href={h.docsUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                >
                  Docs <ExternalLink size={12} aria-hidden="true" />
                </a>
              </div>
            </Card>
          ))}
        </div>
      </div>

      {/* Structured Tools Directory Table */}
      <Card padded={false} className="overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5 sm:px-5">
          <div>
            <h2 className="text-sm font-semibold text-foreground">
              Tools Catalog ({filteredTools.length}
              {filteredTools.length !== data.tools.length ? ` of ${data.tools.length}` : ""})
            </h2>
            <p className="text-xs text-muted-foreground">
              All MCP tools exposed by UniRoute to connected coding agents.
            </p>
          </div>
          <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
            <div className="relative w-full sm:w-56">
              <Search
                size={14}
                aria-hidden="true"
                className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                controlSize="sm"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search tools or args..."
                className="pl-8"
              />
            </div>
            <Select
              controlSize="sm"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="w-full sm:w-44"
              aria-label="Filter by category"
            >
              <option value="all">All categories</option>
              {CATEGORY_ORDER.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          </div>
        </div>

        {filteredTools.length === 0 ? (
          <p className="border-t border-border py-10 text-center text-sm text-muted-foreground">
            No MCP tools match your filter.
          </p>
        ) : (
          <Table className="min-w-[680px]">
            <THead>
              <TRow className="hover:bg-transparent">
                <THeadCell className="whitespace-nowrap">Tool Name</THeadCell>
                <THeadCell className="whitespace-nowrap">Category</THeadCell>
                <THeadCell className="w-[210px]">Parameters</THeadCell>
                <THeadCell>Description</THeadCell>
              </TRow>
            </THead>
            <tbody>
              {filteredTools.map((t) => (
                <TRow key={t.name}>
                  <TCell className="whitespace-nowrap font-mono text-xs font-semibold text-primary">
                    {t.name}
                  </TCell>
                  <TCell className="whitespace-nowrap">
                    <Badge tone="neutral">{t.category}</Badge>
                  </TCell>
                  <TCell className="w-[210px]">
                    {t.args.length === 0 ? (
                      <span className="text-xs text-muted-foreground">none</span>
                    ) : (
                      <div className="flex flex-wrap gap-1">
                        {t.args.map((a) => (
                          <code
                            key={a}
                            className="rounded border border-border bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-foreground"
                          >
                            {a}
                          </code>
                        ))}
                      </div>
                    )}
                  </TCell>
                  <TCell className="whitespace-normal text-xs leading-relaxed text-muted-foreground">
                    {t.description}
                  </TCell>
                </TRow>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      {dialog}
    </div>
  );
}
