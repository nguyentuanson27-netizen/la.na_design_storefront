import assert from "node:assert/strict";
import test from "node:test";

import { parseGiftQuantityDraftForm } from "../../src/commerce/gift-quantity-admin-input.ts";
import { MAX_GIFT_OPTIONS_PER_CAMPAIGN } from "../../src/commerce/gift-quantity-entitlement.ts";
import {
  exceedsConcurrentWindows,
  formCarriesGiftRule,
  giftRuleColumns,
  giftRuleOfRow,
  parseGiftRuleForm,
  sameGiftRule,
  validateGiftRuleBounds,
  validateGiftRuleForPublish,
  validateGiftRuleStructure,
  type GiftRuleInput,
} from "../../src/commerce/gift-quantity-gift-rule.ts";

function form(entries: Array<[string, string]>): FormData {
  const data = new FormData();
  for (const [key, value] of entries) data.append(key, value);
  return data;
}
function parsed(entries: Array<[string, string]>) {
  const result = parseGiftRuleForm(form(entries));
  assert.equal(result.ok, true, JSON.stringify(result));
  return (result as Extract<typeof result, { ok: true }>).value;
}
function refusal(entries: Array<[string, string]>) {
  const result = parseGiftRuleForm(form(entries));
  assert.equal(result.ok, false, JSON.stringify(result));
  return (result as Extract<typeof result, { ok: false }>).reason;
}
const rule = (overrides: Partial<GiftRuleInput> = {}): GiftRuleInput => ({
  minimumQuantity: 2,
  minimumSubtotalVnd: null,
  awardMode: null,
  maxGiftsPerOrder: null,
  allowDuplicateGifts: false,
  variantIds: ["v1"],
  ...overrides,
});
const subtotalRule = (overrides: Partial<GiftRuleInput> = {}) =>
  rule({ minimumQuantity: null, minimumSubtotalVnd: 500_000, awardMode: "ONCE", ...overrides });

test("parse: a full quantity form becomes a typed rule; blank variant ids are skipped and ids are trimmed", () => {
  const value = parsed([
    ["giftRuleForm", "on"],
    ["giftMinimumQuantity", " 3 "],
    ["giftMinimumSubtotalVnd", ""],
    ["giftAwardMode", ""],
    ["giftMaxPerOrder", "5"],
    ["giftAllowDuplicates", "on"],
    ["giftVariantId", " v1 "],
    ["giftVariantId", ""],
    ["giftVariantId", "v2"],
  ]);
  assert.deepEqual(value, {
    minimumQuantity: 3, minimumSubtotalVnd: null, awardMode: null, maxGiftsPerOrder: 5, allowDuplicateGifts: true, variantIds: ["v1", "v2"],
  });
});

test("parse: a full subtotal form; an absent checkbox is off; the marker alone is an empty rule", () => {
  assert.deepEqual(parsed([["giftMinimumSubtotalVnd", "880000"], ["giftAwardMode", "REPEAT_PER_THRESHOLD"], ["giftVariantId", "v1"]]), {
    minimumQuantity: null, minimumSubtotalVnd: 880_000, awardMode: "REPEAT_PER_THRESHOLD", maxGiftsPerOrder: null, allowDuplicateGifts: false, variantIds: ["v1"],
  });
  assert.deepEqual(parsed([["giftRuleForm", "on"]]), {
    minimumQuantity: null, minimumSubtotalVnd: null, awardMode: null, maxGiftsPerOrder: null, allowDuplicateGifts: false, variantIds: [],
  });
});

test("parse: only plain base-10 digits are numbers; nothing is coerced", () => {
  for (const bad of ["05", "1e3", "-1", "+1", "1.5", "1,000", "0x10", "１２", "NaN", "9".repeat(16), "٣"]) {
    assert.equal(refusal([["giftMinimumQuantity", bad]]), "INVALID_GIFT_MINIMUM_QUANTITY", bad);
    assert.equal(refusal([["giftMinimumSubtotalVnd", bad]]), "INVALID_GIFT_MINIMUM_SUBTOTAL", bad);
    assert.equal(refusal([["giftMaxPerOrder", bad]]), "INVALID_GIFT_MAX_PER_ORDER", bad);
  }
});

