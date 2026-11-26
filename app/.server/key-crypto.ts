import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

let cachedSecret: string | undefined;
let cachedDerivedKey: Buffer | null = null;

export function hasApiKeySecret(): boolean {
  return !!process.env.API_KEY_SECRET?.trim();
}

function aesKey(): Buffer {
  const secret = process.env.API_KEY_SECRET ?? "";
  if (cachedDerivedKey && cachedSecret === secret) {
    return cachedDerivedKey;
  }
  cachedSecret = secret;
  cachedDerivedKey = createHash("sha256").update(secret).digest();
  return cachedDerivedKey;
}

export function encryptKey(raw: string): string | null {
  if (!hasApiKeySecret()) return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", aesKey(), iv);
  const encrypted = Buffer.concat([cipher.update(raw, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, encrypted, tag]).toString("base64");
}

export function decryptKey(enc: string): string {
  if (!hasApiKeySecret()) {
    throw new Error("API_KEY_SECRET is not set");
  }
  const buf = Buffer.from(enc, "base64");
  if (buf.length < 28) {
    throw new Error("invalid encrypted key data");
  }
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(buf.length - 16);
  const data = buf.subarray(12, buf.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", aesKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}
