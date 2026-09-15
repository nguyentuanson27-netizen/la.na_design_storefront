import { connection } from "next/server";

import {
  listConfiguredStorefrontProducts,
  resolveStorefrontPromotionForProducts,
} from "@/commerce/storefront-catalog-runtime";
import { buildProductListTracking } from "@/components/analytics/product-list-tracking";
import { PancakeConfigError } from "@/integrations/pancake/config";

import { sealRoute, type RouteHandle } from "./core.tsx";
import { selectEditorialPanels, type EditorialPanel } from "./editorial-panels.ts";
import { buildProductCardModel, type ProductCardModel } from "@/components/headless/build-product-card-model";

/** The lookbook's loader: the edit it merchandises and the two chapter photographs. */

const LOOKBOOK_PRODUCT_COUNT = 4;

export type LookbookRouteProps = Readonly<{
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}>;

export type LookbookRouteData = Readonly<{
  chapterOne: EditorialPanel;
  chapterTwo: EditorialPanel;
  cards: readonly Readonly<{ id: string; model: ProductCardModel }>[];
}>;

async function loadEdit(now: Date) {
  try {
    const products = await listConfiguredStorefrontProducts(LOOKBOOK_PRODUCT_COUNT);
    return { products, ...(await resolveStorefrontPromotionForProducts({ products, now })) };
  } catch (error) {
    // An unconfigured Pancake shop is a deployment state: the editorial still reads.
    if (error instanceof PancakeConfigError) {
      return { products: [], pricingRule: undefined, refreshAfterMs: 60_000 };
    }
    throw error;
  }
}

export async function loadLookbookRoute(): Promise<RouteHandle<LookbookRouteData>> {
  await connection();
  const requestNow = new Date();
  const { products, pricingRule, refreshAfterMs } = await loadEdit(requestNow);

  const listTracking = buildProductListTracking({
    products,
    list: { listId: "lookbook-edit", listName: "Lookbook edit" },
    pricingRule,
  });

  const [chapterOne, chapterTwo] = selectEditorialPanels(products, 2);

  return sealRoute({
    data: {
      chapterOne: chapterOne ?? null,
      chapterTwo: chapterTwo ?? null,
      cards: Object.freeze(
        products.map((product) =>
          Object.freeze({
            id: product.id,
            model: buildProductCardModel({
              slug: product.slug,
              name: product.name,
              media: product.media,
              variants: product.variants,
              pricingRule,
              selectEvent: listTracking.selectEventBySlug.get(product.slug) ?? null,
            }),
          }),
        ),
      ),
    },
    refreshAfterMs,
    trackingEvent: listTracking.listEvent,
    structuredData: [],
    pixelEvents: [],
  });
}
