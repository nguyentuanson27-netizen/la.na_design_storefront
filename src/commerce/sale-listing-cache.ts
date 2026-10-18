/**
 * In-process cache for the Sale listings' page read (`listSalePage` in `flash-sale-catalog.ts`).
 *
 * That read decides membership, the representative price and the order before it paginates, so it
 * runs the whole stock-and-pricing projection on every request. This holds its result per page for a
 * bounded time, so a burst of shoppers -- and every open tab's promotion refresher -- shares one run.
 *
 * What may change inside a cache entry's life, and what may not:
 *
 * - Promotion edits and campaign windows never are served stale. The caller puts the durable
 *   promotion pricing revision and the next campaign boundary into the key, so a published edit or a
 *   window opening or closing is a different key, read fresh on the next request.
 * - Stock, mirrored base prices and product visibility come from the catalog sync and reservations,
 *   which advance no revision. Those are served at most `SALE_LISTING_CACHE_MAX_AGE_MS` old. The cart
 *   and checkout re-read them, so a stale listing card can never sell at a stale price or stock.
 *
 * An entry younger than `SALE_LISTING_CACHE_FRESH_MS` is served as is. Between that and the maximum
 * age it is still served, while one background read replaces it, so a shopper waits for the read only
 * on a cold or expired page. Concurrent misses on one key share a single read.
 */

export const SALE_LISTING_CACHE_FRESH_MS = 30_000;
export const SALE_LISTING_CACHE_MAX_AGE_MS = 60_000;
/** Bounds memory: keys are trusted (validated page numbers, fixed kinds), but pages are many. */
export const SALE_LISTING_CACHE_MAX_ENTRIES = 256;

type Entry<T> = Readonly<{ value: T; storedAtMs: number }>;

type Flight<T> = Readonly<{ token: symbol; forced: boolean; promise: Promise<T> }>;

export type SaleListingCacheRead<T> = Readonly<{
  value: T;
  /** True when the value came from an entry rather than a read this call waited on. */
  cached: boolean;
}>;

export type SaleListingCache<T> = Readonly<{
  read: (key: string, load: () => Promise<T>) => Promise<SaleListingCacheRead<T>>;
  /**
   * Drops the entry and waits on a read that starts after this call, for a caller that found the
   * cached value outdated. It never reuses a background read already in flight.
   */
  refresh: (key: string, load: () => Promise<T>) => Promise<T>;
}>;

function assertPositiveMs(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`Sale listing cache ${name} must be a positive integer`);
  }
}

export function createSaleListingCache<T>({
  now = Date.now,
  freshMs = SALE_LISTING_CACHE_FRESH_MS,
  maxAgeMs = SALE_LISTING_CACHE_MAX_AGE_MS,
  maxEntries = SALE_LISTING_CACHE_MAX_ENTRIES,
  onBackgroundError = (error: unknown) => {
    console.error("[sale-listing-cache] background refresh failed", error);
  },
}: Readonly<{
  now?: () => number;
  freshMs?: number;
  maxAgeMs?: number;
  maxEntries?: number;
  onBackgroundError?: (error: unknown) => void;
}> = {}): SaleListingCache<T> {
  assertPositiveMs(freshMs, "fresh time");
  assertPositiveMs(maxAgeMs, "maximum age");
  assertPositiveMs(maxEntries, "entry limit");
  if (freshMs > maxAgeMs) {
    throw new RangeError("Sale listing cache fresh time cannot exceed its maximum age");
  }

  // Map order is recency order: a hit re-inserts its entry, and eviction takes the first key.
  const entries = new Map<string, Entry<T>>();
  // The one read that may publish into each key. A read superseded by a refresh settles for whoever
  // awaits it but publishes nothing, so it cannot overwrite the newer result.
  const inFlight = new Map<string, Flight<T>>();

  function store(key: string, value: T, storedAtMs: number) {
    entries.delete(key);
    entries.set(key, Object.freeze({ value, storedAtMs }));
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next();
      if (oldest.done) break;
      entries.delete(oldest.value);
    }
  }

  /**
   * Joins the key's read in flight, or starts one. A `forced` read joins only another forced read:
   * its caller already holds a page it found outdated, and a background read that began before it
   * may have read that same outdated state.
   */
  function load(key: string, loader: () => Promise<T>, forced = false): Promise<T> {
    const pending = inFlight.get(key);
    if (pending && (pending.forced || !forced)) return pending.promise;
    // Age counts from when the read began: its rows reflect the database no later than that.
    const startedAtMs = now();
    const token = Symbol("sale-listing-read");
    const isCurrent = () => inFlight.get(key)?.token === token;
    // The loader runs a microtask later, so the flight is registered before it can settle, even
    // when the loader throws instead of returning a rejected promise.
    const promise = Promise.resolve().then(loader).then(
      (value) => {
        if (isCurrent()) {
          inFlight.delete(key);
          store(key, value, startedAtMs);
        }
        return value;
      },
      (error: unknown) => {
        if (isCurrent()) inFlight.delete(key);
        throw error;
      },
    );
    inFlight.set(key, Object.freeze({ token, forced, promise }));
    return promise;
  }

  async function read(key: string, loader: () => Promise<T>): Promise<SaleListingCacheRead<T>> {
    const entry = entries.get(key);
    if (entry) {
      const ageMs = now() - entry.storedAtMs;
      // A clock that stepped backwards proves nothing about the entry's age, so it expires.
      if (ageMs >= 0 && ageMs < maxAgeMs) {
        entries.delete(key);
        entries.set(key, entry);
        if (ageMs >= freshMs && !inFlight.has(key)) {
          load(key, loader).catch(onBackgroundError);
        }
        return Object.freeze({ value: entry.value, cached: true });
      }
      entries.delete(key);
    }
    return Object.freeze({ value: await load(key, loader), cached: false });
  }

  async function refresh(key: string, loader: () => Promise<T>): Promise<T> {
    entries.delete(key);
    return load(key, loader, true);
  }

  return Object.freeze({ read, refresh });
}
