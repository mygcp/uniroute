import { createLimiter } from "./async-utils";
import { exec, query } from "./db";
import { assertSafeUrl, validateUrlSync } from "./ssrf";

export const WEBHOOK_BACKOFF_MS = 30_000;
export const WEBHOOK_MAX_ATTEMPTS = 5;

type WebhookRow = { id: number; url: string; payload: string; attempts: number };

const nativeFetch = globalThis.fetch;
const deliveryLimiter = createLimiter(5);
let delivering = false;

export function enqueueWebhook(input: {
  keyId?: number | null;
  event: string;
  url: string;
  payload: unknown;
}): void {
  const checked = validateUrlSync(input.url, { allowPrivate: false, allowLoopback: false });
  if (!checked.ok) {
    return;
  }
  query("INSERT INTO webhook_events (key_id, event, url, payload) VALUES (?, ?, ?, ?)").run(
    input.keyId ?? null,
    input.event,
    checked.url.toString(),
    JSON.stringify(input.payload),
  );
}

export async function deliverPending(): Promise<void> {
  if (delivering) return;
  delivering = true;
  try {
    const rows = query(
      `SELECT id, url, payload, attempts FROM webhook_events
       WHERE status = 'pending' AND next_retry_at <= unixepoch()
       ORDER BY id ASC LIMIT 10`,
    ).all() as WebhookRow[];
    if (rows.length === 0) return;

    const outcomes = await Promise.all(
      rows.map((row) =>
        deliveryLimiter(async () => {
          try {
            await assertSafeUrl(row.url, {
              allowPrivate: false,
              allowLoopback: false,
              skipDns: globalThis.fetch !== nativeFetch,
            });
            const res = await globalThis.fetch(row.url, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: row.payload,
              redirect: "manual",
              signal: AbortSignal.timeout(10_000),
            });
            return { row, ok: res.ok };
          } catch {
            return { row, ok: false };
          }
        }),
      ),
    );

    exec("BEGIN");
    try {
      const stmtSuccess = query("UPDATE webhook_events SET status = 'success' WHERE id = ?");
      const stmtDrop = query("UPDATE webhook_events SET attempts = ?, status = 'dropped' WHERE id = ?");
      const stmtRetry = query(
        `UPDATE webhook_events SET attempts = ?, status = 'pending', next_retry_at = unixepoch() + ? WHERE id = ?`,
      );
      for (const { row, ok } of outcomes) {
        if (ok) {
          stmtSuccess.run(row.id);
          continue;
        }
        const attempts = row.attempts + 1;
        if (attempts >= WEBHOOK_MAX_ATTEMPTS) {
          stmtDrop.run(attempts, row.id);
        } else {
          const backoffSec = Math.floor((WEBHOOK_BACKOFF_MS * 2 ** (attempts - 1)) / 1000);
          stmtRetry.run(attempts, backoffSec, row.id);
        }
      }
      exec("COMMIT");
    } catch (err) {
      exec("ROLLBACK");
      throw err;
    }
  } finally {
    delivering = false;
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

export function startWebhookDeliverer(): void {
  if (delivererTimer) return;
  delivererTimer = setInterval(() => {
    deliverPending().catch(() => {
      /* ignore interval errors */
    });
  }, DELIVER_INTERVAL_MS);
  delivererTimer.unref?.();
}

export function stopWebhookDeliverer(): void {
  if (delivererTimer) {
    clearInterval(delivererTimer);
    delivererTimer = null;
  }
}
