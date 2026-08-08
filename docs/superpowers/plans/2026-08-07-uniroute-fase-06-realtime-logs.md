# Fase 6 — Realtime Logs

> **For agentic workers:** REQUIRED SUB-SKILL: subagent-driven-development atau executing-plans. Steps use checkbox syntax.

**Tujuan:** Merekam semua aktivitas proxy ke `request_logs` dan `proxy_logs` (sudah dipanggil fire-and-forget sejak Fase 2), lalu men-streamnya realtime ke UI via SSE (PRD §10.4). View di `/logs/requests` dan `/logs/proxy`.

**Deliverable:** Logger non-blocking, SSE endpoint `/api/logs/stream`, viewer realtime dengan filter.

**Sumber:** PRD §10.4, §10.5.

---

## Task 6.1 — Logger module (non-blocking insert)

**Files:**
- Create: `app/.server/logger.ts`

**Interfaces:**
- Produces: `recordRequestLog(entry): void`, `proxyLog(level, source, message, metadata?): void`.

- [x] **Step 1: Queue + flush**

```ts
const queue: (() => void)[] = [];
let flushing = false;

function enqueue(fn: () => void) {
  queue.push(fn);
  if (!flushing) void flush();
}

async function flush() {
  flushing = true;
  while (queue.length) {
    const fn = queue.shift()!;
    try { fn(); } catch (e) { console.warn("flush error", e); }
  }
  flushing = false;
}
```

> Ini tetap non-blocking terhadap request: insert dilakuan secara asynchronous di microtask/queue, request stream tidak menunggu.

- [x] **Step 2: `recordRequestLog`**

```ts
export function recordRequestLog({ model, provider_id, strategy_used, rule_applied, duration_ms, status, error_message, prompt_tokens, completion_tokens }) {
  enqueue(() => {
    db.run(`
      INSERT INTO request_logs (model, provider_id, strategy_used, rule_applied, duration_ms, status, error_message, prompt_tokens, completion_tokens)
      VALUES (?,?,?,?,?,?,?,?,?)
    `, [model, provider_id, strategy_used, rule_applied, duration_ms, status, error_message, prompt_tokens, completion_tokens]);
  });
  broadcast({ type: "request", ...entry, created_at: Date.now() }); // ke SSE
}
```

- [x] **Step 3: `proxyLog`**

```ts
export function proxyLog(level: "info"|"warn"|"error"|"debug", source: string, message: string, metadata?: object) {
  enqueue(() => {
    db.run(`INSERT INTO proxy_logs (level, source, message, metadata) VALUES (?,?,?,?)`, [level, source, message, metadata ? JSON.stringify(metadata) : null]);
  });
  broadcast({ type: "proxy", level, source, message, metadata, created_at: Date.now() });
}
```

- [x] **Step 4: Test**

Trigger `recordRequestLog` + `proxyLog` → row muncul di DB async (kecil sleep lalu query).

---

## Task 6.2 — SSE broadcast + endpoint

**Files:**
- Create: `app/.server/log-stream.ts` (broadcast util)
- Create: `app/routes/api.logs.stream.ts` (API resource)

**Interfaces:**
- Produces: `subscribe(fn)`, `broadcast(payload)`, `getClientsCount()`.

- [x] **Step 1: Hub in-memory**

```ts
const clients = new Set<(payload: unknown) => void>();
export function subscribe(fn: (payload: unknown) => void) {
  clients.add(fn);
  return () => clients.delete(fn);
}
export function broadcast(payload: unknown) {
  for (const fn of clients) {
    try { fn(payload); } catch {}
  }
}
```

- [x] **Step 2: Resource route SSE**

```ts
export async function loader({ request }: Route.LoaderArgs) {
  const stream = new ReadableStream({
    start(controller) {
      const send = (p: unknown) => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(p)}\n\n`));
      const unsubscribe = subscribe(send);
      // heartbeat every 25s untuk cegah proxy timeout
      const hb = setInterval(() => controller.enqueue(new TextEncoder().encode(`: ping\n\n`)), 25_000);
      request.signal.addEventListener("abort", () => { clearInterval(hb); unsubscribe(); controller.close(); });
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" } });
}
```

- [x] **Step 3: Integrasi**

`logger.ts` memanggil `broadcast` setelah setiap insert (seperti step 2-3 di 6.1).

- [x] **Step 4: Test manual**

```bash
curl -N http://localhost:3000/api/logs/stream  # terminal A, hold
```
Terminal B: trigger request proxy → SSE line baru muncul di terminal A.

---

## Task 6.3 — Log viewer UI

**Files:**
- Create: `app/routes/logs.requests.tsx`
- Create: `app/routes/logs.proxy.tsx`
- Create: `app/components/log-stream.tsx` (reusable)
- Create: `app/components/request-log-table.tsx`
- Create: `app/hooks/use-realtime-logs.ts`

- [x] **Step 1: `use-realtime-logs` hook**

Connect `EventSource` ke `/api/logs/stream`; state array log; auto-scroll ref; pause/resume toggle; filter callback.

```ts
export function useRealtimeLogs({ filter }: { filter?: (e: any) => boolean }) {
  const [logs, setLogs] = useState<any[]>([]);
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    const es = new EventSource("/api/logs/stream");
    es.onmessage = (ev) => {
      const data = JSON.parse(ev.data);
      if (!filter || filter(data)) setLogs(prev => [...prev.slice(-499), data]); // max 500 rows
    };
    return () => es.close();
  }, []);
  return { logs, paused, setPaused };
}
```

- [x] **Step 2: `log-viewer.tsx` component**

- Header dengan toggle pause/resume + badge jumlah.
- List auto-scroll ke bawah (ref + scrollTop) saat baru, reset saat pause.

- [x] **Step 3: `logs.requests.tsx`**

- Filter: model/provider/status.
- Render row: timestamp, model, provider, strategy, status, duration (dari `log-viewer`).

- [x] **Step 4: `logs.proxy.tsx`**

- Filter: level + source.
- Color by level (info blue, warn amber, error red, debug gray) + source badge.

- [x] **Step 5: Verifikasi**

Trigger beberapa request proxy + proxyLog → kedua page menampilkan secara realtime; pause/resume & filter jalan.

---

## Checkpoint Fase 6

- [x] Logger insert non-blocking (request tidak lambat).
- [x] `/api/logs/stream` SSE stream hidup.
- [x] `/logs/requests` stream realtime + pause/resume.
- [x] `/logs/proxy` + filter level/source.
- [x] Commit: `feat: realtime logs + sse`
---

## Catatan Deviasi

- Logger queue+flush sudah dibuat sejak Fase 2; Fase 6 menambahkan SSE `broadcast` (dari `log-stream.ts` hub) di `recordRequestLog`/`recordProxyLog`.
- `/api/logs/stream` tetap terproteksi cookie (Resource route; EventSource mengirim cookie same-origin).
- `use-realtime-logs` memakai `filterRef` supaya tidak subscribe ulang tiap re-render; initial history dari loader (100 row terakhir) + live events.
