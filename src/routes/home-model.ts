import { CATEGORY_NAVIGATION, type CategoryDefinition } from "../brand/category.config.ts";
import { parseTrustedProductImageUrl, type StorefrontProductMedia } from "../commerce/product-media.ts";
import type { StorefrontDiscoveryQuery } from "../commerce/storefront-discovery.ts";
import { MAX_STOREFRONT_PROMOTION_REFRESH_MS } from "../commerce/storefront-promotion-freshness.ts";
import type {
  StorefrontPricingRule,
  StorefrontVariantFacts,
  StorefrontProductCapacity,
} from "../commerce/storefront-product.ts";
import {
  buildProductCardModel,
  type ProductCardModel,
} from "../components/headless/build-product-card-model.ts";
import {
  FEEDBACK_PATH,
  parseConfiguredCopy,
  parseHomepageImageSrc,
  type FeedbackContent,
  type FeedbackImage,
} from "../content/homepage-content.ts";
import type { CollectionPromoRowConfig, HomepageConfig } from "../content/homepage.config.ts";
import type { TrackingEvent } from "../tracking/commerce-events.ts";
import { orderByFeaturedSlugs } from "./collection-model.ts";
import {
  COLLECTION_PAGE_SIZE,
  buildCollectionFirstPageDiscovery,
  isCollectionRouteReachable,
} from "./collection-first-page.ts";

/**
 * Everything the home route decides, as pure functions.
 *
 * The loader fetches; this turns what came back into what the page renders. It is separate from
 * `home.ts` because that file reaches the catalog runtime and `next/server`, neither of which the
 * domain test runner can load.
 *
 * `docs/specs/homepage-editorial-refresh.md` fixes the order after the (unchanged) hero:
 *
 *   SPECIAL DEALS → promo row A → YOUR NEXT FAVOURITE → promo row B → Feedback → Footer
 *
 * Every section is fail-closed. A section whose data is pending, incomplete or inconsistent is
 * `null` here and absent from the page -- never a partial grid, a placeholder image or a CTA to a
 * collection the public route would 404.
 *
 * No pricing is decided here: every card comes from `buildProductCardModel`, which is where the
 * money rules live.
 */

