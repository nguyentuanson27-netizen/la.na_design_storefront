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

test("builds parent item priced from the orderable options only, in_stock when one is available", () => {
  const items = buildMerchantParentItems([candidate()], ORIGIN);
  assert.equal(items.length, 1);
  const item = items[0]!;
  assert.equal(item.id, "prod-sd1701");
  assert.equal(item.title, "Áo dài Đan Hoa SD1701");
  assert.equal(item.priceVnd, 899_000); // The sold-out 849000 size is not an offer anyone can order
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
        projectionOption({ price: 899_000, purchasable: false, unavailableReason: "OUT_OF_STOCK" }),
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

test("an undated preorder is withheld, never published as out_of_stock (ADR 0011)", () => {
  const prod = candidate({
    projection: {
      mode: "standalone",
      options: [projectionOption({ price: 899_000, purchasable: true, isPreorderSale: true })],
    },
  });
  assert.deepEqual(buildMerchantParentItems([prod], ORIGIN), []);
});

test("an expired preorder date and unreadable stock are withheld too", () => {
  const expired = projectionOption({ price: 899_000, purchasable: true, isPreorderSale: true });
  const withExpiredDate = {
    ...expired,
    availability: fixtureAvailability(expired, { availabilityDate: "2026-09-01", today: "2026-10-09" }),
  };
  const unreadable = projectionOption({ id: "u", price: 899_000, purchasable: false, unavailableReason: null });
  const items = buildMerchantParentItems(
    [
      candidate({ pancakeProductId: "p-expired", slug: "ao-expired", projection: { mode: "standalone", options: [withExpiredDate] } }),
      candidate({ pancakeProductId: "p-unreadable", slug: "ao-unreadable", projection: { mode: "standalone", options: [unreadable] } }),
    ],
    ORIGIN,
  );
  assert.deepEqual(items, []);
});

test("a mix of sold-out and unresolved sizes is withheld; only a provably sold-out product is out_of_stock", () => {
  const soldOut = projectionOption({ id: "so", price: 899_000, purchasable: false, unavailableReason: "OUT_OF_STOCK" });
  const unresolved = projectionOption({ id: "un", size: "M", price: 899_000, purchasable: false, unavailableReason: null });
  const mixed = candidate({ projection: { mode: "standalone", options: [soldOut, unresolved] } });
  assert.deepEqual(buildMerchantParentItems([mixed], ORIGIN), []);

  const genuine = candidate({ projection: { mode: "standalone", options: [soldOut] } });
  const [item] = buildMerchantParentItems([genuine], ORIGIN);
  assert.equal(item!.availability, "out_of_stock");
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
  assert.ok(feed.body.includes("<g:price>899000 VND</g:price>"));
  assert.ok(feed.body.includes("<g:availability>in_stock</g:availability>"));
  assert.ok(feed.body.includes("Mô tả chuẩn &amp; độc quyền &lt;La.na&gt;"));
});

test("serializes Facebook Parent feed with Meta availability formatting", () => {
  const items = buildMerchantParentItems([candidate()], ORIGIN);
  const feed = serializeFacebookParentFeed({ items, market: MARKET, origin: ORIGIN });
  assert.ok(feed.body.includes("<g:availability>in stock</g:availability>"));
  assert.ok(feed.body.includes("<g:price>899000 VND</g:price>"));
});

test("price is the cheapest ORDERABLE option; a cheaper sold-out size never sets the price", () => {
  const prod = candidate({
    projection: {
      mode: "standalone",
      options: [
        projectionOption({ price: 1_000_000, purchasable: true }),
        projectionOption({ price: 950_000, purchasable: true }),
        projectionOption({ price: 500_000, purchasable: false }),
      ],
    },
  });
  const [item] = buildMerchantParentItems([prod], ORIGIN);
  assert.equal(item!.priceVnd, 950_000);
  assert.equal(item!.availability, "in_stock");
});

test("a fully sold-out product keeps its lowest listed price as out_of_stock", () => {
  const prod = candidate({
    projection: {
      mode: "standalone",
      options: [
        projectionOption({ price: 900_000, purchasable: false, unavailableReason: "OUT_OF_STOCK" }),
        projectionOption({ price: 850_000, purchasable: false, unavailableReason: "OUT_OF_STOCK" }),
      ],
    },
  });
  const [item] = buildMerchantParentItems([prod], ORIGIN);
  assert.equal(item!.availability, "out_of_stock");
  assert.equal(item!.priceVnd, 850_000);
});

test("an invalid stored apparel override withholds the product instead of publishing defaults", () => {
  const bad = candidate({
    apparelOverrides: { ...INHERITED_APPAREL_OVERRIDES, gender: "invalid" } as never,
  });
  const good = candidate({ pancakeProductId: "prod-ok", slug: "ao-dai-ok" });
  const items = buildMerchantParentItems([bad, good], ORIGIN);
  assert.deepEqual(items.map((i) => i.id), ["prod-ok"]);
});

test("backorder price and date come from the same option: the cheapest one, with its own date", () => {
  const dated = (price: number, availabilityDate: string) => {
    const option = projectionOption({ price, purchasable: true, isPreorderSale: true });
    return {
      ...option,
      availability: fixtureAvailability(option, { availabilityDate, today: "2026-10-09" }),
    };
  };
  const prod = candidate({
    projection: {
      mode: "standalone",
      options: [dated(750_000, "2026-12-04"), dated(900_000, "2026-11-20")],
    },
  });
  const [item] = buildMerchantParentItems([prod], ORIGIN);
  assert.equal(item!.availability, "backorder");
  // The same option supplies both: 750000 with ITS date, never 750000 with the other size's 11-20.
  assert.equal(item!.priceVnd, 750_000);
  assert.equal(item!.availabilityDate, "2026-12-04");
});
