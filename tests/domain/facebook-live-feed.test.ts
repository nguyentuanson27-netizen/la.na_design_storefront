import assert from "node:assert/strict";
import test from "node:test";

import type { MerchantMarketPolicy, MerchantOffer } from "../../src/commerce/merchant-offer-mapper.ts";
import { MerchantFeedByteOverflowError, MerchantFeedOfferOverflowError, MerchantFeedSerializationError } from "../../src/commerce/merchant-feed-serializer.ts";
import { MAX_MERCHANT_CANDIDATE_VARIANTS, MAX_MERCHANT_OFFERS } from "../../src/commerce/merchant-feed-limits.ts";
import {
  buildFacebookLiveItems,
  serializeFacebookLiveFeed,
} from "../../src/commerce/facebook-live-feed.ts";
import { getStorefrontResolvedPriceRange } from "../../src/commerce/storefront-product.ts";

const ORIGIN = "https://www.lanadesign.vn";
const MARKET: MerchantMarketPolicy = { targetCountry: "VN", contentLanguage: "vi", currency: "VND" };

function offer(overrides: Partial<MerchantOffer> = {}): MerchantOffer {
  return {
    id: "sd1701-s",
    itemGroupId: "product-sd1701",
    brand: "LA Clothing",
    mpn: "SD1701-S",
    title: "Áo dài Đan Hoa SD1701",
    description: "Áo dài & thiết kế <La.na>",
    link: `${ORIGIN}/shop/ao-dai-dan-hoa-sd1701?variant=sd1701-s`,
    imageLink: "https://content.pancake.vn/web-media/img-s.jpg",
    additionalImageLinks: ["https://content.pancake.vn/web-media/img-alt.jpg"],
    availability: "in_stock",
    availabilityDate: null,
    priceVnd: 899_000,
    gender: "female",
    ageGroup: "adult",
    condition: "new",
    color: "Trắng",
    size: "S",
    ...overrides,
  };
}

test("three SD1701 sizes produce one parent item while another product remains independent", () => {
  const sizes = [
    offer({ id: "sd1701-s", priceVnd: 899_000 }),
    offer({ id: "sd1701-m", size: "M", link: `${ORIGIN}/shop/ao-dai-dan-hoa-sd1701?variant=sd1701-m`, priceVnd: 929_000, imageLink: "https://content.pancake.vn/web-media/img-m.jpg" }),
    offer({ id: "sd1701-l", size: "L", link: `${ORIGIN}/shop/ao-dai-dan-hoa-sd1701?variant=sd1701-l`, availability: "out_of_stock", priceVnd: 849_000 }),
  ];
  const another = offer({
    id: "other-s", itemGroupId: "another-product", title: "Áo dài Hoa Vi", mpn: "HV-S",
    link: `${ORIGIN}/shop/ao-dai-hoa-vi?variant=other-s`,
  });

  const first = serializeFacebookLiveFeed({ offers: [another, ...sizes], market: MARKET, origin: ORIGIN });
  const reversed = serializeFacebookLiveFeed({ offers: [...sizes].reverse().concat(another), market: MARKET, origin: ORIGIN });

  assert.equal(first.body, reversed.body);
  assert.equal(first.offerCount, 2);
  assert.equal((first.body.match(/<item>/g) ?? []).length, 2);
  assert.match(first.body, /<g:id>product-sd1701<\/g:id>/);
  assert.match(first.body, /<g:link>https:\/\/www\.lanadesign\.vn\/shop\/ao-dai-dan-hoa-sd1701<\/g:link>/);
  assert.match(first.body, /<g:price>849000 VND<\/g:price>/);
  assert.match(first.body, /<g:availability>in stock<\/g:availability>/);
  assert.match(first.body, /Áo dài &amp; thiết kế &lt;La\.na&gt;/);
  assert.doesNotMatch(first.body, /<g:(?:size|color|mpn|item_group_id)>/);
  assert.doesNotMatch(first.body, /<g:id>sd1701-(?:s|m|l)<\/g:id>/);
  assert.doesNotMatch(first.body, /<g:link>[^<]*\?variant=/);
  assert.equal(first.byteLength, new TextEncoder().encode(first.body).byteLength);
});

test("representative image and availability come from the best stock class while price is the cross-size floor the PDP shows", () => {
  const items = buildFacebookLiveItems([
    offer({ id: "sd1701-l", size: "L", availability: "out_of_stock", priceVnd: 699_000, link: `${ORIGIN}/shop/ao-dai-dan-hoa-sd1701?variant=sd1701-l` }),
    offer({ id: "sd1701-m", size: "M", availability: "in_stock", priceVnd: 929_000, link: `${ORIGIN}/shop/ao-dai-dan-hoa-sd1701?variant=sd1701-m` }),
    offer({ id: "sd1701-s", availability: "in_stock", priceVnd: 899_000 }),
  ], ORIGIN);
  assert.equal(items.length, 1);
  assert.equal(items[0]?.priceVnd, 699_000);
  assert.equal(items[0]?.imageLink, "https://content.pancake.vn/web-media/img-s.jpg");
  assert.equal(items[0]?.availability, "in stock");
});

