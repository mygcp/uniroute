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
  } catch {
    return Response.json(
      { error: { message: "upstream request failed", type: "proxy_error" } },
      { status: 502 },
    );
  }
}
