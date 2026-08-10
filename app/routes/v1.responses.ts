import type { Route } from "./+types/v1.responses";
import { handleProxy } from "../.server/proxy-handler";
import { parse } from "../.server/translate/from-responses";

export async function action({ request }: Route.ActionArgs) {
  return handleProxy(request, { clientFormat: "openai-responses", parse });
}
