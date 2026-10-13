import assert from "node:assert/strict";
import test from "node:test";

import { isPromotionActivationEnabled } from "../../src/commerce/promotion-activation.ts";
import {
  GIFT_QUANTITY_PROMOTIONS_ENV,
  isGiftQuantityPromotionsEnabled,
} from "../../src/commerce/gift-quantity-gate.ts";

test("the gate is OFF by default: unset, empty, false and malformed values are all OFF", () => {
  for (const value of [undefined, "", "false", "FALSE", "0", "1", "TRUE", "True", "yes", "on", " true", "true ", "enabled"]) {
    assert.equal(isGiftQuantityPromotionsEnabled({ [GIFT_QUANTITY_PROMOTIONS_ENV]: value }), false, String(value));
  }
  assert.equal(isGiftQuantityPromotionsEnabled({}), false);
});

test("only the exact string true turns the gate ON", () => {
  assert.equal(isGiftQuantityPromotionsEnabled({ [GIFT_QUANTITY_PROMOTIONS_ENV]: "true" }), true);
});

test("the gate reads only its own server variable, never a NEXT_PUBLIC copy", () => {
  assert.equal(isGiftQuantityPromotionsEnabled({ NEXT_PUBLIC_LA_GIFT_QUANTITY_PROMOTIONS_ENABLED: "true" }), false);
});

test("legacy promotion activation does not switch gift/quantity on, and the reverse", () => {
  const legacyOn = { LA_PROMOTION_ACTIVATION_ENABLED: "true" };
  assert.equal(isPromotionActivationEnabled(legacyOn), true);
  assert.equal(isGiftQuantityPromotionsEnabled(legacyOn), false);

  const newOn = { [GIFT_QUANTITY_PROMOTIONS_ENV]: "true" };
  assert.equal(isGiftQuantityPromotionsEnabled(newOn), true);
  assert.equal(isPromotionActivationEnabled(newOn), false);
});

test("the default environment is process.env and is OFF unless the variable is set", () => {
  const original = process.env[GIFT_QUANTITY_PROMOTIONS_ENV];
  try {
    delete process.env[GIFT_QUANTITY_PROMOTIONS_ENV];
    assert.equal(isGiftQuantityPromotionsEnabled(), false);
    process.env[GIFT_QUANTITY_PROMOTIONS_ENV] = "true";
    assert.equal(isGiftQuantityPromotionsEnabled(), true);
    process.env[GIFT_QUANTITY_PROMOTIONS_ENV] = "1";
    assert.equal(isGiftQuantityPromotionsEnabled(), false);
  } finally {
    if (original === undefined) delete process.env[GIFT_QUANTITY_PROMOTIONS_ENV];
    else process.env[GIFT_QUANTITY_PROMOTIONS_ENV] = original;
  }
});
