import assert from "node:assert/strict";
import test from "node:test";

import { buildProductCardModel } from "../../src/components/headless/build-product-card-model.ts";
import type { StorefrontPricingRule, StorefrontVariantFacts } from "../../src/commerce/storefront-product.ts";
import type { StorefrontProductMedia } from "../../src/commerce/product-media.ts";

/**
 * Characterization tests for the pricing and tracking behaviour that lived inside
 * `StorefrontProductCard`. The expected strings are written as literals on purpose: they are what
 * the card renders today, so any drift in the extracted builder shows up as a diff here rather than
 * as a wrong price in front of a shopper.
 *
 * The four edge cases are the ones spec 06 §5 names: composite (product-level price), several
 * variants with only one on sale, flash sale with a representative variant, and an out-of-stock
 * variant that is still displayed.
 */

/**
 * A realistic purchasable variant. Two baseline rules make the details load-bearing:
 * `resolveStorefrontPrice` is equality-gated, so a variant whose mirrored discount field disagrees
 * with its retail price resolves to no price at all; and `buildStorefrontVariantOptions` clears
 * `isDiscounted` on any variant the shopper cannot buy, which includes one with no size.
 */
function variant(overrides: Partial<StorefrontVariantFacts> = {}): StorefrontVariantFacts {
  const retailPrice = overrides.retailPrice ?? 100_000;
  return {
    id: "variant-1",
    pancakeVariationId: "pancake-1",
    color: null,
    size: "S",
    sellableStock: 5,
    retailPrice,
    retailPriceAfterDiscount: retailPrice,
    ...overrides,
  };
}

/**
 * The VND formatter emits U+00A0 before the ₫ sign, not a plain space. Spelling that out keeps the
 * expected values honest literals rather than something re-derived from the formatter under test.
 */
const vnd = (amount: string): string => `${amount}\u00A0₫`;

const media: StorefrontProductMedia = {
  primary: { url: "https://content.pancake.vn/a/1/2/3/primary.jpg", alt: "Ảnh chính" },
  gallery: [
    { url: "https://content.pancake.vn/a/1/2/3/primary.jpg", alt: "Ảnh chính" },
    { url: "https://content.pancake.vn/a/1/2/3/hover.jpg", alt: "Ảnh phụ" },
  ],
};

/* ------------------------------------------------------------------- price text */

test("a single price renders as the exact formatted amount", () => {
  const model = buildProductCardModel({
    slug: "ao-thun",
    name: "Áo thun",
    variants: [variant()],
  });

  assert.equal(model.price.displayText, vnd("100.000"));
  assert.equal(model.price.compareAtText, null);
  assert.equal(model.price.isRange, false);
  assert.equal(model.price.discountPercent, null);
});

test("a spread of prices renders as a `Từ` range", () => {
  const model = buildProductCardModel({
    slug: "ao-thun",
    name: "Áo thun",
    variants: [
      variant({ id: "a", size: "S", retailPrice: 100_000 }),
      variant({ id: "b", size: "M", retailPrice: 150_000 }),
    ],
  });

  assert.equal(model.price.displayText, `Từ ${vnd("100.000")}`);
  assert.equal(model.price.isRange, true);
});

test("a product with no usable price keeps the baseline placeholder", () => {
  const model = buildProductCardModel({
    slug: "ao-thun",
    name: "Áo thun",
    variants: [variant({ retailPrice: null, retailPriceAfterDiscount: null })],
  });

  assert.equal(model.price.displayText, "Giá đang cập nhật");
  assert.equal(model.price.compareAtText, null);
});

test("the equality gate is preserved: a disagreeing discount field shows no price", () => {
  // `resolveStorefrontPrice` returns null unless retail and after-discount agree. That is a
  // deliberate money guard -- a mirrored row the two systems disagree about is not quoted to a
  // shopper -- and extracting the card must not soften it into showing one of the two numbers.
  const model = buildProductCardModel({
    slug: "ao-thun",
    name: "Áo thun",
    variants: [variant({ retailPrice: 150_000, retailPriceAfterDiscount: 100_000 })],
  });

  assert.equal(model.price.displayText, "Giá đang cập nhật");
});

/* --------------------------------------------------------------- edge case: sale */

