import { Form, Link, Outlet, redirect, useFetcher, useNavigation, useParams } from "react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Route } from "./+types/providers";
import { ProviderForm } from "../components/provider-form";
import {
  PROVIDER_TEMPLATES,
  ProviderTemplateCard,
  type ProviderTemplate,
} from "../components/provider-templates";
import { requireSession } from "../.server/auth";
import { query } from "../.server/db";
import { reload } from "../.server/registry";
import { getRegistryEntry } from "~/registry";
import { testProviderConnection } from "../.server/provider-test";
import { ArrowRight, Plug, Plus, Search, X } from "lucide-react";
import { PageHeader } from "../components/ui/page-header";
import { Card } from "../components/ui/card";
import { Badge, type BadgeTone } from "../components/ui/badge";
import { Toggle } from "../components/ui/toggle";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/field";
import { EmptyState } from "../components/ui/empty-state";
import { Spinner } from "../components/ui/feedback";
import { useToast } from "../components/ui/toast";

export function meta() {
  return [{ title: "Providers | UniRoute" }];
}

export type ProviderRow = {
  id: string;
  name: string;
  base_url: string;
  auth_type: string;
  is_active: number;
  weight: number;
  priority: number;
  current_connections: number;
  last_used_at: number;
  prefix: string | null;
};

type CountRow = {
  provider_id: string;
  c: number;
};

async function testProvider(providerId: string): Promise<{ connected: number; total: number }> {
  const r = await testProviderConnection(providerId);
  return { connected: r.connected, total: r.total };
}

function runAllTests(rows: ProviderRow[], keyCounts: Record<string, number>) {
  return Promise.all(
    rows.map(async (p) => {
      if (!keyCounts[p.id]) return null;
      const result = await testProvider(p.id);
      return [p.id, result] as const;
    }),
  ).then((results) => {
    const initialTestResults: Record<string, { connected: number; total: number }> = {};
    for (const r of results) {
      if (r) initialTestResults[r[0]] = r[1];
    }
    return initialTestResults;
  });
}

export function loader() {
  const providers = query(
    "SELECT id, name, base_url, auth_type, is_active, weight, priority, current_connections, last_used_at, prefix FROM providers ORDER BY is_active DESC, id",
  ).all() as unknown as ProviderRow[];
  const keyRows = query(
    "SELECT provider_id, COUNT(*) as c FROM provider_credentials WHERE is_active = 1 GROUP BY provider_id",
  ).all() as unknown as CountRow[];
  const modelRows = query(
    "SELECT provider_id, COUNT(*) as c FROM models WHERE is_active = 1 GROUP BY provider_id",
  ).all() as unknown as CountRow[];
  const keyCounts: Record<string, number> = {};
  for (const r of keyRows) keyCounts[r.provider_id] = Number(r.c);
  const modelCounts: Record<string, number> = {};
  for (const r of modelRows) modelCounts[r.provider_id] = Number(r.c);
  return { providers, keyCounts, modelCounts };
}

