/** 24-hour clock HH:MM:SS for finished-at timestamps. */
export function formatClock(tsMs: number | null | undefined): string | null {
  if (tsMs == null || !Number.isFinite(tsMs)) return null;
  try {
    return new Date(tsMs).toLocaleTimeString("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
  } catch {
    return null;
  }
}

/** Duration seconds with one decimal, e.g. 12.5s. */
export function formatSecs(ms: number | null | undefined): string | null {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return null;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Rough average tokens/sec from character count (chars/4). */
export function estimateTps(chars: number, ms: number | null | undefined): number | null {
  if (ms == null || !Number.isFinite(ms) || ms <= 200 || chars <= 0) return null;
  return Math.round(chars / 4 / (ms / 1000));
}
