import type { Route } from "./+types/api.logs.stream";
import { requireSession } from "../.server/auth";
import { subscribe } from "../.server/log-stream";

export async function loader({ request }: Route.LoaderArgs) {
  const denied = requireSession(request);
  if (denied) return denied;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (payload: unknown): void => {
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(payload)}\n\n`),
          );
        } catch {
          /* stream closed */
        }
      };
      const unsubscribe = subscribe(send);
      // Flush headers + tanda hidup segera agar client tahu stream siap
      // tanpa menunggu event log pertama / heartbeat.
      try {
        controller.enqueue(encoder.encode(": connected\n\n"));
      } catch {
        /* ignore */
      }
      const hb = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": ping\n\n"));
        } catch {
          /* ignore */
        }
      }, 25_000);

      request.signal.addEventListener("abort", () => {
        clearInterval(hb);
        unsubscribe();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
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