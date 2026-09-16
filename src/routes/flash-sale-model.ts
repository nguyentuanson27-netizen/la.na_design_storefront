import type { StorefrontProductMedia } from "../commerce/product-media.ts";
import type { StorefrontPricingRule, StorefrontVariantFacts } from "../commerce/storefront-product.ts";
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
  flashSale?: StorefrontFlashSalePresentation;
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
}>;

export function buildFlashSaleViewModel(input: FlashSaleViewModelInput): FlashSaleViewModel {
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
            pricingRule: input.pricingRule,
            flashSale: product.flashSale,
            selectEvent: input.selectEventBySlug.get(product.slug) ?? null,
          }),
        }),
      ),
    ),
    toneOffset: (input.page - 1) * input.pageSize,
    totalCount: input.totalCount,
    page: input.page,
    totalPages: input.totalPages,
    previousHref: input.page > 1 ? `/flash-sale?page=${input.page - 1}` : null,
    nextHref: input.page < input.totalPages ? `/flash-sale?page=${input.page + 1}` : null,
  });
}
