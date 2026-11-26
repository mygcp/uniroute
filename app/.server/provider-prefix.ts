import { getTableVersion, hasColumn, onDbReset, query } from "./db";

export const PREFIX_PATTERN = /^[a-zA-Z0-9._-]{1,32}$/;

type CachedDisplayHit = {
  bare: string;
  prefix: string | null;
  providerId: string;
};

type CachedPrefixEntry = {
  id: string;
  prefix: string;
  head: string;
};

let cachedModelsVer = -1;
let cachedProvidersVer = -1;
let displayLookup = new Map<string, CachedDisplayHit>();
let sortedPrefixes: CachedPrefixEntry[] = [];

onDbReset(() => {
  cachedModelsVer = -1;
  cachedProvidersVer = -1;
  displayLookup.clear();
  sortedPrefixes = [];
});

function ensurePrefixCache(): void {
  const mVer = getTableVersion("models");
  const pVer = getTableVersion("providers");
  if (mVer === cachedModelsVer && pVer === cachedProvidersVer) return;

  const provRows = query(
    "SELECT id, prefix FROM providers WHERE prefix IS NOT NULL AND prefix != ''",
  ).all() as unknown as { id: string; prefix: string }[];
  const nextPrefixes: CachedPrefixEntry[] = [];
  for (const r of provRows) {
    const cleaned = cleanPrefix(r.prefix);
    if (cleaned) {
      nextPrefixes.push({ id: r.id, prefix: cleaned, head: `${cleaned}/` });
    }
  }
  nextPrefixes.sort((a, b) => b.prefix.length - a.prefix.length);

  const nextDisplay = new Map<string, CachedDisplayHit>();
  if (hasDisplayColumn()) {
    const dispRows = query(
      "SELECT m.display_name AS disp, m.model_name AS bare, m.provider_id AS providerId, p.prefix AS prefix FROM models m JOIN providers p ON p.id = m.provider_id WHERE m.display_name IS NOT NULL AND m.display_name != '' AND m.is_active = 1",
    ).all() as Array<{ disp: string; bare: string; providerId: string; prefix: string | null }>;
    for (const r of dispRows) {
      if (!nextDisplay.has(r.disp)) {
        nextDisplay.set(r.disp, {
          bare: r.bare,
          prefix: cleanPrefix(r.prefix),
          providerId: r.providerId,
        });
      }
    }
  }

  sortedPrefixes = nextPrefixes;
  displayLookup = nextDisplay;
  cachedModelsVer = mVer;
  cachedProvidersVer = pVer;
}

/** Bersihkan prefix legacy ("openai/" -> "openai") untuk jalur baca. */
export function cleanPrefix(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const t = String(raw).trim().replace(/^\/+|\/+$/g, "").trim();
  if (t === "") return null;
  return t;
}

/**
 * Normalisasi prefix provider. Hanya berlaku di aplikasi (virtual).
 * - trim + buang "/" di depan/belakang
 * - kosong => null (tanpa prefix)
 * - hanya nama saja: huruf/angka . _ - (tanpa "/")
 * - return null bila kosong, throw bila invalid (untuk validasi UI)
 */
export function normalizePrefix(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const cleaned = cleanPrefix(raw);
  if (!cleaned) return null;
  if (cleaned.includes("/")) {
    throw new Error('prefix cukup nama saja tanpa "/" (contoh: openai)');
  }
  if (!PREFIX_PATTERN.test(cleaned)) {
    throw new Error(
      "prefix harus 1-32 karakter: huruf/angka . _ - (contoh: openai)",
    );
  }
  return cleaned;
}

/**
 * Bentuk display id model: prefix + "/" + model_name.
 * - customDisplay bila diisi (per-model override) menang atas semuanya.
 * - prefix sengaja SELALU ditempel, tanpa dedupe. Jadi bila model bawaan
 *   sudah mengandung "/" (mis. "oc/muse1.3") + prefix "oc" => "oc/oc/muse1.3".
 * - model_name apa adanya dikirim ke upstream sebagai bare.
 */
export function displayName(
  prefix: string | null | undefined,
  modelName: string,
  customDisplay?: string | null,
): string {
  const custom = (customDisplay ?? "").trim();
  if (custom) return custom;
  const clean = cleanPrefix(prefix);
  if (!clean) return modelName;
  return `${clean}/${modelName}`;
}

/** Helper untuk row { prefix, model_name, custom_display? } */
export function displayNameForRow(row: {
  prefix: string | null | undefined;
  model_name: string;
  custom_display?: string | null;
  model_display?: string | null;
}): string {
  return displayName(
    row.prefix,
    row.model_name,
    row.custom_display ?? row.model_display ?? null,
  );
}

/**
 * Cari prefix yang cocok untuk string model incoming.
 * Pilih prefix terpanjang yang cocok dengan pola "prefix/".
 * Return { bare, prefix, providerId }
 *
 * Contoh: prefix "oc", request "oc/oc/muse1.3" => bare "oc/muse1.3".
 * Bagian dalam ("oc/muse1.3") tetap utuh sebagai nama upstream — provider
 * yang memang sudah pakai prefix sendiri tidak terpengaruh.
 */
