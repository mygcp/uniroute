import { query } from "./db";

export type Provider = {
  id: string;
  name: string;
  base_url: string;
  auth_type: "none" | "bearer" | "apikey";
  is_active: boolean;
  weight: number;
  priority: number;
  current_connections: number;
  last_used_at: number;
};

const cache = new Map<string, Provider[]>();

export function reload() {
  cache.clear();
  const rows = (
    query(
      `SELECT m.model_name AS model_name, p.*
       FROM models m
       JOIN providers p ON p.id = m.provider_id
       WHERE m.is_active = 1 AND p.is_active = 1`,
    ).all() ?? []
  ) as (Provider & { model_name: string })[];
  for (const row of rows) {
    const { model_name: model, ...provider } = row;
    const list = cache.get(model) ?? [];
    list.push(provider as Provider);
    cache.set(model, list);
  }
}

export function getProviders(model: string): Provider[] {
  if (cache.size === 0) reload();
  return cache.get(model) ?? [];
}

export function getAnyProvider(model: string): Provider[] {
  if (cache.size === 0) reload();
  const direct = cache.get(model) ?? [];
  if (direct.length > 0) return direct;
  const all = [...cache.values()].flat();
  const primary = all.filter((p) => p.priority > 0);
  return primary.length > 0 ? primary : all;
}