import { useMemo, useState } from "react";
import { useFetcher, useLoaderData } from "react-router";
import type { Route } from "./+types/mcp";
import { Cable, ExternalLink, Server } from "lucide-react";
import { PageHeader } from "../components/ui/page-header";
import { Card } from "../components/ui/card";
import { Button } from "../components/ui/button";
import { Badge } from "../components/ui/badge";
import { Input } from "../components/ui/field";
import { CopyButton } from "../components/ui/copy-button";
import { Spinner } from "../components/ui/feedback";

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
  clear_logs: "Other",
};

const CATEGORY_ORDER = [
  "Monitoring",
  "Providers & models",
  "Proxy engine",
  "Client keys",
  "Other",
];

export async function loader() {
  // Dynamic import: modul .server tidak boleh masuk graf client bundle.
  const [{ HARNESS_REGISTRY, defaultMcpCommand, isMcpInstalled }, { TOOLS }] =
    await Promise.all([
      import("../.server/agents-config"),
      import("../.server/mcp-tools"),
    ]);
  const command = defaultMcpCommand();
  const cmdStr = command.join(" ");
  const httpPort = Number(process.env.UNIROUTE_MCP_PORT ?? 3007);

  const tools: ToolInfo[] = TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    category: CATEGORY_BY_TOOL[t.name] ?? "Other",
    args: Object.keys(t.inputSchema?.properties ?? {}),
  }));

  return {
    cmdStr,
    httpPort,
    tokenSet: Boolean(process.env.UNIROUTE_MCP_TOKEN),
    tools,
    harnesses: Object.values(HARNESS_REGISTRY).map((h) => ({
      id: h.id,
      name: h.name,
      configPath: h.configPath,
      docsUrl: h.docsUrl,
      installed: isMcpInstalled(h.id),
    })),
    snippets: {
      claude: `claude mcp add uniroute -- ${cmdStr}`,
      opencode: JSON.stringify({
        mcp: { servers: { uniroute: { type: "local", command } } },
      }),
      codex: `[mcp_servers.uniroute]\ncommand = "${command[0]}"\nargs = [${command
        .slice(1)
        .map((a) => `"${a}"`)
        .join(", ")}]`,
    },
  };
}

/* --------------------------------- action --------------------------------- */

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const intent = String(form.get("intent"));
  const harness = String(form.get("harness"));
  const { defaultMcpCommand, installMcp, isHarnessId, removeMcp } =
    await import("../.server/agents-config");
  if (!isHarnessId(harness)) {
    return Response.json({ ok: false, error: "unknown harness" }, { status: 400 });
  }
  if (intent === "mcp-install") installMcp(harness, defaultMcpCommand());
  else if (intent === "mcp-remove") removeMcp(harness);
  else return Response.json({ ok: false, error: "unknown intent" }, { status: 400 });
  return { ok: true };
}

/* ---------------------------------- UI ------------------------------------ */

function SnippetRow({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-glass-border bg-glass-strong px-3 py-2">
      <span className="w-24 shrink-0 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <code className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">
        {value}
      </code>
      <CopyButton text={value} />
    </div>
  );
}

export default function McpPage() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string>("all");

  const busyHarness =
    fetcher.state !== "idle"
      ? String(fetcher.formData?.get("harness") ?? "")
      : null;

  const grouped = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = data.tools.filter(
      (t) =>
        (category === "all" || t.category === category) &&
        (q === "" ||
          t.name.toLowerCase().includes(q) ||
          t.description.toLowerCase().includes(q)),
    );
    const map = new Map<string, ToolInfo[]>();
    for (const t of filtered) {
      const list = map.get(t.category) ?? [];
      list.push(t);
      map.set(t.category, list);
    }
    return CATEGORY_ORDER.filter((c) => map.has(c)).map((c) => ({
      category: c,
      items: map.get(c)!,
    }));
  }, [data.tools, query, category]);

  return (
    <div className="mx-auto w-full max-w-5xl p-4 md:p-6">
      <PageHeader
        title="MCP Server"
        icon={<Cable size={22} />}
        subtitle="Expose UniRoute to coding agents over the Model Context Protocol."
      />

      <Card className="mb-4 p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
            <Server size={16} /> Connection
          </h2>
          <Badge tone="info">{data.tools.length} tools</Badge>
        </div>

        <div className="space-y-2">
          <SnippetRow label="stdio" value={data.cmdStr} />
          <SnippetRow label="claude" value={data.snippets.claude} />
          <SnippetRow
            label="opencode"
            value={data.snippets.opencode.replace(/,/g, ", ")}
          />
          <SnippetRow label="codex" value={data.snippets.codex} />
          <SnippetRow
            label="http"
            value={`bun app/.server/mcp-server.ts --http ${data.httpPort}`}
          />
        </div>

        <p className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>
            HTTP endpoint:{" "}
            <code className="font-mono">POST /mcp</code> on port{" "}
            {data.httpPort}
          </span>
          {data.tokenSet ? (
            <Badge tone="success">token set</Badge>
          ) : (
            <Badge tone="warning">no token (UNIROUTE_MCP_TOKEN unset)</Badge>
          )}
        </p>
      </Card>

      <div className="mb-4 grid gap-3 md:grid-cols-3">
        {data.harnesses.map((h) => (
          <Card key={h.id} className="flex flex-col p-4">
            <div className="mb-2 flex items-start justify-between gap-2">
              <h3 className="text-sm font-semibold text-foreground">{h.name}</h3>
              {h.installed ? (
                <Badge tone="success">registered</Badge>
              ) : (
                <Badge tone="neutral">not registered</Badge>
              )}
            </div>
            <p className="mb-3 break-all font-mono text-xs text-muted-foreground">
              {h.configPath}
            </p>
            <div className="mt-auto flex items-center gap-2">
              <fetcher.Form method="post">
                <input type="hidden" name="harness" value={h.id} />
                {h.installed ? (
                  <Button
                    type="submit"
                    name="intent"
                    value="mcp-remove"
                    variant="ghost"
                    size="sm"
                    disabled={busyHarness === h.id}
                  >
                    {busyHarness === h.id ? <Spinner size={14} /> : null}
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
                    {busyHarness === h.id ? <Spinner size={14} /> : null}
                    Register
                  </Button>
                )}
              </fetcher.Form>
              <a
                href={h.docsUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              >
                docs <ExternalLink size={12} />
              </a>
            </div>
          </Card>
        ))}
      </div>

      <Card className="p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-foreground">Tools</h2>
          <div className="flex items-center gap-2">
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search tools…"
              className="h-8 w-48 text-xs"
            />
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="h-8 rounded-lg border border-glass-border bg-glass-strong px-2 text-xs text-foreground"
              aria-label="Filter by category"
            >
              <option value="all">All categories</option>
              {CATEGORY_ORDER.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="space-y-4">
          {grouped.map(({ category: cat, items }) => (
            <div key={cat}>
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {cat} · {items.length}
              </p>
              <ul className="divide-y divide-glass-border">
                {items.map((t) => (
                  <li key={t.name} className="py-2">
                    <p className="font-mono text-sm font-medium text-primary">
                      {t.name}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {t.description}
                      {t.args.length > 0 && (
                        <span className="ml-1 font-mono">
                          ({t.args.join(", ")})
                        </span>
                      )}
                    </p>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          {grouped.length === 0 && (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No tools match your search.
            </p>
          )}
        </div>
      </Card>
    </div>
  );
}
