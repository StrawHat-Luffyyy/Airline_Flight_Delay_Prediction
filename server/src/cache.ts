interface Entry<V> {
  expiresAt: number;
  value: Promise<V>;
}

export interface TtlCacheOptions {
  /** Time to live per entry; 0 disables caching (every call loads). */
  ttlMs: number;
  /** Oldest entries are evicted beyond this many keys. */
  maxEntries?: number;
  now?: () => number;
}

/**
 * Small in-memory TTL map for heavy, rarely changing responses (PROJECT_OVERVIEW §9: no Redis).
 * Concurrent requests for the same key share one load; failed loads are not cached.
 */
export class TtlCache<V> {
  private readonly entries = new Map<string, Entry<V>>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: TtlCacheOptions) {
    this.ttlMs = options.ttlMs;
    this.maxEntries = options.maxEntries ?? 500;
    this.now = options.now ?? Date.now;
  }

  getOrLoad(key: string, load: () => Promise<V>): Promise<V> {
    if (this.ttlMs <= 0) return load();

    const existing = this.entries.get(key);
    if (existing && existing.expiresAt > this.now()) return existing.value;

    const value = load();
    this.entries.delete(key);
    this.entries.set(key, { expiresAt: this.now() + this.ttlMs, value });
    value.catch(() => {
      if (this.entries.get(key)?.value === value) this.entries.delete(key);
    });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return value;
  }

  clear(): void {
    this.entries.clear();
  }
}
