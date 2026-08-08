const clients = new Set<(payload: unknown) => void>();

export function subscribe(
  fn: (payload: unknown) => void,
): () => void {
  clients.add(fn);
  return () => {
    clients.delete(fn);
  };
}

export function broadcast(payload: unknown): void {
  for (const fn of [...clients]) {
    try {
      fn(payload);
    } catch {
      /* ignore subscriber errors */
    }
  }
}

export function getClientsCount(): number {
  return clients.size;
}