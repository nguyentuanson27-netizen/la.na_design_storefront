import assert from "node:assert/strict";
import test from "node:test";

import {
  buildMerchantParentItems,
  serializeGoogleMerchantParentFeed,
  serializeFacebookParentFeed,
} from "../../src/commerce/merchant-parent-feed.ts";
import type { MerchantCandidateProduct, MerchantMarketPolicy } from "../../src/commerce/merchant-offer-mapper.ts";
import { INHERITED_APPAREL_OVERRIDES } from "../../src/commerce/product-merchant-facts-repository.ts";
import { fixtureAvailability, withFixtureAvailability } from "../fixtures/storefront-projection-option.ts";
import { type StorefrontProjectionOption } from "../../src/commerce/storefront-projection.ts";

const ORIGIN = "https://www.lanadesign.vn";
const MARKET: MerchantMarketPolicy = { targetCountry: "VN", contentLanguage: "vi", currency: "VND" };

function projectionOption(overrides: Partial<StorefrontProjectionOption> = {}): StorefrontProjectionOption {
  return withFixtureAvailability({
    id: "variant-s",
    pancakeVariationId: "pv-1",
    color: "Den",
    size: "S",
    price: 799_000,
    basePriceVnd: 799_000,
    isDiscounted: false,
    purchasable: true,
    isPreorderSale: false,
    unavailableReason: null,
    kindKey: null,
    kindLabel: null,
    ...overrides,
  });
}

function candidate(overrides: Partial<MerchantCandidateProduct> = {}): MerchantCandidateProduct {
  return {
    pancakeProductId: "prod-sd1701",
    slug: "ao-dai-dan-hoa-sd1701",
    name: "Áo dài Đan Hoa SD1701",
    publishedDescription: "Mô tả chuẩn & độc quyền <La.na>",
    media: {
      primary: { url: "https://content.pancake.vn/web-media/img-primary.jpg", alt: "Áo dài Đan Hoa" },
      gallery: [
        { url: "https://content.pancake.vn/web-media/img-primary.jpg", alt: "Áo dài Đan Hoa" },
        { url: "https://content.pancake.vn/web-media/img-detail.jpg", alt: "Chi tiết" },
      ],
    },
    galleryIndexByVariantId: new Map(),
    projection: {
      mode: "standalone",
      options: [
        projectionOption({ price: 899_000, purchasable: true }),
        projectionOption({ price: 849_000, purchasable: false }),
      ],
    },
    apparelOverrides: INHERITED_APPAREL_OVERRIDES,
    variations: [
      { variantId: "v-1", pancakeVariationId: "pv-1", pancakeDisplayId: "SD1701-S", isComposite: false, stockQuantity: 5 },
      { variantId: "v-2", pancakeVariationId: "pv-2", pancakeDisplayId: "SD1701-M", isComposite: false, stockQuantity: 0 },
    ],
    ...overrides,
  };
}

test("builds parent item with lowest price across options and in_stock when at least one option is available", () => {
  const items = buildMerchantParentItems([candidate()], ORIGIN);
  assert.equal(items.length, 1);
  const item = items[0]!;
  assert.equal(item.id, "prod-sd1701");
  assert.equal(item.title, "Áo dài Đan Hoa SD1701");
  assert.equal(item.priceVnd, 849_000); // Minimum price across all valid options
  assert.equal(item.availability, "in_stock");
  assert.equal(item.link, "https://www.lanadesign.vn/shop/ao-dai-dan-hoa-sd1701");
  assert.equal(item.imageLink, "https://content.pancake.vn/web-media/img-primary.jpg");
  assert.deepEqual(item.additionalImageLinks, ["https://content.pancake.vn/web-media/img-detail.jpg"]);
  assert.equal(item.description, "Mô tả chuẩn & độc quyền <La.na>");
});

test("Option B fallback description: uses brand default when publishedDescription is null or empty", () => {
  const prodWithoutDesc = candidate({ publishedDescription: null });
  const items = buildMerchantParentItems([prodWithoutDesc], ORIGIN);
  assert.equal(items.length, 1);
  assert.ok(items[0]!.description.includes("Áo dài Đan Hoa SD1701 — Thiết kế cao cấp độc quyền"));
});

