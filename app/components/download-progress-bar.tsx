import { useEffect, useState } from "react";

type ProgressPayload = {
  status: string;
  bytesDownloaded?: number;
  totalBytes?: number | null;
  percent?: number | null;
  assetName?: string;
};

function fmtMb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const PHASE_LABEL: Record<string, string> = {
  resolving: "Checking latest release...",
  downloading: "Downloading binary...",
  verifying: "Verifying SHA-256...",
  extracting: "Extracting archive...",
  done: "Finishing...",
};

export function DownloadProgressBar({
  progressKey,
  active,
}: {
  progressKey: string;
  active: boolean;
}) {
  const [progress, setProgress] = useState<ProgressPayload | null>(null);

  useEffect(() => {
    if (!active) {
      setProgress(null);
      return;
    }

    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch(
          `/api/tools/progress?key=${encodeURIComponent(progressKey)}`,
        );
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as ProgressPayload;
        if (!cancelled) setProgress(data);
      } catch {
        /* ignore transient poll failures */
      }
    };

    void poll();
    const timer = setInterval(() => void poll(), 250);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [active, progressKey]);

  if (!active) return null;

  const status = progress?.status ?? "resolving";
  const pct =
    typeof progress?.percent === "number"
      ? Math.max(0, Math.min(100, progress.percent))
      : status === "verifying" || status === "extracting" || status === "done"
        ? 100
        : null;
  const downloaded = progress?.bytesDownloaded ?? 0;
  const total = progress?.totalBytes ?? null;

  return (
    <div className="space-y-1.5 rounded-lg border border-border bg-surface-2/60 px-3 py-2 text-[11px]">
      <div className="flex items-center justify-between gap-2 text-muted-foreground">
        <span className="truncate font-medium text-foreground">
          {PHASE_LABEL[status] ?? "Working..."}
        </span>
        <span className="shrink-0 font-mono tabular-nums">
          {total && total > 0
            ? `${fmtMb(downloaded)} / ${fmtMb(total)} (${pct ?? 0}%)`
            : downloaded > 0
              ? fmtMb(downloaded)
              : pct != null
                ? `${pct}%`
                : "..."}
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-sm bg-surface">
        {pct != null ? (
          <div
            className="h-full rounded-sm bg-primary transition-[width] duration-200"
            style={{ width: `${pct}%` }}
          />
        ) : (
          <div className="h-full w-1/2 animate-pulse rounded-sm bg-primary/80" />
        )}
      </div>
    </div>
  );
}
