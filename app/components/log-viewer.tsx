import { memo, type ReactNode } from "react";
import { Inbox, Pause, Play } from "lucide-react";
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
  headerRows?: ReactNode;
  columnHeader?: ReactNode;
};

function keyOf(log: LogEvent): string {
  return String(log.id ?? log.created_at);
}

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
  columnHeader,
}: Props) {
  return (
    <>
      {!connected ? (
        <div
          role="status"
          className="mb-3 rounded-xl border border-warning/35 bg-warning/10 px-3.5 py-2 text-xs font-medium text-warning"
        >
          Connection to live logs lost. Reconnecting...
        </div>
      ) : null}

      <div className="glass-panel flex h-[62vh] flex-col overflow-hidden sm:h-[calc(100vh-285px)] sm:min-h-[420px]">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-surface-2/50 px-4 py-2.5">
          <div className="flex items-center gap-2.5">
            <span className="font-mono text-xs font-medium tabular-nums text-muted-foreground">
              {logs.length.toLocaleString()} {logs.length === 1 ? "event" : "events"}
            </span>
            <Badge tone={paused ? "warning" : "success"} dot>
              {paused ? "Paused" : "Live"}
            </Badge>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onTogglePause}
            aria-label={paused ? "Resume live log stream" : "Pause live log stream"}
          >
            {paused ? <Play size={13} aria-hidden="true" /> : <Pause size={13} aria-hidden="true" />}
            {paused ? "Resume" : "Pause"}
          </Button>
        </div>

        {columnHeader ? (
          <div className="hidden border-b border-border bg-surface-2/70 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground lg:block">
            {columnHeader}
          </div>
        ) : null}

        <div ref={scrollRef} className="slim-scroll flex-1 overflow-y-auto">
          {headerRows}
          {logs.length === 0 && !headerRows ? (
            <EmptyState
              icon={<Inbox size={22} />}
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
