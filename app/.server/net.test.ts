import { describe, expect, test } from "bun:test";
import { ipInCidr, ipInList } from "./net";

describe("ipInCidr", () => {
  test("matches within subnet", () => {
    expect(ipInCidr("192.168.1.50", "192.168.1.0/24")).toBe(true);
    expect(ipInCidr("192.168.1.55", "192.168.1.0/24")).toBe(true);
  });

  test("does not match outside subnet", () => {
    expect(ipInCidr("192.168.2.1", "192.168.1.0/24")).toBe(false);
  });

  test("bare ip treated as /32", () => {
    expect(ipInCidr("10.0.0.5", "10.0.0.5")).toBe(true);
    expect(ipInCidr("10.0.0.6", "10.0.0.5")).toBe(false);
  });

  test("boundary and prefix", () => {
    expect(ipInCidr("10.0.0.255", "10.0.0.0/24")).toBe(true);
    expect(ipInCidr("10.0.1.0", "10.0.0.0/24")).toBe(false);
    expect(ipInCidr("255.255.255.255", "0.0.0.0/0")).toBe(true);
    expect(ipInCidr("1.2.3.4", "0.0.0.0/0")).toBe(true);
    expect(ipInCidr("1.2.3.4", "1.2.3.4/32")).toBe(true);
    expect(ipInCidr("1.2.3.5", "1.2.3.4/32")).toBe(false);
  });

  test("malformed cidr returns false, never throws", () => {
    expect(ipInCidr("192.168.1.50", "not-a-cidr")).toBe(false);
    expect(ipInCidr("192.168.1.50", "1.2.3.4/99")).toBe(false);
    expect(ipInCidr("192.168.1.50", "1.2.3.4/-1")).toBe(false);
    expect(ipInCidr("192.168.1.50", "1.2.3.4.5")).toBe(false);
    expect(ipInCidr("192.168.1.50", "")).toBe(false);
    expect(() => ipInCidr("192.168.1.50", "999.999.999.999/24")).not.toThrow();
  });

  test("malformed ip returns false, never throws", () => {
    expect(ipInCidr("not-an-ip", "10.0.0.0/8")).toBe(false);
    expect(ipInCidr("", "10.0.0.0/8")).toBe(false);
    expect(ipInCidr("256.1.1.1", "10.0.0.0/8")).toBe(false);
    expect(ipInCidr("1.2.3", "10.0.0.0/8")).toBe(false);
    expect(() => ipInCidr("not-an-ip", "not-a-cidr")).not.toThrow();
  });
});

describe("ipInList", () => {
  test("matches any entry", () => {
    const list = ["10.0.0.0/8", "192.168.1.0/24"];
    expect(ipInList("10.1.2.3", list)).toBe(true);
    expect(ipInList("192.168.1.50", list)).toBe(true);
    expect(ipInList("8.8.8.8", list)).toBe(false);
  });

  test("empty list returns false", () => {
    expect(ipInList("1.2.3.4", [])).toBe(false);
  });

  test("malformed entries tolerated, never throws", () => {
    const list = ["bad-entry", "not-an-ip", "10.0.0.0/8"];
    expect(ipInList("10.1.2.3", list)).toBe(true);
    expect(ipInList("1.2.3.4", list)).toBe(false);
    expect(ipInList("not-an-ip", list)).toBe(false);
    expect(() => ipInList("not-an-ip", list)).not.toThrow();
  });

  test("matches IPv6 CIDRs and IPv4-mapped IPv6 addresses", () => {
    expect(ipInCidr("2001:db8:1::42", "2001:db8::/32")).toBe(true);
    expect(ipInCidr("2001:db9::1", "2001:db8::/32")).toBe(false);
    expect(ipInCidr("::1", "::1/128")).toBe(true);
    expect(ipInCidr("::2", "::/0")).toBe(true);
    expect(ipInCidr("::ffff:192.168.1.50", "192.168.1.0/24")).toBe(true);
    expect(ipInCidr("192.168.1.50", "::ffff:192.168.1.0/24")).toBe(true);
  });
});