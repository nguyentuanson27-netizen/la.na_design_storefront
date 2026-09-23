import assert from "node:assert/strict";
import test from "node:test";

import { CATEGORY_NAVIGATION } from "../../src/brand/category.config.ts";
import { parseCollectionDiscoverySearchParams } from "../../src/commerce/collection-discovery-url.ts";
import type { StorefrontDiscoveryQuery } from "../../src/commerce/storefront-discovery.ts";
import { MAX_STOREFRONT_PROMOTION_REFRESH_MS } from "../../src/commerce/storefront-promotion-freshness.ts";
import type { StorefrontVariantFacts } from "../../src/commerce/storefront-product.ts";
import type { FeedbackContent } from "../../src/content/homepage-content.ts";
import { HOMEPAGE_CONFIG, type HomepageConfig } from "../../src/content/homepage.config.ts";
import { orderByFeaturedSlugs } from "../../src/routes/collection-model.ts";
import { COLLECTION_PAGE_SIZE } from "../../src/routes/collection-first-page.ts";
import {
  NEXT_FAVOURITE_CATEGORY_KEYS,
  SPECIAL_DEALS_SIZE,
  SPECIAL_DEALS_TITLE,
  buildHomeViewModel,
  listPromoCollectionSlugs,
  loadSpecialDeals,
  resolveCategoryDiscovery,
  resolveCollectionPromoRow,
  resolveHomeRefreshAfterMs,
  type HomeCollectionFacts,
  type SpecialDealsGrid,
  type SpecialDealsProduct,
  type SpecialDealsReads,
} from "../../src/routes/home-model.ts";
import type { TrackingEvent } from "../../src/tracking/commerce-events.ts";

/**
 * The refreshed homepage's decisions (docs/specs/homepage-editorial-refresh.md).
 *
 * Pricing is not retested here -- it belongs to `buildProductCardModel`. What is tested is what the
 * route decides: which four products SPECIAL DEALS shows and when it shows none, which collection
 * CTAs are allowed to exist, when the four category blocks render, and that the retired sections
 * are gone from the model.
 */

const SOURCE = "he-2026";
const OTHER = "thu-2026";
const IMAGE = (name: string) => `https://content.pancake.vn/1/2/3/4/${name}.jpg`;

function variant(n: number): StorefrontVariantFacts {
  return {
    id: `variant-${n}`,
    pancakeVariationId: `pancake-${n}`,
    color: null,
    size: "S",
    sellableStock: 4,
    retailPrice: 100_000,
    retailPriceAfterDiscount: 100_000,
  };
}

function product(slug: string, collections: readonly string[] = [SOURCE]): SpecialDealsProduct {
  return {
    id: `id-${slug}`,
    slug,
    name: slug,
    media: null,
    variants: [variant(slug.length)],
    collections: collections.map((collection) => ({ slug: collection })),
  };
}

function collection(overrides: Partial<HomeCollectionFacts> = {}): HomeCollectionFacts {
  return {
    slug: SOURCE,
    title: "Hè 2026",
    description: "Câu chuyện bộ sưu tập.",
    featuredProductSlugs: [],
    ...overrides,
  };
}

const grid = (products: readonly SpecialDealsProduct[], refreshAfterMs = 60_000) =>
  ({ products, refreshAfterMs }) satisfies SpecialDealsGrid<SpecialDealsProduct>;

/**
 * A stand-in for the public collection listing's own read: every member of the collection, in its
 * default `name-asc` order, cut to the requested page window. It pages exactly the way
 * `listDiscoveryPage` does, which is what lets a test tell a 24-product window from a 4-product one.
 */
function collectionListing(members: readonly SpecialDealsProduct[]) {
  const calls: { discovery: StorefrontDiscoveryQuery; pageSize: number }[] = [];
  const sorted = [...members].sort((a, b) => a.name.localeCompare(b.name));
  return {
    calls,
    read: async ({ discovery, pageSize }: { discovery: StorefrontDiscoveryQuery; pageSize: number }) => {
      calls.push({ discovery, pageSize });
      const offset = (discovery.page - 1) * pageSize;
      return grid(sorted.slice(offset, offset + pageSize));
    },
  };
}

