import assert from "node:assert/strict";
import test from "node:test";

import { validateDraftShape } from "../../src/commerce/gift-quantity-admin-service.ts";
import { describeGiftQuantityFailure } from "../../src/commerce/gift-quantity-admin-feedback.ts";
import { parseGiftQuantityDraftForm, type GiftQuantityDraftValues } from "../../src/commerce/gift-quantity-admin-input.ts";
import { validateRuleForPublish, type RuleValidationInput } from "../../src/commerce/gift-quantity-rule-validation.ts";
import {
  parseTierRuleForm,
  toQuantityTierConfig,
  validateTierRuleForPublish,
  validateTierRuleStructure,
  type TierRuleInput,
} from "../../src/commerce/gift-quantity-tier-rule.ts";

/** Order-value ladders in the admin layer: what a form may send, what a Draft may hold, what may publish. */

const form = (entries: Array<[string, string]>) => {
  const data = new FormData();
  for (const [key, value] of entries) data.append(key, value);
  return data;
};

const orderRule = (overrides: Partial<TierRuleInput> = {}): TierRuleInput => ({
  basis: "ORDER_SUBTOTAL", unit: "PERCENTAGE", discountedUnits: "ALL_ELIGIBLE_UNITS", selectionPriority: null,
  tiers: [{ minQuantity: 1_000_000, discountValue: 5 }, { minQuantity: 2_000_000, discountValue: 10 }],
  stackingEnabled: false, stackPriority: null, peers: [], ...overrides,
});
const quantityRule = (overrides: Partial<TierRuleInput> = {}): TierRuleInput => ({
  unit: "PERCENTAGE", discountedUnits: "ALL_ELIGIBLE_UNITS", selectionPriority: null,
  tiers: [{ minQuantity: 3, discountValue: 10 }], stackingEnabled: false, stackPriority: null, peers: [], ...overrides,
});

/* ---------------------------------------------------------------- parsing */

test("the form carries the basis, and an unknown basis is refused rather than defaulted", () => {
  const ok = parseTierRuleForm(form([["tierBasis", "ORDER_SUBTOTAL"], ["tierUnit", "FIXED_AMOUNT_TOTAL_VND"], ["tierDiscountedUnits", "ALL_ELIGIBLE_UNITS"], ["tierMinQuantity", "3000000"], ["tierDiscountValue", "200000"]]));
  assert.ok(ok.ok);
  assert.deepEqual(ok.ok && [ok.value.basis, ok.value.unit, ok.value.tiers], ["ORDER_SUBTOTAL", "FIXED_AMOUNT_TOTAL_VND", [{ minQuantity: 3_000_000, discountValue: 200_000 }]]);

  const bad = parseTierRuleForm(form([["tierBasis", "WEIGHT"]]));
  assert.deepEqual(bad.ok ? "OK" : bad.reason, "INVALID_TIER_BASIS");
  const twice = parseTierRuleForm(form([["tierBasis", "QUANTITY"], ["tierBasis", "ORDER_SUBTOTAL"]]));
  assert.deepEqual(twice.ok ? "OK" : twice.reason, "INVALID_TIER_BASIS", "two competing values: neither is picked");
});

test("a form with no basis field describes a quantity ladder", () => {
  const result = parseTierRuleForm(form([["tierUnit", "PERCENTAGE"], ["tierDiscountedUnits", "ALL_ELIGIBLE_UNITS"], ["tierMinQuantity", "3"], ["tierDiscountValue", "10"]]));
  assert.ok(result.ok);
  assert.equal(result.ok && result.value.basis, null);
  assert.equal(result.ok && toQuantityTierConfig(result.value)?.basis, undefined, "and the engine reads it as it always did");
});

/* ---------------------------------------------------------------- structure (every write, Draft included) */

test("a valid order-value rule has no structural errors", () => {
  assert.deepEqual(validateTierRuleStructure(orderRule()), []);
  assert.deepEqual(validateTierRuleStructure(orderRule({ unit: "FIXED_AMOUNT_TOTAL_VND", tiers: [{ minQuantity: 3_000_000, discountValue: 200_000 }] })), []);
});

