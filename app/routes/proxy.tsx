import { useState } from "react";
import type { Route } from "./+types/proxy";
import { Globe } from "lucide-react";
import { MessageInput } from "../components/message-input";
import { ModelSelector } from "../components/model-selector";
import { StreamingResponse } from "../components/streaming-response";
import { query } from "../.server/db";
import { useStreaming } from "../hooks/use-streaming";

export function loader() {
  const rows = query(
    "SELECT DISTINCT model_name FROM models WHERE is_active = 1 ORDER BY model_name",
  ).all() as unknown as { model_name: string }[];
  return { models: rows.map((r) => r.model_name) };
}

export default function Proxy({ loaderData }: Route.ComponentProps) {
  const { models } = loaderData;
  const [model, setModel] = useState(models[0] ?? "");
  const [prompt, setPrompt] = useState("");
  const [stream, setStream] = useState(true);
  const { response, streaming, done, error, send, stop } = useStreaming();

  return (
    <div>
      <h1 className="mb-6 flex items-center gap-2 text-2xl font-bold text-gray-900 dark:text-white">
        <Globe size={24} /> Proxy Playground
      </h1>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <ModelSelector
          models={models}
          value={model}
          onChange={setModel}
        />
        <label className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
          <input
            type="checkbox"
            checked={stream}
            onChange={(e) => setStream(e.target.checked)}
            className="h-4 w-4"
          />
          Stream
        </label>
        <button
          type="button"
          disabled={streaming || !model}
          onClick={() => send(model, prompt, stream)}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          Send
        </button>
        {streaming ? (
          <button
            type="button"
            onClick={stop}
            className="rounded-lg border border-red-300 px-4 py-2 text-sm text-red-600 hover:bg-red-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950/40"
          >
            Stop
          </button>
        ) : null}
      </div>
      <MessageInput value={prompt} onChange={setPrompt} />
      <div className="mt-4">
        <StreamingResponse
          content={response}
          streaming={streaming}
          done={done}
          error={error}
        />
      </div>
    </div>
  );
}