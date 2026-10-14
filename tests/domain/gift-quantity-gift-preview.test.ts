import assert from "node:assert/strict";
import test from "node:test";

import { previewGiftEntitlement, previewSamples, type GiftPreviewRule } from "../../src/commerce/gift-quantity-gift-preview.ts";

const quantity = (overrides: Partial<GiftPreviewRule> = {}): GiftPreviewRule => ({
  trigger: "QUANTITY", minimumQuantity: 2, minimumSubtotalVnd: null, awardMode: null, maxGiftsPerOrder: null, ...overrides,
});
const subtotal = (overrides: Partial<GiftPreviewRule> = {}): GiftPreviewRule => ({
  trigger: "ORDER_SUBTOTAL", minimumQuantity: null, minimumSubtotalVnd: 880_000, awardMode: "REPEAT_PER_THRESHOLD", maxGiftsPerOrder: null, ...overrides,
});
const earned = (rule: GiftPreviewRule, sample: number) => previewGiftEntitlement(rule, sample)?.earned;

test("quantity trigger: earned = floor(Q / N), and exactly N qualifies", () => {
  assert.equal(earned(quantity(), 1), 0);
  assert.equal(earned(quantity(), 2), 1, "the boundary is >=, so Q == N earns one");
  assert.equal(earned(quantity(), 3), 1);
  assert.equal(earned(quantity(), 4), 2);
  assert.equal(earned(quantity(), 5), 2);
  assert.equal(earned(quantity({ minimumQuantity: 1 }), 7), 7);
});

test("subtotal trigger: ONCE grants at most one, REPEAT one per threshold, and S == T qualifies", () => {
  assert.equal(earned(subtotal(), 879_999), 0);
  assert.equal(earned(subtotal(), 880_000), 1);
  assert.equal(earned(subtotal(), 1_759_999), 1);
  assert.equal(earned(subtotal(), 1_760_000), 2);
  assert.equal(earned(subtotal({ awardMode: "ONCE" }), 880_000), 1);
  assert.equal(earned(subtotal({ awardMode: "ONCE" }), 8_800_000), 1, "ONCE never repeats");
});

test("the per-order cap and the technical cap are applied after the threshold and reported", () => {
  const capped = previewGiftEntitlement(quantity({ maxGiftsPerOrder: 2 }), 10)!;
  assert.deepEqual([capped.earned, capped.entitled, capped.cappedByMaximum, capped.shortfallToNext], [5, 2, true, null]);
  const technical = previewGiftEntitlement(quantity({ minimumQuantity: 1 }), 150)!;
  assert.deepEqual([technical.earned, technical.entitled, technical.cappedByMaximum], [150, 100, true]);
  const under = previewGiftEntitlement(quantity({ maxGiftsPerOrder: 5 }), 4)!;
  assert.deepEqual([under.entitled, under.cappedByMaximum], [2, false]);
});

test("the shortfall says how much more reaches the next slot", () => {
  assert.equal(previewGiftEntitlement(quantity(), 3)!.shortfallToNext, 1);
  assert.equal(previewGiftEntitlement(quantity(), 4)!.shortfallToNext, 2);
  assert.equal(previewGiftEntitlement(subtotal({ minimumSubtotalVnd: 300_000 }), 400_000)!.shortfallToNext, 200_000);
  assert.equal(previewGiftEntitlement(subtotal({ awardMode: "ONCE" }), 880_000)!.shortfallToNext, null, "ONCE has no next slot once earned");
});

test("anything the engine would refuse previews as nothing instead of a wrong number", () => {
  for (const sample of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, 1_000_000_001]) {
    assert.equal(previewGiftEntitlement(quantity(), sample), null, String(sample));
  }
  assert.equal(previewGiftEntitlement(subtotal(), 1_000_000_000_001), null);
  assert.equal(previewGiftEntitlement(quantity({ minimumQuantity: null }), 4), null, "no threshold yet");
  assert.equal(previewGiftEntitlement(quantity({ minimumQuantity: 0 }), 4), null);
  assert.equal(previewGiftEntitlement(subtotal({ minimumSubtotalVnd: null }), 4), null);
  assert.equal(previewGiftEntitlement(subtotal({ awardMode: null }), 880_000), null, "an award mode is required");
  assert.equal(previewGiftEntitlement(quantity({ maxGiftsPerOrder: 0 }), 4), null);
});

test("samples cluster around the threshold: one short, on it, the next multiple and one past it", () => {
  assert.deepEqual(previewSamples(2), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(previewSamples(1), [1, 2, 3], "no sample below 1");
  assert.deepEqual(previewSamples(880_000), [879_999, 880_000, 1_759_999, 1_760_000, 1_760_001, 2_640_000]);
  assert.deepEqual(previewSamples(2, [4, 10, 0, -3, 1.5]), [1, 2, 3, 4, 5, 6, 10], "extras are merged, deduplicated and filtered");
  assert.deepEqual(previewSamples(0), []);
  assert.deepEqual(previewSamples(1.5), []);
  assert.deepEqual(previewSamples(Number.NaN), []);
});
