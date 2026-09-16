import assert from "node:assert/strict";
import test from "node:test";

import { buildCatalogListingMetadata } from "../../src/seo/catalog-listing-metadata.ts";

const ORIGIN = "https://shop.example.com";

// This file is the behavior contract for the F3a/A8 SEO boundary: new listing routes gain
// canonical exposure while the retired public routes stay outside every listing authority.
function canonical(metadata: ReturnType<typeof buildCatalogListingMetadata>): string | null {
  const value = metadata.alternates?.canonical;
  if (typeof value === "string") return value;
  if (value instanceof URL) return value.toString();
  return null;
}

test("F3a category and sale listings self-canonicalize clean and paginated URLs", () => {
  for (const [pathname, searchParams, expected] of [
    ["/ao-dai", {}, `${ORIGIN}/ao-dai`],
    ["/ao-dai/tet", { page: "3" }, `${ORIGIN}/ao-dai/tet?page=3`],
    ["/set-do/set-vay", {}, `${ORIGIN}/set-do/set-vay`],
    ["/vay-dam", { page: "2" }, `${ORIGIN}/vay-dam?page=2`],
    ["/sale", {}, `${ORIGIN}/sale`],
    ["/sale", { page: "2" }, `${ORIGIN}/sale?page=2`],
  ] as const) {
    assert.equal(
      canonical(
        buildCatalogListingMetadata({
          origin: ORIGIN,
          indexingEnabled: true,
          pathname,
          searchParams,
          title: "Listing",
        }),
      ),
      expected,
    );
  }
});

test("A8 retired routes never gain listing canonical metadata", () => {
  for (const pathname of ["/lookbook", "/flash-sale"] as const) {
    assert.equal(
      canonical(
        buildCatalogListingMetadata({
          origin: ORIGIN,
          indexingEnabled: true,
          pathname,
          searchParams: {},
          title: "Retired",
        }),
      ),
      null,
    );
  }
});

test("F3a category and sale listings withhold canonical for noncanonical query states", () => {
  for (const [pathname, searchParams] of [
    ["/ao-dai", { page: "1" }],
    ["/ao-dai/cach-tan", { sort: "name-asc" }],
    ["/set-do", { page: "2", color: "red" }],
    ["/sale", { page: "01" }],
    ["/sale", { page: "2", utm_source: "test" }],
  ] as const) {
    assert.equal(
      canonical(
        buildCatalogListingMetadata({
          origin: ORIGIN,
          indexingEnabled: true,
          pathname,
          searchParams,
          title: "Listing",
        }),
      ),
      null,
    );
  }
});
