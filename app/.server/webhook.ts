import { query } from "./db";

export const WEBHOOK_BACKOFF_MS = 30_000;
export const WEBHOOK_MAX_ATTEMPTS = 5;

type WebhookRow = { id: number; url: string; payload: string; attempts: number };

export function enqueueWebhook(input: {
  keyId?: number | null;
  event: string;
  url: string;
  payload: unknown;
}): void {
  if (!input.url.startsWith("http://") && !input.url.startsWith("https://")) {
    return;
  }
  query("INSERT INTO webhook_events (key_id, event, url, payload) VALUES (?, ?, ?, ?)").run(
    input.keyId ?? null,
    input.event,
    input.url,
    JSON.stringify(input.payload),
  );
}

export async function deliverPending(): Promise<void> {
  const rows = query(
    `SELECT id, url, payload, attempts FROM webhook_events
     WHERE status = 'pending' AND next_retry_at <= unixepoch()
     ORDER BY id ASC LIMIT 10`,
  ).all() as WebhookRow[];

  for (const row of rows) {
    const succeeded = await (async () => {
      try {
        const res = await globalThis.fetch(row.url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: row.payload,
        });
        return res.ok;
      } catch {
        return false;
      }
    })();

    if (succeeded) {
      query("UPDATE webhook_events SET status = 'success' WHERE id = ?").run(row.id);
      continue;
    }

    const attempts = row.attempts + 1;
    if (attempts >= WEBHOOK_MAX_ATTEMPTS) {
      query("UPDATE webhook_events SET attempts = ?, status = 'dropped' WHERE id = ?").run(
        attempts,
        row.id,
      );
    } else {
      const backoffSec = Math.floor((WEBHOOK_BACKOFF_MS * 2 ** (attempts - 1)) / 1000);
      query(
        `UPDATE webhook_events SET attempts = ?, status = 'pending', next_retry_at = unixepoch() + ? WHERE id = ?`,
      ).run(attempts, backoffSec, row.id);
    }
  }
}

export function pendingCount(): number {
  const row = query("SELECT COUNT(*) AS c FROM webhook_events WHERE status = 'pending'").get() as {
    c: number;
  };
  return Number(row.c);
}

const DELIVER_INTERVAL_MS = 5000;
let delivererTimer: ReturnType<typeof setInterval> | null = null;

/** Mulai periodik deliver webhook. Dipanggil dari server.ts saat boot. */
export function startWebhookDeliverer(): void {
  if (delivererTimer) return;
  delivererTimer = setInterval(() => {
    deliverPending().catch(() => {
      /* ignore interval errors */
    });
  }, DELIVER_INTERVAL_MS);
}

export function stopWebhookDeliverer(): void {
  if (delivererTimer) {
    clearInterval(delivererTimer);
    delivererTimer = null;
  }
}