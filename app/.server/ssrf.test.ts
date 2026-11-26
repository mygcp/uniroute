import { describe, expect, test } from "bun:test";
import { classifyIp, isLoopbackHost, isMetadataHost, validateUrlSync } from "./ssrf";

describe("ssrf helpers", () => {
  test("detects metadata and loopback hosts including IPv4-mapped IPv6", () => {
    expect(isMetadataHost("169.254.169.254")).toBe(true);
    expect(isMetadataHost("metadata.google.internal")).toBe(true);
    expect(isMetadataHost("::ffff:169.254.169.254")).toBe(true);
    expect(isMetadataHost("::ffff:a9fe:a9fe")).toBe(true);
    expect(classifyIp("::ffff:169.254.169.254")).toBe("metadata");

    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("::ffff:127.0.0.1")).toBe(true);
    expect(classifyIp("fe80::1")).toBe("metadata");
    expect(classifyIp("fc00::1")).toBe("private");
    expect(classifyIp("10.1.2.3")).toBe("private");
    expect(classifyIp("::ffff:10.1.2.3")).toBe("private");
    expect(classifyIp("8.8.8.8")).toBe("public");
  });

  test("validateUrlSync blocks unsafe schemes and metadata hosts", () => {
    expect(validateUrlSync("file:///etc/passwd").ok).toBe(false);
    expect(validateUrlSync("gopher://127.0.0.1:6379/").ok).toBe(false);
    expect(validateUrlSync("http://169.254.169.254/latest/meta-data").ok).toBe(false);
    expect(validateUrlSync("http://[::ffff:169.254.169.254]/latest").ok).toBe(false);
    expect(validateUrlSync("http://metadata.google.internal/computeMetadata/v1/").ok).toBe(false);

    expect(validateUrlSync("http://127.0.0.1:8080/v1").ok).toBe(false);
    expect(validateUrlSync("http://192.168.1.50:11434").ok).toBe(false);

    expect(
      validateUrlSync("http://127.0.0.1:11434/v1", {
        allowPrivate: true,
        allowLoopback: true,
      }).ok,
    ).toBe(true);
    expect(
      validateUrlSync("http://192.168.1.50:11434/v1", {
        allowPrivate: true,
        allowLoopback: true,
      }).ok,
    ).toBe(true);
    expect(
      validateUrlSync("http://169.254.169.254/latest/meta-data", {
        allowPrivate: true,
        allowLoopback: true,
      }).ok,
    ).toBe(false);
    expect(validateUrlSync("https://api.openai.com/v1").ok).toBe(true);
  });
});
