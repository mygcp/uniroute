import { Spinner } from "./ui/feedback";
import { Markdown } from "./markdown";

type Props = {
  content: string;
  streaming: boolean;
  done: boolean;
  error: string;
  /** Waktu berjalan (ms) — dipakai untuk tok/s live. */
  latencyMs?: number | null;
  /** Usage resmi dari chunk akhir (bila provider mengirim). */
  usage?: {
    completion_tokens?: number;
  } | null;
};

/**
 * Bubble asisten: markdown + caret streaming + meter tok/s.
 * Saat streaming → estimasi (chars/4 ÷ detik); setelah selesai & ada usage
 * resmi → token output sebenarnya.
 */
export function StreamingResponse({
  content,
  streaming,
  done,
  error,
  latencyMs,
  usage,
}: Props) {
  const elapsedSec = latencyMs != null ? latencyMs / 1000 : null;
  let tps: number | null = null;
  if (streaming && content.length > 0 && elapsedSec && elapsedSec > 0.2) {
    tps = Math.round(content.length / 4 / elapsedSec);
  } else if (!streaming && done && usage?.completion_tokens && elapsedSec) {
    tps = Math.round(usage.completion_tokens / elapsedSec);
  }

  return (
    <div className="min-w-0 flex-1">
      {error ? (
        <div className="whitespace-pre-wrap break-words rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
          {error}
        </div>
      ) : (
        <>
          <Markdown text={content} />
          {streaming ? (
            <span className="ml-0.5 inline-block h-4 w-[2px] animate-pulse bg-primary align-text-bottom" />
          ) : null}
        </>
      )}
      {(tps != null || (streaming && content === "")) && (
        <p
          className={`mt-1 flex items-center gap-2 text-[11px] tabular-nums ${
            streaming ? "text-muted-foreground" : "text-success"
          }`}
        >
          {streaming && content === "" ? (
            <>
              <Spinner size={12} /> thinking…
            </>
          ) : null}
          {tps != null ? (
            <span title={streaming ? "estimated" : "actual"}>
              ≈ {tps} tok/s{!streaming ? ` · ${usage?.completion_tokens ?? "—"} out` : ""}
            </span>
          ) : null}
        </p>
      )}
    </div>
  );
}
