/**
 * Short-lived, per-process memo for the read-only /offers/eligible listing.
 *
 * Keys are opaque (`paidCartKey` is an HMAC over cart id + paid revision, plus the campaign id), so a
 * paid-line change invalidates an entry by construction and no cart id is held in memory. Values are
 * the already-public browse view: names, slugs, images and option labels. Stock or campaign edits can
 * make an entry up to `ttlMs` old; the page never authorizes a mutation and `add` re-verifies on the
 * server, so staleness cannot move money or entitlements.
 */
export type UpsellBrowseCache<V> = Readonly<{
  /**
   * Return a fresh entry, join an identical in-flight load, or run `load`. `store: false` skips caching
   * (partial/failed); `failed` is passed to every caller sharing the load so they all see a retryable miss.
   */
  resolve(key: string, load: () => Promise<{ value: V | null; store: boolean; failed?: boolean }>): Promise<{ value: V | null; cached: boolean; failed: boolean }>;
  /** Seed an entry computed elsewhere (the checkout banner already verified these products). */
  set(key: string, value: V): void;
  readonly size: number;
}>;

export const UPSELL_BROWSE_CACHE_TTL_MS = 60_000;
export const UPSELL_BROWSE_CACHE_MAX_ENTRIES = 500;

export function createUpsellBrowseCache<V>({ ttlMs = UPSELL_BROWSE_CACHE_TTL_MS, maxEntries = UPSELL_BROWSE_CACHE_MAX_ENTRIES, now = Date.now }: { ttlMs?: number; maxEntries?: number; now?: () => number } = {}): UpsellBrowseCache<V> {
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || !Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
    throw new TypeError("Browse cache ttl and size must be positive safe integers");
  }
  const entries = new Map<string, { value: V; expiresAt: number }>();
  const inflight = new Map<string, Promise<{ value: V | null; store: boolean; failed?: boolean }>>();
  function set(key: string, value: V) {
    entries.delete(key); // re-insert so Map order is least-recently-written first
    entries.set(key, { value, expiresAt: now() + ttlMs });
    while (entries.size > maxEntries) entries.delete(entries.keys().next().value!);
  }
  return {
    set,
    get size() { return entries.size; },
    async resolve(key, load) {
      const entry = entries.get(key);
      if (entry) {
        if (entry.expiresAt > now()) return { value: entry.value, cached: true, failed: false };
        entries.delete(key);
      }
      let pending = inflight.get(key);
      if (!pending) {
        pending = load().finally(() => { inflight.delete(key); });
        inflight.set(key, pending);
      }
      const joined = await pending;
      if (joined.store && joined.value !== null) set(key, joined.value);
      return { value: joined.value, cached: false, failed: joined.failed === true };
    },
  };
}
