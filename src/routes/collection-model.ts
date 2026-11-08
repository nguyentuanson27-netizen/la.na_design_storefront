import { buildCategoryDiscoveryHref, encodeCategoryCursor } from "../commerce/category-discovery-url.ts";
import { collectionListingPath } from "../commerce/collection-discovery-url.ts";
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
import { hasActivePlpFilters, type PlpFilterState } from "../components/headless/plp-filter-model.ts";
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

export type CollectionViewModel = Readonly<{
  slug: string;
  title: string;
  editorial: CollectionEditorial;
  /** The path every filter, sort and paging link is written against: `/collections/<slug>`. */
  basePath: string;
  cards: readonly Readonly<{ id: string; model: ProductCardModel }>[];
  /** Where this page's cards start in the tone cycle, so a page opened by its URL continues it. */
  toneOffset: number;
  totalCount: number;
  page: number;
  totalPages: number;
  hasNext: boolean;
  /** The crawlable next page, keeping every filter; `null` on the last page. */
  nextHref: string | null;
  /** What the infinite grid sends to load the next page; `null` on the last page. */
  nextCursor: string | null;
  /** The category listing's filter state, so the shared panel and grid read it unchanged. */
  filters: PlpFilterState;
  /** Whether a filter narrows the list (a sort alone does not), which decides the empty state's wording. */
  filtered: boolean;
  /** The sizes still selectable under the other filters, canonical spelling, in clothing order. */
  availableSizes: readonly string[];
  /** Whether the other filters leave any discounted product for the Sale toggle to find. */
  saleAvailable: boolean;
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
  saleAvailable: boolean;
  filters: PlpFilterState;
  totalCount: number;
  totalPages: number;
  page: number;
  hasNext: boolean;
  pageSize: number;
  pricingRule?: StorefrontPricingRule;
  selectEventBySlug: ReadonlyMap<string, TrackingEvent>;
}>;

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

/**
 * One page of a collection in the order it is shown: pins first and in-stock products ahead of
 * sold-out ones, but only in the merchandiser's own order. The route's first page and every page the
 * infinite grid loads after it go through this, so a page loaded by scrolling is ordered exactly like
 * the same page opened by its URL.
 */
export function orderCollectionPage<T extends Readonly<{ id: string; slug: string }>>(
  products: readonly T[],
  {
    featuredProductSlugs,
    merchandiserOrder,
    inStockProductIds,
  }: Readonly<{
    featuredProductSlugs: readonly string[];
    merchandiserOrder: boolean;
    inStockProductIds?: readonly string[] | null;
  }>,
): readonly T[] {
  if (!merchandiserOrder) return products;
  const inStock = inStockProductIds ? new Set(inStockProductIds) : null;
  return orderByFeaturedSlugs(
    products,
    featuredProductSlugs,
    inStock ? { isInStock: (product) => inStock.has(product.id) } : {},
  );
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

  const basePath = collectionListingPath(input.slug);
  const { filters } = input;
  const nextPage = input.page + 1;

  return Object.freeze({
    slug: input.slug,
    title: input.title,
    editorial: resolveCollectionEditorial(editorialInput),
    basePath,
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
    hasNext: input.hasNext,
    nextHref: input.hasNext ? buildCategoryDiscoveryHref(basePath, filters, nextPage) : null,
    nextCursor: input.hasNext ? encodeCategoryCursor(nextPage) : null,
    filters: Object.freeze({ ...filters }),
    filtered: hasActivePlpFilters({ ...filters, sort: "default" }),
    availableSizes: Object.freeze([...input.sizes]),
    saleAvailable: input.saleAvailable,
  });
}
