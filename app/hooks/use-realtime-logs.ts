import { useEffect, useRef, useState } from "react";

export type InflightRequest = {
  reqId: string;
  model: string;
  provider_id: string;
  endpoint?: string | null;
  client_ip?: string | null;
  api_key_id?: number | null;
  started_at: number;
};

const INFLIGHT_TTL_MS = 5 * 60_000;

export type LogEvent = {
  id?: number;
  type: "request" | "proxy";
  created_at: number;
  [key: string]: unknown;
};

export function useRealtimeLogs(
  filter?: (e: LogEvent) => boolean,
  initial: LogEvent[] = [],
  opts?: { newestFirst?: boolean },
) {
  const { newestFirst = false } = opts ?? {};
  const [logs, setLogs] = useState<LogEvent[]>(initial);
  const [connected, setConnected] = useState(true);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const filterRef = useRef(filter);
  filterRef.current = filter;
  const newestFirstRef = useRef(newestFirst);
  newestFirstRef.current = newestFirst;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [inflight, setInflight] = useState<InflightRequest[]>([]);

  useEffect(() => {
    let buffer: LogEvent[] = [];
    let raf: number | null = null;

    // Flush accumulated events to React state at most once per animation frame.
    const flush = () => {
      raf = null;
      if (buffer.length === 0) return;
      const batch = buffer;
      buffer = [];
      setLogs((prev) => {
        const merged = newestFirstRef.current
          ? [...batch, ...prev]
          : [...prev, ...batch];
        // Cap panjang list; buang dari ujung yang paling tua.
        return merged.length > 1000
          ? newestFirstRef.current
            ? merged.slice(0, 1000)
            : merged.slice(merged.length - 1000)
          : merged;
      });
      requestAnimationFrame(() => {
        const el = scrollRef.current;
        if (!el) return;
        if (newestFirstRef.current) {
          // Mode terbaru-di-atas: ikut ke atas hanya bila user memang di dekat atas.
          if (el.scrollTop <= 120) el.scrollTop = 0;
        } else {
          // Mode lama: ikut ke bawah hanya bila user di dekat dasar.
          const nearBottom =
            el.scrollHeight - el.scrollTop - el.clientHeight < 120;
          if (nearBottom) el.scrollTop = el.scrollHeight;
        }
      });
    };

    const es = new EventSource("/api/logs/stream");
    es.onopen = () => setConnected(true);
    es.onerror = () => {
      setConnected(false);
    };
    es.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data) as
          | LogEvent
          | {
              type: "request-start" | "request-end";
              reqId?: string;
              model?: string;
              provider_id?: string;
              endpoint?: string;
              client_ip?: string;
              api_key_id?: number | string;
              started_at?: number;
            };

        // Pelacakan request in-flight (tidak terpengaruh pause): muncul saat
        // mulai, hilang saat selesai / melewati TTL.
        if (data.type === "request-start" && data.reqId) {
          setInflight((prev) => [
            {
              reqId: data.reqId!,
              model: String(data.model ?? ""),
              provider_id: String(data.provider_id ?? ""),
              endpoint: (data.endpoint as string) ?? null,
              client_ip: (data.client_ip as string) ?? null,
              api_key_id:
                data.api_key_id != null ? Number(data.api_key_id) : null,
              started_at: Number(data.started_at ?? Date.now()),
            },
            ...prev.filter((p) => p.reqId !== data.reqId),
          ]);
          return;
        }
        if (data.type === "request-end" && data.reqId) {
          setInflight((prev) => prev.filter((p) => p.reqId !== data.reqId));
          return;
        }

        if (pausedRef.current) return;
        if (data.type !== "request" && data.type !== "proxy") return;
        if (filterRef.current && !filterRef.current(data)) return;
        buffer.push(data);
        if (raf == null) raf = requestAnimationFrame(flush);
      } catch {
        /* ignore malformed events */
      }
    };
    // Buang in-flight yang menggantung terlalu lama (proses restart dsb).
    const ttlTimer = setInterval(() => {
      const cutoff = Date.now() - INFLIGHT_TTL_MS;
      setInflight((prev) =>
        prev.some((p) => p.started_at < cutoff)
          ? prev.filter((p) => p.started_at >= cutoff)
          : prev,
      );
    }, 30_000);
    return () => {
      es.close();
      clearInterval(ttlTimer);
      if (raf != null) cancelAnimationFrame(raf);
    };
  }, []);

  /** Remove a log locally (after a successful server delete). */
  function remove(id: number, type: "request" | "proxy") {
    setLogs((prev) => prev.filter((l) => !(l.id === id && l.type === type)));
  }

  /** Replace the whole list locally (after clearing). */
  function reset(next: LogEvent[] = []) {
    setLogs(next);
  }

  return {
    logs,
    connected,
    paused,
    setPaused,
    scrollRef,
    remove,
    reset,
    inflight,
  };
}