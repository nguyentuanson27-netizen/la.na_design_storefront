import assert from "node:assert/strict";
import test from "node:test";

import { buildCatalogListingMetadata } from "../../src/seo/catalog-listing-metadata.ts";

const ORIGIN = "https://shop.example.com";

function canonical(metadata: ReturnType<typeof buildCatalogListingMetadata>): string | null {
  const value = metadata.alternates?.canonical;
  if (typeof value === "string") return value;
  if (value instanceof URL) return value.toString();
  return null;
}

test("F3a category shells self-canonicalize only their clean route URL", () => {
  for (const pathname of [
    "/ao-dai",
    "/ao-dai/tet",
    "/set-do/set-vay",
    "/vay-dam",
    "/phu-kien",
  ] as const) {
    assert.equal(
      canonical(
        buildCatalogListingMetadata({
          origin: ORIGIN,
          indexingEnabled: true,
          pathname,
          searchParams: {},
          title: "Danh mục",
        }),
      ),
      `${ORIGIN}${pathname}`,
    );
    assert.equal(
      canonical(
        buildCatalogListingMetadata({
          origin: ORIGIN,
          indexingEnabled: true,
          pathname,
          searchParams: { page: "2" },
          title: "Danh mục",
        }),
      ),
      null,
      `${pathname} has no paginated product-membership authority before G4`,
    );
  }
});

test("sale keeps truthful listing pagination canonical semantics", () => {
  for (const [searchParams, expected] of [
    [{}, `${ORIGIN}/sale`],
    [{ page: "2" }, `${ORIGIN}/sale?page=2`],
  ] as const) {
    assert.equal(
      canonical(
        buildCatalogListingMetadata({
          origin: ORIGIN,
          indexingEnabled: true,
          pathname: "/sale",
          searchParams,
          title: "Sale",
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

test("sale and category routes with noncanonical query states withhold canonical", () => {
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
