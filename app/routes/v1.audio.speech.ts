import type { Route } from "./+types/v1.audio.speech";
import { handleMediaRequest } from "../.server/media-proxy";

export async function action({ request }: Route.ActionArgs) {
  return handleMediaRequest(request, "audio-speech");
}

export function loader() {
  return Response.json(
    { error: { message: "POST /v1/audio/speech" } },
    { status: 405 },
  );
}
