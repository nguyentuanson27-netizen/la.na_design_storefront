import assert from "node:assert/strict";
import test from "node:test";

import { buildStorefrontProductMetadata } from "../../src/seo/product-metadata.ts";
import { SOCIAL_FALLBACK_ALT, SOCIAL_FALLBACK_PATH } from "../../src/seo/social-identity.ts";

// Derived from the brand's own social identity: the fallback card is renamed per fork by
// `bootstrap:brand`, so pinning the template's filename here would fail every brand but the first.
const SOCIAL_FALLBACK_IMAGE = {
  url: `https://shop.example.com${SOCIAL_FALLBACK_PATH}`,
  alt: SOCIAL_FALLBACK_ALT,
};

const trustedPrimary = {
  url: "https://content.pancake.vn/1/2/3/4/ao-oxford.jpg",
  alt: "Áo Oxford Relaxed",
};

const baseProduct = {
  slug: "ao-oxford-relaxed",
  name: "Áo Oxford Relaxed",
  seoTitle: "Áo Oxford Relaxed nam",
  seoDescription: "Áo Oxford Relaxed của La.na Design với phom hiện đại và thông tin sản phẩm đã được biên tập.",
  media: {
    primary: trustedPrimary,
  },
};

test("P13 builds canonical PDP metadata from published website-owned SEO fields and trusted product media", () => {
  const metadata = buildStorefrontProductMetadata({
    origin: "https://shop.example.com",
    indexingEnabled: true,
    product: baseProduct,
  });
  const title = `${baseProduct.seoTitle} — ${baseProduct.slug}`;
  const description = `${baseProduct.seoDescription} — /shop/${baseProduct.slug}.`;

  assert.equal(metadata.title, title);
  assert.equal(metadata.description, description);
  assert.deepEqual(metadata.alternates, {
    canonical: "https://shop.example.com/shop/ao-oxford-relaxed",
  });
  assert.deepEqual(metadata.openGraph, {
    type: "website",
    locale: "vi_VN",
    siteName: "La.na Design",
    title,
    description,
    url: "https://shop.example.com/shop/ao-oxford-relaxed",
    images: [
      {
        url: trustedPrimary.url,
        alt: trustedPrimary.alt,
      },
    ],
  });
  assert.deepEqual(metadata.twitter, {
    card: "summary_large_image",
    title,
    description,
    images: [
      {
        url: trustedPrimary.url,
        alt: trustedPrimary.alt,
      },
    ],
  });
});

test("P13 published SEO copy remains unique across distinct canonical product slugs", () => {
  const first = buildStorefrontProductMetadata({
    origin: "https://shop.example.com",
    indexingEnabled: true,
    product: {
      ...baseProduct,
      slug: "ao-oxford-relaxed-den",
    },
  });
  const second = buildStorefrontProductMetadata({
    origin: "https://shop.example.com",
    indexingEnabled: true,
    product: {
      ...baseProduct,
      slug: "ao-oxford-relaxed-trang",
    },
  });

  assert.equal(first.title, `${baseProduct.seoTitle} — ao-oxford-relaxed-den`);
  assert.equal(second.title, `${baseProduct.seoTitle} — ao-oxford-relaxed-trang`);
  assert.equal(
    first.description,
    `${baseProduct.seoDescription} — /shop/ao-oxford-relaxed-den.`,
  );
  assert.equal(
    second.description,
    `${baseProduct.seoDescription} — /shop/ao-oxford-relaxed-trang.`,
  );
  assert.notEqual(first.title, second.title);
  assert.notEqual(first.description, second.description);
  assert.deepEqual(first.alternates, {
    canonical: "https://shop.example.com/shop/ao-oxford-relaxed-den",
  });
  assert.deepEqual(second.alternates, {
    canonical: "https://shop.example.com/shop/ao-oxford-relaxed-trang",
  });
});

test("P13 fallback metadata stays factual and unique for distinct slugs sharing the same product name", () => {
  const first = buildStorefrontProductMetadata({
    origin: "https://shop.example.com",
    indexingEnabled: true,
    product: {
      ...baseProduct,
      slug: "ao-oxford-relaxed-den",
      seoTitle: null,
      seoDescription: null,
      media: { primary: null },
    },
  });
  const second = buildStorefrontProductMetadata({
    origin: "https://shop.example.com",
    indexingEnabled: true,
    product: {
      ...baseProduct,
      slug: "ao-oxford-relaxed-trang",
      seoTitle: null,
      seoDescription: null,
      media: { primary: null },
    },
  });

  assert.equal(first.title, "Áo Oxford Relaxed — ao-oxford-relaxed-den");
  assert.equal(
    first.description,
    "Thông tin sản phẩm Áo Oxford Relaxed tại La.na Design — /shop/ao-oxford-relaxed-den.",
  );
  assert.equal(second.title, "Áo Oxford Relaxed — ao-oxford-relaxed-trang");
  assert.equal(
    second.description,
    "Thông tin sản phẩm Áo Oxford Relaxed tại La.na Design — /shop/ao-oxford-relaxed-trang.",
  );
  assert.notEqual(first.title, second.title);
  assert.notEqual(first.description, second.description);
  assert.deepEqual(first.alternates, {
    canonical: "https://shop.example.com/shop/ao-oxford-relaxed-den",
  });
  assert.deepEqual(second.alternates, {
    canonical: "https://shop.example.com/shop/ao-oxford-relaxed-trang",
  });
  assert.deepEqual(first.openGraph?.images, [SOCIAL_FALLBACK_IMAGE]);
  assert.deepEqual(first.twitter?.images, [SOCIAL_FALLBACK_IMAGE]);
});

test("P13 never rewrites trusted remote Pancake media through a website proxy or storage path", () => {
  const metadata = buildStorefrontProductMetadata({
    origin: "https://shop.example.com",
    indexingEnabled: true,
    product: baseProduct,
  });

  assert.deepEqual(metadata.openGraph?.images, [
    {
      url: trustedPrimary.url,
      alt: trustedPrimary.alt,
    },
  ]);
  assert.deepEqual(metadata.twitter?.images, [
    {
      url: trustedPrimary.url,
      alt: trustedPrimary.alt,
    },
  ]);
});

test("P13 withholds the canonical tag while search indexing is disabled", () => {
  const metadata = buildStorefrontProductMetadata({
    origin: "https://la.lanadesign.vn",
    indexingEnabled: false,
    product: baseProduct,
  });

  assert.equal(metadata.alternates, undefined);
  assert.equal(metadata.openGraph?.url, "https://la.lanadesign.vn/shop/ao-oxford-relaxed");
});
