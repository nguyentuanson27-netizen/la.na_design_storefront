/**
 * U15 / P6 — the PDP switches to the central pricing authority.
 *
 * Two things are being proved here, and they pull in opposite directions.
 *
 * The first is that the PDP now prices through `resolvePromotionPricing`, with
 * `pancakeRetailPrice` as the base — which means the equality gate on
 * `retailPriceAfterDiscount` is gone *for this consumer*, exactly as W3's accepted evidence allows.
 *
 * The second is that it is gone *only* for this consumer. `resolveStorefrontPrice` is still used by
 * the cart, the Pancake order submission, the Merchant audit, product cards and structured data.
 * Those belong to later units, and changing them here would alter what buyers are charged at
 * checkout on the strength of a unit that only owns the product page.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildStorefrontVariantOptions,
  resolveStorefrontPrice,
  type StorefrontVariantFacts,
} from "../../src/commerce/storefront-product.ts";
import { buildPromotionalStorefrontPricing } from "../../src/commerce/storefront-promotion-projection.ts";
import type { ApplicablePromotionCampaign } from "../../src/commerce/promotion-pricing.ts";

const NOW = new Date("2026-09-15T00:00:00.000Z");

function variant(overrides: Partial<StorefrontVariantFacts> = {}): StorefrontVariantFacts {
  return {
    id: "cuid-a",
    pancakeVariationId: "pv-a",
    color: "Đen",
    size: "M",
    sellableStock: 5,
    retailPrice: 500_000,
    retailPriceAfterDiscount: 500_000,
    ...overrides,
  };
}

function percentage(overrides: Partial<ApplicablePromotionCampaign> = {}): ApplicablePromotionCampaign {
  return {
    id: "campaign-1",
    name: "Chiến dịch",
    kind: "PROMOTION",
    discountType: "PERCENTAGE",
    percentageValue: 10,
    fixedPriceVnd: null,
    startsAt: null,
    endsAt: null,
    ...overrides,
  };
}

function priceFor(
  variants: readonly StorefrontVariantFacts[],
  campaignsByVariantId: ReadonlyMap<string, readonly ApplicablePromotionCampaign[]>,
) {
  const pricing = buildPromotionalStorefrontPricing({ campaignsByVariantId, now: NOW });
  return buildStorefrontVariantOptions(variants, pricing);
}

test("U15 with no campaign the PDP price is the mirrored base price", () => {
  const [option] = priceFor([variant()], new Map());

  assert.equal(option!.price, 500_000);
  assert.equal(option!.basePriceVnd, 500_000);
  assert.equal(option!.isDiscounted, false);
  assert.equal(option!.purchasable, true);
});

test("U15 a percentage campaign prices through the central resolver", () => {
  const [option] = priceFor([variant()], new Map([["cuid-a", [percentage({ percentageValue: 10 })]]]));

  assert.equal(option!.price, 450_000, "effective price is what the resolver computed");
  assert.equal(option!.basePriceVnd, 500_000, "base stays available so the UI can strike it through");
  assert.equal(option!.isDiscounted, true);
});

test("U15 a fixed-price campaign uses the configured final unit price", () => {
  const [option] = priceFor(
    [variant()],
    new Map([["cuid-a", [percentage({ discountType: "FIXED_PRICE", percentageValue: null, fixedPriceVnd: BigInt(399_000) })]]]),
  );

  assert.equal(option!.price, 399_000);
  assert.equal(option!.isDiscounted, true);
});

test("U15 the equality gate is gone for the PDP: a lower Pancake discount field no longer hides the price", () => {
  // This is the W3 consequence. Under the old gate this variant priced as null and rendered
  // "Giá đang cập nhật"; the accepted evidence established that `retail_price` is the authoritative
  // base and the after-discount field is not, so the variant is now priceable and purchasable.
  const drifted = variant({ retailPrice: 500_000, retailPriceAfterDiscount: 420_000 });

  const [option] = priceFor([drifted], new Map());
  assert.equal(option!.price, 500_000, "website pricing uses retailPrice, not the Pancake discount field");
  assert.equal(option!.purchasable, true);
  assert.equal(option!.unavailableReason, null);

  // …and the old shared rule still returns null, because every other consumer still uses it.
  assert.equal(resolveStorefrontPrice(drifted), null);
});

test("U15 an unusable base price stays unpurchasable rather than being promoted", () => {
  for (const unusable of [null, 0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    const [option] = priceFor(
      [variant({ retailPrice: unusable as number | null })],
      new Map([["cuid-a", [percentage()]]]),
    );

    assert.equal(option!.price, null, `${String(unusable)} must not price`);
    assert.equal(option!.isDiscounted, false);
    assert.equal(option!.purchasable, false);
    assert.equal(option!.unavailableReason, "PRICE_UNRESOLVED");
  }
});

test("U15 a rounding-invalid promotion falls back to base for that variant only", () => {
  const options = priceFor(
    [
      variant({ id: "cuid-low", pancakeVariationId: "pv-low", size: "S", retailPrice: 50 }),
      variant({ id: "cuid-ok", pancakeVariationId: "pv-ok", size: "L" }),
    ],
    new Map([
      ["cuid-low", [percentage({ percentageValue: 1 })]],
      ["cuid-ok", [percentage({ percentageValue: 10 })]],
    ]),
  );

  const low = options.find((entry) => entry.id === "cuid-low")!;
  const ok = options.find((entry) => entry.id === "cuid-ok")!;

  assert.equal(low.price, 50, "50 @ 1% rounds back to 50, so there is no discount");
  assert.equal(low.isDiscounted, false);
  assert.equal(low.purchasable, true, "an invalid promotion must not make the variant unbuyable");
  assert.equal(ok.isDiscounted, true, "the healthy sibling keeps its promotion");
});

test("U15 two applicable campaigns conflict and neither is applied", () => {
  const [option] = priceFor(
    [variant()],
    new Map([["cuid-a", [percentage({ id: "c1" }), percentage({ id: "c2", percentageValue: 20 })]]]),
  );

  assert.equal(option!.price, 500_000, "a conflicted variant gets no website promotion");
  assert.equal(option!.isDiscounted, false);
  assert.equal(option!.purchasable, true);
});

test("U15 a campaign outside its window does not discount, and recovery is automatic", () => {
  const scheduled = percentage({
    startsAt: new Date("2026-09-20T00:00:00.000Z"),
    endsAt: new Date("2026-09-21T00:00:00.000Z"),
  });

  const before = buildStorefrontVariantOptions(
    [variant()],
    buildPromotionalStorefrontPricing({
      campaignsByVariantId: new Map([["cuid-a", [scheduled]]]),
      now: NOW,
    }),
  );
  assert.equal(before[0]!.isDiscounted, false, "scheduled campaigns do not discount before they open");

  const during = buildStorefrontVariantOptions(
    [variant()],
    buildPromotionalStorefrontPricing({
      campaignsByVariantId: new Map([["cuid-a", [scheduled]]]),
      now: new Date("2026-09-20T12:00:00.000Z"),
    }),
  );
  assert.equal(during[0]!.isDiscounted, true, "the same facts discount inside the window");
  assert.equal(during[0]!.price, 450_000);
});

test("U15 pricing is keyed by the internal variant id, never by the external variation id", () => {
  // The campaign repository keys candidates by `VariantMirror.id`. Keying the projection by the
  // external id instead would quietly mis-price whenever the two diverge.
  const [option] = priceFor([variant()], new Map([["pv-a", [percentage()]]]));

  assert.equal(option!.isDiscounted, false, "an external-id key must not resolve a campaign");
});

test("U15 the default pricing path is untouched for every other consumer", () => {
  // No pricing argument means the shared equality-gated rule, which cart, checkout, Pancake
  // submission, Merchant audit, cards and structured data all still depend on.
  const drifted = variant({ retailPrice: 500_000, retailPriceAfterDiscount: 420_000 });
  const [option] = buildStorefrontVariantOptions([drifted]);

  assert.equal(option!.price, null);
  assert.equal(option!.unavailableReason, "PRICE_UNRESOLVED");
  assert.equal(option!.isDiscounted, false);
  assert.equal(option!.basePriceVnd, null);
});

test("a kind-scoped rule shows only that kind's discounts and never unmasks a conflict", () => {
  const promotionVariant = variant({ id: "cuid-promo", pancakeVariationId: "pv-promo", size: "M" });
  const flashVariant = variant({ id: "cuid-flash", pancakeVariationId: "pv-flash", size: "L" });
  const conflictVariant = variant({ id: "cuid-both", pancakeVariationId: "pv-both", size: "XL" });
  const promotion = percentage({ id: "promo", kind: "PROMOTION", percentageValue: 20 });
  const flash = percentage({
    id: "flash",
    kind: "FLASH_SALE",
    percentageValue: 40,
    startsAt: new Date(NOW.getTime() - 60_000),
    endsAt: new Date(NOW.getTime() + 3_600_000),
  });
  const campaignsByVariantId = new Map([
    ["cuid-promo", [promotion]],
    ["cuid-flash", [flash]],
    ["cuid-both", [promotion, flash]],
  ]);
  const variants = [promotionVariant, flashVariant, conflictVariant];

  const scoped = buildStorefrontVariantOptions(
    variants,
    buildPromotionalStorefrontPricing({ campaignsByVariantId, now: NOW, onlyKind: "PROMOTION" }),
  );
  assert.deepEqual(
    scoped.map((option) => [option.id, option.price, option.isDiscounted]),
    [
      ["cuid-promo", 400_000, true],
      // The Flash price stays off a Promotion-only listing: shown at base, not at 300k.
      ["cuid-flash", 500_000, false],
      // Two active campaigns is a conflict at checkout; scoping must not turn it into a discount.
      ["cuid-both", 500_000, false],
    ],
  );

  const unscoped = buildStorefrontVariantOptions(
    variants,
    buildPromotionalStorefrontPricing({ campaignsByVariantId, now: NOW }),
  );
  assert.deepEqual(unscoped.map((option) => option.price), [400_000, 300_000, 500_000]);
});
