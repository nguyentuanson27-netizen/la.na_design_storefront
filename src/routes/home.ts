import { connection } from "next/server";

import { createCollectionDefinitionRepository } from "@/commerce/collection-definition-repository";
import { readGuestShippingPolicy } from "@/commerce/guest-shipping-policy";
import { listConfiguredStorefrontDiscoveryPage } from "@/commerce/storefront-catalog-runtime";
import { parseStorefrontDiscoverySearchParams } from "@/commerce/storefront-discovery";
import { buildProductListTracking } from "@/components/analytics/product-list-tracking";
import { buildPublicBrandFacts } from "@/content/public-brand-facts";
import { prisma } from "@/db/prisma";
import { PancakeConfigError } from "@/integrations/pancake/config";
import { sealRoute, type RouteHandle } from "./core.tsx";
import { buildHomeHeroSlides, type HomeHeroSlide } from "./home-hero.ts";
import { buildHomeViewModel, type HomeViewModel } from "./home-model.ts";

/**
 * The home route's loader: every fetch, the tracking event and the refresh window, in one place.
 *
 * The page is left with markup. That is the point of the split -- promotion refresh, the commerce
 * event and structured data are the things a page author forgets, so they are sealed into the
 * handle here and the shell mounts them unconditionally.
 */

const collectionRepository = createCollectionDefinitionRepository(prisma);

export type HomeRouteData = HomeViewModel &
  Readonly<{
    heroSlides: readonly HomeHeroSlide[];
    brandFacts: ReturnType<typeof buildPublicBrandFacts>;
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

export type HomeRouteProps = Readonly<{
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}>;

async function loadEdit(now: Date) {
  try {
    const page = await listConfiguredStorefrontDiscoveryPage({
      discovery: parseStorefrontDiscoverySearchParams({}),
      pageSize: 20,
      now,
    });
    return { products: page.products, pricingRule: page.pricingRule, refreshAfterMs: page.refreshAfterMs };
  } catch (error) {
    // An unconfigured Pancake shop is a deployment state, not a broken page: the homepage still
    // renders its brand copy and collection navigation with no merchandising.
    if (error instanceof PancakeConfigError) {
      return { products: [], pricingRule: undefined, refreshAfterMs: 60_000 };
    }
    throw error;
  }
}

export async function loadHomeRoute(): Promise<RouteHandle<HomeRouteData>> {
  await connection();
  // One instant for the whole request, so counting, ordering and card pricing cannot disagree.
  const requestNow = new Date();

  const [{ products, pricingRule, refreshAfterMs }, collections] = await Promise.all([
    loadEdit(requestNow),
    collectionRepository.listHomepageMerchandising(),
  ]);

  const listTracking = buildProductListTracking({
    products,
    list: { listId: "homepage-edit", listName: "Tuyển chọn" },
    pricingRule,
  });

  return sealRoute({
    data: {
      ...buildHomeViewModel({
        products,
        pricingRule,
        collections,
        selectEventBySlug: listTracking.selectEventBySlug,
      }),
      heroSlides: buildHomeHeroSlides(toHeroCandidates(collections)),
      brandFacts: buildPublicBrandFacts(readGuestShippingPolicy()),
    },
    refreshAfterMs,
    trackingEvent: listTracking.listEvent,
    // The homepage publishes no JSON-LD of its own; the root layout carries the site graph.
    structuredData: [],
    pixelEvents: [],
  });
}
