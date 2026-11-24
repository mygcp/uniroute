import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useFetcher } from "react-router";
import { ChevronDown, ChevronRight, Clock, FolderOpen, Globe, KeyRound, Trash2 } from "lucide-react";
import type { Route } from "./+types/logs.proxy";
import { query } from "../.server/db";
import { Combobox } from "../components/ui/combobox";
import {
  useRealtimeLogs,
  type LogEvent,
} from "../hooks/use-realtime-logs";
import { useToast } from "../components/ui/toast";
import { useConfirm } from "../components/ui/confirm-dialog";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/field";
import { PageHeader } from "../components/ui/page-header";
import { Spinner } from "../components/ui/feedback";
import { LogViewer } from "../components/log-viewer";
import {
  fmtNum,
  fmtTs,
  parseMetadata,
  printable,
} from "../lib/log-format";

const COLS = `
  l.id, l.level, l.source, l.message, l.metadata, l.created_at,
  l.client_ip, l.api_key_id, l.provider_id, l.proxy_id, l.latency_ms, l.endpoint,
  k.name AS api_key_name, k.key_prefix AS api_key_prefix,
  op.name AS proxy_name, op.host AS proxy_host, op.port AS proxy_port`;

export function meta() {
  return [{ title: "Proxy Logs | UniRoute" }];
}

export function loader() {
  const rows = query(
    `SELECT ${COLS} FROM proxy_logs l
       LEFT JOIN client_api_keys k ON k.id = l.api_key_id
       LEFT JOIN outbound_proxies op ON op.id = l.proxy_id
      ORDER BY l.id DESC LIMIT 500`,
  ).all() as Record<string, unknown>[];

  const proxy: LogEvent[] = rows
    .map((r) => ({
      type: "proxy" as const,
      created_at: Number(r.created_at),
      ...r,
    }));
  // Terbaru di atas — tanpa reverse (SQL sudah ORDER BY id DESC).

  return { initial: proxy };
}

const LEVEL_TONE: Record<string, "success" | "warning" | "danger" | "info" | "neutral"> = {
  info: "info",
  warn: "warning",
  error: "danger",
  debug: "neutral",
};

const OPTIONS = {
  levels: ["info", "warn", "error", "debug"],
  sources: (logs: LogEvent[]) =>
    [...new Set(logs.map((l) => String(l.source ?? "")).filter(Boolean))].sort(),
};

function Detail({ event }: { event: LogEvent }) {
  const metadata = parseMetadata(event.metadata);

  const fields: Array<[string, string | number | boolean | null | undefined]> = [
    ["id", event.id],
    ["level", event.level as string],
    ["source", event.source as string],
    ["time", fmtTs(Number(event.created_at))],
    ["latency_ms", event.latency_ms == null ? null : fmtNum(Number(event.latency_ms))],
    ["client_ip", event.client_ip as string],
    [
      "api_key",
      event.api_key_id == null
        ? null
        : `${String(
            event.api_key_name ?? event.api_key_prefix ?? `#${event.api_key_id}`,
          )} (#${event.api_key_id})`,
    ],
    ["provider_id", event.provider_id as string],
    [
      "proxy",
      event.proxy_id == null
        ? null
        : `${String(event.proxy_name ?? "proxy")} (${String(
            event.proxy_host ?? "?",
          )}:${String(event.proxy_port ?? "?")}) #${event.proxy_id}`,
    ],
    ["endpoint", event.endpoint as string],
  ].filter(([, v]) => v !== null && v !== undefined && v !== "") as Array<
    [string, string | number | boolean]
  >;

  return (
    <div className="mt-2 rounded-lg border border-border bg-muted px-3 py-3">
      <h3 className="mb-2 text-sm font-semibold text-foreground">Proxy log detail</h3>
      <dl className="grid grid-cols-1 gap-1.5 sm:grid-cols-2 md:grid-cols-3">
        {fields.map(([k, v]) => (
          <div key={k} className="flex min-w-0 gap-2">
            <dt className="shrink-0 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {k}
            </dt>
            <dd
              className="min-w-0 break-all text-xs text-muted-foreground"
              title={printable(v)}
            >
              {printable(v)}
            </dd>
          </div>
        ))}
      </dl>
      <div className="mt-3">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Message
        </h4>
        <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-surface px-3 py-2 font-mono text-xs text-foreground">
          {String(event.message ?? "")}
        </pre>
      </div>
      {metadata ? (
        <div className="mt-3">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Metadata ({Object.keys(metadata).length} field
            {Object.keys(metadata).length === 1 ? "" : "s"})
          </h4>
          <dl className="mt-1 grid grid-cols-1 gap-1.5 sm:grid-cols-2">
            {Object.entries(metadata).map(([k, v]) => (
              <div key={k} className="flex min-w-0 gap-2 rounded-lg bg-surface px-2 py-1">
                <dt className="shrink-0 font-mono text-xs font-semibold text-foreground">
                  {k}:
                </dt>
                <dd
                  className="min-w-0 break-all font-mono text-xs text-muted-foreground"
                  title={printable(v)}
                >
                  {printable(v)}
                </dd>
              </div>
            ))}
          </dl>
          <details className="mt-2">
            <summary className="cursor-pointer text-xs font-semibold text-muted-foreground">
              Raw JSON
            </summary>
            <pre className="mt-2 max-h-72 overflow-auto rounded-lg bg-surface px-3 py-2 font-mono text-xs text-foreground">
              {JSON.stringify(metadata, null, 2)}
            </pre>
          </details>
        </div>
      ) : null}
    </div>
  );
}

