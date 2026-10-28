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
  type StorefrontFlashSalePresentation,
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

/**
 * The fragment that lands a shopper on a collection's products instead of its full-bleed hero.
 *
 * The homepage hero's MUA NGAY link carries it: the shopper has just seen the campaign image, so
 * arriving on a second screen-filling copy of it before any product would be a wasted scroll.
 */
export const COLLECTION_PRODUCTS_ANCHOR = "san-pham";

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
  /** Present when a Flash Sale prices this product; the card then renders as on the Flash listing. */
  flashSale?: StorefrontFlashSalePresentation;
}>;

export type CollectionVideo = Readonly<{ src: string; poster: string | null }>;

export type CollectionEditorial = Readonly<{
  /** The collection's story. Not a separate field: this is `description`. */
  story: string;
  heroImage: string | null;
  heroImageMobile: string | null;
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

export type CollectionAvailabilityOption = Readonly<{
  active: boolean;
  /** Switches the "còn hàng" filter, keeping size and sort. */
  href: string;
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
  /** Drops every filter (size and availability), keeping the sort. */
  clearFilterHref: string;
  /** Whether any filter is applied, which decides the empty state's wording. */
  filtered: boolean;
  sortOptions: readonly CollectionSortOption[];
  sizeOptions: readonly CollectionSizeOption[];
  availabilityOption: CollectionAvailabilityOption;
}>;

export type CollectionDiscoveryState = Readonly<{
  size: string | null;
  sort: string;
  availability?: "in-stock" | null;
}>;

export type CollectionViewModelInput = Readonly<{
  slug: string;
  title: string;
  description: string;
  heroImageUrl: string | null;
  heroImageMobileUrl?: string | null;
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
  hrefFor: (
    state: Readonly<{
      size: string | null;
      sort: string;
      page: number;
      availability: "in-stock" | null;
    }>,
  ) => string;
}>;

/**
 * Sizes compare without case: the catalog has carried the same size as `XL` and `Xl`, and a link
 * typed as `?size=m` should still mark the `M` chip rather than filter silently with none lit.
 */
function sameSize(a: string | null, b: string | null): boolean {
  if (a === null || b === null) return a === b;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * The grid, with the merchandiser's pinned slugs first.
 *
 * Pinning reorders what this page already returned; it never reaches for a product the query did not
 * match, because that would put an item in front of someone who filtered it out. A pinned slug that
 * is not on the page is ignored, and a slug pinned twice keeps its first position. Without pins the
 * order is untouched.
 *
 * `view_item_list`/`select_item` indices come from this one ordered array: building tracking from
 * the repository order and then reordering the cards would report a pinned product at the index it
 * would have had, not the position it is shown in.
 *
 * With `isInStock`, in-stock products always precede out-of-stock ones, so a pinned sold-out
 * product never leapfrogs a product that is on sale. The caller supplies the classification the
 * repository's own query used (it judges only variants matching the active filters), rather than
 * this function re-deriving one from every variant. Only the collection's default sort passes it:
 * under a sort the shopper picked, partitioning by stock would break the order the list claims.
 */
export function orderByFeaturedSlugs<T extends Readonly<{ slug: string }>>(
  products: readonly T[],
  featuredSlugs: readonly string[],
  { isInStock }: Readonly<{ isInStock?: (product: T) => boolean }> = {},
): readonly T[] {
  const rank = new Map<string, number>();
  featuredSlugs.forEach((slug, index) => {
    if (!rank.has(slug)) rank.set(slug, index);
  });

  const pinFirst = (items: readonly T[]): readonly T[] => {
    if (rank.size === 0) return items;
    const pinned: T[] = [];
    const rest: T[] = [];
    for (const item of items) {
      (rank.has(item.slug) ? pinned : rest).push(item);
    }
    pinned.sort((a, b) => rank.get(a.slug)! - rank.get(b.slug)!);
    return [...pinned, ...rest];
  };

  if (!isInStock) return pinFirst(products);

  const inStock: T[] = [];
  const outOfStock: T[] = [];
  for (const product of products) {
    (isInStock(product) ? inStock : outOfStock).push(product);
  }
  if (outOfStock.length === 0) return pinFirst(products);
  return [...pinFirst(inStock), ...pinFirst(outOfStock)];
}

/** Editorial media, with anything that fails the trusted-URL contract dropped. */
export function resolveCollectionEditorial(
  input: Readonly<{
    description: string;
    heroImageUrl: string | null;
    heroImageMobileUrl?: string | null;
    galleryImageUrls: readonly string[];
    videoSrcUrl: string | null;
    videoPosterUrl: string | null;
  }>,
): CollectionEditorial {
  const src = parseTrustedProductVideoUrl(input.videoSrcUrl);

  return Object.freeze({
    story: input.description,
    heroImage: parseTrustedProductImageUrl(input.heroImageUrl),
    heroImageMobile: parseTrustedProductImageUrl(input.heroImageMobileUrl),
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

/**
 * Promotional pricing collections ("BST Đồng Giá") do not render a full-bleed hero banner
 * on their detail pages so shoppers immediately see breadcrumbs, title, size filters, and products.
 * Their 16:9 banner cover remains active on the `/collections` index page.
 */
export function isDongGiaCollectionSlug(slug: string): boolean {
  return slug.includes("dong-gia");
}

export function buildCollectionViewModel(input: CollectionViewModelInput): CollectionViewModel {
  const editorialInput = isDongGiaCollectionSlug(input.slug)
    ? { ...input, heroImageUrl: null, heroImageMobileUrl: null }
    : input;

  const { size, sort } = input.discovery;
  const availability = input.discovery.availability ?? null;
  const href = (
    next: Partial<Readonly<{ size: string | null; sort: string; page: number; availability: "in-stock" | null }>>,
  ) =>
    input.hrefFor({
      size: next.size === undefined ? size : next.size,
      sort: next.sort ?? sort,
      page: next.page ?? 1,
      availability: next.availability === undefined ? availability : next.availability,
    });

  return Object.freeze({
    slug: input.slug,
    title: input.title,
    editorial: resolveCollectionEditorial(editorialInput),
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
    previousHref: input.hasPrevious ? href({ page: input.page - 1 }) : null,
    nextHref: input.hasNext ? href({ page: input.page + 1 }) : null,
    clearFilterHref: href({ size: null, availability: null }),
    filtered: size !== null || availability !== null,
    sortOptions: Object.freeze(
      input.sortChoices.map((choice) =>
        Object.freeze({
          value: choice.value,
          label: choice.label,
          href: href({ sort: choice.value }),
          active: sort === choice.value,
        }),
      ),
    ),
    sizeOptions: Object.freeze([
      Object.freeze({
        value: null,
        label: "Tất cả kích cỡ",
        href: href({ size: null }),
        active: size === null,
      }),
      ...input.sizes.map((option) =>
        Object.freeze({
          value: option,
          label: option,
          href: href({ size: option }),
          active: sameSize(size, option),
        }),
      ),
    ]),
    availabilityOption: Object.freeze({
      active: availability !== null,
      href: href({ availability: availability === null ? "in-stock" : null }),
    }),
  });
}
