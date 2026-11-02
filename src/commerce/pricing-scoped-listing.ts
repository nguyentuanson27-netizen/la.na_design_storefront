import type { PricingGenerationRead } from "./pricing-generation-flight.ts";
import { storefrontCacheKey } from "./storefront-cache-key.ts";
import type { StorefrontListingCache } from "./sale-listing-cache.ts";
import { rebaseListingFlashSaleRemaining } from "./storefront-listing-flash-sale.ts";

/** A cached listing with the instant it was read at, which its countdowns count from. */
export type PricingStamped<T> = Readonly<{ value: T; loadedAtMs: number }>;

/**
 * Reads a listing whose prices depend on promotions through an in-process cache.
 *
 * Like `/sale`, the key carries the durable promotion pricing revision and the next campaign
 * boundary, so a published promotion edit or a window opening or closing is a different key and is
 * read fresh instead of being served for up to the cache's maximum age. A burst of requests shares
 * reads of that generation without any of them using one older than its own arrival, and the listing
 * is read at the instant of the generation that keys it: a waiter's own earlier `now` can sit before
 * a campaign boundary the shared generation is already past, and pricing at it would store
 * pre-campaign data under the key of the window that follows. What counts down from the instant the
 * listing was read -- its own `refreshAfterMs` and each product's Flash `remainingMs` -- is shortened
 * by the time since.
 */
export function createPricingScopedListingReader({
  readGeneration,
  enabled,
}: Readonly<{
  readGeneration: (now: Date) => Promise<PricingGenerationRead>;
  enabled: () => boolean;
}>) {
  return async function readPricingScopedListing<T>(
    cache: StorefrontListingCache<PricingStamped<T>>,
    baseKey: string,
    now: Date | undefined,
    load: (readAt: Date) => Promise<T>,
  ): Promise<T> {
    const at = now ?? new Date();
    if (!enabled()) return load(at);
    const generation = await readGeneration(at);
    const { value: stamped } = await cache.read(
      storefrontCacheKey([baseKey, generation.key]),
      async () =>
        Object.freeze({
          value: await load(generation.readAt),
          loadedAtMs: generation.readAt.getTime(),
        }),
    );
    const { value } = stamped;
    const elapsedMs = at.getTime() - stamped.loadedAtMs;
    if (elapsedMs <= 0 || typeof value !== "object" || value === null) return value;

    let rebased = { ...(value as Record<string, unknown>) };
    if ("refreshAfterMs" in value && typeof value.refreshAfterMs === "number") {
      rebased = { ...rebased, refreshAfterMs: Math.max(0, value.refreshAfterMs - elapsedMs) };
    }
    if ("products" in value && Array.isArray(value.products)) {
      rebased = { ...rebased, products: rebaseListingFlashSaleRemaining(value.products, elapsedMs) };
    }
    return rebased as T;
  };
}
