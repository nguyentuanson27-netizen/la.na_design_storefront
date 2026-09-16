import {
  LEGACY_TEMPORARY_STOREFRONT_HOST,
  OFFICIAL_PRODUCTION_STOREFRONT_HOST,
  readStorefrontOrigin,
} from "../commerce/storefront-origin.ts";

type SearchExposureEnvironment = Readonly<Record<string, string | undefined>>;

export type SearchExposure = Readonly<{
  origin: string;
  indexingEnabled: boolean;
}>;

type SearchRequestPolicyInput = Readonly<{
  indexingEnabled: boolean;
  pathname: string;
  search: string;
}>;

const BLOCKED_INDEXING_HOSTS = new Set([
  "staging.lanadesign.vn",
  "localhost",
  "127.0.0.1",
]);

const TEMPORARY_PRODUCTION_HOSTS = new Set([LEGACY_TEMPORARY_STOREFRONT_HOST]);

export const CRAWL_BLOCKED_PATHS = ["/api"] as const;

export const INDEXABLE_CATEGORY_PATH_PATTERNS = [
  /^\/ao-dai(?:\/(?:cach-tan|tet|cuoi|4-ta|6-ta))?$/,
  /^\/set-do(?:\/(?:set-vay|set-quan-ao))?$/,
  /^\/vay-dam$/,
  /^\/phu-kien$/,
] as const;

const INDEXABLE_PATH_PATTERNS = [
  /^\/$/,
  /^\/shop$/,
  /^\/shop\/[^/]+$/,
  /^\/collections$/,
  /^\/collections\/[^/]+$/,
  /^\/new-arrivals$/,
  ...INDEXABLE_CATEGORY_PATH_PATTERNS,
  /^\/sale$/,
  /^\/about$/,
  /^\/contact$/,
  /^\/returns$/,
  /^\/shipping$/,
  /^\/size-guide$/,
] as const;

// F3a category destinations are crawlable route shells only. Until G4 approves canonical product
// membership they have no paginated listing semantics, so query state remains noindex. `/sale`
// already has a truthful paginated projection and keeps the existing catalog pagination contract.
const INDEXABLE_PAGINATION_PATH_PATTERNS = [
  /^\/shop$/,
  /^\/collections\/[^/]+$/,
  /^\/sale$/,
] as const;

const MAX_INDEXABLE_CATALOG_PAGE = 10_000;
const CANONICAL_CATALOG_PAGINATION_SEARCH = /^\?page=((?:[2-9])|(?:[1-9]\d+))$/;

function storefrontHostname(origin: string): string {
  return new URL(origin).hostname.toLowerCase();
}

function isBlockedIndexingOrigin(origin: string): boolean {
  return BLOCKED_INDEXING_HOSTS.has(storefrontHostname(origin));
}

export function isTemporaryProductionOrigin(origin: string): boolean {
  return TEMPORARY_PRODUCTION_HOSTS.has(storefrontHostname(origin));
}

export function isApprovedPermanentProductionOrigin(origin: string): boolean {
  return storefrontHostname(origin) === OFFICIAL_PRODUCTION_STOREFRONT_HOST;
}

function isCrawlBlockedPath(pathname: string): boolean {
  return CRAWL_BLOCKED_PATHS.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

export function isCanonicalCatalogPaginationRequest(
  pathname: string,
  search: string,
): boolean {
  if (!INDEXABLE_PAGINATION_PATH_PATTERNS.some((pattern) => pattern.test(pathname))) {
    return false;
  }

  const match = CANONICAL_CATALOG_PAGINATION_SEARCH.exec(search);
  if (!match) return false;

  const page = Number(match[1]);
  return Number.isSafeInteger(page) && page <= MAX_INDEXABLE_CATALOG_PAGE;
}

export function readSearchExposure(
  env: SearchExposureEnvironment = process.env,
): SearchExposure {
  const origin = readStorefrontOrigin(env);
  const requested = env.SEARCH_INDEXING_ENABLED === "true";

  return {
    origin,
    indexingEnabled:
      requested &&
      isApprovedPermanentProductionOrigin(origin) &&
      !isBlockedIndexingOrigin(origin) &&
      !isTemporaryProductionOrigin(origin),
  };
}

export function validateSearchExposureForRelease(
  env: SearchExposureEnvironment,
): SearchExposure {
  const raw = env.SEARCH_INDEXING_ENABLED;
  if (raw !== "true" && raw !== "false") {
    throw new Error("SEARCH_INDEXING_ENABLED must be explicitly configured as true or false");
  }

  const exposure = readSearchExposure(env);
  if (raw === "true" && isTemporaryProductionOrigin(exposure.origin)) {
    throw new Error(
      "Search indexing cannot be enabled on the temporary production storefront origin; it requires the approved permanent domain and a separate explicit approval",
    );
  }
  if (raw === "true" && isBlockedIndexingOrigin(exposure.origin)) {
    throw new Error("Search indexing cannot be enabled on staging or local storefront origins");
  }
  if (raw === "true" && !isApprovedPermanentProductionOrigin(exposure.origin)) {
    throw new Error(
      "Search indexing can only be enabled on the approved permanent storefront origin",
    );
  }

  return exposure;
}

export function shouldNoIndexRequest({
  indexingEnabled,
  pathname,
  search,
}: SearchRequestPolicyInput): boolean {
  if (isCrawlBlockedPath(pathname)) return false;
  if (!indexingEnabled) return true;
  if (search.length > 0) {
    return !isCanonicalCatalogPaginationRequest(pathname, search);
  }

  return !INDEXABLE_PATH_PATTERNS.some((pattern) => pattern.test(pathname));
}
