import { memo, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useFetcher } from "react-router";
import type { Route } from "./+types/logs._index";
import { query } from "../.server/db";
import { getPrice } from "../.server/pricing";
import { Combobox } from "../components/combobox";
import {
  useRealtimeLogs,
  type LogEvent,
} from "../hooks/use-realtime-logs";
import { useToast } from "../components/ui/toast";
import { Spinner } from "../components/ui/feedback";
import { useConfirm } from "../components/ui/confirm-dialog";
import { Badge } from "../components/ui/badge";
import { LogViewer } from "../components/log-viewer";
import {
  costOf,
  fmtNum,
  fmtTs,
  fmtTokensShort,
  fmtUsd,
  keyLabelOf,
  priceKeyOf,
  printable,
  sourceLabel,
  totalTokens,
  type KeyLabelMap,
  type PriceMap,
} from "../lib/log-format";

const REQUEST_COLS = `
  r.id, r.model, r.provider_id, r.strategy_used, r.rule_applied, r.duration_ms,
  r.status, r.error_message, r.prompt_tokens, r.completion_tokens, r.cached_tokens,
  r.api_key_id, r.created_at, r.via_proxy, r.proxy_id, r.endpoint, r.upstream_tls,
  k.name AS api_key_name, k.key_prefix AS api_key_prefix,
  op.name AS proxy_name, op.host AS proxy_host, op.port AS proxy_port`;

export function meta() {
  return [{ title: "Request Logs — UniRoute" }];
}

export function loader() {
  const reqRows = query(
    `SELECT ${REQUEST_COLS} FROM request_logs r
       LEFT JOIN client_api_keys k ON k.id = r.api_key_id
       LEFT JOIN outbound_proxies op ON op.id = r.proxy_id
      ORDER BY r.id DESC LIMIT 500`,
  ).all() as Record<string, unknown>[];

  // Peta harga per kombinasi model::provider (untuk estimasi biaya di UI,
  // termasuk untuk event realtime yang datang setelah halaman dimuat).
  const combos = query(
    `SELECT DISTINCT model, provider_id FROM request_logs WHERE model IS NOT NULL`,
  ).all() as { model: string; provider_id: string | null }[];
  const prices: PriceMap = {};
  for (const c of combos) {
    const { input, output } = getPrice(c.model, c.provider_id);
    prices[priceKeyOf(c.model, c.provider_id)] = { input, output };
  }

  // Label api key agar detail menampilkan nama key, bukan hanya id numerik.
  const keyRows = query(
    "SELECT id, name, key_prefix FROM client_api_keys ORDER BY id ASC",
  ).all() as { id: number; name: string | null; key_prefix: string }[];
  const keyLabels: KeyLabelMap = {};
  for (const k of keyRows) {
    keyLabels[String(k.id)] =
      k.name?.trim() || k.key_prefix?.trim() || `#${k.id}`;
  }

  const request: LogEvent[] = reqRows
    .map((r) => ({
      type: "request" as const,
      created_at: Number(r.created_at),
      ...r,
    }));
  // Terbaru di atas — SQL sudah ORDER BY r.id DESC.

  return { initial: request, prices, keyLabels };
}

const STATUS_TONE: Record<string, "success" | "warning" | "danger" | "neutral"> =
  {
    success: "success",
    timeout: "warning",
    error: "danger",
    denied: "neutral",
  };

const OPTIONS = {
  models: (logs: LogEvent[]) =>
    [...new Set(logs.map((l) => String(l.model ?? "")).filter(Boolean))].sort(),
  providers: (logs: LogEvent[]) =>
    [...new Set(logs.map((l) => String(l.provider_id ?? "")).filter(Boolean))].sort(),
  sources: (logs: LogEvent[]) =>
    [...new Set(logs.map(sourceLabel))].sort(),
  statuses: ["success", "error", "timeout", "denied"],
};

