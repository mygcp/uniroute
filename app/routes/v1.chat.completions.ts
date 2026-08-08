import type { Route } from "./+types/v1.chat.completions";
import { transformRequest } from "../.server/adapter";
import { executeStreaming } from "../.server/executor";
import { checkAllowlist } from "../.server/guard";
import { recordRequestLog } from "../.server/logger";
import { getProviders } from "../.server/registry";

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

type ChatRequestBody = {
  model?: unknown;
  messages?: unknown;
  stream?: unknown;
  [key: string]: unknown;
};

export async function action({ request }: Route.ActionArgs) {
  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return json({ error: { message: "invalid JSON body" } }, 400);
  }

  const body = (payload ?? {}) as ChatRequestBody & Record<string, unknown>;
  const model =
    typeof body.model === "string" && body.model.trim() !== ""
      ? body.model.trim()
      : null;

  if (!model) {
    return json({ error: { message: "model is required" } }, 400);
  }

  const guard = checkAllowlist(model);
  if (!guard.ok) {
    recordRequestLog({
      model,
      provider_id: "guard",
      status: "denied",
      error_message: guard.reason,
    });
    return json(
      { error: { message: guard.reason, type: "model_denied" } },
      403,
    );
  }

  const providers = getProviders(model);
  if (providers.length === 0) {
    recordRequestLog({
      model,
      provider_id: "none",
      status: "error",
      error_message: "model not found",
    });
    return json(
      { error: { message: "model not found", type: "model_not_found" } },
      404,
    );
  }

  const provider = providers[0];

  let transformed;
  try {
    transformed = transformRequest(body, provider);
  } catch (err) {
    recordRequestLog({
      model,
      provider_id: provider.id,
      strategy_used: "first_available",
      status: "error",
      error_message: err instanceof Error ? err.message : String(err),
    });
    return json({ error: { message: "provider request failed" } }, 500);
  }

  return executeStreaming({
    url: transformed.url,
    headers: transformed.headers,
    body: transformed.body,
    signal: request.signal,
    onComplete: (log) =>
      recordRequestLog({
        model,
        provider_id: provider.id,
        strategy_used: "first_available",
        ...log,
      }),
  });
}