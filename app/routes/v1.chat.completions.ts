import type { Route } from "./+types/v1.chat.completions";
import { handleProxy } from "../.server/proxy-handler";
import { parse } from "../.server/translate/from-openai-chat";

export async function action({ request }: Route.ActionArgs) {
  return handleProxy(request, { clientFormat: "openai-chat", parse });
}