test("several variants with only one on sale keeps the strike-through", () => {
  // The sale price is the lowest on the card, so the baseline shows a bare amount. "Sale từ" is
  // reserved for the case below, where some *other* variant is currently cheaper than the sale
  // representative -- a distinction worth pinning, because it is easy to reimplement as "any sale".
  const pricingRule: StorefrontPricingRule = (candidate) =>
    candidate.id === "b"
      ? { price: 89_000, basePriceVnd: 150_000, isDiscounted: true }
      : { price: 100_000, basePriceVnd: 100_000, isDiscounted: false };

  const model = buildProductCardModel({
    slug: "ao-thun",
    name: "Áo thun",
    variants: [variant({ id: "a", size: "S", retailPrice: 100_000 }), variant({ id: "b", size: "M", retailPrice: 150_000 })],
    pricingRule,
  });

  assert.equal(model.price.displayText, vnd("89.000"));
  assert.equal(model.price.compareAtText, vnd("150.000"));
  assert.equal(model.price.isRange, false);
  assert.ok((model.price.discountPercent ?? 0) > 0, "a discount badge is shown");
});

test("`Sale từ` appears only when another variant undercuts the sale representative", () => {
  const pricingRule: StorefrontPricingRule = (candidate) =>
    candidate.id === "b"
      ? { price: 89_000, basePriceVnd: 150_000, isDiscounted: true }
      : { price: 60_000, basePriceVnd: 60_000, isDiscounted: false };

  const model = buildProductCardModel({
    slug: "ao-thun",
    name: "Áo thun",
    variants: [
      variant({ id: "a", size: "S", retailPrice: 60_000 }),
      variant({ id: "b", size: "M", retailPrice: 150_000 }),
    ],
    pricingRule,
  });

  assert.equal(model.price.displayText, `Sale từ ${vnd("89.000")}`);
  assert.equal(model.price.compareAtText, vnd("150.000"));
  assert.equal(model.price.isRange, true);
});

/* ---------------------------------------------------------- edge case: composite */

test("a composite product prices at the product level, not per variant", () => {
  // Composite products carry one product-level price: every variant resolves to the same amount, so
  // the card shows a single price rather than a range.
  const pricingRule: StorefrontPricingRule = () => ({
    price: 250_000,
    basePriceVnd: 250_000,
    isDiscounted: false,
  });

  const model = buildProductCardModel({
    slug: "set-do",
    name: "Set đồ",
    variants: [
      variant({ id: "a", size: "S", retailPrice: 120_000 }),
      variant({ id: "b", size: "M", retailPrice: 180_000 }),
    ],
    pricingRule,
  });

  assert.equal(model.price.displayText, vnd("250.000"));
  assert.equal(model.price.isRange, false);
  assert.equal(model.price.compareAtText, null);
});

/* -------------------------------------------------------- edge case: flash sale */

test("a flash sale uses its representative variant and ignores the option range", () => {
  const model = buildProductCardModel({
    slug: "ao-thun",
    name: "Áo thun",
    variants: [variant({ id: "a", size: "S", retailPrice: 100_000 }), variant({ id: "b", size: "M", retailPrice: 150_000 })],
    flashSale: {
      representativeVariantId: "b",
      basePriceVnd: 150_000,
      effectivePriceVnd: 89_000,
      hasCheaperCurrentVariant: false,
      remainingMs: 3 * 60 * 60 * 1000 + 25 * 60 * 1000,
    },
  });

  assert.equal(model.price.displayText, vnd("89.000"));
  assert.equal(model.price.compareAtText, vnd("150.000"));
  assert.equal(model.price.discountPercent, 41);
  assert.equal(model.flashSale?.remainingMs, 3 * 60 * 60 * 1000 + 25 * 60 * 1000);
  assert.equal(model.flashSale?.countdownText, "Còn 3 giờ 25 phút");
});

test("a flash sale with a cheaper current variant says `Sale từ`", () => {
  const model = buildProductCardModel({
    slug: "ao-thun",
    name: "Áo thun",
    variants: [variant()],
    flashSale: {
      representativeVariantId: "variant-1",
      basePriceVnd: 150_000,
      effectivePriceVnd: 89_000,
      hasCheaperCurrentVariant: true,
      remainingMs: 60_000,
    },
  });

  assert.equal(model.price.displayText, `Sale từ ${vnd("89.000")}`);
});

