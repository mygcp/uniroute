import "./.server/db";

import { renderToReadableStream } from "react-dom/server";
import type { EntryContext, RouterContextProvider } from "react-router";
import { ServerRouter } from "react-router";
import { isbot } from "isbot";

export const streamTimeout = 30_000;

export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  routerContext: EntryContext,
  _loadContext: RouterContextProvider,
) {
  // https://httpwg.org/specs/rfc9110.html#HEAD
  if (request.method.toUpperCase() === "HEAD") {
    return new Response(null, {
      status: responseStatusCode,
      headers: responseHeaders,
    });
  }

  let userAgent = request.headers.get("user-agent");

  const body = await renderToReadableStream(
    <ServerRouter context={routerContext} url={request.url} />,
    {
      signal: request.signal,
      onError(error: unknown) {
        responseStatusCode = 500;
        if (userAgent && !isbot(userAgent)) {
          console.error(error);
        }
      },
    },
  );

  if (routerContext.isSpaMode) {
    responseHeaders.set("X-React-Router-Wait", "1");
  }

  responseHeaders.set("Content-Type", "text/html");
  return new Response(body, {
    status: responseStatusCode,
    headers: responseHeaders,
  });
}