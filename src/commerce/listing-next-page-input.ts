import {
  parseSaleDiscoverySearchParams,
  type CategoryDiscoverySort,
} from "./category-discovery-url.ts";
import {
  parseStorefrontDiscoverySearchParams,
  type StorefrontDiscoveryQuery,
} from "./storefront-discovery.ts";
import type { SaleListingKind } from "../brand/sale.config.ts";
import type { PlpFilterState } from "../components/headless/plp-filter-model.ts";

/**
 * How an infinite grid asks for its next page, in one place, for the listings whose filters do not
 * fit the category filter state.
 *
 * Three things have to agree for a page loaded by scrolling to be the page `?page=N` shows: the
 * filter state the page hands its grid, the request the grid sends, and the discovery the server
 * action rebuilds from that request. Spelled out in the page, the hook and the action, each is a
 * place to drop or reinterpret a value -- and a dropped `sort` changes the ORDER BY between page 1
 * and page 2, which duplicates and skips products at the boundary. So the three live here as pure
 * functions, and `tests/domain/listing-next-page-input.test.ts` runs the whole loop.
 */

const text = (value: string | null | undefined) => value ?? undefined;
const price = (value: number | null | undefined) =>
  value !== null && value !== undefined ? String(value) : undefined;

/** The filters of an already-parsed `/shop` URL, as the grid holds them. */
export function shopPlpFilters(discovery: StorefrontDiscoveryQuery): PlpFilterState {
  return {
    size: discovery.size,
    color: discovery.color,
    availability: discovery.availability,
    minPriceVnd: discovery.minPriceVnd,
    maxPriceVnd: discovery.maxPriceVnd,
    sale: discovery.sale ?? null,
    sort: discovery.sort,
  };
}

export type ShopNextPageInput = {
  page: number;
  query?: string | null;
  collection?: string | null;
  color?: string | null;
  size?: string | null;
  availability?: "in-stock" | null;
  minPriceVnd?: number | null;
  maxPriceVnd?: number | null;
  sale?: boolean | null;
  /**
   * Sent exactly as the page holds it. On `/shop` an absent sort is `name-asc`, but `sort=default` is
   * a different, valid order (no in-stock-first), so `default` must never be turned into "absent".
   */
  sort?: CategoryDiscoverySort;
};

export function buildShopNextPageInput(
  source: Readonly<{ query: string | null; collection: string | null }>,
  filters: PlpFilterState,
  page: number,
): ShopNextPageInput {
  return {
    page,
    query: source.query,
    collection: source.collection,
    color: filters.color,
    size: filters.size,
    availability: filters.availability,
    minPriceVnd: filters.minPriceVnd,
    maxPriceVnd: filters.maxPriceVnd,
    sale: filters.sale,
    sort: filters.sort,
  };
}

/** The discovery the shop's server action reads: the route's own parser over the same facts. */
export function shopDiscoveryFromInput(input: ShopNextPageInput): StorefrontDiscoveryQuery {
  return parseStorefrontDiscoverySearchParams({
    q: text(input.query),
    collection: text(input.collection),
    color: text(input.color),
    size: text(input.size),
    availability: text(input.availability),
    minPrice: price(input.minPriceVnd),
    maxPrice: price(input.maxPriceVnd),
    sale: input.sale ? "true" : undefined,
    sort: input.sort,
    page: String(input.page),
  });
}

/** The filters of an already-parsed sale-listing URL, as the grid holds them. */
export function salePlpFilters(discovery: StorefrontDiscoveryQuery): PlpFilterState {
  return {
    size: discovery.size,
    color: discovery.color,
    // Everything on a sale listing is in stock and on sale by construction: nothing to narrow.
    availability: null,
    minPriceVnd: discovery.minPriceVnd,
    maxPriceVnd: discovery.maxPriceVnd,
    sale: null,
    sort: discovery.sort,
  };
}

export type SaleNextPageInput = {
  /** Which sale listing is being paged; absent or `null` is `/sale` itself (every active discount). */
  kind?: SaleListingKind | null;
  page: number;
  color?: string | null;
  size?: string | null;
  minPriceVnd?: number | null;
  maxPriceVnd?: number | null;
  sort?: CategoryDiscoverySort;
};

export function buildSaleNextPageInput(
  saleKind: SaleListingKind | null,
  filters: PlpFilterState,
  page: number,
): SaleNextPageInput {
  return {
    kind: saleKind,
    page,
    color: filters.color,
    size: filters.size,
    minPriceVnd: filters.minPriceVnd,
    maxPriceVnd: filters.maxPriceVnd,
    sort: filters.sort,
  };
}

/** The discovery the sale action reads: the sale listings' own parser over the same facts. */
export function saleDiscoveryFromInput(input: SaleNextPageInput): StorefrontDiscoveryQuery {
  return parseSaleDiscoverySearchParams({
    color: text(input.color),
    size: text(input.size),
    minPrice: price(input.minPriceVnd),
    maxPrice: price(input.maxPriceVnd),
    sort: input.sort,
    page: String(input.page),
  });
}
