import type { StorefrontProductMedia } from "../commerce/product-media.ts";
import {
  buildStorefrontDiscoveryHref,
  STOREFRONT_DISCOVERY_LIMITS,
  type StorefrontDiscoveryQuery,
} from "../commerce/storefront-discovery.ts";
import type {
  StorefrontPricingRule,
  StorefrontVariantFacts,
  StorefrontProductCapacity,
} from "../commerce/storefront-product.ts";
import {
  buildProductCardModel,
  type ProductCardModel,
  type StorefrontFlashSalePresentation,
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
  /**
   * I5/F8a — the product's real capacity, when the read supplied one. Absent keeps the approved
   * STANDARD default, which is what this surface assumed before F8a.
   */
  productCapacity?: StorefrontProductCapacity;
  /** Present when a Flash Sale prices this product; the card then renders as on the Flash listing. */
  flashSale?: StorefrontFlashSalePresentation;
}>;

export type ShopFacets = Readonly<{
  collections: readonly string[];
  colors: readonly string[];
  sizes: readonly string[];
}>;

export type ShopCollectionFacet = Readonly<{ value: string; label: string }>;

/**
 * The option a `<select>` should show for a value that came from the URL.
 *
 * Facets are canonicalised (`Xl` is offered as `XL`) while the URL keeps whatever case it was
 * written in, and the SQL matches without case. Handing the raw URL value to the select would find
 * no option, fall back to "Tất cả" and make the next submit drop a filter that is still applied.
 * So the value is resolved to the facet's own spelling, and one the facets do not contain at all
 * (a size nothing carries any more) is kept as an extra option rather than silently cleared.
 */
export function resolveSelectedFacet(
  options: readonly string[],
  selected: string | null,
): Readonly<{ value: string; options: readonly string[] }> {
  if (selected === null) return Object.freeze({ value: "", options });
  const wanted = selected.trim().toLowerCase();
  const match = options.find((option) => option.trim().toLowerCase() === wanted);
  if (match !== undefined) return Object.freeze({ value: match, options });
  return Object.freeze({ value: selected, options: Object.freeze([...options, selected]) });
}

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
  /** The size and colour the controls should show as chosen, in the facets' own spelling; `""` for none. */
  selectedSize: string;
  selectedColor: string;
  /** The collection the select should show as chosen; `""` for none. Kept even when no longer published. */
  selectedCollection: string;
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
    || Boolean(discovery.sale)
    || discovery.sort !== "name-asc"
  );
}

export function buildShopViewModel(input: ShopViewModelInput): ShopViewModel {
  const size = resolveSelectedFacet(input.facets.sizes, input.discovery.size);
  const color = resolveSelectedFacet(input.facets.colors, input.discovery.color);
  const collection = resolveSelectedFacet(input.facets.collections, input.discovery.collection);

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
            flashSale: product.flashSale,
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
    // A collection in the URL that is no longer published has no facet. It stays selectable, marked
    // as unavailable, so a shared link keeps showing what it filters by and a sort change does not
    // quietly drop it.
    collectionFacets: Object.freeze(
      collection.options.map((value, index) =>
        Object.freeze({
          value,
          label:
            index < input.facets.collections.length
              ? shopCollectionLabel(value)
              : `${shopCollectionLabel(value)} (không còn khả dụng)`,
        }),
      ),
    ),
    selectedCollection: collection.value,
    colorFacets: Object.freeze([...color.options]),
    sizeFacets: Object.freeze([...size.options]),
    selectedSize: size.value,
    selectedColor: color.value,
    discovery: input.discovery,
    limits: Object.freeze({
      query: STOREFRONT_DISCOVERY_LIMITS.query,
      priceVnd: STOREFRONT_DISCOVERY_LIMITS.priceVnd,
    }),
  });
}
