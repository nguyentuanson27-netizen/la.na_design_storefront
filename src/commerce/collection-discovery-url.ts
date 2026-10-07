import {
  parseStorefrontDiscoverySearchParams,
  type StorefrontDiscoveryQuery,
  type StorefrontDiscoverySearchParams,
  type StorefrontDiscoverySort,
} from "./storefront-discovery.ts";

export type CollectionDiscoveryUrlState = Pick<
  StorefrontDiscoveryQuery,
  "size" | "sort" | "page"
>;

const COLLECTION_DEFAULT_SORTS: Readonly<Record<string, StorefrontDiscoverySort>> = {
  "xa-hang-chao-thu": "price-asc",
};

export function resolveCollectionDefaultSort(routeSlug: string): StorefrontDiscoverySort {
  return COLLECTION_DEFAULT_SORTS[routeSlug] ?? "name-asc";
}

export function parseCollectionDiscoverySearchParams(
  routeSlug: string,
  searchParams: StorefrontDiscoverySearchParams,
): StorefrontDiscoveryQuery {
  const defaultSort = resolveCollectionDefaultSort(routeSlug);
  const rawSort = searchParams.sort;
  const sortParam =
    rawSort === undefined || rawSort === ""
      ? defaultSort
      : rawSort;

  return parseStorefrontDiscoverySearchParams({
    collection: routeSlug,
    size: searchParams.size,
    sort: sortParam,
    page: searchParams.page,
  });
}

export function buildCollectionDiscoveryHref(
  routeSlug: string,
  state: CollectionDiscoveryUrlState,
): string {
  const defaultSort = resolveCollectionDefaultSort(routeSlug);
  const parsed = parseStorefrontDiscoverySearchParams({
    collection: routeSlug,
    size: state.size ?? undefined,
    sort: state.sort,
    page: String(state.page),
  });

  if (!parsed.collection) {
    throw new RangeError("Collection route slug is required");
  }

  const params = new URLSearchParams();
  if (parsed.size) params.set("size", parsed.size);
  if (parsed.sort !== defaultSort) params.set("sort", parsed.sort);
  if (parsed.page !== 1) params.set("page", String(parsed.page));

  const pathname = `/collections/${parsed.collection}`;
  const serialized = params.toString();
  return serialized.length > 0 ? `${pathname}?${serialized}` : pathname;
}

