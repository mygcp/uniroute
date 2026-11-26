import type { Route } from "./+types/v1.responses";
import { handleProxy } from "../.server/proxy-handler";
import { parse } from "../.server/translate/from-responses";

export async function action({ request }: Route.ActionArgs) {
  try {
    return await handleProxy(request, {
      clientFormat: "openai-responses",
      parse,
      endpoint: "responses",
    });
  } catch {
    return Response.json(
      { error: { message: "upstream request failed", type: "proxy_error" } },
      { status: 502 },
    );
  }
}
