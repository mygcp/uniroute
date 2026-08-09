import type { ReactNode } from "react";
import type { LogEvent } from "../hooks/use-realtime-logs";

type Props = {
  logs: LogEvent[];
  paused: boolean;
  setPaused: (v: boolean) => void;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  renderRow: (event: LogEvent) => ReactNode;
};

export function LogViewer({
  logs,
  paused,
  setPaused,
  scrollRef,
  renderRow,
}: Props) {
  return (
    <div className="flex h-[calc(100vh-220px)] flex-col rounded-xl border border-gray-200 bg-white shadow-sm dark:border-gray-800 dark:bg-gray-900">
      <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3 dark:border-gray-800">
        <div className="flex items-center gap-3">
          <span className="text-sm font-medium text-gray-700 dark:text-gray-200">
            {logs.length} event
          </span>
          <span
            className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ${
              paused ? "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300" : "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300"
            }`}
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                paused ? "bg-amber-500" : "bg-green-500 animate-pulse"
              }`}
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
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-2">
        {logs.length === 0 ? (
          <p className="py-10 text-center text-sm text-gray-400 dark:text-gray-500">
            Belum ada event. Coba trigger request proxy...
          </p>
        ) : (
          logs.map((log, i) => <div key={`${log.created_at}-${i}`}>{renderRow(log)}</div>)
        )}
      </div>
    </div>
  );
}