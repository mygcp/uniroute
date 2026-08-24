import type { Route } from "./+types/v1.chat.completions";
import { handleProxy } from "../.server/proxy-handler";
import { parse } from "../.server/translate/from-openai-chat";

export async function action({ request }: Route.ActionArgs) {
  try {
    return await handleProxy(request, {
      clientFormat: "openai-chat",
      parse,
      endpoint: "chat-completions",
    });
  } catch (err) {
    // Timeout upstream / kegagalan tak terduga → jawab rapi, jangan crash SSR.
    const message =
      err instanceof Error ? err.message : "upstream request failed";
    return Response.json(
      { error: { message: `upstream error: ${message}`, type: "proxy_error" } },
      { status: 502 },
    );
  }
}
