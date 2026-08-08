import { resolve } from "node:path";
import { query } from "./db";
import { recordProxyLog } from "./logger";

const TIMEOUT_MS = 5_000;

export type CompressionSettings = {
  rtk_enabled: boolean;
  caveman_enabled: boolean;
  rtk_binary_path: string;
  caveman_binary_path: string;
};

export function getSettings(): CompressionSettings {
  const row = query(
    `SELECT rtk_enabled, caveman_enabled, rtk_binary_path, caveman_binary_path
     FROM compression_settings WHERE id = 1`,
  ).get() as
    | {
        rtk_enabled: number;
        caveman_enabled: number;
        rtk_binary_path: string | null;
        caveman_binary_path: string | null;
      }
    | undefined;

  return {
    rtk_enabled: !!row?.rtk_enabled,
    caveman_enabled: !!row?.caveman_enabled,
    rtk_binary_path: row?.rtk_binary_path ?? "./bin/rtk",
    caveman_binary_path: row?.caveman_binary_path ?? "./bin/caveman",
  };
}

export function isEnabled(): { rtk: boolean; caveman: boolean } {
  const { rtk_enabled, caveman_enabled } = getSettings();
  return { rtk: rtk_enabled, caveman: caveman_enabled };
}

/**
 * Jalankan satu binary via stdin->stdout dengan timeout 5s.
 * Throw → fallback ke prompt asli.
 */
async function runBinary(binPath: string, input: string): Promise<string> {
  if (typeof Bun === "undefined") {
    throw new Error("Bun runtime not available");
  }

  const proc = Bun.spawn({
    cmd: [resolve(binPath)],
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  const encoder = new TextEncoder();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;

  try {
    const reader = proc.stdout.getReader();
    timeout = setTimeout(() => {
      timedOut = true;
      try {
        proc.kill();
      } catch {
        /* ignore */
      }
      try {
        reader.cancel("compression timeout");
      } catch {
        /* ignore */
      }
    }, TIMEOUT_MS);

    proc.stdin?.write(encoder.encode(input));
    proc.stdin?.end();

    let stdout = "";
    const decoder = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      stdout += decoder.decode(value, { stream: true });
    }

    const code = await proc.exited;
    if (timedOut) {
      throw new Error(`binary timed out after ${TIMEOUT_MS}ms`);
    }
    if (code !== 0) {
      throw new Error(`binary exited with code ${code}`);
    }
    return stdout;
  } finally {
    clearTimeout(timeout);
    try {
      proc.kill();
    } catch {}
  }
}

export async function compress(prompt: string): Promise<{
  output: string;
  usedFallback: boolean;
  durationMs: number;
}> {
  const { rtk, caveman } = isEnabled();
  const start = Date.now();
  if (!rtk && !caveman) {
    return { output: prompt, usedFallback: false, durationMs: 0 };
  }

  const settings = getSettings();
  try {
    let out = prompt;
    if (settings.rtk_enabled) {
      out = await runBinary(settings.rtk_binary_path, out);
    }
    if (settings.caveman_enabled) {
      out = await runBinary(settings.caveman_binary_path, out);
    }
    return {
      output: out,
      usedFallback: false,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    recordProxyLog({
      level: "warn",
      source: "compressor",
      message: "compression failed, fallback to original prompt",
      metadata: { error: err instanceof Error ? err.message : String(err) },
    });
    return {
      output: prompt,
      usedFallback: true,
      durationMs: Date.now() - start,
    };
  }
}

export async function testCompression(
  sample: string,
): Promise<{
  output: string;
  usedFallback: boolean;
  durationMs: number;
  settings: CompressionSettings;
}> {
  const settings = getSettings();
  const start = Date.now();

  if (!settings.rtk_enabled && !settings.caveman_enabled) {
    return {
      output: sample,
      usedFallback: false,
      durationMs: 0,
      settings,
    };
  }

  try {
    let out = sample;
    if (settings.rtk_enabled) {
      out = await runBinary(settings.rtk_binary_path, out);
    }
    if (settings.caveman_enabled) {
      out = await runBinary(settings.caveman_binary_path, out);
    }
    return {
      output: out,
      usedFallback: false,
      durationMs: Date.now() - start,
      settings,
    };
  } catch (err) {
    recordProxyLog({
      level: "warn",
      source: "compressor",
      message: "compression test failed, fallback to original prompt",
      metadata: { error: err instanceof Error ? err.message : String(err) },
    });
    return {
      output: sample,
      usedFallback: true,
      durationMs: Date.now() - start,
      settings,
    };
  }
}