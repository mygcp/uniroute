import type { Route } from "./+types/api.logs.stream";
import { requireSession } from "../.server/auth";
import { subscribe, subscriberCount } from "../.server/log-stream";

const ENCODER = new TextEncoder();
const CONNECTED_BYTES = ENCODER.encode(": connected\n\n");
const PING_BYTES = ENCODER.encode(": ping\n\n");
const MAX_SSE_CLIENTS = 50;

export async function loader({ request }: Route.LoaderArgs) {
  const denied = requireSession(request);
  if (denied) return denied;

  if (subscriberCount() >= MAX_SSE_CLIENTS) {
    return Response.json(
      { ok: false, error: "too many active log stream connections" },
      { status: 429 },
    );
  }

  let cleanup = (): void => {};

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let cleaned = false;
      const send = (payload: unknown): void => {
        if (cleaned) return;
        try {
          controller.enqueue(
            ENCODER.encode(`data: ${JSON.stringify(payload)}\n\n`),
          );
        } catch {
          cleanup();
        }
      };

      const unsubscribe = subscribe(send);
      try {
        controller.enqueue(CONNECTED_BYTES);
      } catch {
        /* ignore */
      }

      const hb = setInterval(() => {
        if (cleaned) return;
        try {
          controller.enqueue(PING_BYTES);
        } catch {
          cleanup();
        }
      }, 25_000);

      cleanup = (): void => {
        if (cleaned) return;
        cleaned = true;
        clearInterval(hb);
        unsubscribe();
        try {
          request.signal.removeEventListener("abort", cleanup);
        } catch {
          /* ignore */
        }
        try {
          controller.close();
        } catch {
          /* ignore */
        }
      };

      request.signal.addEventListener("abort", cleanup, { once: true });
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
