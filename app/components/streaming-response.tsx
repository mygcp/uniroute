import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { Brain, Spinner } from "./ui/feedback";
import { Markdown } from "./markdown";
import { estimateTps, formatClock, formatSecs } from "../lib/format";

type Props = {
  content: string;
  streaming: boolean;
  done: boolean;
  error: string;
  thinking?: string;
  latencyMs?: number | null;
  usage?: {
    completion_tokens?: number;
  } | null;
};

export function StreamingResponse({
  content,
  streaming,
  done,
  error,
  thinking = "",
  latencyMs,
  usage,
}: Props) {
  const [endedAt, setEndedAt] = useState<number | null>(null);

  useEffect(() => {
    if (streaming) {
      setEndedAt(null);
    } else if (done) {
      setEndedAt((prev) => prev ?? Date.now());
    }
  }, [streaming, done]);

  const meter = useMemo(() => {
    const secs = formatSecs(latencyMs);
    let tps: number | null = null;
    let tpsEstimated = false;
    if (usage?.completion_tokens && latencyMs && latencyMs > 200) {
      tps = Math.round(usage.completion_tokens / (latencyMs / 1000));
    } else {
      tps = estimateTps(content.length, latencyMs);
      tpsEstimated = tps != null;
    }
    return { secs, tps, tpsEstimated };
  }, [content.length, latencyMs, usage?.completion_tokens]);
  const { secs, tps, tpsEstimated } = meter;

  const clock = !streaming && done ? formatClock(endedAt) : null;
  const thinkingOpen = streaming && content === "" && thinking !== "";
  const showMeter = !error && (streaming || done);
  const deferredContent = useDeferredValue(content);

  return (
    <div className="min-w-0 flex-1">
      {error ? (
        <div className="whitespace-pre-wrap break-words rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
          {error}
        </div>
      ) : (
        <>
          {thinking !== "" ? (
            <details
              open={thinkingOpen || undefined}
              className="mb-2 rounded-lg border border-info/25 bg-info/8 px-2.5 py-1.5"
            >
              <summary className="flex cursor-pointer items-center gap-1.5 text-xs font-medium text-info">
                <Brain size={12} />
                {streaming && content === "" ? "Thinking…" : "Thought process"}
              </summary>
              <div className="mt-1.5 max-h-48 overflow-y-auto whitespace-pre-wrap break-words text-xs leading-relaxed text-muted-foreground">
                {thinking}
              </div>
            </details>
          ) : null}
          <Markdown
            text={streaming ? deferredContent : content}
            highlight={!streaming}
          />
          {streaming ? (
            <span className="ml-0.5 inline-block h-4 w-[2px] animate-pulse bg-primary align-text-bottom" />
          ) : null}
        </>
      )}
      {showMeter && (
        <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs tabular-nums text-muted-foreground">
          {streaming && content === "" && thinking === "" ? (
            <span className="flex items-center gap-1.5">
              <Spinner size={12} /> thinking…
            </span>
          ) : null}
          {secs != null ? <span title="elapsed">{secs}</span> : null}
          {tps != null ? (
            <span title={tpsEstimated ? "estimated" : "actual"}>
              ≈ {tps} tok/s{tpsEstimated ? " (est.)" : ""}
              {!streaming && usage?.completion_tokens
                ? ` · ${usage.completion_tokens} out`
                : ""}
            </span>
          ) : (
            <span>measuring…</span>
          )}
          {clock ? <span title="finished at">· {clock}</span> : null}
        </p>
      )}
    </div>
  );
}
