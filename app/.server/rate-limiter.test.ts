import { beforeEach, describe, expect, test } from "bun:test";
import {
  acquireSlot,
  checkRateLimit,
  currentConcurrent,
  releaseSlot,
  resetRateLimiter,
} from "./rate-limiter";

beforeEach(() => {
  resetRateLimiter();
});

describe("rate-limiter", () => {
  describe("checkRateLimit rpm", () => {
    test("allows up to rpm requests then denies", () => {
      expect(checkRateLimit("rpmkey", 0, { rpm: 3 })).toEqual({ allowed: true });
      expect(checkRateLimit("rpmkey", 0, { rpm: 3 })).toEqual({ allowed: true });
      expect(checkRateLimit("rpmkey", 0, { rpm: 3 })).toEqual({ allowed: true });
      expect(checkRateLimit("rpmkey", 0, { rpm: 3 })).toEqual({ allowed: false, limit: "rpm" });
      expect(checkRateLimit("rpmkey", 0, { rpm: 3 })).toEqual({ allowed: false, limit: "rpm" });
    });

    test("reset clears rpm state and allows again", () => {
      expect(checkRateLimit("rpmkey", 0, { rpm: 3 })).toEqual({ allowed: true });
      expect(checkRateLimit("rpmkey", 0, { rpm: 3 })).toEqual({ allowed: true });
      expect(checkRateLimit("rpmkey", 0, { rpm: 3 })).toEqual({ allowed: true });
      expect(checkRateLimit("rpmkey", 0, { rpm: 3 })).toEqual({ allowed: false, limit: "rpm" });

      resetRateLimiter();

      expect(checkRateLimit("rpmkey", 0, { rpm: 3 })).toEqual({ allowed: true });
      expect(checkRateLimit("rpmkey", 0, { rpm: 3 })).toEqual({ allowed: true });
      expect(checkRateLimit("rpmkey", 0, { rpm: 3 })).toEqual({ allowed: true });
      expect(checkRateLimit("rpmkey", 0, { rpm: 3 })).toEqual({ allowed: false, limit: "rpm" });
    });
  });

  describe("checkRateLimit tpm", () => {
    test("denies when token sum would exceed tpm", () => {
      expect(checkRateLimit("tpmkey", 60, { tpm: 100 })).toEqual({ allowed: true });
      expect(checkRateLimit("tpmkey", 50, { tpm: 100 })).toEqual({ allowed: false, limit: "tpm" });
      expect(checkRateLimit("tpmkey", 40, { tpm: 100 })).toEqual({ allowed: true });
      expect(checkRateLimit("tpmkey", 60, { tpm: 100 })).toEqual({ allowed: false, limit: "tpm" });
    });

    test("tokens not counted when tpm unset, many calls allowed", () => {
      for (let i = 0; i < 100; i++) {
        expect(checkRateLimit("nokey", 100, {})).toEqual({ allowed: true });
      }
    });

    test("scopes are isolated", () => {
      expect(checkRateLimit("akey", 90, { tpm: 100 })).toEqual({ allowed: true });
      expect(checkRateLimit("bkey", 90, { tpm: 100 })).toEqual({ allowed: true });
      expect(checkRateLimit("akey", 90, { tpm: 100 })).toEqual({ allowed: false, limit: "tpm" });
    });
  });

  describe("concurrency", () => {
    test("acquireSlot honors limit and release frees a slot", () => {
      expect(acquireSlot("ckey", 2)).toBe(true);
      expect(acquireSlot("ckey", 2)).toBe(true);
      expect(acquireSlot("ckey", 2)).toBe(false);
      expect(currentConcurrent("ckey")).toBe(2);

      releaseSlot("ckey");

      expect(currentConcurrent("ckey")).toBe(1);
      expect(acquireSlot("ckey", 2)).toBe(true);
      expect(acquireSlot("ckey", 2)).toBe(false);
    });

    test("releaseSlot never drops below zero", () => {
      releaseSlot("empty");
      releaseSlot("empty");
      expect(currentConcurrent("empty")).toBe(0);
    });

    test("releaseSlot leaves zero when last slot released", () => {
      expect(acquireSlot("lkey", 1)).toBe(true);
      releaseSlot("lkey");
      expect(currentConcurrent("lkey")).toBe(0);
      expect(acquireSlot("lkey", 1)).toBe(true);
    });
  });

  describe("resetRateLimiter", () => {
    test("clears rpm and concurrency state", () => {
      checkRateLimit("rkey", 0, { rpm: 1, tpm: 1 });
      acquireSlot("rkey", 1);
      expect(currentConcurrent("rkey")).toBe(1);

      resetRateLimiter();

      expect(checkRateLimit("rkey", 0, { rpm: 1, tpm: 1 })).toEqual({ allowed: true });
      expect(checkRateLimit("rkey", 0, { rpm: 1, tpm: 1 })).toEqual({ allowed: false, limit: "rpm" });
      expect(acquireSlot("rkey", 1)).toBe(true);
      expect(currentConcurrent("rkey")).toBe(1);
    });
  });
});