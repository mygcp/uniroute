import { useEffect, useMemo, useState } from "react";
import { useFetcher } from "react-router";
import type { Route } from "./+types/logs._index";
import { query } from "../.server/db";
import { Combobox } from "../components/combobox";
import {
  useRealtimeLogs,
  type LogEvent,
} from "../hooks/use-realtime-logs";

const REQUEST_COLS =
  `id, model, provider_id, strategy_used, rule_applied, duration_ms,
   status, error_message, prompt_tokens, completion_tokens, api_key_id, created_at`;

export function meta() {
  return [{ title: "Request Logs — UniRoute" }];
}

export function loader() {
  const reqRows = query(
    `SELECT ${REQUEST_COLS} FROM request_logs ORDER BY id DESC LIMIT 500`,
  ).all() as Record<string, unknown>[];

  const request: LogEvent[] = reqRows
    .map((r) => ({
      type: "request" as const,
      created_at: Number(r.created_at),
      ...r,
    }))
    .reverse();

  return { initial: request };
}

function fmtTs(ts: number): string {
  const ms = ts < 1e12 ? ts * 1000 : ts;
  return new Date(ms).toLocaleString();
}

const STATUS_COLORS: Record<string, string> = {
  success: "bg-green-100 text-green-700 dark:bg-green-500/15 dark:text-green-300",
  error: "bg-red-100 text-red-700 dark:bg-red-500/15 dark:text-red-300",
  timeout: "bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300",
  denied: "bg-gray-200 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
};

/**
 * Combo requests are labelled with their combo strategy (e.g. `combo:failover`).
 * Everything else goes straight to a provider — label it "direct".
 */
function sourceLabel(e: LogEvent): string {
  const strategy = String(e.strategy_used ?? "").trim();
  if (strategy.startsWith("combo:")) return strategy;
  if (strategy) return strategy;
  return "direct";
}

const OPTIONS = {
  models: (logs: LogEvent[]) =>
    [...new Set(logs.map((l) => String(l.model ?? "")).filter(Boolean))].sort(),
  providers: (logs: LogEvent[]) =>
    [...new Set(logs.map((l) => String(l.provider_id ?? "")).filter(Boolean))].sort(),
  sources: (logs: LogEvent[]) =>
    [...new Set(logs.map(sourceLabel))].sort(),
  statuses: ["success", "error", "timeout", "denied"],
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

  const fields: Array<[string, string | number | boolean | null | undefined]> = [
    ["id", event.id],
    ["model", event.model as string],
    ["provider_id", event.provider_id as string],
    ["source", sourceLabel(event)],
    ["strategy_used", event.strategy_used as string],
    ["rule_applied", event.rule_applied as string],
    ["status", event.status as string],
    ["duration_ms", event.duration_ms as number],
    ["prompt_tokens", event.prompt_tokens as number],
    ["completion_tokens", event.completion_tokens as number],
    ["api_key_id", event.api_key_id as number],
    ["error_message", event.error_message as string],
    ["created_at", fmtTs(Number(event.created_at))],
  ];

  return (
    <div className="mt-2 rounded-lg border border-gray-200 bg-gray-50 px-4 py-3 dark:border-gray-800 dark:bg-gray-950">
      <h3 className="mb-2 text-sm font-semibold text-gray-900 dark:text-white">Request details</h3>
      <dl className="grid grid-cols-1 gap-1.5 sm:grid-cols-2 md:grid-cols-3">
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
          className={`rounded-full px-2 py-0.5 text-xs font-medium ${
            STATUS_COLORS[String(event.status)] ?? "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300"
          }`}
        >
          {String(event.status)}
        </span>
        <span className="truncate font-medium text-gray-900 dark:text-white sm:max-w-[220px]">
          {String(event.model ?? "-")}
        </span>
        <span className="truncate text-gray-500 sm:max-w-[140px]">
          {String(event.provider_id ?? "-")}
        </span>
        <span className="hidden rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-600 dark:bg-gray-800 dark:text-gray-300 md:inline">
          {sourceLabel(event)}
        </span>
        <span className="ml-auto text-xs text-gray-500">
          {event.duration_ms != null ? `${event.duration_ms}ms` : ""}
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
      {event.error_message ? (
        <div className="mt-1 truncate text-xs text-red-500 dark:text-red-400">
          {String(event.error_message)}
        </div>
      ) : null}
      {selected ? <Detail event={event} /> : null}
    </div>
  );
}

