import type { AccessHoursConfig } from "./client-key";

const DAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

function toLocalParts(d: Date, timeZone: string): { hours: number; minutes: number; weekday: string } | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
      hourCycle: "h23",
      timeZone,
    }).formatToParts(d);
    const map: Record<string, string> = {};
    for (const part of parts) map[part.type] = part.value;
    const hours = Number(map.hour);
    const minutes = Number(map.minute);
    if (Number.isNaN(hours) || Number.isNaN(minutes)) return null;
    const shortDay = (map.weekday ?? "").toLowerCase();
    const fullIndex = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"].indexOf(shortDay);
    return { hours, minutes, weekday: DAY_NAMES[fullIndex] ?? "" };
  } catch {
    return null;
  }
}

function utcParts(d: Date): { hours: number; minutes: number; weekday: string } {
  return {
    hours: d.getUTCHours(),
    minutes: d.getUTCMinutes(),
    weekday: DAY_NAMES[d.getUTCDay()],
  };
}

/** Compare "HH:mm" (24h) strings lexicographically. */
function hhmmOf(parts: { hours: number; minutes: number }): string {
  return `${pad(parts.hours)}:${pad(parts.minutes)}`;
}

function minutesOf(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/**
 * Cek apakah waktu sekarang (di timezone config) berada dalam hari & jam yang
 * diizinkan. Konfigurasi null/salah/disabled → allowed. Timezone yang tidak
 * bisa di-resolve → fallback interpretasi UTC (agar tidak hard-block).
 */
export function isWithinAccessHours(
  cfg: AccessHoursConfig | null | undefined,
  now: Date = new Date(),
): { allowed: boolean; reason?: string } {
  if (!cfg || cfg.enabled !== true) return { allowed: true };

  const tz = cfg.timezone?.trim();
  const parts = (tz ? toLocalParts(now, tz) : null) ?? utcParts(now);

  if (Array.isArray(cfg.allowed_days) && cfg.allowed_days.length > 0) {
    const days = cfg.allowed_days.map((d) => d.trim().toLowerCase());
    if (!days.includes(parts.weekday)) {
      return { allowed: false, reason: "outside allowed days" };
    }
  }

  const nowMin = Number(pad(parts.hours)) * 60 + parts.minutes;
  const startMin = cfg.start_time ? minutesOf(cfg.start_time.trim()) : null;
  const endMin = cfg.end_time ? minutesOf(cfg.end_time.trim()) : null;

  if (startMin !== null && endMin !== null) {
    if (startMin <= endMin ? nowMin < startMin || nowMin >= endMin : nowMin < startMin && nowMin >= endMin) {
      return { allowed: false, reason: "outside allowed hours" };
    }
  } else if (startMin !== null) {
    if (nowMin < startMin) return { allowed: false, reason: "outside allowed hours" };
  } else if (endMin !== null) {
    if (nowMin >= endMin) return { allowed: false, reason: "outside allowed hours" };
  }

  return { allowed: true };
}