import type { LogEvent } from "../hooks/use-realtime-logs";

export type PricePair = { input: number; output: number };
/** Price map per lowercase `model::provider_id` key. */
export type PriceMap = Record<string, PricePair>;
/** API key label map: id -> name or prefix. */
export type KeyLabelMap = Record<string, string>;

export function fmtTs(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return "-";
  const ms = ts < 1e12 ? ts * 1000 : ts;
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * Combo requests are labelled with their combo strategy (e.g. `combo:failover`).
 * Everything else goes straight to a provider, so label it "direct".
 */
export function sourceLabel(e: LogEvent): string {
  const strategy = String(e.strategy_used ?? "").trim();
  if (strategy) return strategy;
  return "direct";
}

function tokenPair(e: LogEvent): [number | null, number | null] {
  const pt = e.prompt_tokens == null ? null : Number(e.prompt_tokens);
  const ct = e.completion_tokens == null ? null : Number(e.completion_tokens);
  return [pt, ct];
}

/** Combined prompt + completion tokens; null if neither is recorded. */
export function totalTokens(e: LogEvent): number | null {
  const [pt, ct] = tokenPair(e);
  if (pt == null && ct == null) return null;
  return (pt ?? 0) + (ct ?? 0);
}

export function priceKeyOf(model: unknown, providerId: unknown): string {
  return `${String(model ?? "").trim().toLowerCase()}::${String(
    providerId ?? "",
  ).trim().toLowerCase()}`;
}

/** Estimated USD cost for a single request from token usage and loader price map. */
export function costOf(e: LogEvent, prices: PriceMap): number | null {
  const [pt, ct] = tokenPair(e);
  if (pt == null && ct == null) return null;
  const p =
    prices[priceKeyOf(e.model, e.provider_id)] ?? { input: 0, output: 0 };
  return ((pt ?? 0) * p.input + (ct ?? 0) * p.output) / 1_000_000;
}

export function fmtUsd(v: number | null): string {
  if (v == null) return "-";
  if (v === 0) return "$0";
  if (v < 0.01) return `$${v.toFixed(6)}`;
  if (v < 1) return `$${v.toFixed(4)}`;
  return `$${v.toFixed(2)}`;
}

export function fmtNum(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(Number(n))) return "-";
  return Number(n).toLocaleString("en-US");
}

const shortCount = (n: number): string =>
  n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : String(n);

/** Token summary for log row: "315", "1.2k/315", or empty when missing. */
export function fmtTokensShort(e: LogEvent): string {
  const [pt, ct] = tokenPair(e);
  if (pt == null && ct == null) return "";
  if (pt != null && ct != null) return `${shortCount(pt)}/${shortCount(ct)}`;
  return shortCount((pt ?? ct)!);
}

/** API key label from live event or loader join map. */
export function keyLabelOf(e: LogEvent, keyLabels: KeyLabelMap): string {
  const name = String(e.api_key_name ?? "").trim();
  if (name) return name;
  const prefix = String(e.api_key_prefix ?? "").trim();
  if (prefix) return prefix;
  if (e.api_key_id == null) return "";
  return keyLabels[String(e.api_key_id)] ?? `#${e.api_key_id}`;
}

export function printable(entry: unknown): string {
  if (entry === null || entry === undefined) return "-";
  if (
    typeof entry === "string" ||
    typeof entry === "number" ||
    typeof entry === "boolean"
  ) {
    return String(entry);
  }
  try {
    return JSON.stringify(entry, null, 2);
  } catch {
    return String(entry);
  }
}

/** Proxy log metadata can be a JSON string (from DB) or an object (live SSE). */
export function parseMetadata(raw: unknown): Record<string, unknown> | null {
  if (typeof raw === "string") {
    try {
      const v: unknown = JSON.parse(raw);
      return v && typeof v === "object" && !Array.isArray(v)
        ? (v as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  return null;
}

/** Scalar-friendly value for inline key=value display. */
export function scalarValue(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
