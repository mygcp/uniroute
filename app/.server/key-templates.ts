import { query } from "./db";
import type { CreateClientKeyInput } from "./client-key";

export type KeyTemplate = {
  id: number;
  name: string;
  description: string | null;
  config: CreateClientKeyInput;
  created_at: number;
};

type KeyTemplateRow = {
  id: number;
  name: string;
  description: string | null;
  config: string;
  created_at: number;
};

export function listTemplates(): KeyTemplate[] {
  const rows = query(
    "SELECT id, name, description, config, created_at FROM key_templates ORDER BY name ASC",
  ).all() as unknown as KeyTemplateRow[];
  return rows.map(toTemplate);
}

export function getTemplate(id: number): KeyTemplate | undefined {
  const row = query(
    "SELECT id, name, description, config, created_at FROM key_templates WHERE id = ?",
  ).get(id) as KeyTemplateRow | undefined;
  return row ? toTemplate(row) : undefined;
}

export function createTemplate(
  name: string,
  description: string | null,
  config: CreateClientKeyInput,
): number {
  const res = query(
    "INSERT INTO key_templates (name, description, config) VALUES (?, ?, ?)",
  ).run(name.trim(), description?.trim() || null, JSON.stringify(config)) as {
    lastInsertRowid?: number;
  };
  return Number(res.lastInsertRowid);
}

export function deleteTemplate(id: number): void {
  query("DELETE FROM key_templates WHERE id = ?").run(id);
}

function toTemplate(row: KeyTemplateRow): KeyTemplate {
  let config: CreateClientKeyInput = { name: "" };
  try {
    config = JSON.parse(row.config) as CreateClientKeyInput;
  } catch {
    config = { name: "" };
  }
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    config,
    created_at: row.created_at,
  };
}