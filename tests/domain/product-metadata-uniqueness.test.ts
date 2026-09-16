import assert from "node:assert/strict";
import test from "node:test";

import { buildStorefrontProductMetadata } from "../../src/seo/product-metadata.ts";
import {
  buildSlugFreeProductCopy,
  evaluateProductMetadataUniqueness,
  findProductMetadataCollisions,
} from "../../src/seo/product-metadata-uniqueness.ts";

const media = { primary: null } as const;

type MetadataFixture = Readonly<{
  slug: string;
  name: string;
  seoTitle: string | null;
  seoDescription: string | null;
  media: typeof media;
}>;

/** Two products whose editors published the same SEO copy. Nothing in the schema prevents this. */
const duplicatePublished: readonly MetadataFixture[] = [
  {
    slug: "ao-oxford-relaxed-den",
    name: "Áo Oxford Relaxed",
    seoTitle: "Áo Oxford Relaxed nam",
    seoDescription: "Áo Oxford Relaxed của La.na Design với phom hiện đại.",
    media,
  },
  {
    slug: "ao-oxford-relaxed-trang",
    name: "Áo Oxford Relaxed",
    seoTitle: "Áo Oxford Relaxed nam",
    seoDescription: "Áo Oxford Relaxed của La.na Design với phom hiện đại.",
    media,
  },
];

/** Two products sharing a name with no published SEO copy, so both fall back to the same sentences. */
const duplicateFallback: readonly MetadataFixture[] = [
  { slug: "ao-thun-basic-den", name: "Áo thun Basic", seoTitle: null, seoDescription: null, media },
  { slug: "ao-thun-basic-trang", name: "Áo thun Basic", seoTitle: null, seoDescription: null, media },
];

const distinct: readonly MetadataFixture[] = [
  { slug: "ao-oxford-relaxed", name: "Áo Oxford Relaxed", seoTitle: null, seoDescription: null, media },
  { slug: "ao-thun-basic", name: "Áo thun Basic", seoTitle: null, seoDescription: null, media },
];

function currentCopy(product: MetadataFixture) {
  const metadata = buildStorefrontProductMetadata({
    origin: "https://shop.example.com",
    indexingEnabled: true,
    product,
  });
  return { title: metadata.title, description: metadata.description };
}

test("W2a the current slug-bearing contract keeps every collision class distinct", () => {
  for (const group of [duplicatePublished, duplicateFallback]) {
    const [first, second] = group.map(currentCopy);
    assert.notEqual(first?.title, second?.title);
    assert.notEqual(first?.description, second?.description);
  }
});

test("W2a the slug-free replacement candidate is deterministic and carries no technical path", () => {
  const copy = buildSlugFreeProductCopy(duplicatePublished[0]);

  assert.deepEqual(copy, buildSlugFreeProductCopy(duplicatePublished[0]));
  assert.equal(copy.title, "Áo Oxford Relaxed nam");
  assert.equal(copy.description, "Áo Oxford Relaxed của La.na Design với phom hiện đại.");
  for (const value of [copy.title, copy.description]) {
    assert.equal(value.includes("/shop/"), false);
    assert.equal(value.includes(duplicatePublished[0].slug), false);
  }

  const fallback = buildSlugFreeProductCopy(duplicateFallback[0]);
  assert.equal(fallback.title, "Áo thun Basic");
  assert.equal(fallback.description, "Thông tin sản phẩm Áo thun Basic tại La.na Design.");
});

test("W2a collision detection reports the exact groups that would stop being distinguishable", () => {
  assert.deepEqual(findProductMetadataCollisions(distinct), []);

  assert.deepEqual(findProductMetadataCollisions(duplicatePublished), [
    {
      title: "Áo Oxford Relaxed nam",
      description: "Áo Oxford Relaxed của La.na Design với phom hiện đại.",
      slugs: ["ao-oxford-relaxed-den", "ao-oxford-relaxed-trang"],
    },
  ]);

  assert.deepEqual(findProductMetadataCollisions(duplicateFallback), [
    {
      title: "Áo thun Basic",
      description: "Thông tin sản phẩm Áo thun Basic tại La.na Design.",
      slugs: ["ao-thun-basic-den", "ao-thun-basic-trang"],
    },
  ]);
});

test("W2a collision groups are reported deterministically regardless of input order", () => {
  const forward = findProductMetadataCollisions([...duplicateFallback, ...duplicatePublished]);
  const reversed = findProductMetadataCollisions([
    duplicatePublished[1],
    duplicateFallback[1],
    duplicatePublished[0],
    duplicateFallback[0],
  ]);

  assert.deepEqual(forward, reversed);
  assert.equal(forward.length, 2);
});

test("W2a title-only or description-only overlap is not a collision", () => {
  const sameTitleOnly: readonly MetadataFixture[] = [
    { slug: "a", name: "Áo", seoTitle: "Áo nam", seoDescription: "Mô tả A.", media },
    { slug: "b", name: "Áo", seoTitle: "Áo nam", seoDescription: "Mô tả B.", media },
  ];

  assert.deepEqual(findProductMetadataCollisions(sameTitleOnly), []);
});

test("W2a the uniqueness verdict gates removal of the slug discriminator on real evidence", () => {
  assert.deepEqual(evaluateProductMetadataUniqueness(distinct), {
    safeToRemoveSlugDiscriminator: true,
    collidingProductCount: 0,
    collisions: [],
  });

  const verdict = evaluateProductMetadataUniqueness([...duplicatePublished, ...duplicateFallback]);
  assert.equal(verdict.safeToRemoveSlugDiscriminator, false);
  assert.equal(verdict.collidingProductCount, 4);
  assert.equal(verdict.collisions.length, 2);
});

test("W2a an empty or single-product catalog is trivially safe rather than an error", () => {
  assert.equal(evaluateProductMetadataUniqueness([]).safeToRemoveSlugDiscriminator, true);
  assert.equal(
    evaluateProductMetadataUniqueness([duplicatePublished[0]]).safeToRemoveSlugDiscriminator,
    true,
  );
});

test("W2a the live PDP metadata contract is unchanged while the replacement stays unproven", () => {
  const metadata = buildStorefrontProductMetadata({
    origin: "https://shop.example.com",
    indexingEnabled: true,
    product: duplicatePublished[0],
  });

  assert.equal(metadata.title, "Áo Oxford Relaxed nam — ao-oxford-relaxed-den");
  assert.equal(
    metadata.description,
    "Áo Oxford Relaxed của La.na Design với phom hiện đại. — /shop/ao-oxford-relaxed-den.",
  );
});
