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
  Readonly<{ brandFacts: ReturnType<typeof buildPublicBrandFacts> }>;

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
      brandFacts: buildPublicBrandFacts(readGuestShippingPolicy()),
    },
    refreshAfterMs,
    trackingEvent: listTracking.listEvent,
    // The homepage publishes no JSON-LD of its own; the root layout carries the site graph.
    structuredData: [],
  });
}