test("parse: allowlists, repeated scalar fields and non-string values are refused instead of picking one", () => {
  assert.equal(refusal([["giftAwardMode", "ALWAYS"]]), "INVALID_GIFT_AWARD_MODE");
  assert.equal(refusal([["giftAwardMode", "once"]]), "INVALID_GIFT_AWARD_MODE");
  assert.equal(refusal([["giftMinimumQuantity", "2"], ["giftMinimumQuantity", "3"]]), "INVALID_GIFT_MINIMUM_QUANTITY");
  assert.equal(refusal([["giftMaxPerOrder", "2"], ["giftMaxPerOrder", "3"]]), "INVALID_GIFT_MAX_PER_ORDER");
  assert.equal(refusal([["giftAllowDuplicates", "yes"]]), "INVALID_GIFT_DUPLICATE_FLAG");
  assert.equal(refusal([["giftAllowDuplicates", "on"], ["giftAllowDuplicates", "off"]]), "INVALID_GIFT_DUPLICATE_FLAG");
  const withFile = new FormData();
  withFile.append("giftVariantId", new Blob(["x"]), "x.txt");
  assert.equal(parseGiftRuleForm(withFile).ok, false);
  for (const token of ["on", "true", "off", "false", ""]) {
    assert.equal(parseGiftRuleForm(form([["giftAllowDuplicates", token]])).ok, true, token);
  }
});

test("parse: an oversized allowlist is refused whole, never truncated", () => {
  const ids = Array.from({ length: MAX_GIFT_OPTIONS_PER_CAMPAIGN * 2 + 1 }, (_, index) => ["giftVariantId", `v${index}`] as [string, string]);
  assert.equal(refusal(ids), "INVALID_GIFT_VARIANT");
  // Up to twice the bound is passed through so the structure validator can report "too many" itself.
  const edge = Array.from({ length: MAX_GIFT_OPTIONS_PER_CAMPAIGN + 1 }, (_, index) => ["giftVariantId", `v${index}`] as [string, string]);
  assert.equal(parsed(edge).variantIds.length, MAX_GIFT_OPTIONS_PER_CAMPAIGN + 1);
  assert.deepEqual(validateGiftRuleBounds(parsed(edge)), ["GIFT_OPTIONS_TOO_MANY"]);
});

test("a form without any gift field does not describe the rule, so a stored allowlist is never wiped", () => {
  assert.equal(formCarriesGiftRule(form([["name", "x"], ["giftTrigger", "QUANTITY"]])), false);
  for (const field of ["giftRuleForm", "giftMinimumQuantity", "giftMinimumSubtotalVnd", "giftAwardMode", "giftMaxPerOrder", "giftAllowDuplicates", "giftVariantId"]) {
    assert.equal(formCarriesGiftRule(form([[field, ""]])), true, field);
  }
  const base: Array<[string, string]> = [["kind", "GIFT_ITEM"], ["name", "Gift"], ["scopeMode", "DYNAMIC_CATEGORY"], ["categoryKey", "setVay"], ["giftTrigger", "QUANTITY"]];
  const withoutRule = parseGiftQuantityDraftForm(form(base));
  assert.ok(withoutRule.ok);
  if (withoutRule.ok) assert.equal(withoutRule.value.giftRule, null);
  const withRule = parseGiftQuantityDraftForm(form([...base, ["giftMinimumQuantity", "2"], ["giftVariantId", "v1"]]));
  assert.ok(withRule.ok);
  if (withRule.ok) assert.deepEqual(withRule.value.giftRule?.variantIds, ["v1"]);
});

test("the draft parser: gift fields on a tier are refused, a malformed gift field is typed, tier fields on a gift stay refused", () => {
  const tier: Array<[string, string]> = [["kind", "QUANTITY_TIER"], ["name", "Tier"], ["scopeMode", "DYNAMIC_CATEGORY"], ["categoryKey", "setVay"]];
  const onTier = parseGiftQuantityDraftForm(form([...tier, ["giftMaxPerOrder", "2"]]));
  assert.deepEqual(onTier, { ok: false, reason: "GIFT_FIELDS_ON_TIER" });
  const gift: Array<[string, string]> = [["kind", "GIFT_ITEM"], ["name", "Gift"], ["scopeMode", "DYNAMIC_CATEGORY"], ["categoryKey", "setVay"], ["giftTrigger", "QUANTITY"]];
  assert.deepEqual(parseGiftQuantityDraftForm(form([...gift, ["giftMinimumQuantity", "2.5"]])), { ok: false, reason: "INVALID_GIFT_MINIMUM_QUANTITY" });
  assert.deepEqual(parseGiftQuantityDraftForm(form([...gift, ["tierUnit", "PERCENTAGE"]])), { ok: false, reason: "TIER_FIELDS_ON_GIFT" });
});

