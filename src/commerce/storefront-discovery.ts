export const STOREFRONT_DISCOVERY_LIMITS = {
  query: 80,
  option: 64,
  collection: 48,
  priceVnd: 1_000_000_000,
  page: 10_000,
} as const;

export const STOREFRONT_DISCOVERY_SORTS = [
  "default",
  "name-asc",
  "name-desc",
  "price-asc",
  "price-desc",
] as const;

export type StorefrontDiscoverySort = (typeof STOREFRONT_DISCOVERY_SORTS)[number];

export type StorefrontDiscoveryQuery = {
  query: string | null;
  color: string | null;
  size: string | null;
  availability: "in-stock" | null;
  minPriceVnd: number | null;
  maxPriceVnd: number | null;
  sale?: boolean | null;
  categoryKey?: string | null;
  categoryListingKeys?: readonly string[] | null;
  collection: string | null;
  sort: StorefrontDiscoverySort;
  page: number;
};

type SearchParamValue = string | string[] | undefined;
export type StorefrontDiscoverySearchParams = Record<string, SearchParamValue>;

const COLLECTION_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SORTS = new Set<string>(STOREFRONT_DISCOVERY_SORTS);

function invalid(): never {
  throw new RangeError("Invalid storefront discovery parameters");
}

function one(value: SearchParamValue): string | undefined {
  if (Array.isArray(value)) invalid();
  return value;
}

function optionalText(value: SearchParamValue, maxLength: number): string | null {
  const raw = one(value);
  if (raw === undefined || raw === "") return null;
  if (raw.length > maxLength) invalid();
  const normalized = raw.trim();
  if (normalized.length === 0) return null;
  return normalized;
}

function optionalPrice(value: SearchParamValue): number | null {
  const raw = one(value);
  if (raw === undefined || raw === "") return null;
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) invalid();
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > STOREFRONT_DISCOVERY_LIMITS.priceVnd) {
    invalid();
  }
  return parsed;
}

function parsePage(value: SearchParamValue): number {
  const raw = one(value);
  if (raw === undefined || raw === "") return 1;
  if (!/^[1-9][0-9]*$/.test(raw)) invalid();
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed > STOREFRONT_DISCOVERY_LIMITS.page) invalid();
  return parsed;
}

function parseAvailability(value: SearchParamValue): "in-stock" | null {
  const raw = one(value);
  if (raw === undefined || raw === "") return null;
  if (raw !== "in-stock") invalid();
  return raw;
}

function parseCollection(value: SearchParamValue): string | null {
  const collection = optionalText(value, STOREFRONT_DISCOVERY_LIMITS.collection);
  if (collection === null) return null;
  if (!COLLECTION_SLUG.test(collection)) invalid();
  return collection;
}

function parseSale(value: SearchParamValue): boolean | null {
  const raw = one(value);
  if (raw === undefined || raw === "") return null;
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  invalid();
}

function parseSort(value: SearchParamValue): StorefrontDiscoverySort {
  const raw = one(value);
  if (raw === undefined || raw === "") return "name-asc";
  if (!SORTS.has(raw)) invalid();
  return raw as StorefrontDiscoverySort;
}

export function parseStorefrontDiscoverySearchParams(
  searchParams: StorefrontDiscoverySearchParams,
): StorefrontDiscoveryQuery {
  const minPriceVnd = optionalPrice(searchParams.minPrice);
  const maxPriceVnd = optionalPrice(searchParams.maxPrice);
  if (minPriceVnd !== null && maxPriceVnd !== null && minPriceVnd > maxPriceVnd) invalid();

  return {
    query: optionalText(searchParams.q, STOREFRONT_DISCOVERY_LIMITS.query),
    color: optionalText(searchParams.color, STOREFRONT_DISCOVERY_LIMITS.option),
    size: optionalText(searchParams.size, STOREFRONT_DISCOVERY_LIMITS.option),
    availability: parseAvailability(searchParams.availability),
    minPriceVnd,
    maxPriceVnd,
    sale: parseSale(searchParams.sale),
    collection: parseCollection(searchParams.collection),
    sort: parseSort(searchParams.sort),
    page: parsePage(searchParams.page),
  };
}

export function buildStorefrontDiscoveryHref(
  query: StorefrontDiscoveryQuery,
  page: number = query.page,
): string {
  if (!Number.isSafeInteger(page) || page < 1 || page > STOREFRONT_DISCOVERY_LIMITS.page) {
    invalid();
  }

  const params = new URLSearchParams();
  if (query.query) params.set("q", query.query);
  if (query.color) params.set("color", query.color);
  if (query.size) params.set("size", query.size);
  if (query.availability) params.set("availability", query.availability);
  if (query.minPriceVnd !== null) params.set("minPrice", String(query.minPriceVnd));
  if (query.maxPriceVnd !== null) params.set("maxPrice", String(query.maxPriceVnd));
  if (query.sale) params.set("sale", "true");
  if (query.collection) params.set("collection", query.collection);
  if (query.sort !== "name-asc") params.set("sort", query.sort);
  if (page !== 1) params.set("page", String(page));

  const serialized = params.toString();
  return serialized.length > 0 ? `/shop?${serialized}` : "/shop";
}