test("the database's pairings are refused before they reach it", () => {
  assert.ok(validateTierRuleStructure(orderRule({ unit: "FIXED_AMOUNT_PER_UNIT_VND" })).includes("TIER_UNIT_BASIS_MISMATCH"));
  assert.ok(validateTierRuleStructure(quantityRule({ unit: "FIXED_AMOUNT_TOTAL_VND" })).includes("TIER_UNIT_BASIS_MISMATCH"));
  assert.ok(validateTierRuleStructure(orderRule({ discountedUnits: "FROM_REACHED_THRESHOLD", selectionPriority: "CHEAPEST_FIRST" })).includes("TIER_ORDER_BASIS_WHOLE_ORDER_ONLY"));
  assert.ok(validateTierRuleStructure(orderRule({ selectionPriority: "CHEAPEST_FIRST" })).includes("TIER_ORDER_BASIS_WHOLE_ORDER_ONLY"));
  assert.ok(validateTierRuleStructure({ ...orderRule(), basis: "WEIGHT" as never }).includes("INVALID_TIER_BASIS"));
});

test("thresholds are bounded per basis: units to a million, order value to two billion", () => {
  assert.ok(validateTierRuleStructure(quantityRule({ tiers: [{ minQuantity: 1_000_001, discountValue: 10 }] })).includes("TIER_THRESHOLD_OUT_OF_RANGE"));
  assert.deepEqual(validateTierRuleStructure(orderRule({ tiers: [{ minQuantity: 2_000_000_000, discountValue: 10 }] })), []);
  assert.ok(validateTierRuleStructure(orderRule({ tiers: [{ minQuantity: 2_000_000_001, discountValue: 10 }] })).includes("TIER_THRESHOLD_OUT_OF_RANGE"));
});

test("a total off the order must be below the order value that earns it", () => {
  const rule = (min: number, value: number) => orderRule({ unit: "FIXED_AMOUNT_TOTAL_VND", tiers: [{ minQuantity: min, discountValue: value }] });
  assert.ok(validateTierRuleStructure(rule(500_000, 500_000)).includes("TIER_TOTAL_NOT_BELOW_THRESHOLD"));
  assert.ok(validateTierRuleStructure(rule(500_000, 700_000)).includes("TIER_TOTAL_NOT_BELOW_THRESHOLD"));
  assert.deepEqual(validateTierRuleStructure(rule(500_000, 499_999)), []);
});

/* ---------------------------------------------------------------- publish */

test("publish accepts a complete order-value ladder and refuses an incomplete or contradictory one", () => {
  assert.deepEqual(validateTierRuleForPublish(orderRule()), []);
  assert.ok(validateTierRuleForPublish(orderRule({ unit: null })).includes("TIER_CONFIG_INCOMPLETE"));
  // The ladder is read in threshold order, so a reversed list is the same ladder; a repeated threshold is not.
  assert.deepEqual(validateTierRuleForPublish(orderRule({ tiers: [{ minQuantity: 2_000_000, discountValue: 10 }, { minQuantity: 1_000_000, discountValue: 5 }] })), []);
  assert.ok(validateTierRuleForPublish(orderRule({ tiers: [{ minQuantity: 1_000_000, discountValue: 5 }, { minQuantity: 1_000_000, discountValue: 10 }] })).includes("THRESHOLD_NOT_STRICTLY_INCREASING"));
  assert.ok(validateTierRuleForPublish(orderRule({ unit: "FIXED_AMOUNT_TOTAL_VND", tiers: [{ minQuantity: 100, discountValue: 100 }] })).includes("DISCOUNT_NOT_BELOW_THRESHOLD"));
});

test("the row validator hands the stored basis to the rule validator (null means QUANTITY)", () => {
  const base: RuleValidationInput = {
    kind: "QUANTITY_TIER", giftTrigger: null, minimumQuantity: null, minimumSubtotalVnd: null, subtotalScope: null, awardMode: null,
    maxGiftsPerOrder: null, allowDuplicateGifts: null, tierBasis: "ORDER_SUBTOTAL", tierUnit: "FIXED_AMOUNT_TOTAL_VND",
    tierDiscountedUnits: "ALL_ELIGIBLE_UNITS", tierSelectionPriority: null, tiers: [{ minQuantity: 3_000_000, discountValue: 200_000 }],
    giftVariantIds: [], stackingEnabled: false, stackPriority: null, stackPeers: [],
  };
  assert.deepEqual(validateRuleForPublish(base), []);
  assert.ok(validateRuleForPublish({ ...base, tierBasis: null }).includes("UNIT_INVALID"), "a total with no basis is a quantity ladder holding a unit it cannot have");
  assert.ok(validateRuleForPublish({ ...base, tierBasis: "QUANTITY" }).includes("UNIT_INVALID"));
});

