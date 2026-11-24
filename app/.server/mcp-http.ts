import { randomBytes, timingSafeEqual } from "node:crypto";
import { query } from "./db";
import { TOOLS, executeTool } from "./mcp-tools";

const KEY_ENABLED = "mcp_http_enabled";
const KEY_TOKEN = "mcp_http_token";
const KEY_REQUIRE_AUTH = "mcp_http_require_auth";

export const MCP_SERVER_INFO = { name: "uniroute", version: "1.2.0" };

function getSetting(key: string): string | null {
  const row = query("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value?: string }
    | undefined;
  return row?.value ?? null;
}

function setSetting(key: string, value: string): void {
  query(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

function generateToken(): string {
  return `umcp_${randomBytes(24).toString("hex")}`;
}

export function maskMcpToken(token: string): string {
  if (token.length <= 12) return `${token.slice(0, 4)}...`;
  return `${token.slice(0, 9)}...${token.slice(-4)}`;
}

export function isRemoteMcpEnabled(): boolean {
  return getSetting(KEY_ENABLED) === "1";
}

export function isRemoteMcpAuthRequired(): boolean {
  const raw = getSetting(KEY_REQUIRE_AUTH);
  return raw === null ? true : raw === "1";
}

export function setRemoteMcpAuthRequired(required: boolean): void {
  setSetting(KEY_REQUIRE_AUTH, required ? "1" : "0");
}

export function getRemoteMcpToken(): {
  token: string | null;
  source: "env" | "db" | "none";
  masked: string | null;
} {
  const envTok = process.env.UNIROUTE_MCP_TOKEN?.trim();
  if (envTok) {
    return { token: envTok, source: "env", masked: maskMcpToken(envTok) };
  }
  const dbTok = getSetting(KEY_TOKEN)?.trim();
  if (dbTok) {
    return { token: dbTok, source: "db", masked: maskMcpToken(dbTok) };
  }
  return { token: null, source: "none", masked: null };
}

export function ensureRemoteMcpToken(): string {
  const cur = getRemoteMcpToken();
  if (cur.token) return cur.token;
  const fresh = generateToken();
  setSetting(KEY_TOKEN, fresh);
  return fresh;
}

export function rotateRemoteMcpToken(): string {
  if (process.env.UNIROUTE_MCP_TOKEN?.trim()) {
    throw new Error(
      "Token is controlled by UNIROUTE_MCP_TOKEN environment variable. Unset it to manage tokens from the UI.",
    );
  }
  const fresh = generateToken();
  setSetting(KEY_TOKEN, fresh);
  return fresh;
}

export function setRemoteMcpEnabled(enabled: boolean): {
  enabled: boolean;
  generatedToken: string | null;
} {
  let generatedToken: string | null = null;
  if (enabled && !getRemoteMcpToken().token) {
    generatedToken = ensureRemoteMcpToken();
  }
  setSetting(KEY_ENABLED, enabled ? "1" : "0");
  return { enabled, generatedToken };
}

export function getRemoteMcpStatus() {
  const tok = getRemoteMcpToken();
  return {
    enabled: isRemoteMcpEnabled(),
    requireAuth: isRemoteMcpAuthRequired(),
    tokenSource: tok.source,
    tokenMasked: tok.masked,
    hasToken: Boolean(tok.token),
    serverInfo: MCP_SERVER_INFO,
    toolCount: TOOLS.length,
  };
}

/* ----------------------------- JSON-RPC Core ------------------------------- */

export type McpRpcRequest = {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
};

export type McpRpcResponse = {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
};

export async function processMcpRpcMessage(
  msg: McpRpcRequest,
): Promise<McpRpcResponse | null> {
  const { id, method } = msg;
  // JSON-RPC notifications omit `id` (or pass null for notifications/initialized)
  if (id === undefined || id === null) {
    return null;
  }

  switch (method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion:
            (msg.params?.protocolVersion as string) ?? "2025-06-18",
          capabilities: { tools: { listChanged: false } },
          serverInfo: MCP_SERVER_INFO,
        },
      };
    case "ping":
      return { jsonrpc: "2.0", id, result: {} };
    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: TOOLS } };
    case "tools/call": {
      const params = msg.params ?? {};
      const name = String(params.name ?? "");
      const args =
        params.arguments && typeof params.arguments === "object"
          ? (params.arguments as Record<string, unknown>)
          : {};
      try {
        const out = await executeTool(name, args);
        return {
          jsonrpc: "2.0",
          id,
          result: { content: out.content, isError: out.isError === true },
        };
      } catch (err) {
        return {
          jsonrpc: "2.0",
          id,
          error: {
            code: -32603,
            message: err instanceof Error ? err.message : String(err),
          },
        };
      }
    }
    case "resources/list":
      return { jsonrpc: "2.0", id, result: { resources: [] } };
    case "prompts/list":
      return { jsonrpc: "2.0", id, result: { prompts: [] } };
    default:
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${method ?? ""}` },
      };
  }
}

/* -------------------------- HTTP Transport (/api/mcp) ---------------------- */

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers":
      "Authorization, Content-Type, Accept, Mcp-Session-Id, X-MCP-Token",
    "Cache-Control": "no-store",
  };
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function isAuthorized(request: Request): boolean {
  if (!isRemoteMcpAuthRequired()) return true;
  const { token } = getRemoteMcpToken();
  if (!token) return false;

  const authHeader = request.headers.get("authorization") ?? "";
  const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
  const candidate =
    bearerMatch?.[1]?.trim() ?? request.headers.get("x-mcp-token")?.trim() ?? "";
  if (!candidate) return false;
  return safeEqual(candidate, token);
}

export async function handleMcpHttpRequest(
  request: Request,
): Promise<Response> {
  const headers = corsHeaders();

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers });
  }

  if (!isRemoteMcpEnabled()) {
    return Response.json(
      {
        ok: false,
        error:
          "Remote MCP HTTP server is disabled. Enable it in UniRoute -> MCP Server.",
      },
      { status: 503, headers },
    );
  }

  if (!isAuthorized(request)) {
    return Response.json(
      {
        ok: false,
        error: "Unauthorized. Provide a valid Authorization: Bearer <token> header.",
      },
      {
        status: 401,
        headers: {
          ...headers,
          "WWW-Authenticate": 'Bearer realm="uniroute-mcp"',
        },
      },
    );
  }

  if (request.method === "GET") {
    return Response.json(
      {
        ok: true,
        server: MCP_SERVER_INFO,
        transport: "streamable-http",
        tools: TOOLS.length,
      },
      { status: 200, headers },
    );
  }

  if (request.method === "DELETE") {
    return new Response(null, { status: 204, headers });
  }

  if (request.method !== "POST") {
    return Response.json(
      { ok: false, error: "Method not allowed" },
      { status: 405, headers },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error: invalid JSON" },
      },
      { status: 400, headers },
    );
  }

  const sessionHeader =
    request.headers.get("mcp-session-id") || "uniroute-stateless";
  const rpcHeaders = {
    ...headers,
    "Mcp-Session-Id": sessionHeader,
  };

  if (Array.isArray(body)) {
    const results = (
      await Promise.all(
        body.map((item) => processMcpRpcMessage(item as McpRpcRequest)),
      )
    ).filter((r): r is McpRpcResponse => r !== null);
    if (results.length === 0) {
      return new Response(null, { status: 202, headers: rpcHeaders });
    }
    return Response.json(results, { status: 200, headers: rpcHeaders });
  }

  const out = await processMcpRpcMessage(body as McpRpcRequest);
  if (!out) {
    return new Response(null, { status: 202, headers: rpcHeaders });
  }
  return Response.json(out, { status: 200, headers: rpcHeaders });
}