test("advertised price matches the unselected PDP 'Từ' floor even when the cheapest size is sold out or backordered", () => {
  const soldOutCheaper = [
    offer({ id: "sd1701-s", priceVnd: 899_000 }),
    offer({ id: "sd1701-l", size: "L", availability: "out_of_stock", priceVnd: 849_000, link: `${ORIGIN}/shop/ao-dai-dan-hoa-sd1701?variant=sd1701-l` }),
  ];
  const backorderCheaper = [
    offer({ id: "sd1701-s", priceVnd: 899_000 }),
    offer({ id: "sd1701-m", size: "M", availability: "backorder", priceVnd: 829_000, link: `${ORIGIN}/shop/ao-dai-dan-hoa-sd1701?variant=sd1701-m` }),
  ];
  for (const offers of [soldOutCheaper, backorderCheaper]) {
    const floor = getStorefrontResolvedPriceRange(offers.map((o) => ({ price: o.priceVnd })))!.minimum;
    const [item] = buildFacebookLiveItems(offers, ORIGIN);
    assert.equal(item?.priceVnd, floor);
    assert.equal(item?.availability, "in stock");
  }
});

test("backorder-only groups retain orderable status; sold-out groups are not shown as stocked", () => {
  const backorder = buildFacebookLiveItems([
    offer({ id: "sd1701-s", availability: "backorder", availabilityDate: "2026-11-15" }),
    offer({ id: "sd1701-m", size: "M", availability: "out_of_stock", link: `${ORIGIN}/shop/ao-dai-dan-hoa-sd1701?variant=sd1701-m` }),
  ], ORIGIN);
  const soldOut = buildFacebookLiveItems([offer({ availability: "out_of_stock" })], ORIGIN);
  assert.equal(backorder[0]?.availability, "available for order");
  assert.equal(soldOut[0]?.availability, "out of stock");
});

test("ambiguous product identities and unsafe landing paths are excluded instead of merged", () => {
  const conflicting = [
    offer(),
    offer({ id: "other-variant", link: `${ORIGIN}/shop/another-product?variant=other-variant` }),
  ];
  assert.equal(buildFacebookLiveItems(conflicting, ORIGIN).length, 0);
  assert.equal(buildFacebookLiveItems([offer({ link: "https://evil.example/shop/ao-dai?variant=sd1701-s" })], ORIGIN).length, 0);
  assert.equal(buildFacebookLiveItems([offer({ itemGroupId: "" })], ORIGIN).length, 0);
  assert.equal(buildFacebookLiveItems([offer({ link: `${ORIGIN}/shop/ao-dai-dan-hoa-sd1701?variant=sd1701-s&campaign=1` })], ORIGIN).length, 0);
});

test("XML encoding is bounded and invalid control characters fail rather than enter the feed", () => {
  const data = { offers: [offer()], market: MARKET, origin: ORIGIN };
  assert.throws(() => serializeFacebookLiveFeed({ ...data, maxBytes: 40 }), MerchantFeedByteOverflowError);
  assert.throws(
    () => serializeFacebookLiveFeed({ ...data, offers: [offer({ title: "Unsafe\u0000title" })] }),
    MerchantFeedSerializationError,
  );
});


test("many size offers remain within the source candidate ceiling when they collapse into fewer parent items", () => {
  // Merchant can read 7,000 candidates, while the emitted 5,000 item budget applies after
  // grouping. A valid catalog of 1,700 designs x 3 sizes must not be rejected at 5,100 variants.
  const variants = Array.from({ length: 1_700 }, (_, productIndex) =>
    ["S", "M", "L"].map((size) => {
      const variantId = `variant-${productIndex}-${size.toLowerCase()}`;
      return offer({
        id: variantId,
        itemGroupId: `product-${productIndex}`,
        title: `Áo dài ${productIndex}`,
        mpn: `SKU-${productIndex}-${size}`,
        size,
        link: `${ORIGIN}/shop/ao-dai-${productIndex}?variant=${variantId}`,
      });
    }),
  ).flat();

  assert.equal(variants.length, 5_100);
  assert.ok(variants.length > MAX_MERCHANT_OFFERS);
  assert.ok(variants.length <= MAX_MERCHANT_CANDIDATE_VARIANTS);
  const feed = serializeFacebookLiveFeed({ offers: variants, market: MARKET, origin: ORIGIN });
  assert.equal(feed.offerCount, 1_700);
  assert.equal((feed.body.match(/<item>/g) ?? []).length, 1_700);
});

test("the Live feed still rejects excess source candidates and excess distinct parent products", () => {
  const tooManyCandidates = Array.from(
    { length: MAX_MERCHANT_CANDIDATE_VARIANTS + 1 },
    () => offer(),
  );
  assert.throws(
    () => buildFacebookLiveItems(tooManyCandidates, ORIGIN),
    MerchantFeedOfferOverflowError,
  );

  const tooManyParents = Array.from({ length: MAX_MERCHANT_OFFERS + 1 }, (_, index) => {
    const variantId = `variant-${index}`;
    return offer({
      id: variantId,
      itemGroupId: `product-${index}`,
      title: `Áo dài ${index}`,
      mpn: `SKU-${index}`,
      link: `${ORIGIN}/shop/ao-dai-${index}?variant=${variantId}`,
    });
  });
  assert.throws(
    () => buildFacebookLiveItems(tooManyParents, ORIGIN),
    MerchantFeedOfferOverflowError,
  );
});