/* ---------------------------------------------------------------- Draft shape vs scope */

const draft = (overrides: Partial<GiftQuantityDraftValues>): GiftQuantityDraftValues => ({
  kind: "QUANTITY_TIER", name: "Giảm theo đơn", startsAt: null, endsAt: null, scopeMode: "GLOBAL_ALL_PAID_LINES",
  categoryKeys: [], includeProductIds: [], excludeProductIds: [], giftTrigger: null, subtotalScope: null,
  tierRule: orderRule(), ...overrides,
});

test("an order-value ladder is global and only an order-value ladder is", () => {
  assert.deepEqual(validateDraftShape(draft({})), []);
  assert.ok(validateDraftShape(draft({ scopeMode: "DYNAMIC_CATEGORY" })).includes("ORDER_BASIS_NEEDS_GLOBAL_SCOPE"));
  assert.ok(validateDraftShape(draft({ tierRule: quantityRule() })).includes("GLOBAL_SCOPE_NOT_ALLOWED"), "a quantity ladder needs a real scope");
  // A form with no tier fields leaves the stored rule alone, so the stored basis decides: `create` and `edit`
  // answer that (see the database tests); the shape check, which cannot see storage, does not guess.
  assert.deepEqual(validateDraftShape(draft({ tierRule: null })), []);
  assert.deepEqual(validateDraftShape(draft({ scopeMode: "DYNAMIC_CATEGORY", tierRule: quantityRule(), categoryKeys: ["vayDam"] })), []);
});

test("the parser carries the basis end to end", () => {
  const data = form([
    ["kind", "QUANTITY_TIER"], ["name", "Giảm theo đơn"], ["scopeMode", "GLOBAL_ALL_PAID_LINES"],
    ["tierBasis", "ORDER_SUBTOTAL"], ["tierUnit", "PERCENTAGE"], ["tierDiscountedUnits", "ALL_ELIGIBLE_UNITS"],
    ["tierMinQuantity", "1000000"], ["tierDiscountValue", "5"],
  ]);
  const parsed = parseGiftQuantityDraftForm(data);
  assert.ok(parsed.ok);
  assert.equal(parsed.ok && parsed.value.tierRule?.basis, "ORDER_SUBTOTAL");
  assert.deepEqual(parsed.ok && validateDraftShape(parsed.value), []);
});

/* ---------------------------------------------------------------- operator-facing sentences */

test("every new refusal has its own plain-language sentence, not the generic one", () => {
  for (const code of ["ORDER_BASIS_NEEDS_GLOBAL_SCOPE", "TIER_BASIS_NOT_EDITABLE_WHEN_SCHEDULED", "TIER_UNIT_BASIS_MISMATCH", "TIER_ORDER_BASIS_WHOLE_ORDER_ONLY", "TIER_TOTAL_NOT_BELOW_THRESHOLD"]) {
    const generic = describeGiftQuantityFailure({ reason: "INVALID_INPUT", errors: ["NOT_A_REAL_CODE"] }).message;
    const specific = describeGiftQuantityFailure({ reason: "INVALID_INPUT", errors: [code] });
    assert.notEqual(specific.message, generic, code);
    assert.equal(specific.code, code);
  }
  for (const code of ["BASIS_INVALID", "DISCOUNT_NOT_BELOW_THRESHOLD"]) {
    const specific = describeGiftQuantityFailure({ reason: "INVALID_RULE", errors: [code] });
    assert.equal(specific.code, code);
  }
  assert.equal(describeGiftQuantityFailure({ reason: "INVALID_TIER_BASIS" }).code, undefined);
  assert.match(describeGiftQuantityFailure({ reason: "INVALID_TIER_BASIS" }).message, /giá trị đơn hàng/);
});
