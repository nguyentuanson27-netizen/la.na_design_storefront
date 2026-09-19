import {
  parseTrustedProductImageUrl,
  parseTrustedProductVideoUrl,
  type StorefrontProductMedia,
} from "../commerce/product-media.ts";
import type {
  StorefrontPricingRule,
  StorefrontVariantFacts,
  StorefrontProductCapacity,
} from "../commerce/storefront-product.ts";
import {
  buildProductCardModel,
  type ProductCardModel,
} from "../components/headless/build-product-card-model.ts";
import type { TrackingEvent } from "../tracking/commerce-events.ts";

/**
 * Everything the collection route decides, as one pure function.
 *
 * The collection's story is its `description` -- there is no separate story field, deliberately.
 * What Phase E adds is the media that story is told with, and the ordering a merchandiser pinned.
 *
 * Every URL is re-validated here against the reviewed Pancake CDN contract rather than trusted
 * because it came out of the database. A row written before the validator existed, or edited by
 * hand, must not be able to put an untrusted host in front of a shopper.
 */

export type CollectionProduct = Readonly<{
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
}>;

export type CollectionVideo = Readonly<{ src: string; poster: string | null }>;

export type CollectionEditorial = Readonly<{
  /** The collection's story. Not a separate field: this is `description`. */
  story: string;
  heroImage: string | null;
  gallery: readonly string[];
  video: CollectionVideo | null;
}>;

export type CollectionSortOption = Readonly<{
  value: string;
  label: string;
  href: string;
  active: boolean;
}>;

export type CollectionSizeOption = Readonly<{
  /** `null` is the "all sizes" entry. */
  value: string | null;
  label: string;
  href: string;
  active: boolean;
}>;

export type CollectionViewModel = Readonly<{
  slug: string;
  title: string;
  editorial: CollectionEditorial;
  cards: readonly Readonly<{ id: string; model: ProductCardModel }>[];
  toneOffset: number;
  totalCount: number;
  page: number;
  totalPages: number;
  previousHref: string | null;
  nextHref: string | null;
  clearFilterHref: string;
  /** Whether a size filter is applied, which decides the empty state's wording. */
  filtered: boolean;
  sortOptions: readonly CollectionSortOption[];
  sizeOptions: readonly CollectionSizeOption[];
}>;

export type CollectionDiscoveryState = Readonly<{ size: string | null; sort: string }>;

export type CollectionViewModelInput = Readonly<{
  slug: string;
  title: string;
  description: string;
  heroImageUrl: string | null;
  galleryImageUrls: readonly string[];
  videoSrcUrl: string | null;
  videoPosterUrl: string | null;
  /**
   * Already in render order. The loader applies `orderByFeaturedSlugs` once, before it builds the
   * grid's tracking, so the impression and select indices describe the order a shopper actually
   * sees. Reordering again here would put the cards and the analytics out of step.
   */
  products: readonly CollectionProduct[];
  sizes: readonly string[];
  discovery: CollectionDiscoveryState;
  sortChoices: readonly Readonly<{ value: string; label: string }>[];
  totalCount: number;
  totalPages: number;
  page: number;
  hasPrevious: boolean;
  hasNext: boolean;
  pageSize: number;
  pricingRule?: StorefrontPricingRule;
  selectEventBySlug: ReadonlyMap<string, TrackingEvent>;
  /** Supplied by the loader, which owns the route's URL shape. */
  hrefFor: (state: Readonly<{ size: string | null; sort: string; page: number }>) => string;
}>;

/**
 * The grid, with the merchandiser's pinned slugs first.
 *
 * Pinning reorders what this page already returned; it never reaches for a product the query did not
 * match, because that would put an item in front of someone who filtered it out. A pinned slug that
 * is absent from the page is simply not on it.
 *
 * Applied once, by the loader, before the grid's tracking is built. Both the rendered cards and the
 * `view_item_list`/`select_item` indices come from this one ordered array: building tracking from
 * the repository order and then reordering the cards would report a pinned product at the index it
 * would have had, not the position it is shown in.
 */
export function orderByFeaturedSlugs<T extends Readonly<{ slug: string }>>(
  products: readonly T[],
  featuredSlugs: readonly string[],
): readonly T[] {
  if (featuredSlugs.length === 0) return products;

  const rank = new Map<string, number>();
  featuredSlugs.forEach((slug, index) => {
    if (!rank.has(slug)) rank.set(slug, index);
  });

  const pinned: T[] = [];
  const rest: T[] = [];
  for (const product of products) {
    (rank.has(product.slug) ? pinned : rest).push(product);
  }
  pinned.sort((a, b) => rank.get(a.slug)! - rank.get(b.slug)!);

  return [...pinned, ...rest];
}

/** Editorial media, with anything that fails the trusted-URL contract dropped. */
export function resolveCollectionEditorial(
  input: Readonly<{
    description: string;
    heroImageUrl: string | null;
    galleryImageUrls: readonly string[];
    videoSrcUrl: string | null;
    videoPosterUrl: string | null;
  }>,
): CollectionEditorial {
  const src = parseTrustedProductVideoUrl(input.videoSrcUrl);

  return Object.freeze({
    story: input.description,
    heroImage: parseTrustedProductImageUrl(input.heroImageUrl),
    gallery: Object.freeze(
      input.galleryImageUrls
        .map((url) => parseTrustedProductImageUrl(url))
        .filter((url): url is string => url !== null),
    ),
    // A poster that fails validation costs the first frame, not the video: the element still plays.
    video: src === null
      ? null
      : Object.freeze({ src, poster: parseTrustedProductImageUrl(input.videoPosterUrl) }),
  });
}

export function buildCollectionViewModel(input: CollectionViewModelInput): CollectionViewModel {
  return Object.freeze({
    slug: input.slug,
    title: input.title,
    editorial: resolveCollectionEditorial(input),
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
      ? input.hrefFor({ size: input.discovery.size, sort: input.discovery.sort, page: input.page - 1 })
      : null,
    nextHref: input.hasNext
      ? input.hrefFor({ size: input.discovery.size, sort: input.discovery.sort, page: input.page + 1 })
      : null,
    clearFilterHref: input.hrefFor({ size: null, sort: input.discovery.sort, page: 1 }),
    filtered: input.discovery.size !== null,
    sortOptions: Object.freeze(
      input.sortChoices.map((choice) =>
        Object.freeze({
          value: choice.value,
          label: choice.label,
          href: input.hrefFor({ size: input.discovery.size, sort: choice.value, page: 1 }),
          active: input.discovery.sort === choice.value,
        }),
      ),
    ),
    sizeOptions: Object.freeze([
      Object.freeze({
        value: null,
        label: "Tất cả kích cỡ",
        href: input.hrefFor({ size: null, sort: input.discovery.sort, page: 1 }),
        active: input.discovery.size === null,
      }),
      ...input.sizes.map((size) =>
        Object.freeze({
          value: size,
          label: size,
          href: input.hrefFor({ size, sort: input.discovery.sort, page: 1 }),
          active: input.discovery.size === size,
        }),
      ),
    ]),
  });
}
