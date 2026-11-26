const clients = new Set<(payload: unknown) => void>();

export function hasSubscribers(): boolean {
  return clients.size > 0;
}

export function subscriberCount(): number {
  return clients.size;
}

export function subscribe(
  fn: (payload: unknown) => void,
): () => void {
  clients.add(fn);
  return () => {
    clients.delete(fn);
  };
}

export function broadcast(payload: unknown): void {
  if (clients.size === 0) return;
  for (const fn of [...clients]) {
    try {
      fn(payload);
    } catch {
      /* ignore subscriber errors */
    }
  }
}
