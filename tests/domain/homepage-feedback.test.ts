import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

import {
  FEEDBACK_PATH,
  parseHomepageImageSrc,
  readFeedbackContent,
  resolveFeedbackContent,
} from "../../src/content/homepage-content.ts";
import { HOMEPAGE_CONFIG, type HomepageConfig } from "../../src/content/homepage.config.ts";
import { STOREFRONT_ROUTES } from "../../src/routes/manifest.ts";
import { shouldNoIndexRequest } from "../../src/seo/search-exposure.ts";
import {
  STATIC_CANONICAL_PATHS,
  listStaticCanonicalPaths,
} from "../../src/seo/search-sitemap-repository.ts";
import { buildStaticPageMetadata } from "../../src/seo/static-page-metadata.ts";

/**
 * The feedback rail and `/feedback` (docs/specs/homepage-editorial-refresh.md §7.6): the config
 * boundary, and the evergreen public-route contract the gallery is published under.
 */

const ORIGIN = "https://shop.example.com";

const complete = (
  overrides: Partial<HomepageConfig["feedback"]> = {},
): HomepageConfig["feedback"] => ({
  title: "Khách hàng của La.na",
  ctaLabel: "Xem thêm",
  metadataTitle: "Khách hàng",
  metadataDescription: "Ảnh khách hàng mặc La.na.",
  images: [
    { src: "/feedback/03.webp", alt: "Khách hàng mặc áo dài" },
    { src: "/feedback/01.webp", alt: "" },
    { src: "https://content.pancake.vn/1/2/3/4/feedback-02.jpg", alt: "Khách hàng mặc set đồ" },
  ],
  ...overrides,
});

/* ------------------------------------------------------------- config boundary */

test("feedback keeps the manually configured image order", () => {
  const content = resolveFeedbackContent(complete());

  assert.deepEqual(
    content?.images.map((image) => image.src),
    ["/feedback/03.webp", "/feedback/01.webp", "https://content.pancake.vn/1/2/3/4/feedback-02.jpg"],
  );
});

test("an explicit decorative alt is kept as a decision, not treated as missing", () => {
  assert.equal(resolveFeedbackContent(complete())?.images[1]?.alt, "");
});

test("feedback content is all-or-nothing while any part is pending", () => {
  for (const pending of [
    { title: null },
    { title: "  " },
    { metadataTitle: null },
    { metadataDescription: null },
    { ctaLabel: "" },
    { images: [] },
  ] satisfies Partial<HomepageConfig["feedback"]>[]) {
    assert.equal(resolveFeedbackContent(complete(pending)), null, JSON.stringify(pending));
  }
});

test("one invalid image closes the gallery instead of silently reordering it", () => {
  const images = [...complete().images, { src: "https://evil.example.com/x.jpg", alt: "" }];
  assert.equal(resolveFeedbackContent(complete({ images })), null);
});

test("homepage images are stable local paths or trusted Pancake URLs only", () => {
  for (const accepted of ["/feedback/01.webp", "/homepage/promo-a.jpg", "/a/b-c_d.png"]) {
    assert.equal(parseHomepageImageSrc(accepted), accepted);
  }
  for (const rejected of [
    "//evil.example.com/x.jpg",
    "https://evil.example.com/x.jpg",
    "http://content.pancake.vn/1/2/3/4/x.jpg",
    "/feedback/../x.webp",
    "/feedback//x.webp",
    "/feedback/x.svg",
    "/feedback/x.webp?v=1",
    "feedback/x.webp",
    "",
    null,
  ]) {
    assert.equal(parseHomepageImageSrc(rejected), null, `${JSON.stringify(rejected)} must be refused`);
  }
});

test("every value the shipped config supplies passes the boundary, so pending never masks a typo", () => {
  // A configured value that fails validation would silently hide its section. Pending values are
  // `null`/empty on purpose; anything filled in must be valid.
  for (const image of HOMEPAGE_CONFIG.feedback.images) {
    assert.notEqual(parseHomepageImageSrc(image.src), null, image.src);
  }
  for (const row of HOMEPAGE_CONFIG.promoRows) {
    for (const slot of row) {
      if (slot) assert.notEqual(parseHomepageImageSrc(slot.imageSrc), null, slot.imageSrc);
    }
  }
  const { feedback } = HOMEPAGE_CONFIG;
  const supplied = [feedback.title, feedback.metadataTitle, feedback.metadataDescription].every(
    (value) => typeof value === "string" && value.trim().length > 0,
  );
  if (supplied && feedback.images.length > 0) {
    assert.notEqual(readFeedbackContent(), null, "a fully supplied feedback config must publish");
  }
});

