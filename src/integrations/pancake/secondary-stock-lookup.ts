import {
  parsePancakeCatalogVariations,
  type PancakeCatalogVariation,
} from "./catalog-contract.ts";
import { normalizeSku } from "./sku.ts";

type QueryValue = string | number | boolean | readonly string[];

export type SecondaryStockLookupClient = {
  getJson(endpoint: string, query?: Readonly<Record<string, QueryValue>>): Promise<unknown>;
};

export type SecondaryShopGatewayConfig = {
  client: SecondaryStockLookupClient;
  shopId: number;
};

/** Pancake accepts up to 100 rows a page; a wide page makes a fuzzy `search` unlikely to cut off the exact SKU. */
export const SECONDARY_LOOKUP_PAGE_SIZE = 100;
/** Requests to the secondary shop in flight at once, so a many-line order cannot burst the API. */
export const SECONDARY_LOOKUP_CONCURRENCY = 4;

type LookupOutcome =
  | { kind: "none" }
  | { kind: "found"; matches: readonly PancakeCatalogVariation[] }
  /** Unreadable, or possibly truncated before the exact SKU: nothing is known about its stock. */
  | { kind: "failed" };

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

async function lookupSecondarySku(
  secondary: SecondaryShopGatewayConfig,
  displayId: string,
  sku: string,
): Promise<LookupOutcome> {
  try {
    const payload = await secondary.client.getJson(
      `/shops/${secondary.shopId}/products/variations`,
      { page_number: 1, page_size: SECONDARY_LOOKUP_PAGE_SIZE, search: displayId.trim() },
    );
    const page = parsePancakeCatalogVariations(payload);
    const matches = page.variations.filter((variation) => normalizeSku(variation.displayId) === sku);
    if (matches.length > 0) return { kind: "found", matches };
    // `search` is a fuzzy match. A full page with no exact SKU may have cut it off, which is
    // different from "the secondary shop does not stock it".
    return page.variations.length >= SECONDARY_LOOKUP_PAGE_SIZE ? { kind: "failed" } : { kind: "none" };
  } catch {
    return { kind: "failed" };
  }
}

/**
 * Adds the secondary shop's live sellable stock, matched by SKU, onto primary-shop variations.
 *
 * Identity, price and visibility stay the primary shop's: only the stock figures change. The result
 * is always at least as safe as the primary figure alone — any lookup that fails or is inconclusive
 * leaves its variation exactly as the primary shop reported it.
 *
 * `warn` receives fixed text and counts only, never a Pancake payload, SKU or credential.
 */
export async function addSecondaryShopStock(
  variations: readonly PancakeCatalogVariation[],
  secondary: SecondaryShopGatewayConfig,
  warn: (message: string) => void = (message) => console.warn(message),
): Promise<PancakeCatalogVariation[]> {
  let failed = 0;
  let attempted = 0;
  const enriched = await mapWithConcurrency(
    variations,
    SECONDARY_LOOKUP_CONCURRENCY,
    async (variation): Promise<PancakeCatalogVariation> => {
      const sku = normalizeSku(variation.displayId);
      if (!sku || variation.displayId === null || variation.displayId === undefined) return variation;
      attempted += 1;
      const outcome = await lookupSecondarySku(secondary, variation.displayId, sku);
      if (outcome.kind === "failed") {
        failed += 1;
        return variation;
      }
      if (outcome.kind === "none") return variation;

      // Several exact matches are the same article held in several secondary rows: their stock adds.
      const secondarySellableStock = outcome.matches.reduce(
        (total, match) => total + match.sellableStock,
        0,
      );
      const primarySellableStock = variation.sellableStock;
      return {
        ...variation,
        warehouseStocks: [
          ...variation.warehouseStocks,
          ...outcome.matches.flatMap((match) => match.warehouseStocks),
        ],
        sellableStock: primarySellableStock + secondarySellableStock,
        primarySellableStock,
        secondarySellableStock,
      };
    },
  );

  if (failed > 0) {
    warn(`Secondary Pancake stock lookup failed or was inconclusive for ${failed} of ${attempted} variation(s)`);
  }
  return enriched;
}
