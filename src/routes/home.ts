import { connection } from "next/server";

import { createCollectionDefinitionRepository } from "@/commerce/collection-definition-repository";
import {
  listConfiguredHomepageFeaturedWithPricing,
  listConfiguredStorefrontDiscoveryPage,
  readConfiguredCategoryHeroMedia,
} from "@/commerce/storefront-catalog-runtime";
import { buildProductListTracking } from "@/components/analytics/product-list-tracking";
import { readFeedbackContent } from "@/content/homepage-content";
import { HOMEPAGE_CONFIG } from "@/content/homepage.config";
import { prisma } from "@/db/prisma";
import { PancakeConfigError } from "@/integrations/pancake/config";
import { sealRoute, type RouteHandle } from "./core.tsx";
import { buildHomeHeroSlides, type HomeHeroSlide } from "./home-hero.ts";
import {
  NEXT_FAVOURITE_CATEGORY_KEYS,
  buildHomeViewModel,
  listPromoCollectionSlugs,
  loadSpecialDeals,
  resolveCategoryDiscovery,
  resolveCollectionPromoRow,
  resolveHomeRefreshAfterMs,
  type HomeCollectionFacts,
  type HomeViewModel,
} from "./home-model.ts";
import { readPublishedCollection } from "./metadata/collection.ts";

/**
 * The home route's loader: every fetch, the tracking event and the refresh window, in one place.
 *
 * The page is left with markup. That is the point of the split -- promotion refresh, the commerce
 * event and structured data are the things a page author forgets, so they are sealed into the
 * handle here and the shell mounts them unconditionally.
 *
 * What each section is allowed to show is decided in `home-model.ts`; this file only supplies the
 * existing authorities it reads: `HomepageFeaturedProduct`, the public collection route's own reads,
 * `CategoryEditorialMedia` and the repository homepage config.
 */

const collectionRepository = createCollectionDefinitionRepository(prisma);

/** One stable analytics identity for the section, whatever its supporting copy says (§7.2). */
const SPECIAL_DEALS_LIST = { listId: "homepage-special-deals", listName: "SPECIAL DEALS" } as const;

export type HomeRouteData = HomeViewModel &
  Readonly<{
    heroSlides: readonly HomeHeroSlide[];
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

async function loadSpecialDealsSection(now: Date) {
  try {
    return await loadSpecialDeals({
      sourceCollectionSlug: HOMEPAGE_CONFIG.specialDeals.sourceCollectionSlug,
      readCollection: readPublishedCollection,
      listManual: () => listConfiguredHomepageFeaturedWithPricing(now),
      // The public collection route's own read, with the discovery state and page size it passes.
      listCollectionPage: ({ discovery, pageSize }) =>
        listConfiguredStorefrontDiscoveryPage({ discovery, pageSize, now }),
    });
  } catch (error) {
    // An unconfigured Pancake shop is a deployment state, not a broken page: the section omits
    // itself and the rest of the homepage still renders.
    if (error instanceof PancakeConfigError) return null;
    throw error;
  }
}

async function loadPromoCollections(): Promise<ReadonlyMap<string, HomeCollectionFacts | null>> {
  const slugs = listPromoCollectionSlugs(HOMEPAGE_CONFIG.promoRows);
  const collections = await Promise.all(slugs.map((slug) => readPublishedCollection(slug)));
  return new Map(slugs.map((slug, index) => [slug, collections[index] ?? null]));
}

export async function loadHomeRoute(): Promise<RouteHandle<HomeRouteData>> {
  await connection();
  // One instant for the whole request, so counting, ordering and card pricing cannot disagree.
  const requestNow = new Date();

  const [specialDeals, heroCollections, promoCollections, storedCategoryMedia] = await Promise.all([
    loadSpecialDealsSection(requestNow),
    collectionRepository.listHomepageMerchandising(),
    loadPromoCollections(),
    readConfiguredCategoryHeroMedia([...NEXT_FAVOURITE_CATEGORY_KEYS]),
  ]);

  // Built from the exact four products the section renders, in render order, so impression and
  // select indices describe what the shopper sees.
  const specialDealsTracking = buildProductListTracking({
    products: specialDeals?.products ?? [],
    list: SPECIAL_DEALS_LIST,
    pricingRule: specialDeals?.pricingRule,
  });

  return sealRoute({
    data: {
      ...buildHomeViewModel({
        config: HOMEPAGE_CONFIG,
        specialDeals: {
          selection: specialDeals,
          selectEventBySlug: specialDealsTracking.selectEventBySlug,
        },
        promoRows: [
          resolveCollectionPromoRow(HOMEPAGE_CONFIG.promoRows[0], promoCollections),
          resolveCollectionPromoRow(HOMEPAGE_CONFIG.promoRows[1], promoCollections),
        ],
        categoryTiles: resolveCategoryDiscovery(storedCategoryMedia),
        feedback: readFeedbackContent(),
      }),
      heroSlides: buildHomeHeroSlides(toHeroCandidates(heroCollections)),
    },
    // SPECIAL DEALS is the page's only priced grid, so its window is the page's window; the hero
    // prices nothing. With no section the page still revalidates within the reviewed ceiling.
    refreshAfterMs: resolveHomeRefreshAfterMs(
      specialDeals ? [specialDeals.refreshAfterMs] : [],
    ),
    trackingEvent: specialDealsTracking.listEvent,
    // The homepage publishes no JSON-LD of its own; the root layout carries the site graph.
    structuredData: [],
    pixelEvents: [],
  });
}