test("bounds: thresholds, cap, flag, ids and duplicates", () => {
  assert.deepEqual(validateGiftRuleBounds(rule()), []);
  assert.deepEqual(validateGiftRuleBounds(rule({ minimumQuantity: 1_000_000 })), []);
  assert.deepEqual(validateGiftRuleBounds(subtotalRule({ minimumSubtotalVnd: 100_000_000_000 })), []);
  assert.deepEqual(validateGiftRuleBounds(rule({ maxGiftsPerOrder: 100 })), []);
  for (const [overrides, error] of [
    [{ minimumQuantity: 0 }, "GIFT_MINIMUM_QUANTITY_OUT_OF_RANGE"],
    [{ minimumQuantity: 1_000_001 }, "GIFT_MINIMUM_QUANTITY_OUT_OF_RANGE"],
    [{ minimumQuantity: 1.5 }, "GIFT_MINIMUM_QUANTITY_OUT_OF_RANGE"],
    [{ minimumQuantity: Number.NaN }, "GIFT_MINIMUM_QUANTITY_OUT_OF_RANGE"],
    [{ minimumSubtotalVnd: 0 }, "GIFT_MINIMUM_SUBTOTAL_OUT_OF_RANGE"],
    [{ minimumSubtotalVnd: 100_000_000_001 }, "GIFT_MINIMUM_SUBTOTAL_OUT_OF_RANGE"],
    [{ minimumSubtotalVnd: Number.MAX_SAFE_INTEGER + 2 }, "GIFT_MINIMUM_SUBTOTAL_OUT_OF_RANGE"],
    [{ awardMode: "ALWAYS" }, "INVALID_GIFT_AWARD_MODE"],
    [{ maxGiftsPerOrder: 0 }, "GIFT_MAX_PER_ORDER_OUT_OF_RANGE"],
    [{ maxGiftsPerOrder: 101 }, "GIFT_MAX_PER_ORDER_OUT_OF_RANGE"],
    [{ allowDuplicateGifts: "true" }, "INVALID_GIFT_DUPLICATE_FLAG"],
    [{ variantIds: ["a", "a"] }, "GIFT_OPTION_DUPLICATE"],
    [{ variantIds: [""] }, "GIFT_OPTION_INVALID"],
    [{ variantIds: [" a"] }, "GIFT_OPTION_INVALID"],
    [{ variantIds: ["x".repeat(200)] }, "GIFT_OPTION_INVALID"],
    [{ variantIds: Array.from({ length: MAX_GIFT_OPTIONS_PER_CAMPAIGN + 1 }, (_, index) => `v${index}`) }, "GIFT_OPTIONS_TOO_MANY"],
  ] as const) {
    assert.ok(validateGiftRuleBounds({ ...rule(), ...overrides } as unknown as GiftRuleInput).includes(error), `${JSON.stringify(overrides).slice(0, 60)} -> ${error}`);
  }
});

test("applicability: a threshold belongs to its trigger only, and none exists before a trigger is chosen", () => {
  assert.deepEqual(validateGiftRuleStructure(rule(), "QUANTITY"), []);
  assert.deepEqual(validateGiftRuleStructure(subtotalRule(), "ORDER_SUBTOTAL"), []);
  // An unfinished Draft is fine: nothing set at all, or only the shared fields.
  assert.deepEqual(validateGiftRuleStructure(rule({ minimumQuantity: null, variantIds: [] }), null), []);
  assert.deepEqual(validateGiftRuleStructure(rule({ minimumQuantity: null }), "ORDER_SUBTOTAL"), []);
  assert.deepEqual(validateGiftRuleStructure(rule(), null), ["GIFT_TRIGGER_REQUIRED_FOR_THRESHOLD"]);
  assert.deepEqual(validateGiftRuleStructure(subtotalRule(), null), ["GIFT_TRIGGER_REQUIRED_FOR_THRESHOLD"]);
  assert.deepEqual(validateGiftRuleStructure(subtotalRule(), "QUANTITY"), ["GIFT_FIELD_NOT_APPLICABLE"]);
  assert.deepEqual(validateGiftRuleStructure(rule({ awardMode: "ONCE" }), "QUANTITY"), ["GIFT_FIELD_NOT_APPLICABLE"]);
  assert.deepEqual(validateGiftRuleStructure(rule(), "ORDER_SUBTOTAL"), ["GIFT_FIELD_NOT_APPLICABLE"]);
});

