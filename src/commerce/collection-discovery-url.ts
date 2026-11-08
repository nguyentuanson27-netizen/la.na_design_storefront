import type { PlpFilterState } from "../components/headless/plp-filter-model.ts";
import { parseCategoryDiscoverySearchParams } from "./category-discovery-url.ts";
import {
  parseStorefrontDiscoverySearchParams,
  type StorefrontDiscoveryQuery,
  type StorefrontDiscoverySearchParams,
  type StorefrontDiscoverySort,
} from "./storefront-discovery.ts";

const COLLECTION_DEFAULT_SORTS: Readonly<Record<string, StorefrontDiscoverySort>> = {
  "xa-hang-chao-thu": "price-asc",
};

export function resolveCollectionDefaultSort(routeSlug: string): StorefrontDiscoverySort {
  return COLLECTION_DEFAULT_SORTS[routeSlug] ?? "name-asc";
}

/**
 * Whether a repository read is in the collection's own default order.
 *
 * The catalog repository falls back to this when a caller does not say whether in-stock products
 * lead. The collection route itself always says so, from whether the URL carried a sort at all
 * (`CollectionListingState.merchandiserOrder`).
 */
export function isCollectionDefaultSort(
  routeSlug: string,
  sort: StorefrontDiscoverySort,
): boolean {
  return sort === resolveCollectionDefaultSort(routeSlug);
}

/** The listing path a collection's filter, sort and paging links are written against. */
export function collectionListingPath(routeSlug: string): string {
  const parsed = parseStorefrontDiscoverySearchParams({ collection: routeSlug });
  if (!parsed.collection) throw new RangeError("Collection route slug is required");
  return `/collections/${parsed.collection}`;
}

export type CollectionListingState = Readonly<{
  /** What the catalog repository reads: the collection, its filters and the concrete order. */
  discovery: StorefrontDiscoveryQuery;
  /** What the shared filter panel and the infinite grid hold; `sort: "default"` is the merchandiser's order. */
  filters: PlpFilterState;
  /**
   * Whether the shopper is looking at the collection in the order its merchandiser set (no sort in
   * the URL). Pins and the in-stock-first partition apply only then: under a sort the shopper picked
   * they would sit above a list that claims to be ordered by price or name.
   */
  merchandiserOrder: boolean;
}>;

/**
 * What `/collections/<slug>` takes from the URL, in the category listing's vocabulary.
 *
 * A collection draws the category listing's own filter panel (size, price, "Còn hàng", "Sale",
 * sort) and its infinite grid, so it reads the same parameters with the same rules: an absent sort
 * is `default`, and a malformed value is a `RangeError`, which the route turns into a 404. The
 * links the panel writes (`buildCategoryDiscoveryHref`) therefore round-trip. The one
 * collection-specific step is what `default` means to the repository: the collection's own default
 * order (`resolveCollectionDefaultSort`), with its pins and in-stock-first partition.
 */
export function parseCollectionListingSearchParams(
  routeSlug: string,
  searchParams: StorefrontDiscoverySearchParams,
): CollectionListingState {
  const collection = collectionListingPath(routeSlug).slice("/collections/".length);
  const parsed = parseCategoryDiscoverySearchParams(collection, searchParams);
  const merchandiserOrder = parsed.sort === "default";
  // `sale=false` narrows nothing: only an affirmative toggle filters, as on the category listing.
  const sale = parsed.sale === true ? true : null;

  return Object.freeze({
    discovery: Object.freeze({
      query: null,
      color: parsed.color,
      size: parsed.size,
      availability: parsed.availability,
      minPriceVnd: parsed.minPriceVnd,
      maxPriceVnd: parsed.maxPriceVnd,
      sale,
      collection,
      sort: merchandiserOrder ? resolveCollectionDefaultSort(collection) : parsed.sort,
      page: parsed.page,
    }),
    filters: Object.freeze({
      size: parsed.size,
      color: parsed.color,
      availability: parsed.availability,
      minPriceVnd: parsed.minPriceVnd,
      maxPriceVnd: parsed.maxPriceVnd,
      sale,
      sort: parsed.sort,
    }),
    merchandiserOrder,
  });
}

/**
 * The repository query for a collection URL. The homepage mirrors the route's unfiltered first page
 * through this (`buildCollectionFirstPageDiscovery`), so both read the same thing.
 */
export function parseCollectionDiscoverySearchParams(
  routeSlug: string,
  searchParams: StorefrontDiscoverySearchParams,
): StorefrontDiscoveryQuery {
  return parseCollectionListingSearchParams(routeSlug, searchParams).discovery;
}
