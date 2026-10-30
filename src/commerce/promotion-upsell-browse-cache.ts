import { MAX_STOREFRONT_PROMOTION_REFRESH_MS } from "./storefront-promotion-freshness.ts";

/**
 * Short-lived, per-process memo for the read-only /offers/eligible listing.
 *
 * Keys are opaque (`paidCartKey` is an HMAC over cart id + paid revision, plus the promotion pricing
 * revision and campaign id), so a paid-line change or any effective campaign edit/enable/disable is a
 * different key by construction and no cart id is held in memory. An entry also never outlives the
 * earliest `endsAt` of the campaigns it was verified against (`validUntil`). What the key cannot see is
 * catalog drift (stock, publication, price sync): that is bounded by `ttlMs`. Values are the
 * already-public browse view: names, slugs, images and option labels; the page never authorizes a
 * mutation and `add` re-verifies on the server, so staleness cannot move money or entitlements.
 */
/** `validUntil` (epoch ms) caps the entry's life, for example at a campaign's `endsAt`. */
export type BrowseLoad<V> = { value: V | null; store: boolean; failed?: boolean; validUntil?: number | null };

export type UpsellBrowseCache<V> = Readonly<{
  /**
   * Return a fresh entry, join an identical in-flight load, or run `load`. `store: false` skips caching
   * (partial/failed); `failed` is passed to every caller sharing the load so they all see a retryable miss.
   */
  resolve(key: string, load: () => Promise<BrowseLoad<V>>): Promise<{ value: V | null; cached: boolean; failed: boolean }>;
  /** Seed an entry computed elsewhere (the checkout banner already verified these products). */
  set(key: string, value: V, validUntil?: number | null): void;
  readonly size: number;
}>;

// The page revalidates every MAX_STOREFRONT_PROMOTION_REFRESH_MS, so a TTL equal to that interval always
// expires just before the next refresh and every periodic render recomputes. 2.5× lets the first two
// refreshes of an open page hit, bounds the list's age at 150 s and leaves a recompute every third.
// The list holds names, slugs and option labels only; prices, stock and entitlements are re-verified by `add`.
export const UPSELL_BROWSE_CACHE_TTL_MS = Math.round(MAX_STOREFRONT_PROMOTION_REFRESH_MS * 2.5);
export const UPSELL_BROWSE_CACHE_MAX_ENTRIES = 500;

export function createUpsellBrowseCache<V>({ ttlMs = UPSELL_BROWSE_CACHE_TTL_MS, maxEntries = UPSELL_BROWSE_CACHE_MAX_ENTRIES, now = Date.now }: { ttlMs?: number; maxEntries?: number; now?: () => number } = {}): UpsellBrowseCache<V> {
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || !Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
    throw new TypeError("Browse cache ttl and size must be positive safe integers");
  }
  const entries = new Map<string, { value: V; expiresAt: number }>();
  const inflight = new Map<string, Promise<BrowseLoad<V>>>();
  function set(key: string, value: V, validUntil?: number | null) {
    entries.delete(key); // re-insert so Map order is least-recently-written first
    entries.set(key, { value, expiresAt: Math.min(now() + ttlMs, validUntil ?? Infinity) });
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
      if (joined.store && joined.value !== null) set(key, joined.value, joined.validUntil);
      return { value: joined.value, cached: false, failed: joined.failed === true };
    },
  };
}
