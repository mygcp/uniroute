export type RateLimitOptions = { rpm?: number; tpm?: number };

type Entry = { atMs: number; val: number };

type Bucket = {
  items: Entry[];
  head: number;
  sum: number;
};

const WINDOW_MS = 60_000;

const requests = new Map<string, Bucket>();
const tokens = new Map<string, Bucket>();
const concurrent = new Map<string, number>();

function pruneBucket(map: Map<string, Bucket>, scope: string, cutoff: number): Bucket | undefined {
  const b = map.get(scope);
  if (!b) return undefined;
  const { items } = b;
  let { head, sum } = b;
  while (head < items.length && items[head].atMs < cutoff) {
    sum -= items[head].val;
    head += 1;
  }
  if (head >= items.length) {
    map.delete(scope);
    return undefined;
  }
  b.sum = sum > 0 ? sum : 0;
  if (head > 64) {
    b.items = items.slice(head);
    b.head = 0;
  } else {
    b.head = head;
  }
  return b;
}

const sweepTimer = setInterval(() => {
  const cutoff = Date.now() - WINDOW_MS;
  for (const k of requests.keys()) pruneBucket(requests, k, cutoff);
  for (const k of tokens.keys()) pruneBucket(tokens, k, cutoff);
}, 60_000);
sweepTimer.unref?.();

export function checkRateLimit(
  scope: string,
  tokensUsed: number,
  opts: RateLimitOptions,
): { allowed: boolean; limit?: "rpm" | "tpm" } {
  if (opts.rpm === undefined && opts.tpm === undefined) {
    return { allowed: true };
  }

  const now = Date.now();
  const cutoff = now - WINDOW_MS;

  const reqBucket = opts.rpm !== undefined ? pruneBucket(requests, scope, cutoff) : undefined;
  const reqCount = reqBucket?.sum ?? 0;
  if (opts.rpm !== undefined && reqCount + 1 > opts.rpm) {
    return { allowed: false, limit: "rpm" };
  }

  const tokenBucket = opts.tpm !== undefined ? pruneBucket(tokens, scope, cutoff) : undefined;
  const tokenSum = tokenBucket?.sum ?? 0;
  if (opts.tpm !== undefined && tokenSum + tokensUsed > opts.tpm) {
    return { allowed: false, limit: "tpm" };
  }

  if (opts.rpm !== undefined) {
    const b = reqBucket ?? { items: [], head: 0, sum: 0 };
    b.items.push({ atMs: now, val: 1 });
    b.sum += 1;
    if (!reqBucket) requests.set(scope, b);
  }
  if (opts.tpm !== undefined) {
    const b = tokenBucket ?? { items: [], head: 0, sum: 0 };
    b.items.push({ atMs: now, val: tokensUsed });
    b.sum += tokensUsed;
    if (!tokenBucket) tokens.set(scope, b);
  }

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