function reads(
  overrides: Partial<SpecialDealsReads<SpecialDealsProduct>> & {
    manual?: readonly SpecialDealsProduct[];
    source?: HomeCollectionFacts | null;
  } = {},
): SpecialDealsReads<SpecialDealsProduct> & { readSlugs: string[] } {
  const readSlugs: string[] = [];
  return {
    readSlugs,
    sourceCollectionSlug: SOURCE,
    readCollection: async (slug) => {
      readSlugs.push(slug);
      return overrides.source === undefined ? collection() : overrides.source;
    },
    listManual: async () => grid(overrides.manual ?? []),
    listCollectionPage: async () => {
      throw new Error("the collection fallback must not be read");
    },
    ...overrides,
  };
}

const slugs = (products: readonly { slug: string }[] | undefined) =>
  (products ?? []).map((item) => item.slug);

/* ------------------------------------------------------- SPECIAL DEALS: manual */

test("manual SPECIAL DEALS renders exactly the first four HomepageFeaturedProduct rows, in order", async () => {
  const manual = ["d", "a", "c", "b"].map((slug) => product(slug));
  const selection = await loadSpecialDeals(reads({ manual }));

  assert.equal(selection?.source, "manual");
  assert.deepEqual(slugs(selection?.products), ["d", "a", "c", "b"]);
  assert.equal(selection?.collection.href, `/collections/${SOURCE}`);
});

test("a manual list longer than four is bounded to its first four, never re-sorted", async () => {
  const manual = ["e", "d", "c", "b", "a"].map((slug) => product(slug));
  const selection = await loadSpecialDeals(reads({ manual }));

  assert.equal(SPECIAL_DEALS_SIZE, 4);
  assert.deepEqual(slugs(selection?.products), ["e", "d", "c", "b"]);
});

test("manual SPECIAL DEALS with a product outside the source collection omits the section, with no fallback", async () => {
  const manual = [product("a"), product("b"), product("c", [OTHER]), product("d")];
  // `listCollectionPage` throws in `reads()` by default: reaching the fallback would fail the test.
  const selection = await loadSpecialDeals(reads({ manual }));

  assert.equal(selection, null);
});

test("a cross-collection manual set is not filtered or topped up from later manual rows", async () => {
  // The fifth row is a member. Filtering the non-member out and promoting it would publish a set
  // nobody chose, which is exactly what the spec forbids.
  const manual = [product("a"), product("b", [OTHER]), product("c"), product("d"), product("e")];
  assert.equal(await loadSpecialDeals(reads({ manual })), null);
});

test("a product in both collections is a member of the source collection", async () => {
  const manual = [product("a", [OTHER, SOURCE]), product("b"), product("c"), product("d")];
  const selection = await loadSpecialDeals(reads({ manual }));

  assert.deepEqual(slugs(selection?.products), ["a", "b", "c", "d"]);
});

test("a short manual set omits SPECIAL DEALS rather than falling back or showing three", async () => {
  const manual = [product("a"), product("b"), product("c")];
  assert.equal(await loadSpecialDeals(reads({ manual })), null);
});

/* ----------------------------------------------------- SPECIAL DEALS: fallback */

test("an empty manual authority falls back to the collection route's unfiltered first page", async () => {
  const listing = collectionListing(["d", "b", "a", "c", "e"].map((slug) => product(slug)));
  const selection = await loadSpecialDeals(reads({ listCollectionPage: listing.read }));

  assert.equal(selection?.source, "collection");
  assert.deepEqual(slugs(selection?.products), ["a", "b", "c", "d"]);
  assert.equal(listing.calls.length, 1);
  // The same discovery state the collection route builds for `/collections/<slug>` with no query,
  // and its shared page size -- not a homepage-specific window.
  assert.deepEqual(listing.calls[0]?.discovery, parseCollectionDiscoverySearchParams(SOURCE, {}));
  assert.equal(listing.calls[0]?.discovery.sort, "name-asc");
  assert.equal(listing.calls[0]?.discovery.page, 1);
  assert.equal(listing.calls[0]?.discovery.size, null);
  assert.equal(listing.calls[0]?.pageSize, COLLECTION_PAGE_SIZE);
  assert.equal(COLLECTION_PAGE_SIZE, 24);
});

