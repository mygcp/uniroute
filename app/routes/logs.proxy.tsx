import { useEffect, useMemo, useState } from "react";
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

const COLS = `id, level, source, message, metadata, created_at`;

export function meta() {
  return [{ title: "Proxy Logs — UniRoute" }];
}

export function loader() {
  const rows = query(
    `SELECT ${COLS} FROM proxy_logs ORDER BY id DESC LIMIT 500`,
  ).all() as Record<string, unknown>[];

  const proxy: LogEvent[] = rows
    .map((r) => ({
      type: "proxy" as const,
      created_at: Number(r.created_at),
      ...r,
    }))
    .reverse();

  return { initial: proxy };
}

function fmtTs(ts: number): string {
  const ms = ts < 1e12 ? ts * 1000 : ts;
  return new Date(ms).toLocaleString();
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

function printable(entry: unknown): string {
  if (entry === null || entry === undefined) return "—";
  if (typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean") {
    return String(entry);
  }
  try {
    return JSON.stringify(entry, null, 2);
  } catch {
    return String(entry);
  }
}

function Detail({ event }: { event: LogEvent }) {
  let metadata: Record<string, unknown> | null = null;
  if (typeof event.metadata === "string") {
    try {
      metadata = JSON.parse(event.metadata);
    } catch {
      metadata = null;
    }
  } else if (event.metadata && typeof event.metadata === "object") {
    metadata = event.metadata as Record<string, unknown>;
  }

  const fields: Array<[string, string | number | boolean | null | undefined]> = [
    ["id", event.id],
    ["level", event.level as string],
    ["source", event.source as string],
    ["message", event.message as string],
    ["created_at", fmtTs(Number(event.created_at))],
  ];

  return (
    <div className="mt-2 rounded-lg border border-border bg-muted px-4 py-3">
      <h3 className="mb-2 text-sm font-semibold text-foreground">Proxy log detail</h3>
      <dl className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
        {fields.map(([k, v]) => (
          <div key={k} className="flex gap-2">
            <dt className="shrink-0 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {k}
            </dt>
            <dd
              className="min-w-0 truncate text-xs text-muted-foreground"
              title={printable(v)}
            >
              {printable(v)}
            </dd>
          </div>
        ))}
      </dl>
      {metadata ? (
        <details className="mt-3">
          <summary className="cursor-pointer text-xs font-semibold text-muted-foreground">
            Metadata
          </summary>
          <pre className="mt-2 max-h-72 overflow-auto rounded-lg bg-muted px-3 py-2 text-xs text-foreground">
            {JSON.stringify(metadata, null, 2)}
          </pre>
        </details>
      ) : null}
    </div>
  );
}

function Row({
  event,
  selected,
  onSelect,
  onDelete,
}: {
  event: LogEvent;
  selected: boolean;
  onSelect: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      onClick={onSelect}
      className={`cursor-pointer border-b border-border px-3 py-2 text-sm transition-colors hover:bg-muted ${
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
        <span className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">
          {String(event.source)}
        </span>
        <span className="min-w-0 flex-1 truncate text-foreground">
          {String(event.message)}
        </span>
        <button
          type="button"
          title={selected ? "Close details" : "Inspect"}
          onClick={(e) => {
            e.stopPropagation();
            onSelect();
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
            onDelete();
          }}
          className="rounded border border-border px-1.5 text-xs text-danger hover:bg-danger/10"
        >
          ✕
        </button>
      </div>
      {selected ? <Detail event={event} /> : null}
    </div>
  );
}

export default function LogsProxy({ loaderData }: Route.ComponentProps) {
  const [level, setLevel] = useState("");
  const [source, setSource] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{ id: number; type: "proxy" } | null>(null);
  const clearFetcher = useFetcher();
  const deleteFetcher = useFetcher();
  const { toast } = useToast();
  const { confirm, dialog } = useConfirm();
  const { logs, connected, paused, setPaused, scrollRef, remove, reset } =
    useRealtimeLogs((l) => l.type === "proxy", loaderData.initial);

  const options = useMemo(() => ({ source: OPTIONS.sources(logs) }), [logs]);

  const filtered = useMemo(() => {
    const sourceQ = source.trim().toLowerCase();
    return logs.filter((l) => {
      if (level && String(l.level ?? "") !== level) return false;
      if (sourceQ && !String(l.source ?? "").toLowerCase().includes(sourceQ)) return false;
      return true;
    });
  }, [logs, level, source]);

  async function handleClear() {
    const ok = await confirm({
      title: "Clear all proxy logs?",
      description: "This removes every proxy log from the active view. This action cannot be undone.",
      variant: "danger",
    });
    if (!ok) return;
    clearFetcher.submit({ scope: "proxy" }, { method: "POST", action: "/api/logs/clear" });
  }

  async function handleDelete(id: number, type: "proxy") {
    const ok = await confirm({
      title: "Delete this log?",
      description: "This proxy log will be removed from the active view.",
      variant: "danger",
    });
    if (!ok) return;
    setPendingDelete({ id, type });
    deleteFetcher.submit(
      { id: String(id), type },
      { method: "POST", action: "/api/logs/delete" },
    );
  }

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

  const activeFilters = Boolean(level || source);

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
        {activeFilters ? (
          <button
            type="button"
            onClick={() => {
              setLevel("");
              setSource("");
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
        renderRow={(event) => {
          const key = `${event.id ?? event.created_at}`;
          return (
            <Row
              event={event}
              selected={selectedId === key}
              onSelect={() => setSelectedId(selectedId === key ? null : key)}
              onDelete={() => handleDelete(Number(event.id), "proxy")}
            />
          );
        }}
      />
    </div>
  );
}
