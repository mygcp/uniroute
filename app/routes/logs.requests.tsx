import { useState } from "react";
import type { Route } from "./+types/logs.requests";
import { LogViewer } from "../components/log-viewer";
import { query } from "../.server/db";
import {
  useRealtimeLogs,
  type LogEvent,
} from "../hooks/use-realtime-logs";

export function loader() {
  const rows = query(
    `SELECT id, model, provider_id, strategy_used, rule_applied, duration_ms,
            status, error_message, prompt_tokens, completion_tokens, created_at
     FROM request_logs ORDER BY id DESC LIMIT 100`,
  ).all() as Record<string, unknown>[];
  return { initial: rows.reverse() };
}

function fmtTs(ts: number): string {
  const ms = ts < 1e12 ? ts * 1000 : ts;
  return new Date(ms).toLocaleTimeString();
}

const STATUS_COLORS: Record<string, string> = {
  success: "bg-green-100 text-green-700",
  error: "bg-red-100 text-red-700",
  timeout: "bg-amber-100 text-amber-700",
  denied: "bg-gray-200 text-gray-700",
};

export default function LogsRequests({ loaderData }: Route.ComponentProps) {
  const [model, setModel] = useState("");
  const [provider, setProvider] = useState("");
  const [status, setStatus] = useState("");

  const filter = (e: LogEvent): boolean =>
    e.type === "request" &&
    (model === "" || String(e.model ?? "").includes(model)) &&
    (provider === "" || String(e.provider_id ?? "").includes(provider)) &&
    (status === "" || e.status === status);

  const initial: LogEvent[] = loaderData.initial.map((r) => ({
    type: "request" as const,
    created_at: Number(r.created_at),
    ...r,
  }));

  const { logs, paused, setPaused, scrollRef } = useRealtimeLogs(filter, initial);

  return (
    <div>
      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-3">
        <h2 className="text-xl font-bold text-gray-900 dark:text-white">Request Logs</h2>
        <input
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder="Model"
          className="w-full rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-800 dark:text-white sm:w-auto"
        />
        <input
          value={provider}
          onChange={(e) => setProvider(e.target.value)}
          placeholder="Provider"
          className="w-full rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-800 dark:text-white sm:w-auto"
        />
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="w-full rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-800 dark:text-white sm:w-auto"
        >
          <option value="">Status</option>
          <option value="success">success</option>
          <option value="error">error</option>
          <option value="timeout">timeout</option>
          <option value="denied">denied</option>
        </select>
      </div>

      <LogViewer
        logs={logs}
        paused={paused}
        setPaused={setPaused}
        scrollRef={scrollRef}
        renderRow={(e) => (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-gray-100 py-2 text-sm dark:border-gray-800">
            <span className="w-full text-xs text-gray-400 sm:w-20 sm:shrink-0">
              {fmtTs(e.created_at)}
            </span>
            <span className="truncate font-medium text-gray-900 dark:text-white max-w-[120px] sm:max-w-none sm:w-40" title={String(e.model)}>
              {String(e.model ?? "-")}
            </span>
            <span className="truncate text-gray-600 dark:text-gray-300 max-w-[100px] sm:max-w-none sm:w-28">{String(e.provider_id ?? "-")}</span>
            <span className="hidden sm:block sm:w-24 sm:truncate sm:text-xs sm:text-gray-500 sm:dark:text-gray-400">
              {String(e.strategy_used ?? "")}
            </span>
            <span
              className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                STATUS_COLORS[String(e.status)] ?? "bg-gray-100 text-gray-600"
              }`}
            >
              {String(e.status)}
            </span>
            <span className="ml-auto text-right text-xs text-gray-500 sm:ml-0 sm:w-16">
              {e.status === "success" && e.duration_ms != null
                ? `${e.duration_ms}ms`
                : ""}
            </span>
            {e.error_message ? (
              <span className="truncate text-xs text-red-500 dark:text-red-400">
                {String(e.error_message)}
              </span>
            ) : null}
          </div>
        )}
      />
    </div>
  );
}