export default function Logs({ loaderData }: Route.ComponentProps) {
  const [model, setModel] = useState("");
  const [provider, setProvider] = useState("");
  const [status, setStatus] = useState("");
  const [source, setSource] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{ id: number; type: "request" } | null>(null);
  const clearFetcher = useFetcher();
  const deleteFetcher = useFetcher();
  const { logs, connected, paused, setPaused, scrollRef, remove, reset } =
    useRealtimeLogs((l) => l.type === "request", loaderData.initial);

  const options = useMemo(
    () => ({
      model: OPTIONS.models(logs),
      provider: OPTIONS.providers(logs),
      source: OPTIONS.sources(logs),
    }),
    [logs],
  );

  const filtered = useMemo(() => {
    const modelQ = model.trim().toLowerCase();
    const providerQ = provider.trim().toLowerCase();
    const sourceQ = source.trim().toLowerCase();
    return logs.filter((l) => {
      if (modelQ && !String(l.model ?? "").toLowerCase().includes(modelQ)) return false;
      if (providerQ && !String(l.provider_id ?? "").toLowerCase().includes(providerQ)) return false;
      if (status && String(l.status ?? "") !== status) return false;
      if (sourceQ && !sourceLabel(l).toLowerCase().includes(sourceQ)) return false;
      return true;
    });
  }, [logs, model, provider, status, source]);

  function handleDelete(id: number, type: "request") {
    setPendingDelete({ id, type });
    deleteFetcher.submit(
      { id: String(id), type },
      { method: "POST", action: "/api/logs/delete" },
    );
  }

  function handleClear() {
    clearFetcher.submit({ scope: "request" }, { method: "POST", action: "/api/logs/clear" });
  }

  useEffect(() => {
    const d = deleteFetcher.data;
    if (
      deleteFetcher.state === "idle" &&
      d &&
      (d as { ok?: boolean }).ok &&
      pendingDelete
    ) {
      remove(pendingDelete.id, pendingDelete.type);
      setPendingDelete(null);
    }
  }, [deleteFetcher.state, deleteFetcher.data, pendingDelete]);

  useEffect(() => {
    if (clearFetcher.state === "idle" && clearFetcher.data) {
      reset([]);
    }
  }, [clearFetcher.state, clearFetcher.data]);

  const activeFilters = Boolean(model || provider || status || source);

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-bold text-gray-900 dark:text-white">Request Logs</h1>
        <div className="flex items-center gap-2">
          <span className="text-sm text-gray-500 dark:text-gray-400">
            {filtered.length} shown
          </span>
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
          options={options.model}
          value={model}
          onChange={setModel}
          placeholder="Search model…"
          className="w-40 rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-800 dark:text-white"
        />
        <Combobox
          options={options.provider}
          value={provider}
          onChange={setProvider}
          placeholder="Search provider…"
          className="w-40 rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-800 dark:text-white"
        />
        <Combobox
          options={OPTIONS.statuses}
          value={status}
          onChange={setStatus}
          placeholder="Status"
          className="w-32 rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-800 dark:text-white"
        />
        <Combobox
          options={options.source}
          value={source}
          onChange={setSource}
          placeholder="Source (direct / combo)…"
          className="w-44 rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-800 dark:text-white"
        />
        {activeFilters ? (
          <button
            type="button"
            onClick={() => {
              setModel("");
              setProvider("");
              setStatus("");
              setSource("");
            }}
            className="rounded-lg border border-gray-300 px-2.5 py-1.5 text-xs font-medium text-gray-500 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-400 dark:hover:bg-gray-800"
          >
            Clear filters
          </button>
        ) : null}
      </div>

      {!connected ? (
        <div className="mb-3 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
          Connection to live logs lost — reconnecting…
        </div>
      ) : null}
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
              No matching request logs yet. Route a request through the proxy to see it appear live.
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
                  onDelete={() => handleDelete(Number(e.id), "request")}
                />
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}