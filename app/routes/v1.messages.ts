import type { Route } from "./+types/v1.messages";
import { handleProxy } from "../.server/proxy-handler";
import { parse } from "../.server/translate/from-anthropic";

export async function action({ request }: Route.ActionArgs) {
  try {
    return await handleProxy(request, {
      clientFormat: "anthropic",
      parse,
      endpoint: "messages",
    });
  } catch {
    return Response.json(
      { error: { message: "upstream request failed", type: "proxy_error" } },
      { status: 502 },
    );
  }
}
