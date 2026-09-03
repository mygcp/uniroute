import { query } from "./db";

/**
 * Penyimpanan chat playground — tabel terpisah di SQLite yang sama
 * (WAL: baca/tulis konkuren aman; backup tetap satu file).
 */

export type ChatSession = {
  id: number;
  provider_id: string;
  title: string;
  model: string | null;
  created_at: number;
  updated_at: number;
};

export type ChatMessage = {
  id?: number;
  session_id?: number;
  role: "user" | "assistant" | "system";
  content: string;
  model?: string | null;
  latency_ms?: number | null;
  thinking?: string | null;
  created_at?: number;
};

export function listSessions(providerId: string): ChatSession[] {
  return query(
    `SELECT id, provider_id, title, model, created_at, updated_at
       FROM chat_sessions WHERE provider_id = ?
      ORDER BY updated_at DESC LIMIT 100`,
  ).all(providerId) as unknown as ChatSession[];
}

function getSession(id: number): ChatSession | null {
  const row = query(
    "SELECT id, provider_id, title, model, created_at, updated_at FROM chat_sessions WHERE id = ?",
  ).get(id) as ChatSession | undefined;
  return row ?? null;
}

export function getMessages(sessionId: number): ChatMessage[] {
  try {
    return query(
      `SELECT id, session_id, role, content, model, latency_ms, thinking, created_at
       FROM chat_messages WHERE session_id = ? ORDER BY id ASC`,
    ).all(sessionId) as unknown as ChatMessage[];
  } catch {
    // DB lama belum punya kolom thinking
    return query(
      `SELECT id, session_id, role, content, model, latency_ms, created_at
       FROM chat_messages WHERE session_id = ? ORDER BY id ASC`,
    ).all(sessionId) as unknown as ChatMessage[];
  }
}

function touch(id: number): void {
  query("UPDATE chat_sessions SET updated_at = unixepoch() WHERE id = ?").run(
    id,
  );
}

export function createSession(
  providerId: string,
  title: string,
  model: string | null,
): number {
  const res = query(
    `INSERT INTO chat_sessions (provider_id, title, model) VALUES (?, ?, ?)`,
  ).run(providerId, title.slice(0, 120), model);
  return Number(
    (res as { lastInsertRowid?: number | bigint }).lastInsertRowid ?? 0,
  );
}

export type AppendInput = {
  role: "user" | "assistant" | "system";
  content: string;
  model?: string | null;
  latency_ms?: number | null;
  thinking?: string | null;
};

function appendMessages(
  sessionId: number,
  msgs: AppendInput[],
): void {
  if (msgs.length === 0) return;
  // Kolom thinking ditambahkan via ensureColumn saat open — fallback di bawah
  // hanya untuk koneksi DB yang dibuka sebelum migrasi sempat jalan.
  try {
    const stmt = query(
      `INSERT INTO chat_messages (session_id, role, content, model, latency_ms, thinking)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const m of msgs) {
      stmt.run(sessionId, m.role, m.content, m.model ?? null, m.latency_ms ?? null, m.thinking ?? null);
    }
  } catch {
    const stmt = query(
      `INSERT INTO chat_messages (session_id, role, content, model, latency_ms)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const m of msgs) {
      stmt.run(sessionId, m.role, m.content, m.model ?? null, m.latency_ms ?? null);
    }
  }
  touch(sessionId);
}

/** Simpan ulang seluruh percakapan (strategi replace sederhana). */
export function saveSession(
  providerId: string,
  sessionId: number | null,
  title: string,
  model: string | null,
  msgs: AppendInput[],
): { sessionId: number } {
  let id = sessionId ?? 0;
  if (id && getSession(id)) {
    query("DELETE FROM chat_messages WHERE session_id = ?").run(id);
    query(
      "UPDATE chat_sessions SET title = ?, model = ?, updated_at = unixepoch() WHERE id = ?",
    ).run(title.slice(0, 120), model, id);
  } else {
    id = createSession(providerId, title, model);
  }
  appendMessages(id, msgs);
  return { sessionId: id };
}

export function deleteSession(id: number): void {
  query("DELETE FROM chat_messages WHERE session_id = ?").run(id);
  query("DELETE FROM chat_sessions WHERE id = ?").run(id);
}
