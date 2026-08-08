import { useRef, useState } from "react";

export function useStreaming() {
  const [response, setResponse] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");
  const abortRef = useRef<AbortController | null>(null);

  const send = async (model: string, prompt: string, stream: boolean) => {
    abortRef.current = new AbortController();
    setStreaming(true);
    setResponse("");
    setError("");
    setDone(false);

    try {
      const res = await fetch("/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: prompt }],
          stream,
        }),
        signal: abortRef.current.signal,
      });

      if (!res.ok) {
        const text = await res.text();
        setError(text);
        setStreaming(false);
        return;
      }

      if (!stream || !res.body) {
        const json = (await res.json()) as {
          choices?: { message?: { content?: string } }[];
        };
        setResponse(
          json.choices?.[0]?.message?.content ?? JSON.stringify(json),
        );
        setDone(true);
        setStreaming(false);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done: readerDone, value } = await reader.read();
        if (readerDone) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") {
            setDone(true);
            break;
          }
          try {
            const j = JSON.parse(data) as {
              choices?: { delta?: { content?: string } }[];
            };
            const delta = j.choices?.[0]?.delta?.content ?? "";
            if (delta) setResponse((prev) => prev + delta);
          } catch {
            /* skip malformed */
          }
        }
      }
      setDone(true);
      setStreaming(false);
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setError(err instanceof Error ? err.message : String(err));
      }
      setStreaming(false);
    }
  };

  const stop = () => abortRef.current?.abort();

  return { response, streaming, done, error, send, stop };
}