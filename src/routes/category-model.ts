import {
  buildCategoryDiscoveryHref,
  encodeCategoryCursor,
  type CategoryDiscoveryQuery,
} from "../commerce/category-discovery-url.ts";
import type { StorefrontProductMedia } from "../commerce/product-media.ts";
import type {
  StorefrontPricingRule,
  StorefrontVariantFacts,
  StorefrontProductCapacity,
} from "../commerce/storefront-product.ts";
import {
  buildProductCardModel,
  type ProductCardModel,
} from "../components/headless/build-product-card-model.ts";
import type { PlpFilterState } from "../components/headless/plp-filter-model.ts";
import type { TrackingEvent } from "../tracking/commerce-events.ts";
import type { CategoryBreadcrumb } from "./category-breadcrumbs.ts";
import type { CategoryDestination } from "./category-destinations.ts";

export type CategoryProduct = Readonly<{
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

export type CategoryFacets = Readonly<{
  colors: readonly string[];
  sizes: readonly string[];
}>;

export type CategoryViewModel = Readonly<{
  destination: CategoryDestination;
  categoryKey: string;
  breadcrumbs: readonly CategoryBreadcrumb[];
  subcategories: readonly Readonly<{ label: string; href: string }>[];
  cards: readonly ProductCardModel[];
  totalCount: number;
  totalPages: number;
  page: number;
  hasNext: boolean;
  hasPrevious: boolean;
  nextHref: string | null;
  previousHref: string | null;
  nextCursor: string | null;
  previousCursor: string | null;
  facets: CategoryFacets;
  activeFilters: PlpFilterState;
}>;

export type CategoryViewModelInput = Readonly<{
  destination: CategoryDestination;
  categoryKey: string;
  breadcrumbs: readonly CategoryBreadcrumb[];
  subcategories: readonly Readonly<{ label: string; href: string }>[];
  discovery: CategoryDiscoveryQuery;
  products: readonly CategoryProduct[];
  facets: CategoryFacets;
  totalCount: number;
  totalPages: number;
  page: number;
  hasPrevious: boolean;
  hasNext: boolean;
  pageSize: number;
  pricingRule?: StorefrontPricingRule;
  selectEventBySlug: ReadonlyMap<string, TrackingEvent>;
}>;

export function buildCategoryViewModel(input: CategoryViewModelInput): CategoryViewModel {
  const {
    destination,
    categoryKey,
    breadcrumbs,
    subcategories,
    discovery,
    products,
    facets,
    totalCount,
    totalPages,
    page,
    hasPrevious,
    hasNext,
    pricingRule,
    selectEventBySlug,
  } = input;

  const cards: ProductCardModel[] = products.map((product) =>
    buildProductCardModel({
      slug: product.slug,
      name: product.name,
      media: product.media,
      variants: product.variants,
      productCapacity: product.productCapacity,
      pricingRule,
      selectEvent: selectEventBySlug.get(product.slug) ?? null,
    }),
  );

  const nextPage = page + 1;
  const prevPage = page - 1;

  const nextHref = hasNext
    ? buildCategoryDiscoveryHref(destination.href, discovery, nextPage)
    : null;
  const previousHref = hasPrevious
    ? buildCategoryDiscoveryHref(destination.href, discovery, prevPage)
    : null;

  const nextCursor = hasNext ? encodeCategoryCursor(nextPage) : null;
  const previousCursor = hasPrevious ? encodeCategoryCursor(prevPage) : null;

  const activeFilters: PlpFilterState = {
    size: discovery.size,
    color: discovery.color,
    minPriceVnd: discovery.minPriceVnd,
    maxPriceVnd: discovery.maxPriceVnd,
    sale: discovery.sale,
    sort: discovery.sort,
  };

  return Object.freeze({
    destination,
    categoryKey,
    breadcrumbs,
    subcategories,
    cards: Object.freeze(cards),
    totalCount,
    totalPages,
    page,
    hasNext,
    hasPrevious,
    nextHref,
    previousHref,
    nextCursor,
    previousCursor,
    facets,
    activeFilters,
  });
}
