import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { redirect } from "react-router";

export const SESSION_COOKIE = "uniroute_session";
const SESSION_MAX_AGE_SEC = 60 * 60 * 24;
const SESSION_MAX_AGE_MS = SESSION_MAX_AGE_SEC * 1000;
const MAX_SESSIONS = 1000;

export const DEFAULT_PASSWORD = "CHANGEME";

let warnedDefaultPassword = false;
const ENCODER = new TextEncoder();
const AUTH_STATE_SYMBOL = Symbol.for("uniroute.authState");
type AuthState = {
  compareKey: Buffer;
  sessions: Map<string, number>;
  loginFailures: Map<string, { count: number; resetAt: number }>;
};
const gAuth = globalThis as Record<symbol, AuthState | undefined>;
const authState: AuthState =
  gAuth[AUTH_STATE_SYMBOL] ??
  (gAuth[AUTH_STATE_SYMBOL] = {
    compareKey: randomBytes(32),
    sessions: new Map<string, number>(),
    loginFailures: new Map<string, { count: number; resetAt: number }>(),
  });

const PASSWORD_COMPARE_KEY = authState.compareKey;
const sessions = authState.sessions;
const loginFailures = authState.loginFailures;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;

function pruneExpiredSessions(now = Date.now()): void {
  for (const [token, expiresAt] of sessions) {
    if (expiresAt <= now) sessions.delete(token);
  }
}

export function createSession(): string {
  const now = Date.now();
  if (sessions.size >= MAX_SESSIONS) {
    pruneExpiredSessions(now);
    while (sessions.size >= MAX_SESSIONS) {
      const oldest = sessions.keys().next().value;
      if (oldest === undefined) break;
      sessions.delete(oldest);
    }
  }
  const token = randomBytes(32).toString("hex");
  sessions.set(token, now + SESSION_MAX_AGE_MS);
  return token;
}

export function isValid(token: string | null | undefined): boolean {
  if (!token) return false;
  const expiresAt = sessions.get(token);
  if (expiresAt === undefined) return false;
  if (expiresAt <= Date.now()) {
    sessions.delete(token);
    return false;
  }
  return true;
}

export function destroySession(token: string): void {
  sessions.delete(token);
}

export function getSessionToken(request: Request): string | null {
  const cookie = request.headers.get("cookie");
  const match = cookie?.match(/(?:^|;\s*)uniroute_session=([^;]+)/);
  return match ? match[1] : null;
}

export function timingSafeStringEqual(a: string, b: string): boolean {
  const digestA = createHash("sha256").update(ENCODER.encode(a)).digest();
  const digestB = createHash("sha256").update(ENCODER.encode(b)).digest();
  return timingSafeEqual(digestA, digestB) && a.length === b.length;
}

export function verifyCsrfOrigin(request: Request): boolean {
  const method = request.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
    return true;
  }
  const secFetchSite = request.headers.get("sec-fetch-site")?.toLowerCase();
  if (secFetchSite === "cross-site") {
    return false;
  }
  const origin = request.headers.get("origin");
  if (!origin) return true;

  let originHost: string;
  try {
    originHost = new URL(origin).host.toLowerCase();
  } catch {
    return false;
  }

  const reqHost = new URL(request.url).host.toLowerCase();
  const hostHeader = request.headers.get("host")?.toLowerCase();
  const fwdHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim().toLowerCase();
  return (
    originHost === reqHost ||
    (hostHeader != null && originHost === hostHeader) ||
    (fwdHost != null && originHost === fwdHost)
  );
}

export function requireSession(request: Request): Response | null {
  if (!isValid(getSessionToken(request))) {
    return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  if (!verifyCsrfOrigin(request)) {
    return Response.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  return null;
}

export function requireLoaderSession(request: Request): void {
  if (isValid(getSessionToken(request))) return;
  const { pathname, search } = new URL(request.url);
  if (
    pathname.endsWith(".data") ||
    (request.headers.get("accept") ?? "").includes("application/json")
  ) {
    throw Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  throw redirect(`/login?next=${encodeURIComponent(pathname + search)}`);
}

function isHttpsRequest(request?: Request): boolean {
  if (process.env.FORCE_SECURE_COOKIE === "1") return true;
  if (!request) return false;
  try {
    if (new URL(request.url).protocol === "https:") return true;
  } catch {
    /* ignore */
  }
  const xfProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  if (xfProto === "https") return true;
  const cfVisitor = request.headers.get("cf-visitor")?.toLowerCase();
  return Boolean(cfVisitor && cfVisitor.includes('"https"'));
}

export function setSessionCookie(response: Response, token: string, request?: Request): void {
  const secure = isHttpsRequest(request) ? "; Secure" : "";
  response.headers.set(
    "Set-Cookie",
    `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_SEC}${secure}`,
  );
}

export function clearSessionCookie(response: Response, request?: Request): void {
  const secure = isHttpsRequest(request) ? "; Secure" : "";
  response.headers.set(
    "Set-Cookie",
    `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`,
  );
}

export function verifyPassword(input: string): boolean {
  const pwd = process.env.PASSWORD?.trim() || DEFAULT_PASSWORD;
  if (!process.env.PASSWORD?.trim() && !warnedDefaultPassword) {
    warnedDefaultPassword = true;
    console.warn(
      "[uniroute] PASSWORD not set: using default 'CHANGEME'. Set it in .env for production.",
    );
  }
  if (!input) return false;
  const macInput = createHmac("sha256", PASSWORD_COMPARE_KEY).update(ENCODER.encode(input)).digest();
  const macPwd = createHmac("sha256", PASSWORD_COMPARE_KEY).update(ENCODER.encode(pwd)).digest();
  return timingSafeEqual(macInput, macPwd);
}

export function checkLoginRateLimit(key: string): { ok: true } | { ok: false; retryAfterSec: number } {
  const now = Date.now();
  const entry = loginFailures.get(key);
  if (!entry) return { ok: true };
  if (entry.resetAt <= now) {
    loginFailures.delete(key);
    return { ok: true };
  }
  if (entry.count >= LOGIN_MAX_ATTEMPTS) {
    return { ok: false, retryAfterSec: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)) };
  }
  return { ok: true };
}

export function recordLoginFailure(key: string): void {
  const now = Date.now();
  if (loginFailures.size > 2000) {
    for (const [k, v] of loginFailures) {
      if (v.resetAt <= now) loginFailures.delete(k);
    }
    if (loginFailures.size > 2000) loginFailures.clear();
  }
  const existing = loginFailures.get(key);
  if (!existing || existing.resetAt <= now) {
    loginFailures.set(key, { count: 1, resetAt: now + LOGIN_WINDOW_MS });
  } else {
    existing.count += 1;
  }
}

export function clearLoginFailures(key: string): void {
  loginFailures.delete(key);
}
