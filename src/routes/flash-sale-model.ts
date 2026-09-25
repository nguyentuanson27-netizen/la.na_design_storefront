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

export type FlashSaleViewModel = Readonly<{
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
}>;

export function buildFlashSaleViewModel(input: FlashSaleViewModelInput): FlashSaleViewModel {
  const basePath = input.basePath ?? "/flash-sale";
  return Object.freeze({
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
    previousHref: input.page > 1 ? `${basePath}?page=${input.page - 1}` : null,
    nextHref: input.page < input.totalPages ? `${basePath}?page=${input.page + 1}` : null,
  });
}
