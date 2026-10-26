/** Run async work over items with a concurrency limit, preserving order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, idx: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** "Name <a@b.com>" -> "a@b.com" (lower-case). */
export function emailOf(addr: string): string {
  return (addr.match(/<([^>]+)>/)?.[1] ?? addr).trim().toLowerCase();
}

/** Display name part of an address, or the address. */
export function nameOf(addr: string): string {
  const m = addr.match(/^\s*"?([^"<]*?)"?\s*<[^>]+>\s*$/);
  return (m?.[1] || emailOf(addr)).trim();
}

export function hoursSince(iso: string, now = Date.now()): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.max(0, Math.round(((now - t) / 3_600_000) * 10) / 10) : 0;
}
