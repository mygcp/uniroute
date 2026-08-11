export type RateLimitOptions = { rpm?: number; tpm?: number };

type ReqEntry = { atMs: number; count: number };
type TokenEntry = { atMs: number; amount: number };

const WINDOW_MS = 60_000;

const requests = new Map<string, ReqEntry[]>();
const tokens = new Map<string, TokenEntry[]>();
const concurrent = new Map<string, number>();

function pruneReq(scope: string, now: number): void {
  const q = requests.get(scope);
  if (!q) return;
  const cutoff = now - WINDOW_MS;
  let i = 0;
  while (i < q.length && q[i].atMs < cutoff) i++;
  if (i > 0) q.splice(0, i);
  if (q.length === 0) requests.delete(scope);
}

function pruneTokens(scope: string, now: number): void {
  const q = tokens.get(scope);
  if (!q) return;
  const cutoff = now - WINDOW_MS;
  let i = 0;
  while (i < q.length && q[i].atMs < cutoff) i++;
  if (i > 0) q.splice(0, i);
  if (q.length === 0) tokens.delete(scope);
}

export function checkRateLimit(
  scope: string,
  tokensUsed: number,
  opts: RateLimitOptions,
): { allowed: boolean; limit?: "rpm" | "tpm" } {
  const now = Date.now();
  pruneReq(scope, now);
  pruneTokens(scope, now);

  const reqQ = requests.get(scope) ?? [];
  const tokenQ = tokens.get(scope) ?? [];

  const reqCount = reqQ.reduce((sum, e) => sum + e.count, 0);
  const tokenSum = tokenQ.reduce((sum, e) => sum + e.amount, 0);

  if (opts.rpm !== undefined && reqCount + 1 > opts.rpm) {
    return { allowed: false, limit: "rpm" };
  }
  if (opts.tpm !== undefined && tokenSum + tokensUsed > opts.tpm) {
    return { allowed: false, limit: "tpm" };
  }

  reqQ.push({ atMs: now, count: 1 });
  requests.set(scope, reqQ);
  tokenQ.push({ atMs: now, amount: tokensUsed });
  tokens.set(scope, tokenQ);

  return { allowed: true };
}

export function acquireSlot(scope: string, limit: number): boolean {
  const current = concurrent.get(scope) ?? 0;
  if (current >= limit) return false;
  concurrent.set(scope, current + 1);
  return true;
}

export function releaseSlot(scope: string): void {
  const current = concurrent.get(scope) ?? 0;
  if (current <= 1) concurrent.delete(scope);
  else concurrent.set(scope, current - 1);
}

export function currentConcurrent(scope: string): number {
  return concurrent.get(scope) ?? 0;
}

export function resetRateLimiter(): void {
  requests.clear();
  tokens.clear();
  concurrent.clear();
}