test("publish: a finished quantity rule and a finished subtotal rule are valid", () => {
  assert.deepEqual(validateGiftRuleForPublish({ trigger: "QUANTITY", subtotalScope: null, rule: rule() }), []);
  assert.deepEqual(validateGiftRuleForPublish({ trigger: "QUANTITY", subtotalScope: null, rule: rule({ maxGiftsPerOrder: 3, allowDuplicateGifts: true }) }), []);
  assert.deepEqual(validateGiftRuleForPublish({ trigger: "ORDER_SUBTOTAL", subtotalScope: "ALL_PAID_LINES", rule: subtotalRule() }), []);
  assert.deepEqual(validateGiftRuleForPublish({ trigger: "ORDER_SUBTOTAL", subtotalScope: "ELIGIBLE_PAID_LINES", rule: subtotalRule({ awardMode: "REPEAT_PER_THRESHOLD" }) }), []);
});

test("publish: every missing piece is named, in a stable order", () => {
  const empty = rule({ minimumQuantity: null, allowDuplicateGifts: null, variantIds: [] });
  assert.deepEqual(validateGiftRuleForPublish({ trigger: null, subtotalScope: null, rule: empty }), ["GIFT_TRIGGER_REQUIRED", "GIFT_DUPLICATE_POLICY_REQUIRED", "GIFT_OPTIONS_EMPTY"]);
  assert.deepEqual(validateGiftRuleForPublish({ trigger: "QUANTITY", subtotalScope: null, rule: empty }), ["GIFT_MINIMUM_QUANTITY_REQUIRED", "GIFT_DUPLICATE_POLICY_REQUIRED", "GIFT_OPTIONS_EMPTY"]);
  assert.deepEqual(
    validateGiftRuleForPublish({ trigger: "ORDER_SUBTOTAL", subtotalScope: null, rule: empty }),
    ["GIFT_MINIMUM_SUBTOTAL_REQUIRED", "GIFT_AWARD_MODE_REQUIRED", "GIFT_SUBTOTAL_SCOPE_REQUIRED", "GIFT_DUPLICATE_POLICY_REQUIRED", "GIFT_OPTIONS_EMPTY"],
  );
});

test("publish: a rule that is out of bounds or does not fit the trigger is refused even when complete", () => {
  assert.deepEqual(validateGiftRuleForPublish({ trigger: "QUANTITY", subtotalScope: null, rule: rule({ minimumQuantity: 2_000_000 }) }), ["GIFT_MINIMUM_QUANTITY_OUT_OF_RANGE"]);
  assert.deepEqual(validateGiftRuleForPublish({ trigger: "QUANTITY", subtotalScope: null, rule: subtotalRule({ minimumQuantity: 2 }) }).includes("GIFT_FIELD_NOT_APPLICABLE"), true);
  assert.deepEqual(validateGiftRuleForPublish({ trigger: "QUANTITY", subtotalScope: null, rule: rule({ maxGiftsPerOrder: 500 }) }), ["GIFT_MAX_PER_ORDER_OUT_OF_RANGE"]);
});

test("sameGiftRule: the allowlist is a set, and each field is compared", () => {
  assert.equal(sameGiftRule(rule({ variantIds: ["a", "b"] }), rule({ variantIds: ["b", "a"] })), true);
  for (const change of [
    { variantIds: ["a", "b", "c"] }, { variantIds: ["a", "c"] }, { minimumQuantity: 3 }, { maxGiftsPerOrder: 4 },
    { allowDuplicateGifts: true }, { allowDuplicateGifts: null }, { awardMode: "ONCE" as const },
  ]) {
    assert.equal(sameGiftRule(rule({ variantIds: ["a", "b"] }), rule({ variantIds: ["a", "b"], ...change })), false, JSON.stringify(change));
  }
  assert.equal(sameGiftRule(subtotalRule(), subtotalRule({ minimumSubtotalVnd: 500_001 })), false);
});

