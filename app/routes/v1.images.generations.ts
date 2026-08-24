import type { Route } from "./+types/v1.images.generations";
import { handleMediaRequest } from "../.server/media-proxy";

export async function action({ request }: Route.ActionArgs) {
  return handleMediaRequest(request, "images-generations");
}

export function loader() {
  return Response.json(
    { error: { message: "POST /v1/images/generations" } },
    { status: 405 },
  );
}
