/**
 * Map with a fixed size cap and a per-entry TTL. On `get`, an expired entry
 * is dropped and `undefined` returned. On `set`, the oldest entry is dropped
 * if the map is at capacity (FIFO/LRU hybrid: a `set` that overwrites bumps
 * the entry to most-recent).
 *

 * * Backing structure: `Map` (insertion-ordered iteration).
 */
export class TtlLru<K, V> {
  private readonly maxSize: number;
  private readonly ttlMs: number;
  private readonly entries = new Map<K, { value: V; expiresAt: number }>();

  constructor(opts: { maxSize: number; ttlMs: number }) {
    // Programming-error guards: maxSize=0 silently produces a permanently-
    // empty cache (every set evicts everything including itself); ttlMs<=0
    // means every entry expires on the very next get. Both are caller bugs,
    // not runtime conditions, so fail loud at construction.
    if (opts.maxSize < 1) {
      throw new RangeError(`TtlLru: maxSize must be >= 1, got ${opts.maxSize}`);
    }
    if (opts.ttlMs <= 0) {
      throw new RangeError(`TtlLru: ttlMs must be > 0, got ${opts.ttlMs}`);
    }
    this.maxSize = opts.maxSize;
    this.ttlMs = opts.ttlMs;
  }

  get(key: K): V | undefined {
    const now = Date.now();
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= now) {
      this.entries.delete(key);
      return undefined;
    }
    // Bump to most-recent position.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: K, value: V): void {
    const now = Date.now();
    if (this.entries.has(key)) this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: now + this.ttlMs });
    while (this.entries.size > this.maxSize) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  /** For tests / metrics; not in the hot path. */
  size(): number { return this.entries.size; }
}
