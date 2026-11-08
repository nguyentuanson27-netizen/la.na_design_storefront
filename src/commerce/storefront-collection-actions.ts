"use server";

import { prisma } from "../db/prisma.ts";
import { orderCollectionPage } from "../routes/collection-model.ts";
import { COLLECTION_PAGE_SIZE, isCollectionRouteReachable } from "../routes/collection-first-page.ts";
import {
  buildCategoryDiscoveryHref,
  encodeCategoryCursor,
  type CategoryDiscoverySort,
} from "./category-discovery-url.ts";
import { collectionListingPath, parseCollectionListingSearchParams } from "./collection-discovery-url.ts";
import { CollectionDefinitionError } from "./collection-definition.ts";
import { createCollectionDefinitionRepository } from "./collection-definition-repository.ts";
import { listConfiguredStorefrontDiscoveryPage } from "./storefront-catalog-runtime.ts";
import { buildProductListTracking } from "../components/analytics/product-list-tracking.ts";
import {
  buildProductCardModel,
  type ProductCardModel,
} from "../components/headless/build-product-card-model.ts";

/**
 * The next page of `/collections/<slug>` for the infinite grid.
 *
 * It takes the same facts the URL carries and parses them with the route's own parser, so a page
 * loaded by scrolling lists, orders and prices exactly what that page's crawlable URL does. The slug
 * is re-read as a published, reachable collection on every call: this is a public POST endpoint and
 * must not page through a draft collection or a slug the route itself would 404.
 */

export type CollectionNextPageActionInput = {
  slug: string;
  page?: number;
  cursor?: string | null;
  color?: string | null;
  size?: string | null;
  availability?: "in-stock" | null;
  minPriceVnd?: number | null;
  maxPriceVnd?: number | null;
  sale?: boolean | null;
  sort?: CategoryDiscoverySort;
};

export type CollectionNextPageActionResult = {
  products: ProductCardModel[];
  page: number;
  totalPages: number;
  totalCount: number;
  hasNext: boolean;
  nextCursor: string | null;
  nextHref: string | null;
};

const repository = createCollectionDefinitionRepository(prisma);

async function readReachableCollection(slug: string) {
  try {
    const collection = await repository.findPublishedBySlug(slug);
    return isCollectionRouteReachable(collection) ? collection : null;
  } catch (error) {
    if (error instanceof CollectionDefinitionError) return null;
    throw error;
  }
}

export async function loadCollectionNextPageAction(
  input: CollectionNextPageActionInput,
): Promise<CollectionNextPageActionResult> {
  if (typeof input?.slug !== "string") throw new RangeError("Invalid collection page request");
  // Validates the slug's shape before any read.
  const basePath = collectionListingPath(input.slug);
  const collection = await readReachableCollection(input.slug);
  if (!collection) throw new RangeError("Collection is not published");

  const listing = parseCollectionListingSearchParams(collection.slug, {
    color: input.color ?? undefined,
    size: input.size ?? undefined,
    availability: input.availability ?? undefined,
    minPrice: input.minPriceVnd !== null && input.minPriceVnd !== undefined ? String(input.minPriceVnd) : undefined,
    maxPrice: input.maxPriceVnd !== null && input.maxPriceVnd !== undefined ? String(input.maxPriceVnd) : undefined,
    sale: input.sale ? "true" : undefined,
    sort: input.sort && input.sort !== "default" ? input.sort : undefined,
    page: input.page !== undefined ? String(input.page) : undefined,
    cursor: input.cursor ?? undefined,
  });

  const pageResult = await listConfiguredStorefrontDiscoveryPage({
    discovery: listing.discovery,
    pageSize: COLLECTION_PAGE_SIZE,
    allowCuratedComponents: true,
    inStockFirst: listing.merchandiserOrder,
    featuredProductSlugs: listing.merchandiserOrder ? collection.featuredProductSlugs : [],
    now: new Date(),
  });

  const ordered = orderCollectionPage(pageResult.products, {
    featuredProductSlugs: collection.featuredProductSlugs,
    merchandiserOrder: listing.merchandiserOrder,
    inStockProductIds: pageResult.inStockProductIds,
  });

  // The same list identity, pricing rule and order the first page's tracking was built from, and
  // numbered on from the pages before it, so a product added by scrolling reports `select_item`
  // exactly as it would on its own page. Empty when this deployment publishes no commerce events.
  const tracking = buildProductListTracking({
    products: ordered,
    list: { listId: `collection:${collection.slug}`, listName: collection.title },
    pricingRule: pageResult.pricingRule,
    startIndex: (pageResult.page - 1) * COLLECTION_PAGE_SIZE,
  });

  const cards: ProductCardModel[] = ordered.map((product) =>
    buildProductCardModel({
      slug: product.slug,
      name: product.name,
      media: product.media,
      variants: product.variants,
      productCapacity: product.productCapacity,
      flashSale: product.flashSale,
      pricingRule: pageResult.pricingRule,
      selectEvent: tracking.selectEventBySlug.get(product.slug) ?? null,
    }),
  );

  const hasNext = pageResult.hasNext;
  const nextPage = pageResult.page + 1;

  return {
    products: cards,
    page: pageResult.page,
    totalPages: pageResult.totalPages,
    totalCount: pageResult.totalCount,
    hasNext,
    nextCursor: hasNext ? encodeCategoryCursor(nextPage) : null,
    nextHref: hasNext ? buildCategoryDiscoveryHref(basePath, listing.filters, nextPage) : null,
  };
}