/** The fields of a catalog product this route actually reads. */
export type HomeProduct = Readonly<{
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

export type HomeCard = Readonly<{ id: string; model: ProductCardModel }>;

type CardGridInput = Readonly<{
  products: readonly HomeProduct[];
  pricingRule?: StorefrontPricingRule;
  /** Prebuilt on the server, so a click handler never reassembles a payload from the DOM. */
  selectEventBySlug: ReadonlyMap<string, TrackingEvent>;
}>;

/**
 * How long the homepage may wait before asking the server for prices again.
 *
 * Each priced grid resolves its own next campaign boundary against the request instant, and the page
 * takes the soonest one. The refreshed homepage has exactly one priced grid (SPECIAL DEALS), so the
 * removed grids no longer contribute a window -- but the rule stays general, because a stale window
 * from any priced grid is exactly the staleness the freshness contract exists to prevent.
 *
 * An empty page (no priced grids at all) still revalidates within the reviewed ceiling rather than
 * never, and a window that is not a usable number is ignored instead of poisoning the minimum.
 */
export function resolveHomeRefreshAfterMs(refreshWindows: readonly number[]): number {
  let soonest = MAX_STOREFRONT_PROMOTION_REFRESH_MS;

  for (const window of refreshWindows) {
    if (!Number.isFinite(window) || window < 0) continue;
    if (window < soonest) soonest = window;
  }

  return soonest;
}

export function buildHomeCards({
  products,
  pricingRule,
  selectEventBySlug,
}: CardGridInput): readonly HomeCard[] {
  return Object.freeze(
    products.map((product) =>
      Object.freeze({
        id: product.id,
        model: buildProductCardModel({
          slug: product.slug,
          name: product.name,
          media: product.media,
          variants: product.variants,
          productCapacity: product.productCapacity,
          pricingRule,
          selectEvent: selectEventBySlug.get(product.slug) ?? null,
        }),
      }),
    ),
  );
}

/* ------------------------------------------------------------------ collections */

/** What a homepage CTA needs from `readPublishedCollection()`. */
export type HomeCollectionFacts = Readonly<{
  slug: string;
  title: string;
  description: string | null;
  featuredProductSlugs: readonly string[];
}>;

function collectionHref(slug: string): string {
  return `/collections/${slug}`;
}

/* ---------------------------------------------------------------- SPECIAL DEALS */

/** Spec §7.2: one fixed four-product section. Not a campaign framework, not a configurable count. */
export const SPECIAL_DEALS_SIZE = 4;

/**
 * Spec §7.2: the section's approved title. A constant rather than config, because the spec fixes
 * this role -- config owns only its supporting copy and source collection.
 */
export const SPECIAL_DEALS_TITLE = "SPECIAL DEALS";

/** A product as the catalog read returns it: the card facts plus its collection membership. */
export type SpecialDealsProduct = HomeProduct &
  Readonly<{
    /**
     * The product's published collections, as `toStorefrontProduct` projects them from
     * `ProductContent.collectionSlugs` -- the same column the public collection listing filters on.
     */
    collections: readonly Readonly<{ slug: string }>[];
  }>;

export type SpecialDealsGrid<P extends SpecialDealsProduct> = Readonly<{
  products: readonly P[];
  pricingRule?: StorefrontPricingRule;
  refreshAfterMs: number;
}>;

export type SpecialDealsSource = "manual" | "collection";

export type SpecialDealsSelection<P extends SpecialDealsProduct> = Readonly<{
  source: SpecialDealsSource;
  collection: Readonly<{ slug: string; title: string; href: string }>;
  /** Exactly `SPECIAL_DEALS_SIZE`, in render order. */
  products: readonly P[];
  pricingRule?: StorefrontPricingRule;
  refreshAfterMs: number;
}>;

export type SpecialDealsReads<P extends SpecialDealsProduct> = Readonly<{
  sourceCollectionSlug: string | null;
  /** `readPublishedCollection()`: the published definition, or `null`. */
  readCollection: (slug: string) => Promise<HomeCollectionFacts | null>;
  /** The existing ordered `HomepageFeaturedProduct` authority, visible products only. */
  listManual: () => Promise<SpecialDealsGrid<P>>;
  /** The public collection route's own discovery read. */
  listCollectionPage: (
    input: Readonly<{ discovery: StorefrontDiscoveryQuery; pageSize: number }>,
  ) => Promise<SpecialDealsGrid<P>>;
}>;

/**
 * Whether a product is a member of a collection, by the public listing's own truth.
 *
 * `collections` is the product's `ProductContent.collectionSlugs` narrowed to published definitions;
 * `/collections/<slug>` lists exactly the products whose `collectionSlugs` contain a published
 * `<slug>`. A category, a homepage config entry or a visual placement is not membership.
 */
export function isCollectionMember(
  product: Readonly<{ collections: readonly Readonly<{ slug: string }>[] }>,
  collectionSlug: string,
): boolean {
  return product.collections.some((collection) => collection.slug === collectionSlug);
}

/**
 * The manual SPECIAL DEALS set, or `null` when the merchandising state is inconsistent.
 *
 * Only reached when the manual authority is non-empty. Its first four products are the intended set,
 * and all four must belong to the source collection. Anything else -- fewer than four, or one from
 * another collection -- omits the section: it is not filtered, topped up with collection products or
 * quietly replaced by the fallback, because each of those publishes a set nobody chose.
 */
export function selectManualSpecialDeals<P extends SpecialDealsProduct>(
  manual: readonly P[],
  collectionSlug: string,
): readonly P[] | null {
  const intended = manual.slice(0, SPECIAL_DEALS_SIZE);
  if (intended.length !== SPECIAL_DEALS_SIZE) return null;
  if (!intended.every((product) => isCollectionMember(product, collectionSlug))) return null;
  return Object.freeze(intended);
}

/**
 * The collection fallback: the public collection page's own visible first four.
 *
 * `pageProducts` is the route's unfiltered first page (its full `COLLECTION_PAGE_SIZE` window, in
 * its default order). The route pins `featuredProductSlugs` within that page and nothing else, so
 * this does the same and only then takes four. Taking four *before* pinning -- or reading a
 * four-product page -- would drop a pinned product that the collection page shows first.
 */
export function selectCollectionFallbackSpecialDeals<P extends Readonly<{ slug: string }>>(
  pageProducts: readonly P[],
  featuredProductSlugs: readonly string[],
): readonly P[] | null {
  const visible = orderByFeaturedSlugs(pageProducts, featuredProductSlugs).slice(
    0,
    SPECIAL_DEALS_SIZE,
  );
  return visible.length === SPECIAL_DEALS_SIZE ? Object.freeze([...visible]) : null;
}

/**
 * SPECIAL DEALS, resolved through the existing authorities in the spec's priority order.
 *
 * 1. No configured source collection, or one the public route would 404: omit. The section's
 *    `Xem thêm` must land on a page, and its membership rule needs a real collection.
 * 2. `HomepageFeaturedProduct` non-empty: manual mode, validated by `selectManualSpecialDeals`.
 *    The fallback is never read in this mode.
 * 3. Otherwise: the collection route's unfiltered first page, pinned, then four.
 */
export async function loadSpecialDeals<P extends SpecialDealsProduct>(
  reads: SpecialDealsReads<P>,
): Promise<SpecialDealsSelection<P> | null> {
  const slug = reads.sourceCollectionSlug;
  if (slug === null) return null;

  const [collection, manual] = await Promise.all([reads.readCollection(slug), reads.listManual()]);
  if (!isCollectionRouteReachable(collection)) return null;

  const destination = Object.freeze({
    slug: collection.slug,
    title: collection.title,
    href: collectionHref(collection.slug),
  });

  if (manual.products.length > 0) {
    const products = selectManualSpecialDeals(manual.products, collection.slug);
    if (products === null) return null;
    return Object.freeze({
      source: "manual",
      collection: destination,
      products,
      pricingRule: manual.pricingRule,
      refreshAfterMs: manual.refreshAfterMs,
    });
  }

  const page = await reads.listCollectionPage({
    discovery: buildCollectionFirstPageDiscovery(collection.slug),
    pageSize: COLLECTION_PAGE_SIZE,
  });
  const products = selectCollectionFallbackSpecialDeals(
    page.products,
    collection.featuredProductSlugs,
  );
  if (products === null) return null;

  return Object.freeze({
    source: "collection",
    collection: destination,
    products,
    pricingRule: page.pricingRule,
    refreshAfterMs: page.refreshAfterMs,
  });
}

/* ------------------------------------------------------------ collection promos */

export type HomePromoTile = Readonly<{
  collectionSlug: string;
  /** The collection's canonical `CollectionDefinition.title`. There is no promo title field. */
  title: string;
  href: string;
  imageSrc: string;
  ctaLabel: string;
}>;

export type HomePromoRow = readonly [HomePromoTile, HomePromoTile];

/** Every collection slug a promo config maps, so the loader can read each once. */
export function listPromoCollectionSlugs(rows: HomepageConfig["promoRows"]): readonly string[] {
  const slugs = new Set<string>();
  for (const row of rows) {
    for (const slot of row) if (slot) slugs.add(slot.collectionSlug);
  }
  return [...slugs];
}

/**
 * One two-tile promo row, or `null`.
 *
 * Both-or-neither: the row's design is two 50% images, and a half row is a layout nobody approved.
 * A slot fails when it is unmapped, its image is not a stable local path or trusted URL, its CTA is
 * blank, or its collection is not route-reachable -- the same gate `/collections/<slug>` applies,
 * because `isPublished` alone still 404s without a description. Two slots pointing at one collection
 * are not "2 collections" either.
 */
export function resolveCollectionPromoRow(
  row: CollectionPromoRowConfig,
  collections: ReadonlyMap<string, HomeCollectionFacts | null>,
): HomePromoRow | null {
  const [first, second] = row;
  if (!first || !second || first.collectionSlug === second.collectionSlug) return null;

  const tiles: HomePromoTile[] = [];
  for (const slot of [first, second]) {
    const collection = collections.get(slot.collectionSlug) ?? null;
    if (!isCollectionRouteReachable(collection)) return null;
    const imageSrc = parseHomepageImageSrc(slot.imageSrc);
    const ctaLabel = parseConfiguredCopy(slot.ctaLabel);
    if (imageSrc === null || ctaLabel === null) return null;
    tiles.push(
      Object.freeze({
        collectionSlug: collection.slug,
        title: collection.title,
        href: collectionHref(collection.slug),
        imageSrc,
        ctaLabel,
      }),
    );
  }

  return Object.freeze([tiles[0]!, tiles[1]!] as const);
}

/* ----------------------------------------------------------- YOUR NEXT FAVOURITE */

/** Spec §7.4: exactly these four canonical categories, in this order. */
export const NEXT_FAVOURITE_CATEGORY_KEYS = ["aoDai", "vayDam", "setDo", "phuKien"] as const;

export type HomeCategoryTile = Readonly<{
  key: string;
  label: string;
  href: string;
  imageUrl: string;
}>;

/**
 * The four category tiles, or `null`.
 *
 * Label and href come from `CATEGORY_NAVIGATION`; the image is the stored
 * `CategoryEditorialMedia.heroImageUrl`, re-validated here against the trusted-media contract. The
 * section is all-or-nothing: one missing or rejected image omits all four tiles rather than
 * publishing three, an image-less tile or a borrowed photograph.
 */
export function resolveCategoryDiscovery(
  storedHeroMedia: ReadonlyMap<string, string>,
  categories: readonly CategoryDefinition[] = CATEGORY_NAVIGATION,
): readonly HomeCategoryTile[] | null {
  const tiles: HomeCategoryTile[] = [];
  for (const key of NEXT_FAVOURITE_CATEGORY_KEYS) {
    const category = categories.find((candidate) => candidate.key === key);
    const imageUrl = parseTrustedProductImageUrl(storedHeroMedia.get(key));
    if (!category || imageUrl === null) return null;
    tiles.push(Object.freeze({ key, label: category.label, href: category.href, imageUrl }));
  }
  return Object.freeze(tiles);
}

/* ------------------------------------------------------------------- view model */

export type HomeSpecialDealsSection = Readonly<{
  title: string;
  supportingCopy: string | null;
  ctaLabel: string;
  href: string;
  collectionTitle: string;
  cards: readonly HomeCard[];
}>;

export type HomeCategoryDiscoverySection = Readonly<{
  title: string;
  description: string | null;
  tiles: readonly HomeCategoryTile[];
}>;

export type HomeFeedbackSection = Readonly<{
  title: string;
  ctaLabel: string;
  href: string;
  images: readonly FeedbackImage[];
}>;

/**
 * The refreshed homepage below the hero. Each field is one section, in page order, and `null` means
 * that section is omitted. The retired sections (new arrivals, lead Áo dài editorial, Featured grid,
 * two-block category editorial, collection navigation, service strip, brand story) have no field.
 */
export type HomeViewModel = Readonly<{
  specialDeals: HomeSpecialDealsSection | null;
  promoRowA: HomePromoRow | null;
  categoryDiscovery: HomeCategoryDiscoverySection | null;
  promoRowB: HomePromoRow | null;
  feedback: HomeFeedbackSection | null;
}>;

export type HomeViewModelInput = Readonly<{
  config: HomepageConfig;
  specialDeals: Readonly<{
    selection: SpecialDealsSelection<SpecialDealsProduct> | null;
    selectEventBySlug: ReadonlyMap<string, TrackingEvent>;
  }>;
  promoRows: readonly [HomePromoRow | null, HomePromoRow | null];
  categoryTiles: readonly HomeCategoryTile[] | null;
  feedback: FeedbackContent | null;
}>;

export function buildHomeViewModel({
  config,
  specialDeals,
  promoRows,
  categoryTiles,
  feedback,
}: HomeViewModelInput): HomeViewModel {
  const { selection } = specialDeals;
  const categoryTitle = parseConfiguredCopy(config.categoryDiscovery.title);

  return Object.freeze({
    specialDeals: selection
      ? Object.freeze({
          title: SPECIAL_DEALS_TITLE,
          supportingCopy: parseConfiguredCopy(config.specialDeals.supportingCopy),
          ctaLabel: config.specialDeals.ctaLabel,
          href: selection.collection.href,
          collectionTitle: selection.collection.title,
          cards: buildHomeCards({
            products: selection.products,
            pricingRule: selection.pricingRule,
            selectEventBySlug: specialDeals.selectEventBySlug,
          }),
        })
      : null,
    promoRowA: promoRows[0],
    categoryDiscovery:
      categoryTiles && categoryTitle
        ? Object.freeze({
            title: categoryTitle,
            description: parseConfiguredCopy(config.categoryDiscovery.description),
            tiles: categoryTiles,
          })
        : null,
    promoRowB: promoRows[1],
    feedback: feedback
      ? Object.freeze({
          title: feedback.title,
          ctaLabel: feedback.ctaLabel,
          href: FEEDBACK_PATH,
          images: feedback.images,
        })
      : null,
  });
}
