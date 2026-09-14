import type { StorefrontProductMedia } from "../commerce/product-media.ts";
import type { StorefrontVariantFacts } from "../commerce/storefront-product.ts";
import {
  buildProductCardModel,
  type ProductCardModel,
  type StorefrontFlashSalePresentation,
} from "../components/headless/build-product-card-model.ts";
import type { TrackingEvent } from "../tracking/commerce-events.ts";

/**
 * Everything the Flash Sale route decides, as one pure function.
 *
 * Flash pricing is not decided here. Each card's representative is selected server-side and arrives
 * as `flashSale`; `buildProductCardModel` turns it into a countdown. What this owns is the grid's
 * ordering, the tone offset across pages and the pagination links.
 */

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
    // `?page=1` is kept rather than canonicalised away, because that is what this route emits today
    // and a migration is not the place to change a URL. Unlike the shop listing, whose href builder
    // drops the param, page one here has two spellings; noted as a carry-forward, not fixed here.
    previousHref: input.page > 1 ? `/flash-sale?page=${input.page - 1}` : null,
    nextHref: input.page < input.totalPages ? `/flash-sale?page=${input.page + 1}` : null,
  });
}
