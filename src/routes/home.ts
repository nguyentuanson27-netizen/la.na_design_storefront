import { connection } from "next/server";

import { createCollectionDefinitionRepository } from "@/commerce/collection-definition-repository";
import { readGuestShippingPolicy } from "@/commerce/guest-shipping-policy";
import { parseTrustedProductImageUrl } from "@/commerce/product-media";
import {
  listConfiguredHomepageFeaturedWithPricing,
  listConfiguredHomepageNewArrivals,
  readConfiguredCategoryHeroMedia,
} from "@/commerce/storefront-catalog-runtime";
import { MAX_STOREFRONT_PROMOTION_REFRESH_MS } from "@/commerce/storefront-promotion-freshness";
import { buildProductListTracking } from "@/components/analytics/product-list-tracking";
import { buildPublicBrandFacts } from "@/content/public-brand-facts";
import { prisma } from "@/db/prisma";
import { PancakeConfigError } from "@/integrations/pancake/config";
import { sealRoute, type RouteHandle } from "./core.tsx";
import { buildHomeHeroSlides, type HomeHeroSlide } from "./home-hero.ts";
import {
  buildHomeViewModel,
  resolveHomeRefreshAfterMs,
  type HomeViewModel,
} from "./home-model.ts";

/**
 * The home route's loader: every fetch, the tracking event and the refresh window, in one place.
 *
 * The page is left with markup. That is the point of the split -- promotion refresh, the commerce
 * event and structured data are the things a page author forgets, so they are sealed into the
 * handle here and the shell mounts them unconditionally.
 */

const collectionRepository = createCollectionDefinitionRepository(prisma);

/** Master spec §18: four per row on desktop, two on mobile. Two full rows. */
const NEW_ARRIVALS_LIMIT = 8;

/** The categories whose editorial media the homepage renders (§19, §21). */
const EDITORIAL_CATEGORY_KEYS = ["aoDai", "setDo", "vayDam"] as const;

export type HomeRouteData = HomeViewModel &
  Readonly<{
    heroSlides: readonly HomeHeroSlide[];
    categoryHeroMedia: ReadonlyMap<string, string>;
    brandFacts: ReturnType<typeof buildPublicBrandFacts>;
  }>;

export type HomeRouteProps = Readonly<{
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}>;

/**
 * The hero's source, and the only place that knows what a campaign slide is made of today.
 *
 * Master spec §17 wants campaign slides, and no campaign owner is approved yet. Published
 * collections that carry hero media are the one real admin-owned pair of image and destination the
 * site already has, and `homepagePosition` already orders them, so they stand in as the source
 * rather than a hardcoded slide or a placeholder. A collection with no hero image contributes
 * nothing, which is why the hero is absent today rather than invented.
 *
 * When a campaign owner is approved, this function is what changes. `buildHomeHeroSlides`, the
 * component and their tests are written against `HomeHeroSlideCandidate`, not against collections.
 */
function toHeroCandidates(
  collections: readonly Readonly<{ slug: string; title: string; heroImageUrl: string | null }>[],
) {
  return collections.map((collection) => ({
    imageUrl: collection.heroImageUrl,
    href: `/collections/${collection.slug}`,
    label: collection.title,
  }));
}

// A grid that could not be read prices nothing, so it has no campaign boundary of its own and
// reports the reviewed ceiling rather than 0 -- an unreadable grid must not pin the whole page to
// an immediate refresh.
const emptyGrid = {
  products: [],
  pricingRule: undefined,
  refreshAfterMs: MAX_STOREFRONT_PROMOTION_REFRESH_MS,
} as const;

async function loadNewArrivals(now: Date) {
  try {
    return await listConfiguredHomepageNewArrivals(NEW_ARRIVALS_LIMIT, now);
  } catch (error) {
    // An unconfigured Pancake shop is a deployment state, not a broken page: the homepage still
    // renders its brand copy, editorial blocks and collection navigation with no merchandising.
    if (error instanceof PancakeConfigError) return emptyGrid;
    throw error;
  }
}

async function loadFeatured(now: Date) {
  try {
    return await listConfiguredHomepageFeaturedWithPricing(now);
  } catch (error) {
    if (error instanceof PancakeConfigError) return emptyGrid;
    throw error;
  }
}

export async function loadHomeRoute(): Promise<RouteHandle<HomeRouteData>> {
  await connection();
  // One instant for the whole request, so counting, ordering and card pricing cannot disagree.
  const requestNow = new Date();

  const [newArrivals, featured, collections, storedCategoryMedia] = await Promise.all([
    loadNewArrivals(requestNow),
    loadFeatured(requestNow),
    collectionRepository.listHomepageMerchandising(),
    readConfiguredCategoryHeroMedia([...EDITORIAL_CATEGORY_KEYS]),
  ]);

  // Validated here rather than in the page: an untrusted origin must fail the same media contract
  // every other storefront image goes through, and the page layer renders what it is handed. A
  // rejected URL leaves no entry, which is what makes that block omit itself.
  const categoryHeroMedia = new Map<string, string>();
  for (const [categoryKey, rawUrl] of storedCategoryMedia) {
    const trusted = parseTrustedProductImageUrl(rawUrl);
    if (trusted !== null) categoryHeroMedia.set(categoryKey, trusted);
  }

  const newArrivalsTracking = buildProductListTracking({
    products: newArrivals.products,
    list: { listId: "homepage-new-arrivals", listName: "Hàng mới về" },
    pricingRule: newArrivals.pricingRule,
  });

  // Featured gets its own select events, so a click from that grid is attributed to the product a
  // shopper actually clicked. Its list *impression* is not reported: the route contract seals one
  // tracking event, and reporting two `view_item_list` events needs a change to that contract
  // rather than a second event smuggled through this page.
  const featuredTracking = buildProductListTracking({
    products: featured.products,
    list: { listId: "homepage-featured", listName: "Sản phẩm nổi bật" },
    pricingRule: featured.pricingRule,
  });

  return sealRoute({
    data: {
      ...buildHomeViewModel({
        newArrivals: {
          products: newArrivals.products,
          pricingRule: newArrivals.pricingRule,
          selectEventBySlug: newArrivalsTracking.selectEventBySlug,
        },
        featured: {
          products: featured.products,
          pricingRule: featured.pricingRule,
          selectEventBySlug: featuredTracking.selectEventBySlug,
        },
        collections,
      }),
      heroSlides: buildHomeHeroSlides(toHeroCandidates(collections)),
      categoryHeroMedia,
      brandFacts: buildPublicBrandFacts(readGuestShippingPolicy()),
    },
    // Both grids are priced, so both carry a boundary. The soonest one governs the page: sealing
    // only new arrivals would let a Featured campaign start or end while the page holds the old
    // price until the 60s ceiling.
    refreshAfterMs: resolveHomeRefreshAfterMs([newArrivals.refreshAfterMs, featured.refreshAfterMs]),
    trackingEvent: newArrivalsTracking.listEvent,
    // The homepage publishes no JSON-LD of its own; the root layout carries the site graph.
    structuredData: [],
    pixelEvents: [],
  });
}