function Detail({
  event,
  prices,
  keyLabels,
}: {
  event: LogEvent;
  prices: PriceMap;
  keyLabels: KeyLabelMap;
}) {
  const pt = event.prompt_tokens == null ? null : Number(event.prompt_tokens);
  const ct =
    event.completion_tokens == null ? null : Number(event.completion_tokens);
  const total = totalTokens(event);
  const keyId = event.api_key_id == null ? null : Number(event.api_key_id);
  const keyLabel = keyLabelOf(event, keyLabels);

  const fields: Array<[string, string | number | boolean | null | undefined]> = [
    ["id", event.id],
    ["created_at", fmtTs(Number(event.created_at))],
    ["epoch_ms", Number(event.created_at)],
    ["status", event.status as string],
    ["duration_ms", event.duration_ms as number],
    ["model", event.model as string],
    ["provider_id", event.provider_id as string],
    ["source", sourceLabel(event)],
    ["strategy_used", event.strategy_used as string],
    ["rule_applied", event.rule_applied as string],
    [
      "api_key",
      keyId == null
        ? null
        : `${keyLabel} (#${keyId})`,
    ],
    ["prompt_tokens", pt == null ? null : fmtNum(pt)],
    ["completion_tokens", ct == null ? null : fmtNum(ct)],
    [
      "cached_tokens",
      event.cached_tokens == null ? null : fmtNum(Number(event.cached_tokens)),
    ],
    ["total_tokens", total == null ? null : fmtNum(total)],
    ["est_cost", fmtUsd(costOf(event, prices))],
    [
      "transport",
      event.via_proxy === 1
        ? "proxy"
        : event.via_proxy === 0
          ? "direct"
          : null,
    ],
    [
      "proxy",
      event.proxy_id == null
        ? null
        : `${String(event.proxy_name ?? "proxy")} (${String(
            event.proxy_host ?? "?",
          )}:${String(event.proxy_port ?? "?")}) #${event.proxy_id}`,
    ],
    ["endpoint", event.endpoint as string],
    [
      "upstream_tls",
      event.upstream_tls == null ? null : event.upstream_tls === 1 ? "https" : "http",
    ],
  ];

  return (
    <div className="mt-2 rounded-lg border border-border bg-muted px-3 py-3">
      <h3 className="mb-2 text-sm font-semibold text-foreground">Request details</h3>
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
      {event.error_message ? (
        <div className="mt-3">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-danger">
            Error message
          </h4>
          <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-danger/10 px-3 py-2 font-mono text-xs text-danger">
            {String(event.error_message)}
          </pre>
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
  prices,
  keyLabels,
}: {
  event: LogEvent;
  selected: boolean;
  onSelect: (key: string) => void;
  onDelete: (id: number) => void;
  prices: PriceMap;
  keyLabels: KeyLabelMap;
}) {
  const key = `${event.id ?? event.created_at}`;
  const tokensShort = fmtTokensShort(event);
  const tokenTitle =
    event.prompt_tokens == null && event.completion_tokens == null
      ? undefined
      : `prompt ${fmtNum(event.prompt_tokens as number)} / completion ${fmtNum(
          event.completion_tokens as number,
        )} tokens`;
  const keyLabelText = keyLabelOf(event, keyLabels);

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
        <Badge tone={STATUS_TONE[String(event.status)] ?? "neutral"}>
          {String(event.status)}
        </Badge>
        <span
          className="truncate font-medium text-foreground sm:max-w-[220px]"
          title={printable(event.model)}
        >
          {String(event.model ?? "-")}
        </span>
        <span
          className="truncate text-muted-foreground sm:max-w-[140px]"
          title={printable(event.provider_id)}
        >
          {String(event.provider_id ?? "-")}
        </span>
        <span
          className="hidden rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground md:inline"
          title={`source: ${sourceLabel(event)}${
            event.rule_applied ? ` · rule: ${String(event.rule_applied)}` : ""
          }`}
        >
          {sourceLabel(event)}
        </span>
        {event.via_proxy === 1 ? (
          <span
            className="rounded bg-primary/15 px-1.5 py-0.5 text-[11px] font-medium text-primary"
            title={`via proxy: ${String(event.proxy_name ?? "")} (${String(
              event.proxy_host ?? "",
            )}:${String(event.proxy_port ?? "")})`}
          >
            PROXY
          </span>
        ) : (
          <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">
            DIRECT
          </span>
        )}
        {tokensShort ? (
          <span
            className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground"
            title={tokenTitle}
          >
            {tokensShort} tok
          </span>
        ) : null}
        {keyLabelText ? (
          <span
            className="hidden max-w-[140px] truncate rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground lg:inline"
            title={`API key: ${keyLabelText}${
              event.api_key_id != null ? ` (#${event.api_key_id})` : ""
            }`}
          >
            {keyLabelText}
          </span>
        ) : null}
        <span className="ml-auto text-xs text-muted-foreground">
          {event.duration_ms != null
            ? `${fmtNum(Number(event.duration_ms))}ms · ${fmtUsd(costOf(event, prices))}`
            : ""}
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
      {event.error_message ? (
        <div className="mt-1 truncate text-xs text-danger" title={String(event.error_message)}>
          {String(event.error_message)}
        </div>
      ) : null}
      {selected ? (
        <Detail event={event} prices={prices} keyLabels={keyLabels} />
      ) : null}
    </div>
  );
});

export default function Logs({ loaderData }: Route.ComponentProps) {
  const { prices, keyLabels } = loaderData;
  const [model, setModel] = useState("");
  const [provider, setProvider] = useState("");
  const [status, setStatus] = useState("");
  const [source, setSource] = useState("");
  const [search, setSearch] = useState("");
  const [transport, setTransport] = useState<"" | "proxy" | "direct">("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<{ id: number; type: "request" } | null>(null);
  const clearFetcher = useFetcher();
  const deleteFetcher = useFetcher();
  const { toast } = useToast();
  const { confirm, dialog } = useConfirm();
  const {
    logs,
    connected,
    paused,
    setPaused,
    scrollRef,
    remove,
    reset,
    inflight,
  } = useRealtimeLogs((l) => l.type === "request", loaderData.initial, {
    newestFirst: true,
  });

  const deferredModel = useDeferredValue(model);
  const deferredProvider = useDeferredValue(provider);
  const deferredStatus = useDeferredValue(status);
  const deferredSource = useDeferredValue(source);
  const deferredSearch = useDeferredValue(search);
  const deferredTransport = useDeferredValue(transport);

  const options = useMemo(
    () => ({
      model: OPTIONS.models(logs),
      provider: OPTIONS.providers(logs),
      source: OPTIONS.sources(logs),
    }),
    [logs],
  );

  const filtered = useMemo(() => {
    const modelQ = deferredModel.trim().toLowerCase();
    const providerQ = deferredProvider.trim().toLowerCase();
    const sourceQ = deferredSource.trim().toLowerCase();
    const searchQ = deferredSearch.trim().toLowerCase();
    return logs.filter((l) => {
      if (modelQ && !String(l.model ?? "").toLowerCase().includes(modelQ)) return false;
      if (providerQ && !String(l.provider_id ?? "").toLowerCase().includes(providerQ)) return false;
      if (deferredStatus && String(l.status ?? "") !== deferredStatus) return false;
      if (sourceQ && !sourceLabel(l).toLowerCase().includes(sourceQ)) return false;
      if (
        deferredTransport === "proxy" && l.via_proxy !== 1
      )
        return false;
      if (deferredTransport === "direct" && l.via_proxy !== 0) return false;
      if (
        searchQ &&
        !`${String(l.model ?? "")} ${String(l.provider_id ?? "")} ${String(
          l.error_message ?? "",
        )} ${String(l.rule_applied ?? "")}`.toLowerCase().includes(searchQ)
      )
        return false;
      return true;
    });
  }, [logs, deferredModel, deferredProvider, deferredStatus, deferredSource, deferredSearch, deferredTransport]);

  async function handleClear() {
    const ok = await confirm({
      title: "Clear all request logs?",
      description: "This permanently removes every request log from the database. This action cannot be undone.",
      variant: "danger",
    });
    if (!ok) return;
    clearFetcher.submit({ scope: "request" }, { method: "POST", action: "/api/logs/clear" });
  }

  const deleteFetcherRef = useRef(deleteFetcher);
  deleteFetcherRef.current = deleteFetcher;

  const toggleSelect = useCallback((key: string) => {
    setSelectedId((cur) => (cur === key ? null : key));
  }, []);

  const handleDelete = useCallback(
    async (id: number, type: "request") => {
      const ok = await confirm({
        title: "Delete this log?",
        description: "This request log will be permanently removed from the database.",
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

  const deleteRequest = useCallback(
    (id: number) => handleDelete(id, "request"),
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

  const activeFilters = Boolean(
    model || provider || status || source || search || transport,
  );

  const renderRow = useCallback(
    (event: LogEvent) => (
      <Row
        event={event}
        selected={selectedId === `${event.id ?? event.created_at}`}
        onSelect={toggleSelect}
        onDelete={deleteRequest}
        prices={prices}
        keyLabels={keyLabels}
      />
    ),
    [selectedId, toggleSelect, deleteRequest, prices, keyLabels],
  );

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
        <select
          value={transport}
          onChange={(e) =>
            setTransport(e.target.value as "" | "proxy" | "direct")
          }
          className="h-9 rounded-lg border border-border px-2 text-sm text-foreground"
          title="Transport"
        >
          <option value="">Transport: all</option>
          <option value="proxy">Proxy</option>
          <option value="direct">Direct</option>
        </select>
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search errors / rules…"
          className="w-48 rounded-lg border border-border px-3 py-1.5 text-sm text-foreground placeholder:text-muted-foreground"
        />
        {activeFilters ? (
          <button
            type="button"
            onClick={() => {
              setModel("");
              setProvider("");
              setStatus("");
              setSource("");
              setSearch("");
              setTransport("");
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
        renderRow={renderRow}
        headerRows={
          inflight.length > 0 ? (
            <>
              {inflight.map((r) => (
                <div
                  key={r.reqId}
                  className="border-b border-border px-2 py-1.5 text-sm"
                >
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="w-full text-xs text-muted-foreground sm:w-24 sm:shrink-0">
                      {fmtTs(r.started_at)}
                    </span>
                    <Badge tone="warning">
                      <Spinner size={11} />
                      running
                    </Badge>
                    <span
                      className="truncate font-medium text-foreground sm:max-w-[220px]"
                      title={r.model}
                    >
                      {r.model || "-"}
                    </span>
                    <span className="truncate text-muted-foreground sm:max-w-[140px]">
                      {r.provider_id}
                    </span>
                    <span className="hidden rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground md:inline">
                      {r.endpoint ?? "chat"}
                    </span>
                    {r.client_ip ? (
                      <span className="hidden font-mono text-[11px] text-muted-foreground lg:inline">
                        {r.client_ip}
                      </span>
                    ) : null}
                    {r.api_key_id != null ? (
                      <span className="hidden font-mono text-[11px] text-muted-foreground lg:inline">
                        key #{r.api_key_id}
                      </span>
                    ) : null}
                  </div>
                </div>
              ))}
            </>
          ) : null
        }
      />
    </div>
  );
}
