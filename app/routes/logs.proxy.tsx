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
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <h2 className="text-xl font-bold">Proxy Logs</h2>
        <select
          value={level}
          onChange={(e) => setLevel(e.target.value)}
          className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm"
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
          className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm"
        />
      </div>

      <LogViewer
        logs={logs}
        paused={paused}
        setPaused={setPaused}
        scrollRef={scrollRef}
        renderRow={(e) => (
          <div className="flex items-center gap-3 border-b border-gray-100 py-2 text-sm">
            <span className="w-20 shrink-0 text-xs text-gray-400">
              {fmtTs(e.created_at)}
            </span>
            <span
              className={`rounded-full px-2 py-0.5 text-xs font-medium uppercase ${
                LEVEL_COLORS[String(e.level)] ?? "bg-gray-100 text-gray-600"
              }`}
            >
              {String(e.level)}
            </span>
            <span className="w-28 shrink-0 rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-600">
              {String(e.source)}
            </span>
            <span className="truncate">{String(e.message)}</span>
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