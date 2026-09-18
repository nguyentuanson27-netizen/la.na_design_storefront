import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { MerchantMarketPolicy, MerchantOffer } from "../../src/commerce/merchant-offer-mapper.ts";
import {
  MerchantFeedByteOverflowError,
  MerchantFeedSerializationError,
  assertMerchantOfferCount,
  serializeMerchantFeed,
} from "../../src/commerce/merchant-feed-serializer.ts";
import {
  MAX_MERCHANT_FEED_BYTES,
  MAX_MERCHANT_OFFERS,
} from "../../src/commerce/merchant-feed-limits.ts";

const MARKET: MerchantMarketPolicy = {
  targetCountry: "VN",
  contentLanguage: "vi",
  currency: "VND",
};

function offer(overrides: Partial<MerchantOffer> = {}): MerchantOffer {
  return {
    id: "variation-1",
    itemGroupId: "product-1",
    brand: "LA Clothing",
    mpn: "MPN-1",
    title: "Áo & quần <đẹp> 👕",
    description: "Mô tả & chi tiết > cơ bản",
    link: "https://shop.example.test/products/ao?variant=variation-1&view=full",
    imageLink: "https://cdn.example.test/a&b.jpg",
    additionalImageLinks: ["https://cdn.example.test/2.jpg"],
    availability: "in_stock",
    availabilityDate: null,
    priceVnd: 249000,
    gender: "male",
    ageGroup: "adult",
    condition: "new",
    color: "Đen & Trắng",
    size: "M",
    ...overrides,
  };
}

describe("Merchant RSS serializer", () => {
  it("emits deterministic complete RSS 2.0 bytes from U25 facts", () => {
    const input = [
      offer({ id: "variation-2", itemGroupId: "product-2", mpn: "MPN-2" }),
      offer(),
    ];

    const first = serializeMerchantFeed({
      offers: input,
      market: MARKET,
      origin: "https://shop.example.test",
    });
    const second = serializeMerchantFeed({
      offers: [...input].reverse(),
      market: MARKET,
      origin: "https://shop.example.test",
    });

    assert.equal(first.body, second.body);
    assert.equal(first.byteLength, new TextEncoder().encode(first.body).byteLength);
    assert.equal(first.body.startsWith('<?xml version="1.0" encoding="UTF-8"?>'), true);
    assert.equal(first.body.includes('<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">'), true);
    assert.equal(first.body.endsWith("</channel></rss>\n"), true);
    assert.equal(first.body.indexOf("variation-1") < first.body.indexOf("variation-2"), true);
    assert.equal(first.body.includes("<g:price>249000 VND</g:price>"), true);
    assert.equal(first.body.includes("<g:availability>in_stock</g:availability>"), true);
    assert.equal(first.body.includes("<g:item_group_id>product-1</g:item_group_id>"), true);
  });

  it("escapes XML text and counts UTF-8 bytes after escaping expansion", () => {
    const result = serializeMerchantFeed({
      offers: [offer()],
      market: MARKET,
      origin: "https://shop.example.test",
    });

    assert.equal(result.body.includes("Áo &amp; quần &lt;đẹp&gt; 👕"), true);
    assert.equal(result.body.includes("Đen &amp; Trắng"), true);
    assert.equal(result.body.includes("variant=variation-1&amp;view=full"), true);
    assert.equal(result.body.includes("<đẹp>"), false);
    assert.equal(result.byteLength > result.body.length, true);
  });

  it("rejects forbidden XML 1.0 control characters instead of producing malformed output", () => {
    assert.throws(
      () =>
        serializeMerchantFeed({
          offers: [offer({ title: "bad\u0001title" })],
          market: MARKET,
          origin: "https://shop.example.test",
        }),
      MerchantFeedSerializationError,
    );
  });

  for (const [count, allowed] of [
    [MAX_MERCHANT_OFFERS - 1, true],
    [MAX_MERCHANT_OFFERS, true],
    [MAX_MERCHANT_OFFERS + 1, false],
  ] as const) {
    it(`enforces the offer-count boundary at ${count}`, () => {
      if (allowed) assert.doesNotThrow(() => assertMerchantOfferCount(count));
      else assert.throws(() => assertMerchantOfferCount(count), /5,000|5000/);
    });
  }

  it("accepts the exact UTF-8 byte boundary and rejects the next byte without a partial body", () => {
    const baseline = serializeMerchantFeed({
      offers: [offer()],
      market: MARKET,
      origin: "https://shop.example.test",
    });

    assert.doesNotThrow(() =>
      serializeMerchantFeed({
        offers: [offer()],
        market: MARKET,
        origin: "https://shop.example.test",
        maxBytes: baseline.byteLength,
      }),
    );

    assert.throws(
      () =>
        serializeMerchantFeed({
          offers: [offer()],
          market: MARKET,
          origin: "https://shop.example.test",
          maxBytes: baseline.byteLength - 1,
        }),
      MerchantFeedByteOverflowError,
    );
  });

  it("keeps the reviewed production byte ceiling at 16 MiB", () => {
    assert.equal(MAX_MERCHANT_FEED_BYTES, 16 * 1024 * 1024);
  });

  /**
   * I9 — `availability_date` is the one element Google both requires and restricts: `backorder`
   * is invalid without it, and it belongs on nothing else in this feed. So both directions are
   * asserted. The mapper is what decides whether a date exists; the serializer's only job is to
   * emit exactly what it was handed, which is why there is no fallback branch to test.
   */
  it("emits availability_date for a backorder offer and for nothing else", () => {
    const backorder = serializeMerchantFeed({
      offers: [offer({ availability: "backorder", availabilityDate: "2026-10-03" })],
      market: MARKET,
      origin: "https://shop.example.test",
    });
    assert.match(backorder.body, /<g:availability>backorder<\/g:availability>/);
    assert.match(backorder.body, /<g:availability_date>2026-10-03<\/g:availability_date>/);

    for (const availability of ["in_stock", "out_of_stock"] as const) {
      const plain = serializeMerchantFeed({
        offers: [offer({ availability })],
        market: MARKET,
        origin: "https://shop.example.test",
      });
      assert.equal(
        plain.body.includes("<g:availability_date>"),
        false,
        `${availability} carries no date`,
      );
    }
  });
});
