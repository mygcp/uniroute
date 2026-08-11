import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * Enkripsi AES-256-GCM untuk nilai API key.
 * Kunci AES diturunkan dari env `API_KEY_SECRET` (hex 32 byte) via SHA-256.
 * Format tersimpan: base64(iv(12) || ciphertext || tag(16)).
 * Dibaca saat pemanggilan (bukan module-load) supaya test bisa set env per-case.
 */

export function hasApiKeySecret(): boolean {
  return !!process.env.API_KEY_SECRET?.trim();
}

function aesKey(): Buffer {
  return createHash("sha256").update(process.env.API_KEY_SECRET ?? "").digest();
}

/** Encrypt raw key. Return `null` bila `API_KEY_SECRET` tidak diset. */
export function encryptKey(raw: string): string | null {
  if (!hasApiKeySecret()) return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", aesKey(), iv);
  const encrypted = Buffer.concat([cipher.update(raw, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, encrypted, tag]).toString("base64");
}

/** Decrypt base64(iv||ciphertext||tag). Throw bila secret hilang atau data rusak. */
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