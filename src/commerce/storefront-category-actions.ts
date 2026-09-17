"use server";

import {
  buildCategoryDiscoveryHref,
  encodeCategoryCursor,
  parseCategoryDiscoverySearchParams,
  type CategoryDiscoverySort,
} from "./category-discovery-url.ts";
import { listConfiguredCategoryDiscoveryPage } from "./storefront-catalog-runtime.ts";
import {
  buildProductCardModel,
  type ProductCardModel,
} from "../components/headless/build-product-card-model.ts";

const CATEGORY_PAGE_SIZE = 24;

export type CategoryNextPageActionInput = {
  categoryKey: string;
  categoryPath: string;
  page?: number;
  cursor?: string | null;
  color?: string | null;
  size?: string | null;
  minPriceVnd?: number | null;
  maxPriceVnd?: number | null;
  sale?: boolean | null;
  sort?: CategoryDiscoverySort;
};

export type CategoryNextPageActionResult = {
  products: ProductCardModel[];
  page: number;
  totalPages: number;
  totalCount: number;
  hasNext: boolean;
  nextCursor: string | null;
  nextHref: string | null;
  currentHref: string;
};

export async function loadCategoryNextPageAction(
  input: CategoryNextPageActionInput,
): Promise<CategoryNextPageActionResult> {
  const discovery = parseCategoryDiscoverySearchParams(input.categoryKey, {
    color: input.color ?? undefined,
    size: input.size ?? undefined,
    minPrice: input.minPriceVnd !== null && input.minPriceVnd !== undefined ? String(input.minPriceVnd) : undefined,
    maxPrice: input.maxPriceVnd !== null && input.maxPriceVnd !== undefined ? String(input.maxPriceVnd) : undefined,
    sale: input.sale ? "true" : undefined,
    sort: input.sort ?? undefined,
    page: input.page !== undefined ? String(input.page) : undefined,
    cursor: input.cursor ?? undefined,
  });

  const now = new Date();
  const pageResult = await listConfiguredCategoryDiscoveryPage({
    categoryKey: input.categoryKey,
    discovery,
    pageSize: CATEGORY_PAGE_SIZE,
    now,
  });

  const cards: ProductCardModel[] = pageResult.products.map((product) =>
    buildProductCardModel({
      slug: product.slug,
      name: product.name,
      media: product.media,
      variants: product.variants,
      pricingRule: pageResult.pricingRule,
      selectEvent: null,
    }),
  );

  const hasNext = pageResult.hasNext;
  const nextPage = discovery.page + 1;
  const currentHref = buildCategoryDiscoveryHref(input.categoryPath, discovery, pageResult.page);

  return {
    products: cards,
    page: pageResult.page,
    totalPages: pageResult.totalPages,
    totalCount: pageResult.totalCount,
    hasNext,
    nextCursor: hasNext ? encodeCategoryCursor(nextPage) : null,
    nextHref: hasNext ? buildCategoryDiscoveryHref(input.categoryPath, discovery, nextPage) : null,
    currentHref,
  };
}