const Row = memo(function Row({
  event,
  selected,
  onSelect,
  onDelete,
}: {
  event: LogEvent;
  selected: boolean;
  onSelect: (key: string) => void;
  onDelete: (id: number) => void;
}) {
  const key = `${event.id ?? event.created_at}`;
  const message = String(event.message ?? "");
  const latency =
    event.latency_ms == null ? null : Number(event.latency_ms);
  const keyLabel =
    event.api_key_id == null
      ? ""
      : String(
          event.api_key_name ?? event.api_key_prefix ?? `#${event.api_key_id}`,
        );
  const proxyShort =
    event.proxy_id != null || event.proxy_host
      ? String(
          event.proxy_name ?? event.proxy_host ?? `#${event.proxy_id ?? ""}`,
        ).trim() || "proxy"
      : null;
  const proxyTitle =
    event.proxy_id != null || event.proxy_host
      ? `proxy: ${String(event.proxy_name ?? "proxy")} (${String(
          event.proxy_host ?? "?",
        )}:${String(event.proxy_port ?? "?")})${
          event.proxy_id != null ? ` #${event.proxy_id}` : ""
        }`
      : null;
  const hasMeta =
    latency != null ||
    event.provider_id ||
    event.endpoint ||
    event.client_ip ||
    proxyShort ||
    keyLabel;

  return (
    <div
      className={`border-b border-border/70 text-sm transition-colors last:border-b-0 ${
        selected ? "bg-primary/8" : "hover:bg-glass-hover"
      }`}
    >
      <div className="flex flex-col gap-2 px-4 py-2.5 lg:grid lg:grid-cols-[148px_82px_130px_minmax(0,1fr)_96px_68px] lg:items-center lg:gap-3">
        {/* Timestamp */}
        <div className="flex items-center justify-between gap-2 lg:block">
          <span className="font-mono text-xs tabular-nums text-muted-foreground">
            {fmtTs(event.created_at)}
          </span>
          <div className="flex items-center gap-1.5 lg:hidden">
            <Badge tone={LEVEL_TONE[String(event.level)] ?? "neutral"}>
              {String(event.level)}
            </Badge>
            <Badge tone="neutral">{String(event.source)}</Badge>
          </div>
        </div>

        {/* Level */}
        <div className="hidden lg:block">
          <Badge tone={LEVEL_TONE[String(event.level)] ?? "neutral"}>
            {String(event.level)}
          </Badge>
        </div>

        {/* Source */}
        <div className="hidden min-w-0 lg:block">
          <span
            className="block truncate font-mono text-xs text-muted-foreground"
            title={`source: ${String(event.source)}`}
          >
            {String(event.source)}
          </span>
        </div>

        {/* Message + compact metadata pills */}
        <div className="min-w-0">
          <p className="truncate text-xs font-medium text-foreground" title={message}>
            {message}
          </p>
          {hasMeta ? (
            <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
              {event.provider_id ? (
                <span className="rounded border border-border bg-surface-2 px-1.5 py-0.25">
                  {String(event.provider_id)}
                </span>
              ) : null}
              {event.endpoint ? (
                <span className="truncate font-mono">{String(event.endpoint)}</span>
              ) : null}
              {event.client_ip ? (
                <span className="font-mono">{String(event.client_ip)}</span>
              ) : null}
              {proxyShort ? (
                <span
                  className="inline-flex items-center gap-1 rounded border border-primary/25 bg-primary/10 px-1.5 py-0.25 text-primary"
                  title={proxyTitle ?? undefined}
                >
                  <Globe size={10} aria-hidden="true" />
                  <span className="max-w-[140px] truncate">{proxyShort}</span>
                </span>
              ) : null}
              {keyLabel ? (
                <span
                  className="inline-flex items-center gap-1 rounded border border-border bg-surface-2 px-1.5 py-0.25"
                  title={`API key: ${keyLabel}`}
                >
                  <KeyRound size={10} aria-hidden="true" />
                  <span className="max-w-[120px] truncate">{keyLabel}</span>
                </span>
              ) : null}
            </div>
          ) : null}
        </div>

        {/* Latency */}
        <div className="flex items-center justify-between gap-2 text-xs lg:block lg:text-right">
          <span className="text-[11px] text-muted-foreground lg:hidden">Latency</span>
          <span className="font-mono tabular-nums text-muted-foreground">
            {latency != null ? `${fmtNum(latency)}ms` : "-"}
          </span>
        </div>

        {/* Actions */}
        <div className="flex items-center justify-end gap-1">
          <button
            type="button"
            title={selected ? "Close details" : "Inspect log"}
            aria-label={selected ? "Close log details" : "Inspect log details"}
            aria-expanded={selected}
            onClick={() => onSelect(key)}
            className="grid h-7 w-7 place-items-center rounded-md border border-border bg-surface text-muted-foreground transition-colors hover:border-border-strong hover:bg-surface-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            {selected ? (
              <ChevronDown size={14} aria-hidden="true" />
            ) : (
              <ChevronRight size={14} aria-hidden="true" />
            )}
          </button>
          <button
            type="button"
            title="Delete log"
            aria-label="Delete log"
            onClick={() => onDelete(Number(event.id))}
            className="grid h-7 w-7 place-items-center rounded-md border border-border bg-surface text-danger transition-colors hover:border-danger/50 hover:bg-danger/12 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <Trash2 size={13} aria-hidden="true" />
          </button>
        </div>
      </div>

      {selected ? (
        <div className="border-t border-border/60 bg-surface-2/40 px-4 py-3">
          <Detail event={event} />
        </div>
      ) : null}
    </div>
  );
});

export default function LogsProxy({ loaderData }: Route.ComponentProps) {
  const [level, setLevel] = useState("");
  const [source, setSource] = useState("");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{ id: number; type: "proxy" } | null>(null);
  const clearFetcher = useFetcher();
  const deleteFetcher = useFetcher();
  const { toast } = useToast();
  const { confirm, dialog } = useConfirm();
  const { logs, connected, paused, setPaused, scrollRef, remove, reset } =
    useRealtimeLogs((l) => l.type === "proxy", loaderData.initial, {
      newestFirst: true,
    });

  const deferredLevel = useDeferredValue(level);
  const deferredSource = useDeferredValue(source);
  const deferredSearch = useDeferredValue(search);

  const options = useMemo(() => ({ source: OPTIONS.sources(logs) }), [logs]);

  const filtered = useMemo(() => {
    const sourceQ = deferredSource.trim().toLowerCase();
    const searchQ = deferredSearch.trim().toLowerCase();
    return logs.filter((l) => {
      if (deferredLevel && String(l.level ?? "") !== deferredLevel) return false;
      if (sourceQ && !String(l.source ?? "").toLowerCase().includes(sourceQ)) return false;
      if (searchQ) {
        const haystack = `${String(l.message ?? "")} ${String(
          l.metadata ?? "",
        )} ${String(l.client_ip ?? "")} ${String(l.provider_id ?? "")} ${String(
          l.proxy_host ?? "",
        )} ${String(l.proxy_name ?? "")} ${String(l.api_key_name ?? "")} ${String(
          l.api_key_prefix ?? "",
        )} ${String(l.endpoint ?? "")}`.toLowerCase();
        if (!haystack.includes(searchQ)) return false;
      }
      return true;
    });
  }, [logs, deferredLevel, deferredSource, deferredSearch]);

  async function handleClear() {
    const ok = await confirm({
      title: "Clear all proxy logs?",
      description: "This permanently removes every proxy log from the database. This action cannot be undone.",
      variant: "danger",
    });
    if (!ok) return;
    clearFetcher.submit({ scope: "proxy" }, { method: "POST", action: "/api/logs/clear" });
  }

  const deleteFetcherRef = useRef(deleteFetcher);
  deleteFetcherRef.current = deleteFetcher;

  const toggleSelect = useCallback((key: string) => {
    setSelectedId((cur) => (cur === key ? null : key));
  }, []);

  const handleDelete = useCallback(
    async (id: number, type: "proxy") => {
      const ok = await confirm({
        title: "Delete this log?",
        description: "This proxy log will be permanently removed from the database.",
        variant: "danger",
      });
      if (!ok) return;
      setPendingDelete({ id, type });
      deleteFetcherRef.current.submit(
        { id: String(id), type },
        { method: "POST", action: "/api/logs/delete" },
      );
    },
    [confirm, setPendingDelete],
  );

  const deleteLog = useCallback(
    (id: number) => handleDelete(id, "proxy"),
    [handleDelete],
  );

  useEffect(() => {
    if (deleteFetcher.state !== "idle" || !deleteFetcher.data || !pendingDelete) return;
    setPendingDelete(null);
    if (deleteFetcher.data.ok !== true) {
      toast({ title: "Delete failed", variant: "error" });
    } else {
      remove(pendingDelete.id, pendingDelete.type);
      toast({ title: "Proxy log deleted", variant: "success" });
    }
  }, [deleteFetcher.state, deleteFetcher.data, pendingDelete, remove, toast]);

  const lastClearRef = useRef<unknown>(null);
  useEffect(() => {
    if (clearFetcher.state !== "idle" || !clearFetcher.data) return;
    if (lastClearRef.current === clearFetcher.data) return;
    lastClearRef.current = clearFetcher.data;
    if (clearFetcher.data.ok !== true) {
      toast({ title: "Failed to clear proxy logs", variant: "error" });
      return;
    }
    reset([]);
    toast({ title: "Proxy logs cleared", variant: "success" });
  }, [clearFetcher.state, clearFetcher.data, reset, toast]);

  const activeFilters = Boolean(level || source || search);

  const renderRow = useCallback(
    (event: LogEvent) => (
      <Row
        event={event}
        selected={selectedId === `${event.id ?? event.created_at}`}
        onSelect={toggleSelect}
        onDelete={deleteLog}
      />
    ),
    [selectedId, toggleSelect, deleteLog],
  );

  return (
    <div>
      <PageHeader
        title="Proxy Logs"
        icon={<FolderOpen size={20} />}
        subtitle="System diagnostics, outbound proxy routing events, and runtime warnings."
        actions={
          <>
            <span className="text-xs font-medium tabular-nums text-muted-foreground">
              {filtered.length.toLocaleString()} shown
            </span>
            <Button
              type="button"
              variant="danger"
              size="sm"
              disabled={logs.length === 0 || clearFetcher.state !== "idle"}
              onClick={handleClear}
            >
              {clearFetcher.state !== "idle" ? <Spinner size={13} /> : <Trash2 size={13} />}
              Clear logs
            </Button>
          </>
        }
      />

      <div className="mb-4 grid grid-cols-1 gap-2 sm:grid-cols-3">
        <Combobox
          options={OPTIONS.levels}
          value={level}
          onChange={setLevel}
          placeholder="Level…"
        />
        <Combobox
          options={options.source}
          value={source}
          onChange={setSource}
          placeholder="Source…"
        />
        <div className="flex items-center gap-2">
          <Input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search message…"
          />
          {activeFilters ? (
            <Button
              type="button"
              variant="outline"
              size="md"
              className="shrink-0"
              onClick={() => {
                setLevel("");
                setSource("");
                setSearch("");
              }}
            >
              Reset
            </Button>
          ) : null}
        </div>
      </div>

      {dialog}

      <LogViewer
        logs={filtered}
        paused={paused}
        onTogglePause={() => setPaused(!paused)}
        connected={connected}
        type="proxy"
        scrollRef={scrollRef}
        emptyMessage="No proxy logs yet. They appear here as requests are routed through the proxy."
        renderRow={renderRow}
        columnHeader={
          <div className="grid grid-cols-[148px_82px_130px_minmax(0,1fr)_96px_68px] items-center gap-3 px-4 py-2">
            <span>Timestamp</span>
            <span>Level</span>
            <span>Source</span>
            <span>Message / Context</span>
            <span className="text-right">Latency</span>
            <span className="text-right">Actions</span>
          </div>
        }
      />
    </div>
  );
}
