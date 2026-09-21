import assert from "node:assert/strict";
import test from "node:test";

import { shouldNoIndexRequest } from "../../src/seo/search-exposure.ts";
import { buildStaticPageMetadata } from "../../src/seo/static-page-metadata.ts";

const ORIGIN = "https://shop.example.com";

function canonical(metadata: ReturnType<typeof buildStaticPageMetadata>): string | null {
  const value = metadata.alternates?.canonical;
  if (typeof value === "string") return value;
  if (value instanceof URL) return value.toString();
  return null;
}

// `/new-arrivals` left this list when §10's "shows newest products automatically" became a real
// paged listing: a paginated route's canonical belongs to `buildCatalogListingMetadata`, which is
// the authority that knows `?page=2` is a URL rather than arbitrary query state.
const APPROVED_STATIC_PATHS = [
  "/",
  "/collections",
  "/about",
  "/contact",
  "/returns",
  "/shipping",
  "/size-guide",
  "/policies",
] as const;

test("static authority self-canonicalizes every approved static page when indexing is enabled", () => {
  for (const pathname of APPROVED_STATIC_PATHS) {
    const expected = pathname === "/" ? ORIGIN : `${ORIGIN}${pathname}`;
    assert.equal(
      canonical(buildStaticPageMetadata({ origin: ORIGIN, indexingEnabled: true, pathname, searchParams: {} })),
      expected,
    );
  }
});

test("static authority withholds canonical under noindex or query state", () => {
  for (const pathname of APPROVED_STATIC_PATHS) {
    assert.equal(
      canonical(buildStaticPageMetadata({ origin: ORIGIN, indexingEnabled: false, pathname, searchParams: {} })),
      null,
    );
  }
  assert.equal(
    canonical(
      buildStaticPageMetadata({
        origin: ORIGIN,
        indexingEnabled: true,
        pathname: "/collections",
        searchParams: { utm_source: "test" },
      }),
    ),
    null,
  );
  assert.equal(
    shouldNoIndexRequest({
      indexingEnabled: true,
      pathname: "/collections",
      search: "?utm_source=test",
    }),
    true,
  );
});

test("retired and listing routes are outside static canonical authority", () => {
  for (const pathname of [
    "/lookbook",
    "/flash-sale",
    "/sale",
    "/new-arrivals",
    "/ao-dai",
    "/shop",
    "/collections/summer-shirts",
    "/shop/current-product",
  ] as const) {
    assert.equal(
      canonical(buildStaticPageMetadata({ origin: ORIGIN, indexingEnabled: true, pathname, searchParams: {} })),
      null,
    );
  }
});

test("static metadata preserves route-owned title and description without adding other authorities", () => {
  const metadata = buildStaticPageMetadata({
    origin: ORIGIN,
    indexingEnabled: true,
    pathname: "/collections",
    searchParams: {},
    title: "Bộ sưu tập",
    description: "Khám phá các bộ sưu tập từ La.na Design.",
  });
  assert.equal(metadata.title, "Bộ sưu tập");
  assert.equal(metadata.description, "Khám phá các bộ sưu tập từ La.na Design.");
  assert.equal("robots" in metadata, false);
  assert.equal("openGraph" in metadata, false);
  assert.equal("twitter" in metadata, false);
});
