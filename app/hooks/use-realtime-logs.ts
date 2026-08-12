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
  const [paused, setPaused] = useState(false);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const filterRef = useRef(filter);
  filterRef.current = filter;
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const es = new EventSource("/api/logs/stream");
    es.onmessage = (ev) => {
      if (pausedRef.current) return;
      try {
        const data = JSON.parse(ev.data) as LogEvent;
        if (data.type !== "request" && data.type !== "proxy") return;
        if (filterRef.current && !filterRef.current(data)) return;
        setLogs((prev) => {
          const next = [...prev, data];
          if (next.length > 1000) return next.slice(next.length - 1000);
          return next;
        });
        requestAnimationFrame(() => {
          const el = scrollRef.current;
          if (el) el.scrollTop = el.scrollHeight;
        });
      } catch {
        /* ignore malformed events */
      }
    };
    return () => es.close();
  }, []);

  /** Remove a log locally (after a successful server delete). */
  function remove(id: number, type: "request" | "proxy") {
    setLogs((prev) => prev.filter((l) => !(l.id === id && l.type === type)));
  }

  /** Replace the whole list locally (after clearing). */
  function reset(next: LogEvent[] = []) {
    setLogs(next);
  }

  return { logs, paused, setPaused, scrollRef, remove, reset };
}