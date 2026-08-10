import type { Route } from "./+types/v1.messages";
import { handleProxy } from "../.server/proxy-handler";
import { parse } from "../.server/translate/from-anthropic";

export async function action({ request }: Route.ActionArgs) {
  return handleProxy(request, { clientFormat: "anthropic", parse });
}