test("the approved copy the spec fixes is what the config ships", () => {
  assert.equal(HOMEPAGE_CONFIG.specialDeals.ctaLabel, "Xem thêm");
  assert.equal(HOMEPAGE_CONFIG.feedback.ctaLabel, "Xem thêm");
  assert.equal(HOMEPAGE_CONFIG.promoRows.length, 2);
  for (const row of HOMEPAGE_CONFIG.promoRows) assert.equal(row.length, 2);
});

/* ------------------------------------------------------- public-route contract */

test("/feedback is a declared shell route with page-mode metadata through its own builder", async () => {
  const entry = STOREFRONT_ROUTES.find((route) => route.path === "src/app/feedback/page.tsx");
  assert.deepEqual(entry, { path: "src/app/feedback/page.tsx", shell: true, metadata: "page" });
  assert.equal(FEEDBACK_PATH, "/feedback");

  const page = await readFile(new URL("../../src/app/feedback/page.tsx", import.meta.url), "utf8");
  assert.match(page, /buildFeedbackMetadata\(props\)/);
  await access(new URL("../../src/routes/metadata/feedback.ts", import.meta.url));
});

test("feedback metadata copy is read from the config, not written by the route", async () => {
  const builder = await readFile(new URL("../../src/routes/metadata/feedback.ts", import.meta.url), "utf8");
  assert.match(builder, /title: content\.metadataTitle/);
  assert.match(builder, /description: content\.metadataDescription/);
  assert.match(builder, /buildEvergreenPageMetadata/);
});

test("/feedback is indexable only under the global search exposure gate", () => {
  assert.equal(shouldNoIndexRequest({ indexingEnabled: true, pathname: "/feedback", search: "" }), false);
  assert.equal(shouldNoIndexRequest({ indexingEnabled: false, pathname: "/feedback", search: "" }), true);
  // Query variants stay noindex, including a page parameter: the gallery has no paginated form.
  for (const search of ["?utm_source=zalo", "?page=2"]) {
    assert.equal(shouldNoIndexRequest({ indexingEnabled: true, pathname: "/feedback", search }), true);
  }
  assert.equal(
    shouldNoIndexRequest({ indexingEnabled: true, pathname: "/feedback/extra", search: "" }),
    true,
  );
});

test("the clean /feedback URL self-canonicalizes; query variants and noindex get no canonical", () => {
  const metadata = (indexingEnabled: boolean, searchParams: object) =>
    buildStaticPageMetadata({
      origin: ORIGIN,
      indexingEnabled,
      pathname: "/feedback",
      searchParams,
      title: "Khách hàng",
      description: "Ảnh khách hàng.",
    });

  assert.equal(metadata(true, {}).alternates?.canonical, `${ORIGIN}/feedback`);
  assert.equal(metadata(true, { utm_source: "zalo" }).alternates, undefined);
  assert.equal(metadata(false, {}).alternates, undefined);
  assert.equal(metadata(true, {}).title, "Khách hàng");
  assert.equal(metadata(true, {}).description, "Ảnh khách hàng.");
});

test("/feedback is a static sitemap path, published only once its content exists", () => {
  assert.ok((STATIC_CANONICAL_PATHS as readonly string[]).includes("/feedback"));
  assert.ok(listStaticCanonicalPaths({ feedbackPublished: true }).includes("/feedback"));
  // While the route 404s for pending content, the sitemap must not nominate it.
  assert.equal(listStaticCanonicalPaths({ feedbackPublished: false }).includes("/feedback"), false);
  // Nothing else is conditional.
  assert.deepEqual(
    listStaticCanonicalPaths({ feedbackPublished: false }),
    STATIC_CANONICAL_PATHS.filter((pathname) => pathname !== "/feedback"),
  );
});