export async function action({ request }: Route.ActionArgs) {
  const denied = requireSession(request);
  if (denied) return denied;
  const form = await request.formData();
  const intent = String(form.get("intent"));

  if (intent === "test") {
    const id = String(form.get("id"));
    const result = await testProvider(id);
    return { test: { id, ...result } };
  }

  if (intent === "test-all") {
    const rows = query(
      "SELECT id, name, base_url, auth_type, is_active, weight, priority, current_connections, last_used_at, prefix FROM providers ORDER BY is_active DESC, id",
    ).all() as unknown as ProviderRow[];
    const keyRows = query(
      "SELECT provider_id, COUNT(*) as c FROM provider_credentials WHERE is_active = 1 GROUP BY provider_id",
    ).all() as unknown as CountRow[];
    const keyCounts: Record<string, number> = {};
    for (const r of keyRows) keyCounts[r.provider_id] = Number(r.c);
    const initialTestResults = await runAllTests(rows, keyCounts);
    return { testAll: initialTestResults };
  }

  if (intent === "toggle") {
    const id = String(form.get("id"));
    const isActive = Number(form.get("is_active")) === 1 ? 0 : 1;
    query("UPDATE providers SET is_active = ? WHERE id = ?").run(isActive, id);
    reload();
    return redirect("/providers");
  }

  const id = String(form.get("id") ?? "").trim();
  const name = String(form.get("name") ?? "").trim();
  const baseUrl = String(form.get("base_url") ?? "").trim();
  const authType = String(form.get("auth_type") ?? "bearer");
  const weight = Number(form.get("weight") ?? 1);
  const priority = Number(form.get("priority") ?? 0);
  const isActive = form.get("is_active") === "1" ? 1 : 0;
  let prefix: string | null = null;
  try {
    const { normalizePrefix } = await import("../.server/provider-prefix");
    prefix = normalizePrefix(String(form.get("prefix") ?? ""));
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Invalid prefix" };
  }
  if (prefix) {
    const dup = query("SELECT id FROM providers WHERE prefix = ? AND id != ?").get(prefix, id) as
      | { id: string }
      | undefined;
    if (dup) return { error: `Prefix "${prefix}" is already used by provider "${dup.id}"` };
  }

  if (intent === "update") {
    query(
      `UPDATE providers
       SET name = ?, base_url = ?, auth_type = ?, weight = ?, priority = ?, is_active = ?, prefix = ?
       WHERE id = ?`,
    ).run(name, baseUrl, authType, weight, priority, isActive, prefix, id);
  } else {
    const existing = query("SELECT id FROM providers WHERE id = ?").get(id) as
      | { id: string }
      | undefined;
    if (existing) {
      return { error: `Provider ID "${id}" already exists. Please pick a unique ID.` };
    }
    query(
      `INSERT INTO providers (id, name, base_url, auth_type, is_active, weight, priority, prefix)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, name, baseUrl, authType, isActive, weight, priority, prefix);
    const templateId = String(form.get("template_id") ?? "");
    const entry = templateId ? getRegistryEntry(templateId) : undefined;
    if (entry && entry.models.length > 0) {
      for (const [i, m] of entry.models.entries()) {
        query(
          `INSERT OR IGNORE INTO models (model_name, provider_id, context_length, is_active, is_primary)
           VALUES (?, ?, ?, 1, ?)`,
        ).run(m.id, id, m.contextLength ?? null, i === 0 ? 1 : 0);
      }
    }
  }
  reload();
  return redirect("/providers");
}

const AUTH_TONE: Record<string, BadgeTone> = {
  none: "neutral",
  bearer: "info",
  apikey: "primary",
};

function AuthBadge({ auth }: { auth: string }) {
  return <Badge tone={AUTH_TONE[auth] ?? "neutral"}>{auth}</Badge>;
}

export default function Providers({ loaderData, actionData }: Route.ComponentProps) {
  const { providers, keyCounts, modelCounts } = loaderData;
  const [showAdd, setShowAdd] = useState(providers.length === 0);
  const [picked, setPicked] = useState<ProviderTemplate | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "inactive">("all");
  const { id } = useParams();
  const allFetcher = useFetcher<{ testAll?: Record<string, { connected: number; total: number }> }>();
  const { toast } = useToast();
  const navigation = useNavigation();

  const lastProviderActionRef = useRef<typeof actionData>(undefined);
  useEffect(() => {
    if (lastProviderActionRef.current === actionData) return;
    lastProviderActionRef.current = actionData;
    const err = (actionData as { error?: unknown } | undefined)?.error;
    if (typeof err === "string" && err) {
      toast({
        title: "Save provider failed",
        description: err,
        variant: "error",
        ...(err.length > 120 ? { durationMs: 8000 } : {}),
      });
    }
  }, [actionData, toast]);

  type PendingProviderMutation = { intent: string; id: string; name: string };
  const pendingProviderMutationRef = useRef<PendingProviderMutation | null>(null);
  if (navigation.state !== "idle" && navigation.formData) {
    const fd = navigation.formData;
    const intent = String(fd.get("intent") ?? "");
    if (intent === "toggle" || intent === "create" || intent === "update") {
      const pid = String(fd.get("id") ?? "");
      const known = providers.find((pr) => pr.id === pid);
      pendingProviderMutationRef.current = {
        intent,
        id: pid,
        name: known?.name || String(fd.get("name") ?? "").trim() || pid,
      };
    }
  }
  useEffect(() => {
    if (navigation.state !== "idle") return;
    const pending = pendingProviderMutationRef.current;
    if (!pending) return;
    pendingProviderMutationRef.current = null;
    if ((actionData as { error?: unknown } | undefined)?.error) return;
    const fresh = providers.find((pr) => pr.id === pending.id);
    const display = fresh?.name || pending.name || pending.id;
    if (pending.intent === "toggle") {
      const active = Boolean(fresh?.is_active);
      toast({ title: `Provider "${display}" ${active ? "enabled" : "disabled"}`, variant: "success" });
    } else if (pending.intent === "create") {
      setPicked(null);
      setShowAdd(false);
      toast({ title: `Provider "${display}" created`, variant: "success" });
    } else if (pending.intent === "update") {
      toast({ title: `Provider "${display}" updated`, variant: "success" });
    }
  }, [navigation.state, toast, providers, actionData]);

  // Only run connection tests when on the /providers index view (not /providers/:id).
  const hasTestedRef = useRef(false);
  useEffect(() => {
    if (id || hasTestedRef.current || providers.length === 0) return;
    hasTestedRef.current = true;
    const form = new FormData();
    form.set("intent", "test-all");
    allFetcher.submit(form, { method: "post" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, providers.length]);

  const filteredProviders = useMemo(() => {
    const q = search.trim().toLowerCase();
    return providers.filter((p) => {
      if (statusFilter === "active" && !p.is_active) return false;
      if (statusFilter === "inactive" && p.is_active) return false;
      if (!q) return true;
      return (
        p.name.toLowerCase().includes(q) ||
        p.id.toLowerCase().includes(q) ||
        p.base_url.toLowerCase().includes(q) ||
        (p.prefix ?? "").toLowerCase().includes(q)
      );
    });
  }, [providers, search, statusFilter]);

  if (id) {
    return <Outlet />;
  }

  const checkingAll = allFetcher.state !== "idle";

  return (
    <div>
      <PageHeader
        title="Providers"
        icon={<Plug size={20} />}
        subtitle="Manage upstream LLM endpoints, API keys, and connection health."
        actions={
          <Button
            type="button"
            variant={showAdd ? "outline" : "primary"}
            onClick={() => {
              if (showAdd) {
                setShowAdd(false);
                setPicked(null);
              } else {
                setShowAdd(true);
              }
            }}
          >
            {showAdd ? <X size={15} /> : <Plus size={15} />}
            {showAdd ? "Close" : "Add Provider"}
          </Button>
        }
      />

      {showAdd ? (
        <div className="mb-8">
          {picked ? (
            <>
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-base font-semibold text-foreground">
                  Configure new provider
                </h2>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setPicked(null)}
                >
                  ← Choose another template
                </Button>
              </div>
              <ProviderForm
                template={picked}
                providers={providers.map((p) => p.id)}
                onCancel={() => {
                  setPicked(null);
                  if (providers.length > 0) setShowAdd(false);
                }}
              />
            </>
          ) : (
            <>
              <h2 className="mb-1 text-base font-semibold text-foreground">
                Choose a provider template
              </h2>
              <p className="mb-4 text-sm text-muted-foreground">
                Start from an OpenAI or Anthropic preset, or configure any custom endpoint manually.
              </p>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {PROVIDER_TEMPLATES.map((t) => (
                  <ProviderTemplateCard key={t.id} template={t} onPick={setPicked} />
                ))}
              </div>
            </>
          )}
        </div>
      ) : null}

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-semibold text-foreground">
          Configured Providers{" "}
          <span className="font-normal text-muted-foreground">
            ({filteredProviders.length}
            {filteredProviders.length !== providers.length ? ` of ${providers.length}` : ""})
          </span>
        </h2>

        {providers.length > 0 ? (
          <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
            <div className="relative w-full sm:w-60">
              <Search
                size={14}
                className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                controlSize="sm"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search providers…"
                className="pl-8"
              />
            </div>
            <div className="inline-flex rounded-lg border border-border bg-surface-2/70 p-0.5 text-xs">
              {(["all", "active", "inactive"] as const).map((st) => (
                <button
                  key={st}
                  type="button"
                  onClick={() => setStatusFilter(st)}
                  className={`cursor-pointer rounded-md px-2.5 py-1 font-medium capitalize transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 ${
                    statusFilter === st
                      ? "bg-surface text-foreground shadow-xs"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {st}
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>

      {providers.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Plug size={22} />}
            title="No providers configured yet"
            description="Pick a template above to connect your first upstream AI provider."
          />
        </Card>
      ) : filteredProviders.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Search size={20} />}
            title="No providers match your filter"
            description="Try adjusting your search query or status filter."
            action={
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setSearch("");
                  setStatusFilter("all");
                }}
              >
                Clear filters
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="mb-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filteredProviders.map((p) => (
            <Card
              key={p.id}
              interactive
              className={p.is_active ? "flex flex-col justify-between" : "flex flex-col justify-between opacity-75"}
            >
              <div>
                <div className="flex items-start justify-between gap-3">
                  <Link
                    to={`/providers/${p.id}`}
                    prefetch="intent"
                    className="group block min-w-0 flex-1"
                  >
                    <p className="flex items-center gap-1.5 truncate font-semibold text-foreground group-hover:text-primary">
                      <span className="truncate">{p.name}</span>
                      <ArrowRight
                        size={13}
                        className="shrink-0 opacity-0 transition-all group-hover:translate-x-0.5 group-hover:opacity-100"
                      />
                    </p>
                    <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
                      {p.id}
                      {p.prefix ? (
                        <span className="ml-1 text-primary">
                          · {(p.prefix ?? "").replace(/^\/+|\/+$/g, "")}/
                        </span>
                      ) : null}
                    </p>
                  </Link>
                  <div className="flex shrink-0 items-center gap-2">
                    <Toggle
                      checked={Boolean(p.is_active)}
                      label={`${p.is_active ? "Deactivate" : "Activate"} ${p.name}`}
                      onChange={() => {
                        const form = document.getElementById(
                          `toggle-${p.id}`,
                        ) as HTMLFormElement | null;
                        form?.requestSubmit();
                      }}
                    />
                  </div>
                </div>

                <Link
                  to={`/providers/${p.id}`}
                  prefetch="intent"
                  className="mt-2.5 block truncate font-mono text-xs text-muted-foreground hover:text-foreground"
                >
                  {p.base_url}
                </Link>

                <div className="mt-3 flex flex-wrap items-center gap-1.5">
                  <AuthBadge auth={p.auth_type} />
                  <Badge tone="neutral">
                    {modelCounts[p.id] ?? 0} model{(modelCounts[p.id] ?? 0) === 1 ? "" : "s"}
                  </Badge>
                  <Badge tone="neutral">
                    {keyCounts[p.id] ?? 0} key{(keyCounts[p.id] ?? 0) === 1 ? "" : "s"}
                  </Badge>
                </div>
              </div>

              <Form id={`toggle-${p.id}`} method="post" className="hidden">
                <input type="hidden" name="intent" value="toggle" />
                <input type="hidden" name="id" value={p.id} />
                <input type="hidden" name="is_active" value={p.is_active} />
              </Form>

              <ProviderStatusCard
                providerId={p.id}
                keyCount={keyCounts[p.id] || 0}
                initialResult={allFetcher.data?.testAll?.[p.id]}
                checkingAll={checkingAll}
              />
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function ProviderStatusCard({
  providerId,
  keyCount,
  initialResult,
  checkingAll,
}: {
  providerId: string;
  keyCount: number;
  initialResult?: { connected: number; total: number };
  checkingAll: boolean;
}) {
  const fetcher = useFetcher<{ test?: { id: string; connected: number } }>();
  const testResult =
    fetcher.data?.test && fetcher.data.test.id === providerId
      ? fetcher.data.test
      : undefined;
  const testing = fetcher.state !== "idle";
  const pending = testing || (checkingAll && keyCount > 0 && !testResult && !initialResult);

  let statusText: string;
  let statusClass: string;

  if (keyCount === 0) {
    statusText = "No API keys";
    statusClass = "text-muted-foreground";
  } else if (pending) {
    statusText = "Checking…";
    statusClass = "text-muted-foreground";
  } else if (testResult) {
    if (testResult.connected > 0) {
      statusText = `${testResult.connected} connected`;
      statusClass = "text-success";
    } else {
      statusText = "Connection failed";
      statusClass = "text-danger";
    }
  } else if (initialResult) {
    if (initialResult.connected > 0) {
      statusText = `${initialResult.connected} connected`;
      statusClass = "text-success";
    } else {
      statusText = "Connection failed";
      statusClass = "text-danger";
    }
  } else {
    statusText = "Not tested";
    statusClass = "text-muted-foreground";
  }

  return (
    <div className="mt-4 flex items-center justify-between border-t border-border/70 pt-3">
      <span className={`flex items-center gap-1.5 text-xs font-medium ${statusClass}`}>
        {pending ? (
          <Spinner size={13} />
        ) : (
          <span className="inline-block h-2 w-2 rounded-full bg-current" />
        )}
        {statusText}
      </span>
      <div className="flex items-center gap-1.5">
        <fetcher.Form method="post">
          <input type="hidden" name="intent" value="test" />
          <input type="hidden" name="id" value={providerId} />
          <Button type="submit" variant="outline" size="sm" disabled={testing || keyCount === 0}>
            {testing ? <Spinner size={13} /> : <Plug size={13} />}
            Test
          </Button>
        </fetcher.Form>
      </div>
    </div>
  );
}
