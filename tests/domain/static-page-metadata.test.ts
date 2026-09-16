import assert from "node:assert/strict";
import test from "node:test";

import { buildStaticPageMetadata } from "../../src/seo/static-page-metadata.ts";

const ORIGIN = "https://shop.example.com";

function canonical(metadata: ReturnType<typeof buildStaticPageMetadata>): string | null {
  const value = metadata.alternates?.canonical;
  if (typeof value === "string") return value;
  if (value instanceof URL) return value.toString();
  return null;
}

const APPROVED_STATIC_PATHS = [
  "/",
  "/collections",
  "/about",
  "/contact",
  "/returns",
  "/shipping",
  "/size-guide",
] as const;

test("U30b emits self-canonical for each approved static page when indexing is enabled", () => {
  for (const pathname of APPROVED_STATIC_PATHS) {
    const expected = pathname === "/" ? ORIGIN : `${ORIGIN}${pathname}`;
    assert.equal(
      canonical(
        buildStaticPageMetadata({
          origin: ORIGIN,
          indexingEnabled: true,
          pathname,
          searchParams: {},
        }),
      ),
      expected,
      `${pathname} must be its own canonical`,
    );
  }
});

test("U30b withholds canonical entirely when indexing is disabled", () => {
  for (const pathname of APPROVED_STATIC_PATHS) {
    assert.equal(
      canonical(
        buildStaticPageMetadata({
          origin: ORIGIN,
          indexingEnabled: false,
          pathname,
          searchParams: {},
        }),
      ),
      null,
    );
  }
});

test("U30b withholds canonical when a static request carries query state", () => {
  for (const searchParams of [{ q: "shirt" }, { page: "2" }, { utm_source: "newsletter" }]) {
    assert.equal(
      canonical(
        buildStaticPageMetadata({
          origin: ORIGIN,
          indexingEnabled: true,
          pathname: "/collections",
          searchParams,
        }),
      ),
      null,
    );
  }
});

test("U30b canonicalises no path outside the approved static-page authority", () => {
  for (const pathname of [
    "/lookbook",
    "/flash-sale",
    "/sale",
    "/new-arrivals",
    "/ao-dai",
    "/shop",
    "/collections/summer-shirts",
    "/shop/ao-oxford-relaxed",
    "/search",
    "/cart",
    "/checkout",
    "/collections/",
  ] as const) {
    assert.equal(
      canonical(
        buildStaticPageMetadata({
          origin: ORIGIN,
          indexingEnabled: true,
          pathname,
          searchParams: {},
        }),
      ),
      null,
      `${pathname} is owned elsewhere or retired and must get no canonical from here`,
    );
  }
});

test("U30b builds canonical from the server-owned origin it is given", () => {
  assert.equal(
    canonical(
      buildStaticPageMetadata({
        origin: "https://la.lanadesign.vn",
        indexingEnabled: true,
        pathname: "/collections",
        searchParams: {},
      }),
    ),
    "https://la.lanadesign.vn/collections",
  );
});

test("U30b passes through route title and description without adding other authorities", () => {
  const metadata = buildStaticPageMetadata({
    origin: ORIGIN,
    indexingEnabled: true,
    pathname: "/collections",
    searchParams: {},
    title: "Bộ sưu tập",
    description: "Khám phá các bộ sưu tập từ LA Clothing.",
  });
  assert.equal(metadata.title, "Bộ sưu tập");
  assert.equal(metadata.description, "Khám phá các bộ sưu tập từ LA Clothing.");
  assert.equal("robots" in metadata, false);
  assert.equal("openGraph" in metadata, false);
  assert.equal("twitter" in metadata, false);
});