test("marks availability as out_of_stock when all options are sold out", () => {
  const prod = candidate({
    projection: {
      mode: "standalone",
      options: [
        projectionOption({ price: 899_000, purchasable: false }),
      ],
    },
  });
  const items = buildMerchantParentItems([prod], ORIGIN);
  assert.equal(items.length, 1);
  assert.equal(items[0]!.availability, "out_of_stock");
});

test("marks availability as backorder, with its availability_date, when options are preorder sale", () => {
  const preorder = projectionOption({ price: 899_000, purchasable: true, isPreorderSale: true });
  const prod = candidate({
    projection: {
      mode: "standalone",
      options: [
        {
          ...preorder,
          availability: fixtureAvailability(preorder, {
            availabilityDate: "2026-11-20",
            today: "2026-10-09",
          }),
        },
      ],
    },
  });
  const items = buildMerchantParentItems([prod], ORIGIN);
  assert.equal(items.length, 1);
  assert.equal(items[0]!.availability, "backorder");
  assert.equal(items[0]!.availabilityDate, "2026-11-20");

  const google = serializeGoogleMerchantParentFeed({ items, market: MARKET, origin: ORIGIN });
  assert.ok(google.body.includes("<g:availability>backorder</g:availability>"));
  assert.ok(google.body.includes("<g:availability_date>"));
  const facebook = serializeFacebookParentFeed({ items, market: MARKET, origin: ORIGIN });
  assert.ok(facebook.body.includes("<g:availability>available for order</g:availability>"));
  assert.ok(facebook.body.includes("<g:availability_date>"));
});

test("an undated preorder is withheld as out_of_stock rather than published as a dateless backorder", () => {
  const prod = candidate({
    projection: {
      mode: "standalone",
      options: [projectionOption({ price: 899_000, purchasable: true, isPreorderSale: true })],
    },
  });
  const items = buildMerchantParentItems([prod], ORIGIN);
  assert.equal(items[0]!.availability, "out_of_stock");
  assert.equal(items[0]!.availabilityDate, null);
});

test("supports composite/combo products without getting blocked", () => {
  const combo = candidate({
    pancakeProductId: "prod-set-01",
    slug: "set-ao-quan-lua",
    name: "Set Áo Quần Lụa",
    projection: {
      mode: "composite",
      options: [
        projectionOption({
          kindKey: "parent",
          price: 1_250_000,
          purchasable: true,
        }),
        projectionOption({
          kindKey: "component",
          price: 650_000,
          purchasable: true,
        }),
      ],
    },
  });
  const items = buildMerchantParentItems([combo], ORIGIN);
  assert.equal(items.length, 1);
  assert.equal(items[0]!.id, "prod-set-01");
  assert.equal(items[0]!.priceVnd, 1_250_000); // Uses parent set price
  assert.equal(items[0]!.availability, "in_stock");
});

test("serializes Google Merchant Parent feed with XML escaping and proper RSS 2.0 structure", () => {
  const items = buildMerchantParentItems([candidate()], ORIGIN);
  const feed = serializeGoogleMerchantParentFeed({ items, market: MARKET, origin: ORIGIN });
  assert.ok(feed.body.includes("<rss version=\"2.0\" xmlns:g=\"http://base.google.com/ns/1.0\">"));
  assert.ok(feed.body.includes("<g:id>prod-sd1701</g:id>"));
  assert.ok(feed.body.includes("<g:title>Áo dài Đan Hoa SD1701</g:title>"));
  assert.ok(feed.body.includes("<g:price>849000 VND</g:price>"));
  assert.ok(feed.body.includes("<g:availability>in_stock</g:availability>"));
  assert.ok(feed.body.includes("Mô tả chuẩn &amp; độc quyền &lt;La.na&gt;"));
});

test("serializes Facebook Parent feed with Meta availability formatting", () => {
  const items = buildMerchantParentItems([candidate()], ORIGIN);
  const feed = serializeFacebookParentFeed({ items, market: MARKET, origin: ORIGIN });
  assert.ok(feed.body.includes("<g:availability>in stock</g:availability>"));
  assert.ok(feed.body.includes("<g:price>849000 VND</g:price>"));
});
