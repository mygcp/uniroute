// Mock upstream OpenAI-compatible provider untuk E2E testing.
// Jalankan: bun scripts/mock-upstream.ts  → listen localhost:8787

const WORDS = ["Hello", "from", "UniRoute", "mock", "upstream", "provider"];

function emitToken(i: number): string {
  const word = WORDS[i % WORDS.length];
  return `data: ${JSON.stringify({
    id: `chatcmpl-mock-${i}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "gpt-4o",
    choices: [{ index: 0, delta: { content: word + " " }, finish_reason: null }],
  })}\n\n`;
}

const DONE =
  'data: {"id":"chatcmpl-mock-done","object":"chat.completion.chunk","created":0,"model":"gpt-4o","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';

const server = Bun.serve({
  port: 8787,
  async fetch(request) {
    const url = new URL(request.url);
    if (
      request.method === "POST" &&
      url.pathname === "/v1/chat/completions"
    ) {
      const body = (await request.json().catch(() => ({}))) as {
        model?: string;
        stream?: boolean;
      };
      const doStream = body.stream !== false;

      if (!doStream) {
        return Response.json({
          id: "chatcmpl-mock",
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: body.model ?? "gpt-4o",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "Hello from mock upstream." },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        });
      }

      const encoder = new TextEncoder();
      const responseBody = new ReadableStream<Uint8Array>({
        async start(controller) {
          const total = 5;
          for (let i = 0; i < total; i++) {
            controller.enqueue(encoder.encode(emitToken(i)));
            await Bun.sleep(20);
          }
          controller.enqueue(encoder.encode(DONE));
          controller.close();
        },
      });

      return new Response(responseBody, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    }

    return new Response("mock upstream: not found", { status: 404 });
  },
});

console.log(`mock upstream on http://localhost:${server.port}`);