import { memo, type ReactNode } from "react";
import { Inbox } from "lucide-react";
import type { LogEvent } from "../hooks/use-realtime-logs";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { EmptyState } from "./ui/empty-state";

type Props = {
  logs: LogEvent[];
  paused: boolean;
  onTogglePause: () => void;
  connected: boolean;
  type: "request" | "proxy";
  scrollRef: React.RefObject<HTMLDivElement | null>;
  emptyMessage: string;
  renderRow: (event: LogEvent) => ReactNode;
  /** Baris request in-flight (loading) yang tampil di atas log. */
  headerRows?: ReactNode;
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
  type,
  scrollRef,
  emptyMessage,
  renderRow,
  headerRows,
}: Props) {
  return (
    <>
      {!connected ? (
        <div className="mb-3 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
          Connection to live logs lost — reconnecting…
        </div>
      ) : null}

      <div className="flex h-[55vh] flex-col rounded-xl border border-border bg-surface shadow-sm sm:h-[calc(100vh-290px)]">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
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
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={onTogglePause}
            aria-label={paused ? "Resume" : "Pause"}
          >
            {paused ? "Resume" : "Pause"}
          </Button>
        </div>

        <div ref={scrollRef} className="flex-1 overflow-y-auto px-2 py-1.5 sm:px-3">
          {headerRows}
          {logs.length === 0 && !headerRows ? (
            <EmptyState
              icon={<Inbox size={20} />}
              title={type === "request" ? "No request logs" : "No proxy logs"}
              description={emptyMessage}
            />
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
