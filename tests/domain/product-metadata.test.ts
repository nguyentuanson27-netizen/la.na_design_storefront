import assert from "node:assert/strict";
import test from "node:test";

import {
  buildStorefrontProductMetadata,
  MAX_OPEN_GRAPH_IMAGES,
} from "../../src/seo/product-metadata.ts";
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

const coded = (
  overrides: Partial<Omit<typeof baseProduct, "seoTitle" | "seoDescription">> & {
    productCode?: string | null;
    seoTitle?: string | null;
    seoDescription?: string | null;
  },
) => ({
  ...baseProduct,
  slug: "set-vay-sv605-01dd0809c343402da7d6",
  ...overrides,
});

test("a product with a code is told apart by the code, not by a hash-ending slug", () => {
  const metadata = buildStorefrontProductMetadata({
    origin: "https://shop.example.com",
    indexingEnabled: true,
    product: coded({ productCode: "SV605", seoTitle: "Set Váy Tơ Gương", seoDescription: "Set váy tơ gương thêu hoa sen." }),
  });
  assert.equal(metadata.title, "Set Váy Tơ Gương SV605");
  assert.equal(metadata.description, "Set váy tơ gương thêu hoa sen.");
  assert.doesNotMatch(String(metadata.title), /01dd0809/);
  assert.doesNotMatch(String(metadata.description), /\/shop\//);
});

test("the code is not repeated when the published title already carries it", () => {
  const metadata = buildStorefrontProductMetadata({
    origin: "https://shop.example.com",
    indexingEnabled: true,
    product: coded({ productCode: "SV605", seoTitle: "Set Váy SV605 Tơ Gương Thêu Hoa Sen" }),
  });
  assert.equal(metadata.title, "Set Váy SV605 Tơ Gương Thêu Hoa Sen");
});

test("a brand typed at the end of the SEO title is not doubled by the site title template", () => {
  for (const typed of ["Set Váy Tơ Gương | La.na Design", "Set Váy Tơ Gương - La.na Design", "Set Váy Tơ Gương — la.na design"]) {
    const metadata = buildStorefrontProductMetadata({
      origin: "https://shop.example.com",
      indexingEnabled: true,
      product: coded({ productCode: "SV605", seoTitle: typed }),
    });
    assert.equal(metadata.title, "Set Váy Tơ Gương SV605", typed);
  }
  const inside = buildStorefrontProductMetadata({
    origin: "https://shop.example.com",
    indexingEnabled: true,
    product: coded({ productCode: "SV605", seoTitle: "La.na Design Set Váy Tơ Gương" }),
  });
  assert.equal(inside.title, "La.na Design Set Váy Tơ Gương SV605");
});

test("fallback copy with a code names the code and carries no path", () => {
  const metadata = buildStorefrontProductMetadata({
    origin: "https://shop.example.com",
    indexingEnabled: true,
    product: coded({ productCode: "SV9574", name: "Set váy Bạch Lăng", seoTitle: null, seoDescription: null }),
  });
  assert.equal(metadata.title, "Set váy Bạch Lăng SV9574");
  assert.match(String(metadata.description), /^Thông tin sản phẩm Set váy Bạch Lăng \(mã SV9574\) tại .+\.$/);
});

test("two products sharing a name and no published copy stay distinct through their codes", () => {
  const build = (productCode: string, slug: string) =>
    buildStorefrontProductMetadata({
      origin: "https://shop.example.com",
      indexingEnabled: true,
      product: coded({ productCode, slug, name: "Set váy Bạch Lăng", seoTitle: null, seoDescription: null }),
    });
  const [a, b] = [build("SV9574", "set-vay-sv9574-aaa"), build("SV9575", "set-vay-sv9575-bbb")];
  assert.notEqual(a.title, b.title);
  assert.notEqual(a.description, b.description);
});

test("a blank code behaves as no code, keeping the slug discriminator", () => {
  const metadata = buildStorefrontProductMetadata({
    origin: "https://shop.example.com",
    indexingEnabled: true,
    product: coded({ productCode: "   ", seoTitle: "Set Váy", seoDescription: "Mô tả." }),
  });
  assert.equal(metadata.title, "Set Váy — set-vay-sv605-01dd0809c343402da7d6");
  assert.equal(metadata.description, "Mô tả. — /shop/set-vay-sv605-01dd0809c343402da7d6.");
});

test("openGraph.images includes primary image first followed by gallery images", () => {
  const galleryImage1 = {
    url: "https://content.pancake.vn/1/2/3/4/ao-oxford-g1.jpg",
    alt: "Áo Oxford Relaxed - Ảnh 2",
  };
  const galleryImage2 = {
    url: "https://content.pancake.vn/1/2/3/4/ao-oxford-g2.jpg",
    alt: "Áo Oxford Relaxed - Ảnh 3",
  };

  const metadata = buildStorefrontProductMetadata({
    origin: "https://shop.example.com",
    indexingEnabled: true,
    product: {
      ...baseProduct,
      media: {
        primary: trustedPrimary,
        gallery: [galleryImage1, galleryImage2],
      },
    },
  });

  assert.deepEqual(metadata.openGraph?.images, [
    trustedPrimary,
    galleryImage1,
    galleryImage2,
  ]);
  // Twitter Card summary_large_image should keep strictly one image
  assert.deepEqual(metadata.twitter?.images, [trustedPrimary]);
});

test("openGraph.images deduplicates primary image if present in gallery", () => {
  const metadata = buildStorefrontProductMetadata({
    origin: "https://shop.example.com",
    indexingEnabled: true,
    product: {
      ...baseProduct,
      media: {
        primary: trustedPrimary,
        gallery: [
          trustedPrimary, // duplicate of primary
          { url: "https://content.pancake.vn/1/2/3/4/ao-oxford-g1.jpg", alt: "Ảnh 2" },
        ],
      },
    },
  });

  const ogImages = Array.isArray(metadata.openGraph?.images) ? metadata.openGraph.images : [];
  assert.equal(ogImages.length, 2);
  assert.deepEqual(ogImages[0], trustedPrimary);
});

test("openGraph.images is bounded by MAX_OPEN_GRAPH_IMAGES", () => {
  const extraImages = Array.from({ length: 15 }, (_, i) => ({
    url: `https://content.pancake.vn/1/2/3/4/gallery-${i}.jpg`,
    alt: `Ảnh ${i}`,
  }));

  const metadata = buildStorefrontProductMetadata({
    origin: "https://shop.example.com",
    indexingEnabled: true,
    product: {
      ...baseProduct,
      media: {
        primary: trustedPrimary,
        gallery: extraImages,
      },
    },
  });

  const ogImages = Array.isArray(metadata.openGraph?.images) ? metadata.openGraph.images : [];
  assert.equal(ogImages.length, MAX_OPEN_GRAPH_IMAGES);
  assert.deepEqual(ogImages[0], trustedPrimary);
});

test("openGraph.images falls back to SOCIAL_FALLBACK_IMAGE when primary is null and gallery is empty", () => {
  const metadata = buildStorefrontProductMetadata({
    origin: "https://shop.example.com",
    indexingEnabled: true,
    product: {
      ...baseProduct,
      media: {
        primary: null,
        gallery: [],
      },
    },
  });

  assert.deepEqual(metadata.openGraph?.images, [SOCIAL_FALLBACK_IMAGE]);
  assert.deepEqual(metadata.twitter?.images, [SOCIAL_FALLBACK_IMAGE]);
});

