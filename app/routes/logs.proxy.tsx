import { useState } from "react";
import type { Route } from "./+types/logs.proxy";
import { LogViewer } from "../components/log-viewer";
import { query } from "../.server/db";
import {
  useRealtimeLogs,
  type LogEvent,
} from "../hooks/use-realtime-logs";

export function loader() {
  const rows = query(
    `SELECT id, level, source, message, metadata, created_at
     FROM proxy_logs ORDER BY id DESC LIMIT 100`,
  ).all() as Record<string, unknown>[];
  return { initial: rows.reverse() };
}

function fmtTs(ts: number): string {
  const ms = ts < 1e12 ? ts * 1000 : ts;
  return new Date(ms).toLocaleTimeString();
}

const LEVEL_COLORS: Record<string, string> = {
  info: "bg-blue-100 text-blue-700",
  warn: "bg-amber-100 text-amber-700",
  error: "bg-red-100 text-red-700",
  debug: "bg-gray-200 text-gray-600",
};

export default function LogsProxy({ loaderData }: Route.ComponentProps) {
  const [level, setLevel] = useState("");
  const [source, setSource] = useState("");

  const filter = (e: LogEvent): boolean =>
    e.type === "proxy" &&
    (level === "" || e.level === level) &&
    (source === "" || String(e.source ?? "").includes(source));

  const initial: LogEvent[] = loaderData.initial.map((r) => ({
    type: "proxy" as const,
    created_at: Number(r.created_at),
    ...r,
  }));

  const { logs, paused, setPaused, scrollRef } = useRealtimeLogs(filter, initial);

  return (
    <div>
      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-3">
        <h2 className="text-xl font-bold text-gray-900 dark:text-white">Proxy Logs</h2>
        <select
          value={level}
          onChange={(e) => setLevel(e.target.value)}
          className="w-full rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-800 dark:text-white sm:w-auto"
        >
          <option value="">Level</option>
          <option value="info">info</option>
          <option value="warn">warn</option>
          <option value="error">error</option>
          <option value="debug">debug</option>
        </select>
        <input
          value={source}
          onChange={(e) => setSource(e.target.value)}
          placeholder="Source"
          className="w-full rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-800 dark:text-white sm:w-auto"
        />
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
            <span
              className={`rounded-full px-2 py-0.5 text-xs font-medium uppercase ${
                LEVEL_COLORS[String(e.level)] ?? "bg-gray-100 text-gray-600"
              }`}
            >
              {String(e.level)}
            </span>
            <span className="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-600 dark:bg-gray-800 dark:text-gray-300">
              {String(e.source)}
            </span>
            <span className="w-full truncate text-gray-800 dark:text-gray-200 sm:w-auto sm:flex-1">{String(e.message)}</span>
            {e.metadata ? (
              <span className="ml-auto shrink-0 text-xs text-gray-400">
                {String(e.metadata)}
              </span>
            ) : null}
          </div>
        )}
      />
    </div>
  );
}