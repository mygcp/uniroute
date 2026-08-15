import { useEffect, useMemo, useState } from "react";
import { useFetcher } from "react-router";
import type { Route } from "./+types/logs._index";
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

const STATUS_TONE: Record<string, "success" | "warning" | "danger" | "neutral"> =
  {
    success: "success",
    timeout: "warning",
    error: "danger",
    denied: "neutral",
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
    <div className="mt-2 rounded-lg border border-border bg-muted px-4 py-3">
      <h3 className="mb-2 text-sm font-semibold text-foreground">Request details</h3>
      <dl className="grid grid-cols-1 gap-1.5 sm:grid-cols-2 md:grid-cols-3">
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
        <Badge tone={STATUS_TONE[String(event.status)] ?? "neutral"}>
          {String(event.status)}
        </Badge>
        <span className="truncate font-medium text-foreground sm:max-w-[220px]">
          {String(event.model ?? "-")}
        </span>
        <span className="truncate text-muted-foreground sm:max-w-[140px]">
          {String(event.provider_id ?? "-")}
        </span>
        <span className="hidden rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground md:inline">
          {sourceLabel(event)}
        </span>
        <span className="ml-auto text-xs text-muted-foreground">
          {event.duration_ms != null ? `${event.duration_ms}ms` : ""}
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
      {event.error_message ? (
        <div className="mt-1 truncate text-xs text-danger">
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
  const { toast } = useToast();
  const { confirm, dialog } = useConfirm();
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

  async function handleClear() {
    const ok = await confirm({
      title: "Clear all request logs?",
      description: "This removes every request log from the active view. This action cannot be undone.",
      variant: "danger",
    });
    if (!ok) return;
    clearFetcher.submit({ scope: "request" }, { method: "POST", action: "/api/logs/clear" });
  }

  async function handleDelete(id: number, type: "request") {
    const ok = await confirm({
      title: "Delete this log?",
      description: "This request log will be removed from the active view.",
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

  const activeFilters = Boolean(model || provider || status || source);

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-bold text-foreground">Request Logs</h1>
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
          options={options.model}
          value={model}
          onChange={setModel}
          placeholder="Search model…"
          className="w-40 rounded-lg border border-border px-3 py-1.5 text-sm text-foreground"
        />
        <Combobox
          options={options.provider}
          value={provider}
          onChange={setProvider}
          placeholder="Search provider…"
          className="w-40 rounded-lg border border-border px-3 py-1.5 text-sm text-foreground"
        />
        <Combobox
          options={OPTIONS.statuses}
          value={status}
          onChange={setStatus}
          placeholder="Status"
          className="w-32 rounded-lg border border-border px-3 py-1.5 text-sm text-foreground"
        />
        <Combobox
          options={options.source}
          value={source}
          onChange={setSource}
          placeholder="Source (direct / combo)…"
          className="w-44 rounded-lg border border-border px-3 py-1.5 text-sm text-foreground"
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
        type="request"
        scrollRef={scrollRef}
        emptyMessage="No matching request logs yet. Route a request through the proxy to see it appear live."
        renderRow={(event) => {
          const key = `${event.id ?? event.created_at}`;
          return (
            <Row
              event={event}
              selected={selectedId === key}
              onSelect={() => setSelectedId(selectedId === key ? null : key)}
              onDelete={() => handleDelete(Number(event.id), "request")}
            />
          );
        }}
      />
    </div>
  );
}
