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
  /**
   * Of the (variation, normalized SKU) pairs read live, the SKUs whose secondary stock must not be
   * given out: shared by several variants, or whose mirror picture disagrees with the live one. Their
   * secondary stock goes to none, as in the mirror sync. When it is configured and fails, no
   * secondary stock is added at all: counting the same units twice is the error to avoid.
   */
  findUnsafeSkus?: (
    primaryShopId: number,
    entries: readonly Readonly<{ variationId: string; sku: string }>[],
  ) => Promise<ReadonlySet<string>>;
};

/** Pancake accepts up to 100 rows a page; a wide page keeps a fuzzy `search` to a single request in practice. */
export const SECONDARY_LOOKUP_PAGE_SIZE = 100;
/** Requests to the secondary shop in flight at once, so a many-line order cannot burst the API. */
export const SECONDARY_LOOKUP_CONCURRENCY = 4;

type LookupOutcome =
  | { kind: "none" }
  | { kind: "found"; matches: readonly PancakeCatalogVariation[] }
  /** Unreadable, or possibly truncated before the exact SKU: nothing is known about its stock. */
  | { kind: "failed" };

async function mapWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<void>,
  shouldStop: () => boolean,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length && !shouldStop()) {
      const index = next++;
      await task(items[index]!, index);
    }
  });
  await Promise.all(workers);
}

/** Pages of a fuzzy `search` read before the answer is given up as inconclusive. */
export const SECONDARY_LOOKUP_MAX_PAGES = 5;

async function lookupSecondarySku(
  secondary: SecondaryShopGatewayConfig,
  displayId: string,
  sku: string,
): Promise<LookupOutcome> {
  try {
    // The exact SKU may sit on any page of a fuzzy search, and the mirror sync adds every row that
    // carries it, so all pages are read. Like the full catalog traversal, anything that does not
    // look like one consistent walk of the same result set is rejected: a page that answers for a
    // different page number (or a repeated row) would otherwise add the same units twice.
    const matches: PancakeCatalogVariation[] = [];
    const seenIds = new Set<string>();
    let first: { totalPages: number; totalEntries: number } | undefined;
    let rowsRead = 0;
    for (let pageNumber = 1; pageNumber <= (first?.totalPages ?? 1); pageNumber += 1) {
      const payload = await secondary.client.getJson(`/shops/${secondary.shopId}/products/variations`, {
        page_number: pageNumber,
        page_size: SECONDARY_LOOKUP_PAGE_SIZE,
        search: displayId.trim(),
      });
      const page = parsePancakeCatalogVariations(payload);
      if (page.pageNumber !== pageNumber) return { kind: "failed" };
      if (first === undefined) {
        first = { totalPages: page.totalPages, totalEntries: page.totalEntries };
        if (first.totalPages > SECONDARY_LOOKUP_MAX_PAGES) return { kind: "failed" };
      } else if (page.totalPages !== first.totalPages || page.totalEntries !== first.totalEntries) {
        return { kind: "failed" };
      }
      for (const variation of page.variations) {
        if (seenIds.has(variation.id)) return { kind: "failed" };
        seenIds.add(variation.id);
        if (normalizeSku(variation.displayId) === sku) matches.push(variation);
      }
      rowsRead += page.variations.length;
    }
    if (first !== undefined && rowsRead !== first.totalEntries) return { kind: "failed" };
    return matches.length > 0 ? { kind: "found", matches } : { kind: "none" };
  } catch {
    return { kind: "failed" };
  }
}

/**
 * The whole secondary enrichment of one read — every SKU, every page — gets this long. The shop's
 * per-request timeout bounds one request; this bounds what the buyer waits for in total, however
 * many lines the order has and however many pages a lookup walks.
 */
export const SECONDARY_ENRICHMENT_DEADLINE_MS = 4_000;

/**
 * Adds the secondary shop's live sellable stock, matched by SKU, onto primary-shop variations.
 *
 * Identity, price and visibility stay the primary shop's: only the stock figures change. The result
 * is always at least as safe as the primary figure alone — any lookup that fails, is inconclusive or
 * is still running when the deadline passes leaves its variation exactly as the primary shop
 * reported it.
 *
 * `warn` receives fixed text and counts only, never a Pancake payload, SKU or credential.
 */
export async function addSecondaryShopStock(
  variations: readonly PancakeCatalogVariation[],
  secondary: SecondaryShopGatewayConfig,
  {
    primaryShopId,
    deadlineMs = SECONDARY_ENRICHMENT_DEADLINE_MS,
    warn = (message) => console.warn(message),
  }: { primaryShopId: number; deadlineMs?: number; warn?: (message: string) => void },
): Promise<PancakeCatalogVariation[]> {
  const entries = variations.flatMap((variation) => {
    const sku = normalizeSku(variation.displayId);
    return sku === null ? [] : [{ variationId: variation.id, sku }];
  });

  // A SKU carried by two variations of THIS read cannot be told apart whatever the mirror says.
  const variationIdsBySku = new Map<string, Set<string>>();
  for (const { variationId, sku } of entries) {
    const ids = variationIdsBySku.get(sku) ?? new Set<string>();
    ids.add(variationId);
    variationIdsBySku.set(sku, ids);
  }
  const unsafe = new Set<string>();
  for (const [sku, ids] of variationIdsBySku) if (ids.size > 1) unsafe.add(sku);

  if (secondary.findUnsafeSkus) {
    try {
      for (const sku of await secondary.findUnsafeSkus(primaryShopId, entries)) unsafe.add(sku);
    } catch {
      warn("Secondary Pancake stock skipped: the SKU uniqueness check failed");
      return [...variations];
    }
  }

  // Each answered lookup writes into `results`; a variation nobody answered for keeps its primary
  // figure. Once the deadline passes nothing more is started and nothing more is accepted.
  const results: PancakeCatalogVariation[] = [...variations];
  let expired = false;
  let conclusive = 0;
  const work = mapWithConcurrency(
    variations,
    SECONDARY_LOOKUP_CONCURRENCY,
    async (variation, index) => {
      const sku = normalizeSku(variation.displayId);
      if (!sku || variation.displayId === null || variation.displayId === undefined) return;
      if (unsafe.has(sku)) return;
      const outcome = await lookupSecondarySku(secondary, variation.displayId, sku);
      if (expired || outcome.kind === "failed") return;
      conclusive += 1;
      if (outcome.kind === "none") return;

      // Several exact matches are the same article held in several secondary rows: their stock adds.
      const secondarySellableStock = outcome.matches.reduce(
        (total, match) => total + match.sellableStock,
        0,
      );
      const primarySellableStock = variation.sellableStock;
      results[index] = {
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
    () => expired,
  );

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, deadlineMs);
  });
  await Promise.race([work, deadline]);
  expired = true;
  if (timer !== undefined) clearTimeout(timer);

  // Lookups that never started count as unanswered too, so the figure is every eligible variation
  // minus those that got a conclusive answer in time.
  const eligible = variations.filter((variation) => {
    const sku = normalizeSku(variation.displayId);
    return sku !== null && !unsafe.has(sku);
  }).length;
  const unanswered = eligible - conclusive;
  if (unanswered > 0) {
    warn(
      `Secondary Pancake stock lookup was inconclusive for ${unanswered} of ${eligible} variation(s)` +
        ` (failed, unreadable or past the ${deadlineMs} ms deadline)`,
    );
  }
  return results;
}