test("the flash countdown keeps the baseline day/hour/minute thresholds", () => {
  const countdown = (remainingMs: number): string | null =>
    buildProductCardModel({
      slug: "s",
      name: "n",
      variants: [variant()],
      flashSale: {
        representativeVariantId: "variant-1",
        basePriceVnd: 150_000,
        effectivePriceVnd: 89_000,
        hasCheaperCurrentVariant: false,
        remainingMs,
      },
    }).flashSale?.countdownText ?? null;

  assert.equal(countdown(2 * 24 * 60 * 60 * 1000 + 5 * 60 * 60 * 1000), "Còn 2 ngày 5 giờ");
  assert.equal(countdown(2 * 24 * 60 * 60 * 1000), "Còn 2 ngày");
  assert.equal(countdown(90 * 60 * 1000), "Còn 1 giờ 30 phút");
  assert.equal(countdown(45 * 60 * 1000), "Còn 45 phút");
  // A partial minute rounds up to one, and an elapsed sale shows nothing at all.
  assert.equal(countdown(1), "Còn 1 phút");
  assert.equal(countdown(0), null);
  assert.equal(countdown(Number.NaN), null);
});

/* --------------------------------------------------- edge case: out of stock */

test("an out-of-stock variant is still priced and displayed", () => {
  const model = buildProductCardModel({
    slug: "ao-thun",
    name: "Áo thun",
    variants: [variant({ sellableStock: 0 })],
  });

  assert.equal(model.price.displayText, vnd("100.000"));
  assert.equal(model.availability, "out-of-stock");
});

test("availability distinguishes all-in, none-in and partial stock", () => {
  const availabilityOf = (variants: StorefrontVariantFacts[]) =>
    buildProductCardModel({ slug: "s", name: "n", variants }).availability;

  assert.equal(availabilityOf([variant({ sellableStock: 3 })]), "in-stock");
  assert.equal(availabilityOf([variant({ sellableStock: 0 })]), "out-of-stock");
  assert.equal(
    availabilityOf([variant({ id: "a", size: "S", sellableStock: 3 }), variant({ id: "b", size: "M", sellableStock: 0 })]),
    "partial",
  );
});

/* ------------------------------------------------------------------ identity */

test("the href is the encoded product path and the select event passes through", () => {
  const selectEvent = { event: "select_item", item_list_id: "home" } as const;
  const model = buildProductCardModel({
    slug: "áo thun/summer",
    name: "Áo thun",
    variants: [variant()],
    selectEvent,
  });

  assert.equal(model.href, `/shop/${encodeURIComponent("áo thun/summer")}`);
  assert.deepEqual(model.selectEvent, selectEvent);
  assert.equal(model.name, "Áo thun");
});

test("a card with no select event carries null rather than omitting it", () => {
  const model = buildProductCardModel({ slug: "s", name: "n", variants: [variant()] });
  assert.equal(model.selectEvent, null);
});

/* --------------------------------------------------------------------- media */

test("primary and hover images follow the baseline gallery rule", () => {
  const model = buildProductCardModel({ slug: "s", name: "n", variants: [variant()], media });

  assert.deepEqual(model.primaryImage, {
    url: "https://content.pancake.vn/a/1/2/3/primary.jpg",
    alt: "Ảnh chính",
  });
  assert.deepEqual(model.hoverImage, {
    url: "https://content.pancake.vn/a/1/2/3/hover.jpg",
    alt: "Ảnh phụ",
  });
});

test("a gallery whose second image repeats the primary yields no hover image", () => {
  // Baseline rule: the hover image exists only when the gallery's second entry is a different photo.
  const model = buildProductCardModel({
    slug: "s",
    name: "n",
    variants: [variant()],
    media: {
      primary: media.primary,
      gallery: [media.gallery[0]!, media.gallery[0]!],
    },
  });

  assert.equal(model.hoverImage, null);
  assert.notEqual(model.primaryImage, null);
});

test("no media at all yields no images and no swatches", () => {
  const model = buildProductCardModel({ slug: "s", name: "n", variants: [variant()] });

  assert.equal(model.primaryImage, null);
  assert.equal(model.hoverImage, null);
  assert.deepEqual(model.colorSwatches, []);
});

/* ------------------------------------------------------------- colour swatches */

test("swatches list each distinct colour once, in first-seen order", () => {
  const model = buildProductCardModel({
    slug: "s",
    name: "n",
    variants: [
      variant({ id: "a", color: "Đen", size: "S" }),
      variant({ id: "b", color: "Đen", size: "M" }),
      variant({ id: "c", color: "Trắng", size: "S" }),
    ],
    media,
  });

  assert.deepEqual(
    model.colorSwatches.map((swatch) => swatch.color),
    ["Đen", "Trắng"],
  );
});

