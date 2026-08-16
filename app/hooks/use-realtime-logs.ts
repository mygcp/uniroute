import { useEffect, useRef, useState } from "react";

export type LogEvent = {
  id?: number;
  type: "request" | "proxy";
  created_at: number;
  [key: string]: unknown;
};

export function useRealtimeLogs(
  filter?: (e: LogEvent) => boolean,
  initial: LogEvent[] = [],
) {
  const [logs, setLogs] = useState<LogEvent[]>(initial);
  const [connected, setConnected] = useState(true);
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const filterRef = useRef(filter);
  filterRef.current = filter;
  const scrollRef = useRef<HTMLDivElement>(null);

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
        const next = [...prev, ...batch];
        if (next.length > 1000) return next.slice(next.length - 1000);
        return next;
      });
      requestAnimationFrame(() => {
        const el = scrollRef.current;
        if (el) el.scrollTop = el.scrollHeight;
      });
    };

    const es = new EventSource("/api/logs/stream");
    es.onopen = () => setConnected(true);
    es.onerror = () => {
      setConnected(false);
    };
    es.onmessage = (ev) => {
      if (pausedRef.current) return;
      try {
        const data = JSON.parse(ev.data) as LogEvent;
        if (data.type !== "request" && data.type !== "proxy") return;
        if (filterRef.current && !filterRef.current(data)) return;
        buffer.push(data);
        if (raf == null) raf = requestAnimationFrame(flush);
      } catch {
        /* ignore malformed events */
      }
    };
    return () => {
      es.close();
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

  return { logs, connected, paused, setPaused, scrollRef, remove, reset };
}