test("row mapping: the BigInt column round-trips through a plain number at the bound", () => {
  const stored = giftRuleOfRow({
    minimumQuantity: null, minimumSubtotalVnd: BigInt(100_000_000_000), awardMode: "ONCE", maxGiftsPerOrder: null,
    allowDuplicateGifts: true, giftOptions: [{ variantId: "v1" }],
  });
  assert.deepEqual(stored, { minimumQuantity: null, minimumSubtotalVnd: 100_000_000_000, awardMode: "ONCE", maxGiftsPerOrder: null, allowDuplicateGifts: true, variantIds: ["v1"] });
  assert.equal(giftRuleColumns(stored).minimumSubtotalVnd, BigInt(100_000_000_000));
  assert.equal(giftRuleColumns(rule()).minimumSubtotalVnd, null);
});

const at = (day: number) => new Date(Date.UTC(2026, 9, day));
const win = (from: number | null, to: number | null) => ({ startsAt: from === null ? null : at(from), endsAt: to === null ? null : at(to) });

test("concurrency: the candidate is the cap+1st window in force at one instant only when windows really overlap", () => {
  const twenty = Array.from({ length: 20 }, () => win(10, 20));
  assert.equal(exceedsConcurrentWindows(win(10, 20), twenty.slice(0, 19), 20), false, "the 20th is allowed");
  assert.equal(exceedsConcurrentWindows(win(10, 20), twenty, 20), true, "the 21st is refused");
  assert.equal(exceedsConcurrentWindows(win(15, 16), twenty, 20), true, "a window inside the others overlaps them");
  assert.equal(exceedsConcurrentWindows(win(null, null), twenty, 20), true, "an unbounded candidate overlaps everything");
  assert.equal(exceedsConcurrentWindows(win(5, null), twenty, 20), true, "an open end reaches the others");
  assert.equal(exceedsConcurrentWindows(win(null, 11), twenty, 20), true, "an open start reaches the others");
  assert.equal(exceedsConcurrentWindows(win(1, 5), [], 20), false);
});

test("concurrency: windows are half-open, so back-to-back campaigns never overlap", () => {
  const twenty = Array.from({ length: 20 }, () => win(10, 20));
  assert.equal(exceedsConcurrentWindows(win(20, 30), twenty, 20), false, "starts exactly when the others end");
  assert.equal(exceedsConcurrentWindows(win(1, 10), twenty, 20), false, "ends exactly when the others start");
  assert.equal(exceedsConcurrentWindows(win(19, 30), twenty, 20), true, "one day of overlap is enough");
  assert.equal(exceedsConcurrentWindows(win(1, 11), twenty, 20), true);
});

test("concurrency: only the instants inside the candidate window count, and staggered windows are summed per instant", () => {
  // 20 windows, but no instant has more than 10 of them in force at once.
  const staggered = Array.from({ length: 20 }, (_, index) => win(1 + index * 2, 21 + index * 2));
  assert.equal(exceedsConcurrentWindows(win(1, 40), staggered, 10), true, "at most 10 others overlap at once, so 11 in force exceeds a cap of 10");
  assert.equal(exceedsConcurrentWindows(win(1, 40), staggered, 11), false, "and exactly fits a cap of 11");
  // Crowding that never touches the candidate window is irrelevant.
  const crowded = Array.from({ length: 25 }, () => win(1, 5));
  assert.equal(exceedsConcurrentWindows(win(6, 9), crowded, 20), false);
  // A crowd that starts inside the candidate window counts at its own start, not at the candidate's.
  const late = Array.from({ length: 20 }, () => win(15, 25));
  assert.equal(exceedsConcurrentWindows(win(10, 18), late, 20), true);
  assert.equal(exceedsConcurrentWindows(win(10, 15), late, 20), false, "the candidate ends the instant the crowd starts");
});

test("concurrency: an empty or inverted candidate window is not this function's concern", () => {
  const twenty = Array.from({ length: 20 }, () => win(10, 20));
  assert.equal(exceedsConcurrentWindows(win(12, 12), twenty, 20), false);
  assert.equal(exceedsConcurrentWindows(win(15, 12), twenty, 20), false);
});