test("REGRESSION: a pinned product after the first four names but inside the first 24 leads SPECIAL DEALS", async () => {
  // Thirty members, name-sorted p01..p30. The merchandiser pinned p10: the collection page shows it
  // first, because the route pins within its 24-product first page.
  const members = Array.from({ length: 30 }, (_, index) =>
    product(`p${String(index + 1).padStart(2, "0")}`),
  );
  const pinned = ["p10"];
  const listing = collectionListing(members);

  const selection = await loadSpecialDeals(
    reads({ source: collection({ featuredProductSlugs: pinned }), listCollectionPage: listing.read }),
  );

  // What `/collections/<slug>` renders as its first four cards.
  const routeFirstPage = await listing.read({
    discovery: parseCollectionDiscoverySearchParams(SOURCE, {}),
    pageSize: COLLECTION_PAGE_SIZE,
  });
  const routeFirstFour = slugs(orderByFeaturedSlugs(routeFirstPage.products, pinned).slice(0, 4));

  assert.deepEqual(routeFirstFour, ["p10", "p01", "p02", "p03"]);
  assert.deepEqual(slugs(selection?.products), routeFirstFour);

  // The wrong implementation: ask the listing for four products, then pin. p10 is not on a
  // four-product page, so the pin has nothing to promote and the homepage disagrees with the
  // collection page.
  const fourProductPage = await listing.read({
    discovery: parseCollectionDiscoverySearchParams(SOURCE, {}),
    pageSize: 4,
  });
  const wrongFirstFour = slugs(orderByFeaturedSlugs(fourProductPage.products, pinned).slice(0, 4));
  assert.deepEqual(wrongFirstFour, ["p01", "p02", "p03", "p04"]);
  assert.notDeepEqual(slugs(selection?.products), wrongFirstFour);
});

test("a pinned product outside the collection route's first page stays outside SPECIAL DEALS", async () => {
  // No global featured-first ranking: p27 is on page 2 of the collection, so its page 1 does not
  // show it and neither does the homepage.
  const members = Array.from({ length: 30 }, (_, index) =>
    product(`p${String(index + 1).padStart(2, "0")}`),
  );
  const listing = collectionListing(members);
  const selection = await loadSpecialDeals(
    reads({ source: collection({ featuredProductSlugs: ["p27"] }), listCollectionPage: listing.read }),
  );

  assert.deepEqual(slugs(selection?.products), ["p01", "p02", "p03", "p04"]);
});

test("a fallback with fewer than four products omits SPECIAL DEALS rather than rendering a partial grid", async () => {
  const listing = collectionListing([product("a"), product("b"), product("c")]);
  assert.equal(await loadSpecialDeals(reads({ listCollectionPage: listing.read })), null);
});

test("the fallback carries the listing's own pricing window into the page's refresh", async () => {
  const selection = await loadSpecialDeals(
    reads({
      listCollectionPage: async () => grid(["a", "b", "c", "d"].map((slug) => product(slug)), 5_000),
    }),
  );
  assert.equal(selection?.refreshAfterMs, 5_000);
});

/* ------------------------------------------------ SPECIAL DEALS: reachability */

test("no configured source collection omits SPECIAL DEALS without reading anything", async () => {
  const context = reads({
    sourceCollectionSlug: null,
    listManual: async () => {
      throw new Error("must not read the manual authority without a source collection");
    },
  });
  assert.equal(await loadSpecialDeals(context), null);
  assert.deepEqual(context.readSlugs, []);
});

test("an unpublished (unreadable) source collection omits SPECIAL DEALS, even with a valid manual set", async () => {
  const manual = ["a", "b", "c", "d"].map((slug) => product(slug));
  assert.equal(await loadSpecialDeals(reads({ manual, source: null })), null);
});

