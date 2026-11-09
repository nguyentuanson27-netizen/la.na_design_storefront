"use server";

import {
  buildProductListTracking,
} from "../components/analytics/product-list-tracking.ts";
import {
  buildProductCardModel,
  type ProductCardModel,
} from "../components/headless/build-product-card-model.ts";
import { SHOP_TITLE } from "../routes/metadata/shop.ts";
import { SHOP_PAGE_SIZE } from "../routes/shop-model.ts";
import type { TrackingEvent } from "../tracking/commerce-events.ts";
import { localizeListing } from "./product-translation-runtime.ts";
import { listConfiguredStorefrontDiscoveryPage } from "./storefront-catalog-runtime.ts";
import {
  buildStorefrontDiscoveryHref,
  parseStorefrontDiscoverySearchParams,
  type StorefrontDiscoverySort,
} from "./storefront-discovery.ts";

/**
 * The next page of `/shop` for the infinite grid.
 *
 * It takes the facts the URL carries and parses them with the route's own parser, so a page loaded
 * by scrolling lists, orders and prices exactly what that page's crawlable URL does -- including the
 * free-text query and the collection, which the category filter state has no field for.
 */

export type ShopNextPageActionInput = {
  page: number;
  query?: string | null;
  collection?: string | null;
  color?: string | null;
  size?: string | null;
  availability?: "in-stock" | null;
  minPriceVnd?: number | null;
  maxPriceVnd?: number | null;
  sale?: boolean | null;
  /** `default` and `name-asc` are the same order here: the shop's own default is A-Z. */
  sort?: StorefrontDiscoverySort | "default";
};

export type ShopNextPageActionResult = {
  products: ProductCardModel[];
  page: number;
  totalPages: number;
  totalCount: number;
  hasNext: boolean;
  /** The shop pages by number only, so there is never a cursor to continue from. */
  nextCursor: null;
  nextHref: string | null;
  /** The `view_item_list` for exactly the products in this response; `null` when none is published. */
  listEvent: TrackingEvent | null;
};

const text = (value: string | null | undefined) => value ?? undefined;
const number = (value: number | null | undefined) =>
  value !== null && value !== undefined ? String(value) : undefined;

export async function loadShopNextPageAction(
  input: ShopNextPageActionInput,
): Promise<ShopNextPageActionResult> {
  if (typeof input?.page !== "number") throw new RangeError("Invalid shop page request");

  const discovery = parseStorefrontDiscoverySearchParams({
    q: text(input.query),
    collection: text(input.collection),
    color: text(input.color),
    size: text(input.size),
    availability: text(input.availability),
    minPrice: number(input.minPriceVnd),
    maxPrice: number(input.maxPriceVnd),
    sale: input.sale ? "true" : undefined,
    sort: input.sort && input.sort !== "default" ? input.sort : undefined,
    page: String(input.page),
  });

  // Names in the shopper's language, applied after the read as on the first page.
  const catalogPage = await localizeListing(
    await listConfiguredStorefrontDiscoveryPage({
      discovery,
      pageSize: SHOP_PAGE_SIZE,
      now: new Date(),
      // The same rule as the first page: under A-Z, what a shopper can buy leads.
      inStockFirst: discovery.sort === "name-asc",
    }),
  );
  // A page past the end is not an empty page, it is a URL that does not exist (the route 404s it).
  if (catalogPage.page > Math.max(catalogPage.totalPages, 1)) {
    throw new RangeError("Shop page is out of range");
  }

  const tracking = buildProductListTracking({
    products: catalogPage.products,
    list: { listId: "shop", listName: SHOP_TITLE },
    pricingRule: catalogPage.pricingRule,
    startIndex: (catalogPage.page - 1) * SHOP_PAGE_SIZE,
  });

  return {
    products: catalogPage.products.map((product) =>
      buildProductCardModel({
        slug: product.slug,
        name: product.name,
        media: product.media,
        variants: product.variants,
        productCapacity: product.productCapacity,
        flashSale: product.flashSale,
        pricingRule: catalogPage.pricingRule,
        selectEvent: tracking.selectEventBySlug.get(product.slug) ?? null,
      }),
    ),
    page: catalogPage.page,
    totalPages: catalogPage.totalPages,
    totalCount: catalogPage.totalCount,
    hasNext: catalogPage.hasNext,
    nextCursor: null,
    nextHref: catalogPage.hasNext ? buildStorefrontDiscoveryHref(discovery, catalogPage.page + 1) : null,
    listEvent: tracking.listEvent,
  };
}
