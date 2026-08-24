import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useFetcher } from "react-router";
import type { Route } from "./+types/logs.proxy";
import { query } from "../.server/db";
import { Combobox } from "../components/combobox";
import {
  useRealtimeLogs,
  type LogEvent,
} from "../hooks/use-realtime-logs";
import { useToast } from "../components/ui/toast";
import { useConfirm } from "../components/ui/confirm-dialog";
import { Badge } from "../components/ui/badge";
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
  return [{ title: "Proxy Logs — UniRoute" }];
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

/** Strip meta ringkas untuk baris kedua: ip · key · provider · proxy · endpoint · latency. */
/** Teks proxy untuk baris kedua (host:port). Null bila tidak lewat proxy. */
function proxyLine(event: LogEvent): string | null {
  if (event.proxy_id == null && !event.proxy_host) return null;
  const host = String(event.proxy_host ?? "?");
  const port = event.proxy_port != null ? String(event.proxy_port) : "";
  return port ? `${host}:${port}` : host;
}

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

  return (
    <div
      onClick={() => onSelect(key)}
      className={`cursor-pointer border-b border-border px-2 py-1.5 text-sm transition-colors hover:bg-muted ${
        selected ? "bg-primary/10" : ""
      }`}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="w-full text-xs text-muted-foreground sm:w-24 sm:shrink-0">
          {fmtTs(event.created_at)}
        </span>
        <Badge tone={LEVEL_TONE[String(event.level)] ?? "neutral"}>
          {String(event.level)}
        </Badge>
        <span
          className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground"
          title={`source: ${String(event.source)}`}
        >
          {String(event.source)}
        </span>
        <span className="min-w-0 flex-1 truncate text-foreground" title={message}>
          {message}
        </span>
        <button
          type="button"
          title={selected ? "Close details" : "Inspect"}
          onClick={(e) => {
            e.stopPropagation();
            onSelect(key);
          }}
          className="rounded border border-border px-1.5 text-xs text-muted-foreground hover:bg-muted"
        >
          {selected ? "▾" : "▸"}
        </button>
        <button
          type="button"
          title="Delete"
          aria-label="Delete"
          onClick={(e) => {
            e.stopPropagation();
            onDelete(Number(event.id));
          }}
          className="rounded border border-border px-1.5 text-xs text-danger hover:bg-danger/10"
        >
          ✕
        </button>
      </div>
      {proxyLine(event) ? (
        <div className="mt-0.5 flex items-center gap-1 pl-6 text-[11px] leading-none font-mono text-muted-foreground sm:pl-[7.5rem]">
          <span aria-hidden>↳</span>
          <span className="truncate" title={`proxy: ${proxyLine(event)}`}>
            {proxyLine(event)}
          </span>
        </div>
      ) : null}
      {selected ? <Detail event={event} /> : null}
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
    }
  }, [deleteFetcher.state, deleteFetcher.data, pendingDelete]);

  useEffect(() => {
    if (clearFetcher.state === "idle" && clearFetcher.data) {
      reset([]);
    }
  }, [clearFetcher.state, clearFetcher.data]);

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
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-bold text-foreground">Proxy Logs</h1>
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">{filtered.length} shown</span>
          <button
            type="button"
            onClick={handleClear}
            className="rounded-lg border border-danger/30 px-2.5 py-1 text-xs font-medium text-danger hover:bg-danger/10"
          >
            Clear
          </button>
        </div>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Combobox
          options={OPTIONS.levels}
          value={level}
          onChange={setLevel}
          placeholder="Level"
          className="w-32 rounded-lg border border-border px-3 py-1.5 text-sm text-foreground"
        />
        <Combobox
          options={options.source}
          value={source}
          onChange={setSource}
          placeholder="Search source…"
          className="w-40 rounded-lg border border-border px-3 py-1.5 text-sm text-foreground"
        />
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search message / metadata…"
          className="w-56 rounded-lg border border-border px-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground"
        />
        {activeFilters ? (
          <button
            type="button"
            onClick={() => {
              setLevel("");
              setSource("");
              setSearch("");
            }}
            className="rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted"
          >
            Clear filters
          </button>
        ) : null}
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
      />
    </div>
  );
}
