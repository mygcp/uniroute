import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import {
  SESSION_COOKIE,
  clearSessionCookie,
  createSession,
  destroySession,
  getSessionToken,
  isValid,
  setSessionCookie,
  verifyPassword,
} from "./auth";

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