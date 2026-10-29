import type { CheckoutCommune, CheckoutProvince } from "./checkout-geo.ts";

/**
 * Checkout address pickers are read-only. This process-local cache keeps their validated Pancake
 * options across requests without adding a database migration or depending on Next.js cache modes.
 *
 * It is deliberately NOT used by guest-checkout-submit-runtime: submission validates the chosen
 * province/commune against Pancake again, so cached options never authorize an order.
 * No stale-while-revalidate: an expired lookup waits for fresh data or fails closed.
 */
export const CHECKOUT_GEO_CACHE_TTL_MS = 5 * 60_000;
export const CHECKOUT_GEO_CACHE_MAX_COMMUNE_ENTRIES = 128;
export const CHECKOUT_GEO_CACHE_MAX_CONCURRENT_MISSES = 16;

type GeoOption = Readonly<{ id: string; name: string }>;
type Entry<T> = Readonly<{ value: readonly T[]; storedAtMs: number }>;
type CacheLimits = Readonly<{
  now: () => number;
  ttlMs: number;
  maxEntries: number;
  maxConcurrentMisses: number;
}>;

function cloneOptions<T extends GeoOption>(value: readonly T[]): T[] {
  return value.map((option) => ({ ...option }));
}

/** Hard-TTL LRU cache with one upstream request per key and a bound on distinct pending keys. */
function createListCache<T extends GeoOption>({ now, ttlMs, maxEntries, maxConcurrentMisses }: CacheLimits) {
  const entries = new Map<string, Entry<T>>();
  const inFlight = new Map<string, Promise<readonly T[]>>();

  async function read(key: string, load: () => Promise<T[]>): Promise<T[]> {
    const cached = entries.get(key);
    if (cached) {
      const ageMs = now() - cached.storedAtMs;
      if (ageMs >= 0 && ageMs < ttlMs) {
        // Map insertion order tracks recency, so cold provinces are evicted first.
        entries.delete(key);
        entries.set(key, cached);
        return cloneOptions(cached.value);
      }
      entries.delete(key);
    }

    let pending = inFlight.get(key);
    if (!pending) {
      if (inFlight.size >= maxConcurrentMisses) {
        // The public action turns this into GEO_UNAVAILABLE. Never bypass the bound by fetching
        // uncached: distinct attacker-controlled keys must not create unlimited Pancake reads.
        throw new Error("Checkout geo cache miss capacity exceeded");
      }
      const startedAtMs = now();
      // Register the flight before calling load(), including when load throws synchronously.
      pending = Promise.resolve().then(load).then((value) => {
        // Snapshot the allowlisted, already validated options; never retain caller-owned objects.
        const snapshot = cloneOptions(value);
        const ageMs = now() - startedAtMs;
        // Do not negative-cache empty results or keep data whose request already outlived the TTL.
        if (snapshot.length > 0 && ageMs >= 0 && ageMs < ttlMs) {
          entries.delete(key);
          entries.set(key, { value: snapshot, storedAtMs: startedAtMs });
          while (entries.size > maxEntries) {
            const oldest = entries.keys().next();
            if (oldest.done) break;
            entries.delete(oldest.value);
          }
        }
        return snapshot;
      }).finally(() => {
        inFlight.delete(key);
      });
      inFlight.set(key, pending);
    }
    // Independent copies prevent one action's mutations from corrupting later responses.
    return cloneOptions(await pending);
  }

  return { read };
}

function requirePositiveInteger(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError("Checkout geo cache " + name + " must be a positive safe integer");
  }
}

/** Only the checkout's public two-level lookup is cached; each province has its own key. */
export function createCheckoutGeoCache({
  loadProvinces,
  loadCommunes,
  now = Date.now,
  ttlMs = CHECKOUT_GEO_CACHE_TTL_MS,
  maxCommuneEntries = CHECKOUT_GEO_CACHE_MAX_COMMUNE_ENTRIES,
  maxConcurrentMisses = CHECKOUT_GEO_CACHE_MAX_CONCURRENT_MISSES,
}: Readonly<{
  loadProvinces: () => Promise<CheckoutProvince[]>;
  loadCommunes: (provinceId: unknown) => Promise<CheckoutCommune[]>;
  now?: () => number;
  ttlMs?: number;
  maxCommuneEntries?: number;
  maxConcurrentMisses?: number;
}>) {
  requirePositiveInteger(ttlMs, "TTL");
  requirePositiveInteger(maxCommuneEntries, "maximum commune entries");
  requirePositiveInteger(maxConcurrentMisses, "maximum concurrent misses");

  const limits = { now, ttlMs, maxConcurrentMisses };
  const provincesCache = createListCache<CheckoutProvince>({ ...limits, maxEntries: 1 });
  const communesCache = createListCache<CheckoutCommune>({ ...limits, maxEntries: maxCommuneEntries });

  return Object.freeze({
    provinces: () => provincesCache.read("84:new-provinces", loadProvinces),
    communes: (provinceId: unknown) => {
      // Do not cache malformed browser input. The existing gateway rejects it before any
      // Pancake request, and the public action maps that rejection to GEO_UNAVAILABLE.
      if (typeof provinceId !== "string" || provinceId.length === 0 ||
        provinceId.length > 64 || provinceId.trim() !== provinceId) {
        return loadCommunes(provinceId);
      }
      return communesCache.read(provinceId, () => loadCommunes(provinceId));
    },
  });
}
