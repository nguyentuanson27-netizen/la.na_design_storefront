import {
  STOREFRONT_DISCOVERY_LIMITS,
  type StorefrontDiscoverySearchParams,
} from "./storefront-discovery.ts";

export type { StorefrontDiscoverySearchParams };

export const CATEGORY_DISCOVERY_SORTS = [
  "default",
  "name-asc",
  "name-desc",
  "price-asc",
  "price-desc",
] as const;

export type CategoryDiscoverySort = (typeof CATEGORY_DISCOVERY_SORTS)[number];

const SORTS = new Set<string>(CATEGORY_DISCOVERY_SORTS);

export type CategoryDiscoveryQuery = {
  categoryKey: string;
  query: string | null;
  color: string | null;
  size: string | null;
  availability: "in-stock" | null;
  minPriceVnd: number | null;
  maxPriceVnd: number | null;
  sale: boolean | null;
  collection: string | null;
  sort: CategoryDiscoverySort;
  page: number;
  cursor: string | null;
};

type SearchParamValue = string | string[] | undefined;

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

function parseSale(value: SearchParamValue): boolean | null {
  const raw = one(value);
  if (raw === undefined || raw === "") return null;
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  invalid();
}

function parseSort(value: SearchParamValue): CategoryDiscoverySort {
  const raw = one(value);
  if (raw === undefined || raw === "") return "default";
  if (!SORTS.has(raw)) invalid();
  return raw as CategoryDiscoverySort;
}

export function encodeCategoryCursor(page: number): string {
  if (!Number.isSafeInteger(page) || page < 1 || page > STOREFRONT_DISCOVERY_LIMITS.page) {
    invalid();
  }
  return Buffer.from(JSON.stringify({ p: page })).toString("base64url");
}

export function decodeCategoryCursor(cursor: string): { page: number } {
  if (typeof cursor !== "string" || cursor.length === 0 || cursor.length > 256) {
    invalid();
  }
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf8");
    const parsed = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof parsed.p !== "number" ||
      !Number.isSafeInteger(parsed.p) ||
      parsed.p < 1 ||
      parsed.p > STOREFRONT_DISCOVERY_LIMITS.page
    ) {
      invalid();
    }
    return { page: parsed.p };
  } catch {
    invalid();
  }
}

function parsePage(pageValue: SearchParamValue, cursorValue: SearchParamValue): { page: number; cursor: string | null } {
  const rawPage = one(pageValue);
  const rawCursor = one(cursorValue);

  if (rawPage !== undefined && rawPage !== "") {
    if (!/^[1-9][0-9]*$/.test(rawPage)) invalid();
    const parsed = Number(rawPage);
    if (!Number.isSafeInteger(parsed) || parsed > STOREFRONT_DISCOVERY_LIMITS.page) invalid();
    return { page: parsed, cursor: rawCursor ? rawCursor : null };
  }

  if (rawCursor !== undefined && rawCursor !== "") {
    const decoded = decodeCategoryCursor(rawCursor);
    return { page: decoded.page, cursor: rawCursor };
  }

  return { page: 1, cursor: null };
}

export function parseCategoryDiscoverySearchParams(
  categoryKey: string,
  searchParams: StorefrontDiscoverySearchParams,
): CategoryDiscoveryQuery {
  if (typeof categoryKey !== "string" || categoryKey.trim().length === 0) {
    invalid();
  }

  const minPriceVnd = optionalPrice(searchParams.minPrice);
  const maxPriceVnd = optionalPrice(searchParams.maxPrice);
  if (minPriceVnd !== null && maxPriceVnd !== null && minPriceVnd > maxPriceVnd) invalid();

  const { page, cursor } = parsePage(searchParams.page, searchParams.cursor);

  return {
    categoryKey: categoryKey.trim(),
    query: null,
    color: optionalText(searchParams.color, STOREFRONT_DISCOVERY_LIMITS.option),
    size: optionalText(searchParams.size, STOREFRONT_DISCOVERY_LIMITS.option),
    availability: null,
    minPriceVnd,
    maxPriceVnd,
    sale: parseSale(searchParams.sale),
    collection: null,
    sort: parseSort(searchParams.sort),
    page,
    cursor,
  };
}

export function buildCategoryDiscoveryHref(
  basePath: string,
  query: Partial<CategoryDiscoveryQuery>,
  targetPage: number = query.page ?? 1,
): string {
  if (
    !Number.isSafeInteger(targetPage) ||
    targetPage < 1 ||
    targetPage > STOREFRONT_DISCOVERY_LIMITS.page
  ) {
    invalid();
  }

  const params = new URLSearchParams();
  if (query.color) params.set("color", query.color);
  if (query.size) params.set("size", query.size);
  if (query.minPriceVnd !== null && query.minPriceVnd !== undefined) {
    params.set("minPrice", String(query.minPriceVnd));
  }
  if (query.maxPriceVnd !== null && query.maxPriceVnd !== undefined) {
    params.set("maxPrice", String(query.maxPriceVnd));
  }
  if (query.sale) params.set("sale", "true");
  if (query.sort && query.sort !== "default") params.set("sort", query.sort);
  if (targetPage !== 1) params.set("page", String(targetPage));

  const serialized = params.toString();
  return serialized.length > 0 ? `${basePath}?${serialized}` : basePath;
}