test("a published source collection the route would 404 (blank story) omits SPECIAL DEALS", async () => {
  const manual = ["a", "b", "c", "d"].map((slug) => product(slug));
  for (const description of [null, "", "   "]) {
    assert.equal(
      await loadSpecialDeals(reads({ manual, source: collection({ description }) })),
      null,
      `description ${JSON.stringify(description)} must not produce a Xem thêm link`,
    );
  }
});

/* ---------------------------------------------------------- collection promos */

const slot = (collectionSlug: string, overrides: Partial<{ imageSrc: string; ctaLabel: string }> = {}) => ({
  collectionSlug,
  imageSrc: "/homepage/promo.webp",
  ctaLabel: "Khám phá",
  ...overrides,
});

const promoCollections = new Map<string, HomeCollectionFacts | null>([
  [SOURCE, collection()],
  [OTHER, collection({ slug: OTHER, title: "Thu 2026" })],
  ["draft", null],
  ["no-story", collection({ slug: "no-story", title: "Không câu chuyện", description: " " })],
]);

test("a promo tile's visible title is the collection's canonical CollectionDefinition.title", () => {
  const row = resolveCollectionPromoRow([slot(SOURCE), slot(OTHER)], promoCollections);

  assert.deepEqual(
    row?.map((tile) => [tile.title, tile.href, tile.imageSrc, tile.ctaLabel]),
    [
      ["Hè 2026", `/collections/${SOURCE}`, "/homepage/promo.webp", "Khám phá"],
      ["Thu 2026", `/collections/${OTHER}`, "/homepage/promo.webp", "Khám phá"],
    ],
  );
});

test("the promo slot config has no title field to become a second collection-title authority", () => {
  for (const row of HOMEPAGE_CONFIG.promoRows) {
    for (const configured of row) {
      if (configured === null) continue;
      assert.deepEqual(Object.keys(configured).sort(), ["collectionSlug", "ctaLabel", "imageSrc"]);
    }
  }
  // A title smuggled into a slot is ignored: the collection still names the tile.
  const smuggled = { ...slot(SOURCE), title: "Tên khác" } as ReturnType<typeof slot>;
  assert.equal(resolveCollectionPromoRow([smuggled, slot(OTHER)], promoCollections)?.[0].title, "Hè 2026");
});

test("an unmapped slot omits the whole promo row", () => {
  assert.equal(resolveCollectionPromoRow([slot(SOURCE), null], promoCollections), null);
  assert.equal(resolveCollectionPromoRow([null, slot(OTHER)], promoCollections), null);
  assert.equal(resolveCollectionPromoRow([null, null], promoCollections), null);
});

test("a route-unreachable collection omits the promo row rather than publishing a broken CTA", () => {
  // Unpublished, and published-but-no-story: the collection route 404s both.
  assert.equal(resolveCollectionPromoRow([slot(SOURCE), slot("draft")], promoCollections), null);
  assert.equal(resolveCollectionPromoRow([slot("no-story"), slot(OTHER)], promoCollections), null);
  assert.equal(resolveCollectionPromoRow([slot(SOURCE), slot("never-read")], promoCollections), null);
});

test("an untrusted or unstable promo image omits the row", () => {
  for (const imageSrc of [
    "https://evil.example.com/promo.jpg",
    "//evil.example.com/promo.jpg",
    "/homepage/../secret.webp",
    "/homepage/promo.svg",
    "",
  ]) {
    assert.equal(
      resolveCollectionPromoRow([slot(SOURCE, { imageSrc }), slot(OTHER)], promoCollections),
      null,
      `${JSON.stringify(imageSrc)} must not reach the page`,
    );
  }
  // The reviewed Pancake CDN shape is accepted, like every other storefront image.
  assert.notEqual(
    resolveCollectionPromoRow([slot(SOURCE, { imageSrc: IMAGE("promo") }), slot(OTHER)], promoCollections),
    null,
  );
});

