import { buildCategoryDiscoveryHref } from "../commerce/category-discovery-url.ts";
import type { StorefrontProductMedia } from "../commerce/product-media.ts";
import type {
  StorefrontPricingRule,
  StorefrontProductCapacity,
  StorefrontVariantFacts,
} from "../commerce/storefront-product.ts";
import {
  buildProductCardModel,
  type ProductCardModel,
  type StorefrontFlashSalePresentation,
} from "../components/headless/build-product-card-model.ts";
import { hasActivePlpFilters, type PlpFilterState } from "../components/headless/plp-filter-model.ts";
import type { TrackingEvent } from "../tracking/commerce-events.ts";

export type FlashSaleProduct = Readonly<{
  id: string;
  slug: string;
  name: string;
  media?: StorefrontProductMedia | null;
  variants: StorefrontVariantFacts[];
  /**
   * I5/F8a — the product's real capacity, when the read supplied one. Absent keeps the approved
   * STANDARD default, which is what this surface assumed before F8a.
   */
  productCapacity?: StorefrontProductCapacity;
  flashSale?: StorefrontFlashSalePresentation;
  /** The sale read chose this card for a "Xả hàng lẻ size" (CLEARANCE) discount. */
  isClearance?: boolean;
}>;

/** What a listing with filters hands its filter panel. Absent on a listing that has none. */
export type SaleFilterModel = Readonly<{
  /** The route every filter link is written against. */
  basePath: string;
  active: PlpFilterState;
  /** The sizes still selectable under the other choices, canonical spelling, in clothing order. */
  availableSizes: readonly string[];
  /** The shopper chose a filter or a non-default sort, so an empty result is "no match", not "no sale". */
  filtered: boolean;
}>;

export type FlashSaleViewModel = Readonly<{
  filters: SaleFilterModel | null;
  cards: readonly Readonly<{ id: string; model: ProductCardModel }>[];
  toneOffset: number;
  totalCount: number;
  page: number;
  totalPages: number;
  previousHref: string | null;
  nextHref: string | null;
}>;

export type FlashSaleViewModelInput = Readonly<{
  products: readonly FlashSaleProduct[];
  totalCount: number;
  totalPages: number;
  page: number;
  pageSize: number;
  selectEventBySlug: ReadonlyMap<string, TrackingEvent>;
  pricingRule?: StorefrontPricingRule;
  /**
   * The route the paging hrefs are written against.
   *
   * Defaults to the surface this builder was written for. `/sale` and `/new-arrivals` reuse the
   * same shape and each names its own path: both used to take the `/flash-sale` links and string-
   * replace them afterwards, which is a hack that has to be repeated correctly by every new
   * caller, and silently produces a link to an unmounted route when it is not.
   */
  basePath?: string;
  /** Present on a listing that offers filters: the paging hrefs then keep them. */
  filters?: Readonly<{ active: PlpFilterState; availableSizes: readonly string[] }>;
}>;

export function buildFlashSaleViewModel(input: FlashSaleViewModelInput): FlashSaleViewModel {
  const basePath = input.basePath ?? "/flash-sale";
  const filters = input.filters ?? null;
  // A listing with filters writes its paging links from the same state the panel does, so the
  // size, colour, price band and sort survive a page turn; one without keeps the bare `?page=`.
  const pageHref = (page: number) =>
    filters === null
      ? `${basePath}?page=${page}`
      : buildCategoryDiscoveryHref(basePath, filters.active, page);
  return Object.freeze({
    filters:
      filters === null
        ? null
        : Object.freeze({
            basePath,
            active: filters.active,
            availableSizes: filters.availableSizes,
            filtered: hasActivePlpFilters(filters.active),
          }),
    cards: Object.freeze(
      input.products.map((product) =>
        Object.freeze({
          id: product.id,
          model: buildProductCardModel({
            slug: product.slug,
            name: product.name,
            media: product.media,
            variants: product.variants,
            productCapacity: product.productCapacity,
            pricingRule: input.pricingRule,
            flashSale: product.flashSale,
            isClearance: product.isClearance,
            selectEvent: input.selectEventBySlug.get(product.slug) ?? null,
          }),
        }),
      ),
    ),
    toneOffset: (input.page - 1) * input.pageSize,
    totalCount: input.totalCount,
    page: input.page,
    totalPages: input.totalPages,
    previousHref: input.page > 1 ? pageHref(input.page - 1) : null,
    nextHref: input.page < input.totalPages ? pageHref(input.page + 1) : null,
  });
}
