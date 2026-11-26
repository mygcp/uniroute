import { randomUUID } from "node:crypto";

process.env.DATABASE_URL = `/tmp/uniroute-auth-test-${randomUUID()}.db`;

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { resetTestDb } from "./test-db";

let SESSION_COOKIE: string;
let clearSessionCookie: (res: Response) => void;
let createSession: () => string;
let destroySession: (token: string) => void;
let getSessionToken: (req: Request) => string | null;
let isValid: (token: string | null | undefined) => boolean;
let setSessionCookie: (res: Response, token: string, req?: Request) => void;
let verifyPassword: (pw: string) => boolean;
let verifyCsrfOrigin: (req: Request) => boolean;
let requireLoaderSession: (req: Request) => void;
let checkLoginRateLimit: (key: string) => { ok: boolean; retryAfterSec?: number };
let recordLoginFailure: (key: string) => void;
let clearLoginFailures: (key: string) => void;

beforeAll(async () => {
  await resetTestDb();
  const auth = await import("./auth");
  SESSION_COOKIE = auth.SESSION_COOKIE;
  clearSessionCookie = auth.clearSessionCookie;
  createSession = auth.createSession;
  destroySession = auth.destroySession;
  getSessionToken = auth.getSessionToken;
  isValid = auth.isValid;
  setSessionCookie = auth.setSessionCookie;
  verifyPassword = auth.verifyPassword;
  verifyCsrfOrigin = auth.verifyCsrfOrigin;
  requireLoaderSession = auth.requireLoaderSession;
  checkLoginRateLimit = auth.checkLoginRateLimit;
  recordLoginFailure = auth.recordLoginFailure;
  clearLoginFailures = auth.clearLoginFailures;
});

afterAll(() => {
  try {
    Bun.spawnSync(["rm", "-f", `${process.env.DATABASE_URL!}*`]);
  } catch {
    /* ignore */
  }
});

describe("auth sessions", () => {
  test("created sessions are valid until destroyed", () => {
    const token = createSession();
    expect(token.length).toBeGreaterThan(0);
    expect(isValid(token)).toBe(true);
    destroySession(token);
    expect(isValid(token)).toBe(false);
  });

  test("null/undefined/unknown token is invalid", () => {
    expect(isValid(null)).toBe(false);
    expect(isValid(undefined)).toBe(false);
    expect(isValid("not-a-session")).toBe(false);
  });

  test("getSessionToken parses cookie header", () => {
    const req = new Request("http://x/", {
      headers: { cookie: "foo=bar; uniroute_session=abc123" },
    });
    expect(getSessionToken(req)).toBe("abc123");
    expect(getSessionToken(new Request("http://x/"))).toBeNull();
  });
});

describe("session cookie", () => {
  test("sets HttpOnly + Path=/ + Max-Age", () => {
    const res = new Response();
    setSessionCookie(res, "tok");
    const cookie = res.headers.get("Set-Cookie")!;
    expect(cookie).toContain(`${SESSION_COOKIE}=tok`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("Max-Age=");
  });

  test("clearSessionCookie expires immediately", () => {
    const res = new Response();
    clearSessionCookie(res);
    expect(res.headers.get("Set-Cookie")).toContain("Max-Age=0");
  });

  test("setSessionCookie sets Secure only for HTTPS / forwarded HTTPS requests", () => {
    const prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const httpRes = new Response();
      setSessionCookie(httpRes, "tok", new Request("http://127.0.0.1:3000/login"));
      expect(httpRes.headers.get("Set-Cookie")).not.toContain("; Secure");

      const httpsRes = new Response();
      setSessionCookie(
        httpsRes,
        "tok",
        new Request("http://127.0.0.1:3000/login", {
          headers: { "x-forwarded-proto": "https" },
        }),
      );
      expect(httpsRes.headers.get("Set-Cookie")).toContain("; Secure");

      const cfRes = new Response();
      setSessionCookie(
        cfRes,
        "tok",
        new Request("http://127.0.0.1:3000/login", {
          headers: { "cf-visitor": '{"scheme":"https"}' },
        }),
      );
      expect(cfRes.headers.get("Set-Cookie")).toContain("; Secure");
    } finally {
      process.env.NODE_ENV = prevEnv;
    }
  });
});

describe("verifyPassword", () => {
  const original = process.env.PASSWORD;
  beforeEach(() => {
    process.env.PASSWORD = "CHANGEME";
  });
  afterAll(() => {
    if (original === undefined) delete process.env.PASSWORD;
    else process.env.PASSWORD = original;
  });

  test("accepts the configured password", () => {
    expect(verifyPassword("CHANGEME")).toBe(true);
  });

  test("rejects wrong password", () => {
    expect(verifyPassword("salah")).toBe(false);
  });

  test("rejects empty input", () => {
    expect(verifyPassword("")).toBe(false);
  });
});

describe("CSRF, rate limit, and .data guard", () => {
  test("verifyCsrfOrigin permits GET and same-origin POST, blocks cross-origin POST", () => {
    expect(verifyCsrfOrigin(new Request("http://localhost:3000/providers"))).toBe(true);
    expect(
      verifyCsrfOrigin(
        new Request("http://localhost:3000/providers", {
          method: "POST",
          headers: { origin: "http://localhost:3000" },
        }),
      ),
    ).toBe(true);
    expect(
      verifyCsrfOrigin(
        new Request("http://localhost:3000/providers", {
          method: "POST",
          headers: { origin: "https://evil.example" },
        }),
      ),
    ).toBe(false);
  });

  test("login rate limiter locks after repeated failures and resets on clear", () => {
    const key = "198.51.100.77";
    clearLoginFailures(key);
    for (let i = 0; i < 10; i++) {
      expect(checkLoginRateLimit(key).ok).toBe(true);
      recordLoginFailure(key);
    }
    const blocked = checkLoginRateLimit(key);
    expect(blocked.ok).toBe(false);
    clearLoginFailures(key);
    expect(checkLoginRateLimit(key).ok).toBe(true);
  });

  test("requireLoaderSession rejects unauthenticated .data requests with 401", () => {
    let thrown: unknown;
    try {
      requireLoaderSession(new Request("http://localhost:3000/providers.data"));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(401);
  });
});
