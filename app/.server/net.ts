const MASK32 = 0xffffffff;

/**
 * Parse IPv4 "a.b.c.d" menjadi uint32. Return null bila format salah
 * atau ada oktet di luar 0..255.
 */
function parseIp(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;

  let value = 0;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = ((value << 8) | octet) >>> 0;
  }
  return value >>> 0;
}

/** Parse entry CIDR "a.b.c.d/n" atau bare IP. Return null bila malformed. */
function parseCidr(cidr: string): { ip: number; mask: number } | null {
  const trimmed = cidr.trim();
  if (trimmed === "") return null;

  const slash = trimmed.indexOf("/");
  let ipPart: string;
  let prefix: number;

  if (slash === -1) {
    ipPart = trimmed;
    prefix = 32;
  } else {
    ipPart = trimmed.slice(0, slash);
    const prefixPart = trimmed.slice(slash + 1);
    if (!/^\d+$/.test(prefixPart)) return null;
    prefix = Number(prefixPart);
    if (prefix < 0 || prefix > 32) return null;
  }

  const ip = parseIp(ipPart);
  if (ip === null) return null;

  const mask = prefix === 0 ? 0 : (MASK32 << (32 - prefix)) >>> 0;
  return { ip: ip & mask, mask };
}

/** Cek apakah `ip` (IPv4) berada dalam subnet `cidr` "a.b.c.d/n" atau bare IP (/32). */
export function ipInCidr(ip: string, cidr: string): boolean {
  const ipValue = parseIp(ip);
  const cidrParsed = parseCidr(cidr);
  if (ipValue === null || cidrParsed === null) return false;
  return (ipValue & cidrParsed.mask) === cidrParsed.ip;
}

/** True bila `ip` cocok dengan salah satu entry di `list`. */
export function ipInList(ip: string, list: string[]): boolean {
  for (const entry of list) {
    if (ipInCidr(ip, entry)) return true;
  }
  return false;
}