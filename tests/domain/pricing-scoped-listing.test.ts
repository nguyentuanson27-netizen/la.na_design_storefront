import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createPricingGenerationReader } from "../../src/commerce/pricing-generation-flight.ts";
import {
  createPricingScopedListingReader,
  type PricingStamped,
} from "../../src/commerce/pricing-scoped-listing.ts";
import { createStorefrontListingCache } from "../../src/commerce/sale-listing-cache.ts";

type Listing = Readonly<{ priceVnd: number; refreshAfterMs: number }>;

const CAMPAIGN_STARTS_AT = 5_000;
const at = (ms: number) => new Date(ms);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** A promotion that starts at `CAMPAIGN_STARTS_AT`: the generation and the price both depend on the instant read. */
function setup() {
  const slowFirstRead = deferred<void>();
  let generationReads = 0;
  const readGeneration = createPricingGenerationReader(async (now) => {
    generationReads += 1;
    if (generationReads === 1) await slowFirstRead.promise;
    const started = now.getTime() >= CAMPAIGN_STARTS_AT;
    return {
      key: started ? "r1:b10000" : `r1:b${CAMPAIGN_STARTS_AT}`,
      nextBoundaryAt: at(started ? 10_000 : CAMPAIGN_STARTS_AT),
    };
  });
  const read = createPricingScopedListingReader({ readGeneration, enabled: () => true });
  const cache = createStorefrontListingCache<PricingStamped<Listing>>();
  const loadedAt: number[] = [];
  const load = async (readAt: Date): Promise<Listing> => {
    loadedAt.push(readAt.getTime());
    return { priceVnd: readAt.getTime() >= CAMPAIGN_STARTS_AT ? 80_000 : 100_000, refreshAfterMs: 60_000 };
  };
  return { read, cache, load, loadedAt, slowFirstRead };
}

describe("pricing scoped listing", () => {
  it("never stores pre-campaign prices under the key of the window that follows", async () => {
    const { read, cache, load, loadedAt, slowFirstRead } = setup();
    // A leader read is in flight. A arrives just before the campaign starts, B just after it.
    const leader = read(cache, "plp", at(4_000), load);
    await Promise.resolve();
    const a = read(cache, "plp", at(4_999), load);
    const b = read(cache, "plp", at(5_001), load);
    slowFirstRead.resolve();
    const [, first, second] = await Promise.all([leader, a, b]);
    assert.equal(first.priceVnd, 80_000, "A is served the price of the generation keying its page");
    assert.equal(second.priceVnd, 80_000);
    // C arrives after the start and must hit the same entry, still carrying the campaign price.
    const c = await read(cache, "plp", at(5_100), load);
    assert.equal(c.priceVnd, 80_000);
    const postBoundaryLoads = loadedAt.filter((instant) => instant >= CAMPAIGN_STARTS_AT);
    assert.equal(postBoundaryLoads.length, 1, "the post-start page is read once, at a post-start instant");
  });

  it("shortens a cached countdown by the time since the listing was read", async () => {
    const { read, cache, load, slowFirstRead } = setup();
    slowFirstRead.resolve();
    await read(cache, "plp", at(6_000), load);
    const later = await read(cache, "plp", at(6_000 + 45_000 - 40_000), load);
    assert.equal(later.refreshAfterMs, 55_000);
  });

  it("reads straight through when the cache is off", async () => {
    const { cache, load } = setup();
    let generationReads = 0;
    const read = createPricingScopedListingReader({
      readGeneration: async () => {
        generationReads += 1;
        throw new Error("must not be called");
      },
      enabled: () => false,
    });
    assert.equal((await read(cache, "plp", at(1), load)).priceVnd, 100_000);
    assert.equal(generationReads, 0);
  });
});
