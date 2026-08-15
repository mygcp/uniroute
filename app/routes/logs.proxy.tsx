import { useMemo, useState } from "react";
import { useFetcher } from "react-router";
import type { Route } from "./+types/logs.proxy";
import { query } from "../.server/db";
import { Combobox } from "../components/combobox";
import {
  useRealtimeLogs,
  type LogEvent,
} from "../hooks/use-realtime-logs";

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

const LEVEL_COLORS: Record<string, string> = {
  info: "bg-blue-100 text-blue-700 dark:bg-blue-500/15 dark:text-blue-300",
  warn: "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300",
  error: "bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300",
  debug: "bg-gray-200 text-gray-600 dark:bg-gray-800 dark:text-gray-300",
};

const OPTIONS = {
  levels: ["info", "warn", "error", "debug"],
  sources: (logs: LogEvent[]) =>
    [...new Set(logs.map((l) => String(l.source ?? "")).filter(Boolean))].sort(),
};

function Detail({ event }: { event: LogEvent }) {
  const printable = (entry: unknown): string => {
    if (entry === null || entry === undefined) return "—";
    if (typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean") {
      return String(entry);
    }
    try {
      return JSON.stringify(entry, null, 2);
    } catch {
      return String(entry);
    }
  };

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
    <div className="mt-2 rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 dark:border-gray-800 dark:bg-gray-950">
      <h3 className="mb-2 text-sm font-semibold text-gray-900 dark:text-white">Proxy log detail</h3>
      <dl className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
        {fields.map(([k, v]) => (
          <div key={k} className="flex gap-2">
            <dt className="shrink-0 text-xs font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-500">
              {k}
            </dt>
            <dd
              className="min-w-0 truncate text-xs text-gray-700 dark:text-gray-300"
              title={printable(v)}
            >
              {printable(v)}
            </dd>
          </div>
        ))}
      </dl>
      {metadata ? (
        <details className="mt-3">
          <summary className="cursor-pointer text-xs font-semibold text-gray-500 dark:text-gray-400">
            Metadata
          </summary>
          <pre className="mt-2 max-h-72 overflow-auto rounded-lg bg-gray-100 p-3 text-xs text-gray-800 dark:bg-gray-900 dark:text-gray-200">
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
      className={`cursor-pointer border-b border-gray-100 px-3 py-2 text-sm transition-colors hover:bg-gray-50 dark:border-gray-800 dark:hover:bg-gray-800/60 ${
        selected ? "bg-blue-50 dark:bg-blue-950/40" : ""
      }`}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="w-full text-xs text-gray-400 sm:w-24 sm:shrink-0">
          {fmtTs(event.created_at)}
        </span>
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-medium uppercase ${
            LEVEL_COLORS[String(event.level)] ?? "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300"
          }`}
        >
          {String(event.level)}
        </span>
        <span className="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-600 dark:bg-gray-800 dark:text-gray-300">
          {String(event.source)}
        </span>
        <span className="min-w-0 flex-1 truncate text-gray-800 dark:text-gray-200">
          {String(event.message)}
        </span>
        <button
          type="button"
          title={selected ? "Close details" : "Inspect"}
          onClick={(e) => {
            e.stopPropagation();
            onSelect();
          }}
          className="rounded border border-gray-300 px-1.5 text-xs text-gray-500 hover:bg-gray-100 dark:border-gray-600 dark:text-gray-400 dark:hover:bg-gray-700"
        >
          {selected ? "▾" : "▸"}
        </button>
        <button
          type="button"
          title="Delete"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          className="rounded border border-gray-300 px-1.5 text-xs text-red-500 hover:bg-red-50 dark:border-gray-600 dark:hover:bg-red-950"
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
  const { logs, paused, setPaused, scrollRef, remove, reset } =
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

  function handleDelete(id: number, type: "proxy") {
    setPendingDelete({ id, type });
    deleteFetcher.submit(
      { id: String(id), type },
      { method: "POST", action: "/api/logs/delete" },
    );
  }

  function handleClear() {
    clearFetcher.submit({ scope: "proxy" }, { method: "POST", action: "/api/logs/clear" });
  }

  const activeFilters = Boolean(level || source);

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-bold text-gray-900 dark:text-white">Proxy Logs</h1>
        <div className="flex items-center gap-2">
          <span className="text-sm text-gray-500 dark:text-gray-400">{filtered.length} shown</span>
          <button
            type="button"
            onClick={handleClear}
            className="rounded-lg border border-red-300 px-2.5 py-1 text-xs font-medium text-red-600 hover:bg-red-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950"
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
          className="w-32 rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-800 dark:text-white"
        />
        <Combobox
          options={options.source}
          value={source}
          onChange={setSource}
          placeholder="Search source…"
          className="w-40 rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-800 dark:text-white"
        />
        {activeFilters ? (
          <button
            type="button"
            onClick={() => {
              setLevel("");
              setSource("");
            }}
            className="rounded-lg border border-gray-300 px-2.5 py-1.5 text-xs font-medium text-gray-500 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-400 dark:hover:bg-gray-800"
          >
            Clear filters
          </button>
        ) : null}
      </div>

      <div className="flex h-[calc(100vh-330px)] flex-col rounded-xl border border-gray-200 bg-white shadow-sm dark:border-gray-800 dark:bg-gray-900 sm:h-[calc(100vh-290px)]">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-200 px-3 py-2 dark:border-gray-800 sm:px-4 sm:py-3">
          <div className="flex items-center gap-2 sm:gap-3">
            <span className="text-sm font-medium text-gray-700 dark:text-gray-200">
              {filtered.length} event
            </span>
            <span
              className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${
                paused
                  ? "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300"
                  : "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300"
              }`}
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${paused ? "bg-amber-500" : "bg-green-500 animate-pulse"}`}
              />
              {paused ? "paused" : "live"}
            </span>
          </div>
          <button
            type="button"
            onClick={() => setPaused(!paused)}
            className="rounded-lg border border-gray-300 px-3 py-1 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
          >
            {paused ? "Resume" : "Pause"}
          </button>
        </div>
        <div ref={scrollRef} className="flex-1 overflow-y-auto">
          {filtered.length === 0 ? (
            <p className="py-10 text-center text-sm text-gray-400 dark:text-gray-500">
              No proxy logs yet. They appear here as requests are routed through the proxy.
            </p>
          ) : (
            filtered.map((e) => {
              const key = `${e.id ?? e.created_at}`;
              return (
                <Row
                  key={key}
                  event={e}
                  selected={selectedId === key}
                  onSelect={() => setSelectedId(selectedId === key ? null : key)}
                  onDelete={() => handleDelete(Number(e.id), "proxy")}
                />
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}