export function resolvePrefixedModel(model: string): {
  bare: string;
  prefix: string | null;
  providerId: string | null;
} {
  if (!model) return { bare: model, prefix: null, providerId: null };
  ensurePrefixCache();
  for (const r of sortedPrefixes) {
    if (model === r.prefix) continue;
    if (model.startsWith(r.head)) {
      const bare = model.slice(r.head.length);
      if (bare.length === 0) continue;
      return { bare, prefix: r.prefix, providerId: r.id };
    }
  }
  return { bare: model, prefix: null, providerId: null };
}

export function resolveDisplayToBare(displayId: string): {
  bare: string;
  prefix: string | null;
  providerId: string | null;
} {
  const name = (displayId ?? "").trim();
  if (!name) return { bare: displayId, prefix: null, providerId: null };
  ensurePrefixCache();
  const hit = displayLookup.get(name);
  if (hit) return hit;
  return resolvePrefixedModel(name);
}

/** Ambil prefix untuk provider id tertentu (sudah dibersihkan) */
export function prefixForProvider(providerId: string): string | null {
  const row = query("SELECT prefix FROM providers WHERE id = ?").get(
    providerId,
  ) as { prefix: string | null } | undefined;
  return cleanPrefix(row?.prefix);
}

export type UnavailableReason =
  | {
      kind: "model_disabled";
      display: string;
      providerId: string;
      providerName: string;
    }
  | {
      kind: "provider_disabled";
      display: string;
      providerId: string;
      providerName: string;
    };

type AnyStateRow = {
  model_name: string;
  model_active: number;
  custom_display: string | null;
  provider_id: string;
  provider_name: string;
  provider_active: number;
  prefix: string | null;
};

function toReason(r: AnyStateRow): UnavailableReason | null {
  const display = displayName(r.prefix, r.model_name, r.custom_display);
  if (!r.model_active) {
    return {
      kind: "model_disabled",
      display,
      providerId: r.provider_id,
      providerName: r.provider_name,
    };
  }
  if (!r.provider_active) {
    return {
      kind: "provider_disabled",
      display,
      providerId: r.provider_id,
      providerName: r.provider_name,
    };
  }
  return null;
}

/**
 * Jelaskan KENAPA sebuah display id tidak bisa di-route padahal dikenal di DB
 * (model di-disable atau provider-nya di-disable). Return null bila model
 * memang tidak dikenal sama sekali (atau masih tersedia).
 * Dipakai untuk pesan error 404 yang jelas di chat/completions, media,
 * dan endpoint info model.
 */
export function unavailableReason(displayId: string): UnavailableReason | null {
  const name = (displayId ?? "").trim();
  if (!name) return null;
  // 1) custom display_name exact (abaikan status aktif)
  try {
    const hit = query(
      `SELECT m.model_name, m.is_active AS model_active, m.display_name AS custom_display,
              m.provider_id, p.name AS provider_name, p.is_active AS provider_active, p.prefix AS prefix
       FROM models m JOIN providers p ON p.id = m.provider_id
       WHERE m.display_name = ? LIMIT 1`,
    ).get(name) as unknown as AnyStateRow | undefined;
    if (hit) return toReason(hit);
  } catch {
    // kolom display_name belum ada (DB lama) -> lanjut ke prefix/bare
  }
  // 2) prefix/bare
  const { bare, providerId } = resolvePrefixedModel(name);
  const rows = query(
    `SELECT m.model_name, m.is_active AS model_active,
            ${hasDisplayColumn() ? "m.display_name" : "NULL"} AS custom_display,
            m.provider_id, p.name AS provider_name, p.is_active AS provider_active, p.prefix AS prefix
     FROM models m JOIN providers p ON p.id = m.provider_id
     WHERE m.model_name = ?`,
  ).all(bare) as unknown as AnyStateRow[];
  if (rows.length === 0) return null;
  const hinted = providerId ? rows.find((r) => r.provider_id === providerId) : undefined;
  if (hinted) return toReason(hinted);
  // tanpa hint jelas: bila SEMUA baris non-aktif, laporkan yang pertama;
  // bila ada yang aktif, model sebenarnya tersedia (bukan urusan fungsi ini).
  if (rows.every((r) => !r.model_active || !r.provider_active)) {
    return toReason(rows[0]!);
  }
  return null;
}

function hasDisplayColumn(): boolean {
  return hasColumn("models", "display_name");
}

/**
 * Body error 404 yang jelas untuk model yang tidak bisa dipakai.
 * - provider di-disable -> "model 'X' is unavailable: provider 'Y' is disabled"
 * - model di-disable -> "model 'X' is disabled"
 * - tidak dikenal -> "model not found: 'X'"
 */
export function modelNotFoundBody(displayId: string): {
  message: string;
  type: string;
  model: string;
  provider?: string;
} {
  const r = unavailableReason(displayId);
  if (r?.kind === "provider_disabled") {
    return {
      message: `model '${displayId}' is unavailable: provider '${r.providerName}' is disabled`,
      type: "provider_disabled",
      model: displayId,
      provider: r.providerId,
    };
  }
  if (r?.kind === "model_disabled") {
    return {
      message: `model '${displayId}' is disabled`,
      type: "model_disabled",
      model: displayId,
      provider: r.providerId,
    };
  }
  return {
    message: `model not found: '${displayId}'`,
    type: "model_not_found",
    model: displayId,
  };
}
