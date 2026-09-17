import {
  buildCategoryDiscoveryHref,
  type CategoryDiscoverySort,
} from "../../commerce/category-discovery-url.ts";

export type PlpFilterState = {
  size: string | null;
  color: string | null;
  minPriceVnd: number | null;
  maxPriceVnd: number | null;
  sale: boolean | null;
  sort: CategoryDiscoverySort;
};

export function hasActivePlpFilters(state: PlpFilterState): boolean {
  return (
    state.size !== null ||
    state.color !== null ||
    state.minPriceVnd !== null ||
    state.maxPriceVnd !== null ||
    Boolean(state.sale) ||
    state.sort !== "default"
  );
}

export function countActivePlpFilters(state: PlpFilterState): number {
  let count = 0;
  if (state.size !== null) count += 1;
  if (state.color !== null) count += 1;
  if (state.minPriceVnd !== null || state.maxPriceVnd !== null) count += 1;
  if (state.sale) count += 1;
  if (state.sort !== "default") count += 1;
  return count;
}

export function formatFilterPriceVnd(amount: number): string {
  return new Intl.NumberFormat("vi-VN", {
    style: "currency",
    currency: "VND",
    maximumFractionDigits: 0,
  }).format(amount);
}

export function buildToggleSizeHref(
  basePath: string,
  state: PlpFilterState,
  size: string,
): string {
  const nextSize = state.size === size ? null : size;
  return buildCategoryDiscoveryHref(basePath, {
    ...state,
    size: nextSize,
    page: 1,
  }, 1);
}

export function buildToggleColorHref(
  basePath: string,
  state: PlpFilterState,
  color: string,
): string {
  const nextColor = state.color === color ? null : color;
  return buildCategoryDiscoveryHref(basePath, {
    ...state,
    color: nextColor,
    page: 1,
  }, 1);
}

export function buildToggleSaleHref(
  basePath: string,
  state: PlpFilterState,
): string {
  const nextSale = state.sale ? null : true;
  return buildCategoryDiscoveryHref(basePath, {
    ...state,
    sale: nextSale,
    page: 1,
  }, 1);
}

export function buildSortChangeHref(
  basePath: string,
  state: PlpFilterState,
  sort: CategoryDiscoverySort,
): string {
  return buildCategoryDiscoveryHref(basePath, {
    ...state,
    sort,
    page: 1,
  }, 1);
}

export function buildClearAllFiltersHref(basePath: string): string {
  return basePath;
}
