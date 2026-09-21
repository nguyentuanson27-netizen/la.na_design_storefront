import type { Metadata } from "next";

import {
  INDEXABLE_CATEGORY_PATH_PATTERNS,
  isCanonicalCatalogPaginationRequest,
} from "./search-exposure.ts";

type CatalogListingMetadataInput = Readonly<{
  origin: string;
  indexingEnabled: boolean;
  pathname: string;
  searchParams: object;
  title: string;
  description?: string;
}>;

const CATALOG_LISTING_PATH_PATTERNS = [
  /^\/shop$/,
  /^\/collections\/[^/?#]+$/,
  ...INDEXABLE_CATEGORY_PATH_PATTERNS,
  /^\/sale$/,
  /^\/new-arrivals$/,
] as const;

function isCatalogListingPath(pathname: string): boolean {
  return CATALOG_LISTING_PATH_PATTERNS.some((pattern) => pattern.test(pathname));
}

function canonicalSearch(pathname: string, searchParams: object): string | null {
  const entries = Object.entries(searchParams).filter(([, value]) => value !== undefined);
  if (entries.length === 0) return "";
  if (entries.length !== 1) return null;

  const [key, value] = entries[0]!;
  if (key !== "page" || typeof value !== "string") return null;

  const search = `?page=${value}`;
  return isCanonicalCatalogPaginationRequest(pathname, search) ? search : null;
}

export function buildCatalogListingMetadata({
  origin,
  indexingEnabled,
  pathname,
  searchParams,
  title,
  description,
}: CatalogListingMetadataInput): Metadata {
  const metadata: Metadata = {
    title,
    ...(description ? { description } : {}),
  };

  if (!indexingEnabled || !isCatalogListingPath(pathname)) return metadata;

  const search = canonicalSearch(pathname, searchParams);
  if (search === null) return metadata;

  return {
    ...metadata,
    alternates: {
      canonical: new URL(`${pathname}${search}`, origin).toString(),
    },
  };
}
