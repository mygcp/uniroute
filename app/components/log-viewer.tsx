import { memo, type ReactNode } from "react";
import type { LogEvent } from "../hooks/use-realtime-logs";
import { Badge } from "./ui/badge";

type Props = {
  logs: LogEvent[];
  paused: boolean;
  onTogglePause: () => void;
  connected: boolean;
  type: "request" | "proxy";
  scrollRef: React.RefObject<HTMLDivElement | null>;
  emptyMessage: string;
  renderRow: (event: LogEvent) => ReactNode;
};

function keyOf(log: LogEvent): string {
  return String(log.id ?? log.created_at);
}

/**
 * Memoized per-row wrapper: during realtime event bursts only rows whose
 * props actually change (new events, selection toggles) re-render.
 * `renderRow` must be referentially stable (useCallback in the page).
 */
const RowSlot = memo(function RowSlot({
  render,
  log,
}: {
  render: (e: LogEvent) => ReactNode;
  log: LogEvent;
}) {
  return <div className="[content-visibility:auto]">{render(log)}</div>;
});

export function LogViewer({
  logs,
  paused,
  onTogglePause,
  connected,
  scrollRef,
  emptyMessage,
  renderRow,
}: Props) {
  return (
    <>
      {!connected ? (
        <div className="mb-3 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
          Connection to live logs lost — reconnecting…
        </div>
      ) : null}

      <div className="flex h-[calc(100vh-330px)] flex-col rounded-xl border border-border bg-surface shadow-sm sm:h-[calc(100vh-290px)]">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2 sm:px-4 sm:py-3">
          <div className="flex items-center gap-2 sm:gap-3">
            <span className="text-sm font-medium text-muted-foreground">
              {logs.length} event
            </span>
            <Badge
              tone={paused ? "warning" : "success"}
              className="inline-flex items-center gap-1.5"
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${paused ? "bg-warning" : "bg-success animate-pulse"}`}
              />
              {paused ? "paused" : "live"}
            </Badge>
          </div>
          <button
            type="button"
            onClick={onTogglePause}
            aria-label={paused ? "Resume" : "Pause"}
            className="rounded-lg border border-border px-3 py-1 text-sm font-medium text-foreground hover:bg-muted"
          >
            {paused ? "Resume" : "Pause"}
          </button>
        </div>

        <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-2">
          {logs.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">
              {emptyMessage}
            </p>
          ) : (
            logs.map((log) => (
              <RowSlot key={keyOf(log)} render={renderRow} log={log} />
            ))
          )}
        </div>
      </div>
    </>
  );
}