test("a swatch takes its image from the variant gallery mapping when the caller has one", () => {
  const model = buildProductCardModel({
    slug: "s",
    name: "n",
    variants: [
      variant({ id: "a", color: "Đen", size: "S" }),
      variant({ id: "c", color: "Trắng", size: "M" }),
    ],
    media,
    galleryIndexByVariantId: { a: 0, c: 1 },
  });

  assert.deepEqual(model.colorSwatches, [
    { color: "Đen", image: media.gallery[0]! },
    { color: "Trắng", image: media.gallery[1]! },
  ]);
});

test("without a gallery mapping a swatch is colour-only rather than guessed", () => {
  // Listing surfaces do not carry `galleryIndexByVariantId` today. Inventing an image would be
  // worse than saying there is none: the swatch would point at an unrelated photo.
  const model = buildProductCardModel({
    slug: "s",
    name: "n",
    variants: [variant({ id: "a", color: "Đen", size: "S" })],
    media,
  });

  assert.deepEqual(model.colorSwatches, [{ color: "Đen", image: null }]);
});

test("a gallery index outside the gallery yields no image rather than a blank frame", () => {
  const model = buildProductCardModel({
    slug: "s",
    name: "n",
    variants: [variant({ id: "a", color: "Đen", size: "S" })],
    media,
    galleryIndexByVariantId: { a: 99 },
  });

  assert.deepEqual(model.colorSwatches, [{ color: "Đen", image: null }]);
});

test("variants with no colour contribute no swatches", () => {
  const model = buildProductCardModel({
    slug: "s",
    name: "n",
    variants: [variant({ color: null })],
    media,
  });

  assert.deepEqual(model.colorSwatches, []);
});

/* ---------------------------------------------------- F5: marketing badge priority */

test("F5 marketing badge priority: Sale > Hàng mới > Bán chạy", () => {
  const onSaleVariant = variant({ retailPrice: 150_000, retailPriceAfterDiscount: 100_000 });
  const pricingRule: StorefrontPricingRule = () => ({
    price: 100_000,
    basePriceVnd: 150_000,
    isDiscounted: true,
  });

  // When all 3 are true, Sale wins
  const allThree = buildProductCardModel({
    slug: "s",
    name: "n",
    variants: [onSaleVariant],
    pricingRule,
    isNewArrival: true,
    isBestseller: true,
  });
  assert.deepEqual(allThree.marketingBadge, { type: "sale", label: "-33%" });

  // When not on sale, Hàng mới beats Bán chạy
  const newAndBestseller = buildProductCardModel({
    slug: "s",
    name: "n",
    variants: [variant()],
    isNewArrival: true,
    isBestseller: true,
  });
  assert.deepEqual(newAndBestseller.marketingBadge, { type: "new", label: "Hàng mới" });

  // When only Bán chạy
  const onlyBestseller = buildProductCardModel({
    slug: "s",
    name: "n",
    variants: [variant()],
    isBestseller: true,
  });
  assert.deepEqual(onlyBestseller.marketingBadge, { type: "bestseller", label: "Bán chạy" });

  // When neither
  const neither = buildProductCardModel({
    slug: "s",
    name: "n",
    variants: [variant()],
  });
  assert.equal(neither.marketingBadge, null);
});

test("F5 availability is independent from marketing badge priority", () => {
  const oosVariant = variant({ id: "v-oos", size: "S", sellableStock: 0, retailPrice: 150_000 });
  const inStockVariant = variant({ id: "v-in", size: "M", sellableStock: 5, retailPrice: 150_000 });
  const pricingRule: StorefrontPricingRule = () => ({
    price: 100_000,
    basePriceVnd: 150_000,
    isDiscounted: true,
  });

  const model = buildProductCardModel({
    slug: "s",
    name: "n",
    variants: [oosVariant, inStockVariant],
    pricingRule,
    isNewArrival: true,
  });

  // Availability says partial, marketingBadge still resolves to sale
  assert.equal(model.availability, "partial");
  assert.deepEqual(model.marketingBadge, { type: "sale", label: "-33%" });
});

/* ------------------------------------------------------------------ immutability */

test("the model is frozen, so a brand component cannot mutate shared state", () => {
  const model = buildProductCardModel({ slug: "s", name: "n", variants: [variant()], media });

  assert.throws(() => {
    (model as { name: string }).name = "changed";
  }, TypeError);
});

