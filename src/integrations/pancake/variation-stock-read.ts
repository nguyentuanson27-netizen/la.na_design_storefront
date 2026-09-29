import type {
  PancakeCatalogWarehouseStock,
  PancakeParsedCatalogVariation,
} from "./catalog-contract.ts";
import { parsePancakeCatalogVariations } from "./catalog-contract.ts";

/**
 * The authoritative targeted stock read behind the webhook-driven inventory batch:
 * `GET /shops/{SHOP_ID}/products/variations` filtered by `variation_ids[]` (Pancake POS OpenAPI
 * 3.1.0, "Product list"). It is the same endpoint the full reconciliation pages through, parsed by the
 * same reviewed catalog contract, so a targeted read and a full read of one variation can never be
 * interpreted differently.
 *
 * Fail-closed: if Pancake answers with a variation that was not asked for — a filter it ignored — or
 * with more than one page, the read throws and the batch keeps its markers for retry rather than
 * trusting a response it cannot tie to the request. A requested variation that is absent is simply
 * not listed any more; the full reconciliation owns removals.
 */

type QueryValue = string | number | boolean | readonly string[];
type VariationClient = {
  getJson(endpoint: string, query?: Readonly<Record<string, QueryValue>>): Promise<unknown>;
};

/** One request per chunk; also the page size, so a chunk is always answered on one page. */
export const MAX_VARIATIONS_PER_READ = 100;

/**
 * Pancake answered a targeted read with something it cannot be tied to: a variation that was not
 * asked for (the filter was ignored) or more than one page. Its own class so a caller that has a
 * slower but complete fallback can tell "the filter is not honoured" from a network failure.
 */
export class PancakeVariationFilterMismatchError extends Error {
  constructor() {
    super("Pancake targeted variation read does not match the requested variations");
    this.name = "PancakeVariationFilterMismatchError";
  }
}

/**
 * The full parsed variations — price, stock, identity — for at most `MAX_VARIATIONS_PER_READ` ids,
 * in one request. Same endpoint and contract as the full catalog traversal, so checkout pricing a
 * handful of cart lines reads exactly what a full read would have said about them, without paging
 * the whole shop first.
 */
export async function fetchPancakeVariationsByIds({
  client,
  shopId,
  variationIds,
}: {
  client: VariationClient;
  shopId: number;
  variationIds: readonly string[];
}): Promise<PancakeParsedCatalogVariation[]> {
  if (!Number.isSafeInteger(shopId) || shopId <= 0) {
    throw new TypeError("Pancake shop id must be a positive safe integer");
  }
  const requested = [...new Set(variationIds)];
  if (requested.length === 0) return [];
  if (requested.length > MAX_VARIATIONS_PER_READ) {
    throw new RangeError(`At most ${MAX_VARIATIONS_PER_READ} variations per targeted read`);
  }

  const page = parsePancakeCatalogVariations(
    await client.getJson(`/shops/${shopId}/products/variations`, {
      page_number: 1,
      page_size: MAX_VARIATIONS_PER_READ,
      "variation_ids[]": requested,
    }),
  );
  const wanted = new Set(requested);
  if (
    page.pageNumber !== 1 ||
    page.totalPages > 1 ||
    page.totalEntries > requested.length ||
    page.variations.some((variation) => !wanted.has(variation.id))
  ) {
    throw new PancakeVariationFilterMismatchError();
  }
  return page.variations;
}

export async function fetchPancakeVariationStocks(
  input: Parameters<typeof fetchPancakeVariationsByIds>[0],
): Promise<Map<string, PancakeCatalogWarehouseStock[]>> {
  const variations = await fetchPancakeVariationsByIds(input);
  return new Map(variations.map((variation) => [variation.id, variation.warehouseStocks]));
}