test("a blank CTA label or two slots on one collection omit the row", () => {
  assert.equal(resolveCollectionPromoRow([slot(SOURCE, { ctaLabel: "  " }), slot(OTHER)], promoCollections), null);
  assert.equal(resolveCollectionPromoRow([slot(SOURCE), slot(SOURCE)], promoCollections), null);
});

test("the loader reads each mapped promo collection once", () => {
  const rows: HomepageConfig["promoRows"] = [
    [slot(SOURCE), slot(OTHER)],
    [slot(OTHER), null],
  ];
  assert.deepEqual(listPromoCollectionSlugs(rows), [SOURCE, OTHER]);
});

/* ---------------------------------------------------------- YOUR NEXT FAVOURITE */

const allCategoryMedia = () =>
  new Map<string, string>(NEXT_FAVOURITE_CATEGORY_KEYS.map((key) => [key, IMAGE(`category-${key}`)]));

test("YOUR NEXT FAVOURITE renders the four canonical categories with labels and hrefs from CATEGORY_NAVIGATION", () => {
  const tiles = resolveCategoryDiscovery(allCategoryMedia());

  assert.deepEqual(NEXT_FAVOURITE_CATEGORY_KEYS, ["aoDai", "vayDam", "setDo", "phuKien"]);
  const expected = NEXT_FAVOURITE_CATEGORY_KEYS.map((key) => {
    const category = CATEGORY_NAVIGATION.find((candidate) => candidate.key === key)!;
    return { key, label: category.label, href: category.href, imageUrl: IMAGE(`category-${key}`) };
  });
  assert.deepEqual(tiles, expected);
  assert.deepEqual(
    tiles?.map((tile) => tile.href),
    ["/ao-dai", "/vay-dam", "/set-do", "/phu-kien"],
  );
});

test("one missing category image omits the whole section, never three tiles", () => {
  for (const key of NEXT_FAVOURITE_CATEGORY_KEYS) {
    const media = allCategoryMedia();
    media.delete(key);
    assert.equal(resolveCategoryDiscovery(media), null, `missing ${key} must close the section`);
  }
});

test("one untrusted category image omits the whole section", () => {
  const media = allCategoryMedia();
  media.set("phuKien", "https://evil.example.com/phu-kien.jpg");
  assert.equal(resolveCategoryDiscovery(media), null);
});

test("a category the navigation no longer declares omits the section instead of inventing a tile", () => {
  const withoutAccessories = CATEGORY_NAVIGATION.filter((category) => category.key !== "phuKien");
  assert.equal(resolveCategoryDiscovery(allCategoryMedia(), withoutAccessories), null);
});

test("homepage config carries no category image map or manual product list", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../../src/content/homepage.config.ts", import.meta.url), "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  for (const duplicate of ["manualProductSlugs", "imageByCategoryKey", "productSlugs", "heroImageUrl"]) {
    assert.equal(code.includes(duplicate), false, `${duplicate} would duplicate an existing authority`);
  }
});

/* ------------------------------------------------------------------ view model */

const noEvents = new Map<string, TrackingEvent>();

const FEEDBACK: FeedbackContent = {
  title: "Khách hàng",
  ctaLabel: "Xem thêm",
  metadataTitle: "Khách hàng",
  metadataDescription: "Ảnh khách hàng.",
  images: [{ src: "/feedback/1.webp", alt: "" }],
};

const emptyInput = {
  config: HOMEPAGE_CONFIG,
  specialDeals: { selection: null, selectEventBySlug: noEvents },
  promoRows: [null, null] as const,
  categoryTiles: null,
  feedback: null,
};

test("the view model is exactly the refreshed sections, in page order; the retired ones are gone", () => {
  const model = buildHomeViewModel(emptyInput);

  assert.deepEqual(Object.keys(model), [
    "specialDeals",
    "promoRowA",
    "categoryDiscovery",
    "promoRowB",
    "feedback",
  ]);
  for (const retired of ["newArrivals", "featured", "storyPanel", "collections", "brandFacts", "categoryHeroMedia"]) {
    assert.equal(retired in model, false, `${retired} must not be part of the homepage any more`);
  }
});

