import type { StorefrontProductMedia } from "../commerce/product-media.ts";
import {
  buildStorefrontDiscoveryHref,
  STOREFRONT_DISCOVERY_LIMITS,
  type StorefrontDiscoveryQuery,
} from "../commerce/storefront-discovery.ts";
import type {
  StorefrontPricingRule,
  StorefrontVariantFacts,
} from "../commerce/storefront-product.ts";
import {
  buildProductCardModel,
  type ProductCardModel,
} from "../components/headless/build-product-card-model.ts";
import type { TrackingEvent } from "../tracking/commerce-events.ts";

/**
 * Everything the shop route decides, as one pure function.
 *
 * Separate from `shop.ts` because that file reaches the catalog runtime, `next/server` and
 * `notFound()`. What is left here is what the page would otherwise decide inline: whether the
 * shopper has actually filtered anything, how a facet slug reads as a label, where the pagination
 * links point, and which tone each card takes -- the last of which has to survive paging, or page
 * two restarts the colour cycle and the grid visibly repeats itself.
 */

export type ShopProduct = Readonly<{
  id: string;
  slug: string;
  name: string;
  media?: StorefrontProductMedia | null;
  variants: StorefrontVariantFacts[];
}>;

export type ShopFacets = Readonly<{
  collections: readonly string[];
  colors: readonly string[];
  sizes: readonly string[];
}>;

export type ShopCollectionFacet = Readonly<{ value: string; label: string }>;

export type ShopViewModel = Readonly<{
  cards: readonly Readonly<{ id: string; model: ProductCardModel }>[];
  /** Index of the first card on this page, so the tone cycle continues instead of restarting. */
  toneOffset: number;
  totalCount: number;
  page: number;
  totalPages: number;
  previousHref: string | null;
  nextHref: string | null;
  /** Whether the shopper narrowed anything, which decides the empty state's wording. */
  filtered: boolean;
  collectionFacets: readonly ShopCollectionFacet[];
  colorFacets: readonly string[];
  sizeFacets: readonly string[];
  discovery: StorefrontDiscoveryQuery;
  /**
   * The same bounds the loader rejects past, handed to the form so its affordances and the server's
   * answer cannot disagree. Retyping them in markup is how a field lets a shopper enter something
   * the route then refuses.
   */
  limits: Readonly<{ query: number; priceVnd: number }>;
}>;

export type ShopViewModelInput = Readonly<{
  discovery: StorefrontDiscoveryQuery;
  products: readonly ShopProduct[];
  facets: ShopFacets;
  totalCount: number;
  totalPages: number;
  page: number;
  hasPrevious: boolean;
  hasNext: boolean;
  pageSize: number;
  pricingRule?: StorefrontPricingRule;
  selectEventBySlug: ReadonlyMap<string, TrackingEvent>;
}>;

/** A facet slug as a heading: `ao-so-mi` reads `Ao So Mi`. */
export function shopCollectionLabel(slug: string): string {
  return slug
    .split("-")
    .map((part) => (part.length > 0 ? `${part[0]!.toUpperCase()}${part.slice(1)}` : part))
    .join(" ");
}

/**
 * Whether the shopper narrowed the catalog at all.
 *
 * The default sort counts as unfiltered: arriving at `/shop` and seeing "no products match your
 * filters" when no filter was applied is worse than saying the catalog is empty, which it is.
 */
export function hasActiveShopDiscovery(discovery: StorefrontDiscoveryQuery): boolean {
  return (
    discovery.query !== null
    || discovery.color !== null
    || discovery.size !== null
    || discovery.availability !== null
    || discovery.minPriceVnd !== null
    || discovery.maxPriceVnd !== null
    || discovery.collection !== null
    || discovery.sort !== "name-asc"
  );
}

export function buildShopViewModel(input: ShopViewModelInput): ShopViewModel {
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
            selectEvent: input.selectEventBySlug.get(product.slug) ?? null,
          }),
        }),
      ),
    ),
    toneOffset: (input.page - 1) * input.pageSize,
    totalCount: input.totalCount,
    page: input.page,
    totalPages: input.totalPages,
    previousHref: input.hasPrevious
      ? buildStorefrontDiscoveryHref(input.discovery, input.page - 1)
      : null,
    nextHref: input.hasNext ? buildStorefrontDiscoveryHref(input.discovery, input.page + 1) : null,
    filtered: hasActiveShopDiscovery(input.discovery),
    collectionFacets: Object.freeze(
      input.facets.collections.map((value) =>
        Object.freeze({ value, label: shopCollectionLabel(value) }),
      ),
    ),
    colorFacets: Object.freeze([...input.facets.colors]),
    sizeFacets: Object.freeze([...input.facets.sizes]),
    discovery: input.discovery,
    limits: Object.freeze({
      query: STOREFRONT_DISCOVERY_LIMITS.query,
      priceVnd: STOREFRONT_DISCOVERY_LIMITS.priceVnd,
    }),
  });
}
