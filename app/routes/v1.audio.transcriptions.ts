import type { Route } from "./+types/v1.audio.transcriptions";
import { handleMediaRequest } from "../.server/media-proxy";

export async function action({ request }: Route.ActionArgs) {
  return handleMediaRequest(request, "audio-transcriptions");
}

export function loader() {
  return Response.json(
    { error: { message: "POST /v1/audio/transcriptions" } },
    { status: 405 },
  );
}