test("pending content leaves every refreshed section absent rather than invented", () => {
  const model = buildHomeViewModel(emptyInput);

  assert.deepEqual(
    [model.specialDeals, model.promoRowA, model.categoryDiscovery, model.promoRowB, model.feedback],
    [null, null, null, null, null],
  );
});

test("the SPECIAL DEALS title is the spec's fixed constant, not something config can redefine", () => {
  assert.equal(SPECIAL_DEALS_TITLE, "SPECIAL DEALS");
  assert.deepEqual(Object.keys(HOMEPAGE_CONFIG.specialDeals).sort(), [
    "ctaLabel",
    "sourceCollectionSlug",
    "supportingCopy",
  ]);
});

test("SPECIAL DEALS cards keep visible order and their prebuilt select events", async () => {
  const selection = await loadSpecialDeals(reads({ manual: ["d", "a", "c", "b"].map((slug) => product(slug)) }));
  const event = { name: "select_item", payload: { list: "homepage-special-deals" } } as unknown as TrackingEvent;
  const model = buildHomeViewModel({
    ...emptyInput,
    specialDeals: { selection, selectEventBySlug: new Map([["a", event]]) },
  });

  assert.equal(model.specialDeals?.title, "SPECIAL DEALS");
  assert.equal(model.specialDeals?.ctaLabel, "Xem thêm");
  assert.equal(model.specialDeals?.href, `/collections/${SOURCE}`);
  assert.equal(model.specialDeals?.collectionTitle, "Hè 2026");
  assert.deepEqual(
    model.specialDeals?.cards.map((card) => card.model.href),
    ["/shop/d", "/shop/a", "/shop/c", "/shop/b"],
  );
  assert.equal(model.specialDeals?.cards[1]?.model.selectEvent, event);
  assert.equal(model.specialDeals?.cards[0]?.model.selectEvent, null);
});

test("promo rows keep their positions around YOUR NEXT FAVOURITE", () => {
  const rowA = resolveCollectionPromoRow([slot(SOURCE), slot(OTHER)], promoCollections);
  const model = buildHomeViewModel({
    ...emptyInput,
    promoRows: [rowA, null],
    categoryTiles: resolveCategoryDiscovery(allCategoryMedia()),
  });

  assert.equal(model.promoRowA, rowA);
  assert.equal(model.promoRowB, null);
  assert.equal(model.categoryDiscovery?.title, "YOUR NEXT FAVOURITE");
  assert.equal(model.categoryDiscovery?.tiles.length, 4);
});

test("the feedback section links to /feedback and keeps the configured image order", () => {
  const images = [
    { src: "/feedback/3.webp", alt: "Ảnh 3" },
    { src: "/feedback/1.webp", alt: "" },
    { src: "/feedback/2.webp", alt: "Ảnh 2" },
  ];
  const model = buildHomeViewModel({ ...emptyInput, feedback: { ...FEEDBACK, images } });

  assert.equal(model.feedback?.href, "/feedback");
  assert.equal(model.feedback?.ctaLabel, "Xem thêm");
  assert.deepEqual(model.feedback?.images, images);
});

test("the view model is frozen so markup cannot mutate a decision it was handed", () => {
  assert.equal(Object.isFrozen(buildHomeViewModel(emptyInput)), true);
});

/* ------------------------------------------------------- the page's refresh window */

const MAX = MAX_STOREFRONT_PROMOTION_REFRESH_MS;

test("the SPECIAL DEALS boundary governs the page's refresh", () => {
  assert.equal(resolveHomeRefreshAfterMs([5_000]), 5_000);
  assert.equal(resolveHomeRefreshAfterMs([0]), 0);
});

test("a page with no priced grid still revalidates within the reviewed ceiling", () => {
  assert.equal(resolveHomeRefreshAfterMs([]), MAX);
});

test("an unusable window is ignored instead of poisoning the page's refresh", () => {
  assert.equal(resolveHomeRefreshAfterMs([Number.NaN, 5_000]), 5_000);
  assert.equal(resolveHomeRefreshAfterMs([-1, MAX]), MAX);
});
