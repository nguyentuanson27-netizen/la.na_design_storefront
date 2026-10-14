import assert from "node:assert/strict";
import test from "node:test";

import {
  formCarriesTierRule,
  MAX_STACK_PEERS,
  parseTierRuleForm,
  validateTierRuleStructure,
  type TierRuleInput,
} from "../../src/commerce/gift-quantity-tier-rule.ts";
import { MAX_TIERS_PER_CAMPAIGN } from "../../src/commerce/gift-quantity-tier.ts";

function form(entries: Array<[string, string]>): FormData {
  const data = new FormData();
  for (const [key, value] of entries) data.append(key, value);
  return data;
}
function parsed(entries: Array<[string, string]>) {
  const result = parseTierRuleForm(form(entries));
  assert.equal(result.ok, true, JSON.stringify(result));
  return (result as Extract<typeof result, { ok: true }>).value;
}
const rule = (overrides: Partial<TierRuleInput> = {}): TierRuleInput => ({
  unit: "PERCENTAGE",
  discountedUnits: "ALL_ELIGIBLE_UNITS",
  selectionPriority: null,
  tiers: [{ minQuantity: 3, discountValue: 10 }, { minQuantity: 5, discountValue: 15 }],
  stackingEnabled: false,
  stackPriority: null,
  peers: [],
  ...overrides,
});

test("parse: a full tier form becomes a typed rule; blank rows are skipped", () => {
  const value = parsed([
    ["tierUnit", "PERCENTAGE"],
    ["tierDiscountedUnits", "FROM_REACHED_THRESHOLD"],
    ["tierSelectionPriority", "CHEAPEST_FIRST"],
    ["tierMinQuantity", "3"], ["tierDiscountValue", "10"],
    ["tierMinQuantity", ""], ["tierDiscountValue", ""],
    ["tierMinQuantity", "5"], ["tierDiscountValue", "15"],
    ["stackingEnabled", "on"], ["stackPriority", "2"],
    ["stackPeer", "PROMOTION:abc"], ["stackPeer", "QUANTITY_TIER:def"],
  ]);
  assert.equal(value.unit, "PERCENTAGE");
  assert.equal(value.discountedUnits, "FROM_REACHED_THRESHOLD");
  assert.equal(value.selectionPriority, "CHEAPEST_FIRST");
  assert.deepEqual(value.tiers, [{ minQuantity: 3, discountValue: 10 }, { minQuantity: 5, discountValue: 15 }]);
  assert.equal(value.stackingEnabled, true);
  assert.equal(value.stackPriority, 2);
  assert.deepEqual(value.peers, [{ kind: "PROMOTION", campaignId: "abc" }, { kind: "QUANTITY_TIER", campaignId: "def" }]);
});

test("parse: an empty form is an empty, unset rule", () => {
  const value = parsed([]);
  assert.deepEqual(value, { unit: null, discountedUnits: null, selectionPriority: null, tiers: [], stackingEnabled: false, stackPriority: null, peers: [] });
});

test("parse: refuses unknown enums, non-integers, ragged rows and bad priorities without repairing them", () => {
  const reason = (entries: Array<[string, string]>) => {
    const result = parseTierRuleForm(form(entries));
    return result.ok ? "OK" : result.reason;
  };
  assert.equal(reason([["tierUnit", "BOGUS"]]), "INVALID_TIER_UNIT");
  assert.equal(reason([["tierDiscountedUnits", "ALL"]]), "INVALID_TIER_DISCOUNTED_UNITS");
  assert.equal(reason([["tierSelectionPriority", "RANDOM"]]), "INVALID_TIER_SELECTION_PRIORITY");
  assert.equal(reason([["tierMinQuantity", "3"]]), "INVALID_TIER_ROW");
  assert.equal(reason([["tierMinQuantity", "3.5"], ["tierDiscountValue", "10"]]), "INVALID_TIER_ROW");
  assert.equal(reason([["tierMinQuantity", "-3"], ["tierDiscountValue", "10"]]), "INVALID_TIER_ROW");
  assert.equal(reason([["tierMinQuantity", "1e2"], ["tierDiscountValue", "10"]]), "INVALID_TIER_ROW");
  assert.equal(reason([["tierMinQuantity", "3"], ["tierDiscountValue", ""]]), "INVALID_TIER_ROW");
  assert.equal(reason([["stackPriority", "-1"]]), "INVALID_STACK_PRIORITY");
  assert.equal(reason([["stackPriority", "abc"]]), "INVALID_STACK_PRIORITY");
  assert.equal(reason([["stackPeer", "noseparator"]]), "INVALID_STACK_PEER");
  assert.equal(reason([["stackPeer", ":id"]]), "INVALID_STACK_PEER");
});

test("parse: a ladder over the cap is parsed whole and refused by structure; an absurd row count is refused outright", () => {
  const rows = (count: number) => {
    const entries: Array<[string, string]> = [];
    for (let index = 1; index <= count; index += 1) entries.push(["tierMinQuantity", String(index)], ["tierDiscountValue", "5"]);
    return entries;
  };
  const value = parsed(rows(MAX_TIERS_PER_CAMPAIGN + 1));
  assert.equal(value.tiers.length, MAX_TIERS_PER_CAMPAIGN + 1);
  assert.ok(validateTierRuleStructure(value).includes("TIERS_TOO_MANY"));
  const flood = parseTierRuleForm(form(rows(MAX_TIERS_PER_CAMPAIGN * 2 + 1)));
  assert.deepEqual(flood, { ok: false, reason: "INVALID_TIER_ROW" });
  const peers = parseTierRuleForm(form(Array.from({ length: MAX_STACK_PEERS * 2 + 1 }, (_, i): [string, string] => ["stackPeer", `PROMOTION:p${i}`])));
  assert.deepEqual(peers, { ok: false, reason: "INVALID_STACK_PEER" });
});

test("parse: blank rows never hide a real row, and nothing is silently truncated", () => {
  const entries: Array<[string, string]> = [];
  for (let index = 0; index < MAX_TIERS_PER_CAMPAIGN + 5; index += 1) entries.push(["tierMinQuantity", ""], ["tierDiscountValue", ""]);
  entries.push(["tierMinQuantity", "4"], ["tierDiscountValue", "12"]);
  assert.deepEqual(parsed(entries).tiers, [{ minQuantity: 4, discountValue: 12 }]);
});

test("parse: integers are plain digits; repeated or malformed single fields are refused, not picked from", () => {
  const reason = (entries: Array<[string, string]>) => {
    const result = parseTierRuleForm(form(entries));
    return result.ok ? "OK" : result.reason;
  };
  assert.equal(reason([["tierMinQuantity", "03"], ["tierDiscountValue", "10"]]), "INVALID_TIER_ROW");
  assert.equal(reason([["tierMinQuantity", "3 "], ["tierDiscountValue", "1_0"]]), "INVALID_TIER_ROW");
  assert.equal(reason([["tierMinQuantity", "9999999999999999999"], ["tierDiscountValue", "10"]]), "INVALID_TIER_ROW");
  assert.equal(reason([["tierUnit", "PERCENTAGE"], ["tierUnit", "FIXED_AMOUNT_PER_UNIT_VND"]]), "INVALID_TIER_UNIT");
  assert.equal(reason([["stackPriority", "1"], ["stackPriority", "2"]]), "INVALID_STACK_PRIORITY");
  assert.equal(reason([["stackPriority", "007"]]), "INVALID_STACK_PRIORITY");
  assert.equal(reason([["stackPriority", "0"]]), "OK", "priority 0 is a valid first position");
  assert.equal(reason([["stackingEnabled", "maybe"]]), "INVALID_STACKING_FLAG");
  assert.equal(reason([["stackingEnabled", "on"], ["stackingEnabled", "on"]]), "INVALID_STACKING_FLAG");
  assert.equal(reason([["stackingEnabled", "off"]]), "OK");
  const file = new FormData();
  file.append("tierUnit", new Blob(["x"]), "x.txt");
  assert.equal(parseTierRuleForm(file).ok, false);
});

test("a form that carries no tier field does not describe the rule", () => {
  assert.equal(formCarriesTierRule(form([["name", "x"], ["kind", "QUANTITY_TIER"]])), false);
  for (const field of ["tierRuleForm", "tierUnit", "tierMinQuantity", "stackPriority", "stackPeer", "stackingEnabled"]) {
    assert.equal(formCarriesTierRule(form([[field, ""]])), true, field);
  }
});

test("structure: a valid or merely incomplete Draft has no structural errors", () => {
  assert.deepEqual(validateTierRuleStructure(rule()), []);
  assert.deepEqual(validateTierRuleStructure(rule({ unit: null, tiers: [] })), []);
  // A non-increasing ladder is a business problem, not a structural one: a Draft may hold it.
  assert.deepEqual(validateTierRuleStructure(rule({ tiers: [{ minQuantity: 5, discountValue: 10 }, { minQuantity: 3, discountValue: 20 }] })), []);
});

test("structure: bounds, duplicates, percent range, unit and stack inputs", () => {
  const errors = (overrides: Partial<TierRuleInput>) => validateTierRuleStructure(rule(overrides));
  assert.ok(errors({ tiers: [{ minQuantity: 0, discountValue: 5 }] }).includes("TIER_THRESHOLD_OUT_OF_RANGE"));
  assert.ok(errors({ tiers: [{ minQuantity: 2_000_000, discountValue: 5 }] }).includes("TIER_THRESHOLD_OUT_OF_RANGE"));
  assert.ok(errors({ tiers: [{ minQuantity: 2, discountValue: 0 }] }).includes("TIER_VALUE_OUT_OF_RANGE"));
  assert.ok(errors({ tiers: [{ minQuantity: 2, discountValue: 2_000_000_001 }], unit: "FIXED_AMOUNT_PER_UNIT_VND" }).includes("TIER_VALUE_OUT_OF_RANGE"));
  assert.ok(errors({ tiers: [{ minQuantity: 2, discountValue: 100 }] }).includes("TIER_PERCENT_OUT_OF_RANGE"));
  assert.deepEqual(errors({ tiers: [{ minQuantity: 2, discountValue: 100 }], unit: "FIXED_AMOUNT_PER_UNIT_VND" }), []);
  assert.ok(errors({ tiers: [{ minQuantity: 2, discountValue: 5 }, { minQuantity: 2, discountValue: 6 }] }).includes("TIER_THRESHOLD_DUPLICATE"));
  assert.ok(errors({ unit: null }).includes("TIER_UNIT_REQUIRED"));
  assert.ok(errors({ selectionPriority: "CHEAPEST_FIRST" }).includes("SELECTION_PRIORITY_NOT_APPLICABLE"));
  assert.deepEqual(errors({ discountedUnits: "FROM_REACHED_THRESHOLD", selectionPriority: "CHEAPEST_FIRST" }), []);
  assert.ok(errors({ stackPriority: 2_000_000 }).includes("STACK_PRIORITY_OUT_OF_RANGE"));
  assert.ok(errors({ peers: [{ kind: "BOGUS" as never, campaignId: "x" }] }).includes("STACK_PEER_INVALID"));
  assert.deepEqual(errors({ peers: [{ kind: "PROMOTION", campaignId: "*" }, { kind: "QUANTITY_TIER", campaignId: "*" }] }), [], "a kind wildcard is allowed");
  // Gifts are never paired with a tier by the engine, so a tier naming one would store a dead consent.
  assert.ok(errors({ peers: [{ kind: "GIFT_ITEM" as never, campaignId: "x" }] }).includes("STACK_PEER_INVALID"));
  assert.ok(errors({ peers: [{ kind: "PROMOTION", campaignId: " x" }] }).includes("STACK_PEER_INVALID"));
  assert.ok(errors({ peers: [{ kind: "PROMOTION", campaignId: "x".repeat(65) }] }).includes("STACK_PEER_INVALID"));
  assert.ok(errors({ peers: [{ kind: "PROMOTION", campaignId: "x" }, { kind: "PROMOTION", campaignId: "x" }] }).includes("STACK_PEER_DUPLICATE"));
  const many = Array.from({ length: MAX_STACK_PEERS + 1 }, (_, index) => ({ kind: "PROMOTION" as const, campaignId: `p${index}` }));
  assert.ok(errors({ peers: many }).includes("STACK_PEERS_TOO_MANY"));
});

test("structure: direct service inputs enforce enum and boolean allowlists before persistence", () => {
  for (const [field, value, error] of [
    ["unit", "BOGUS", "INVALID_TIER_UNIT"],
    ["discountedUnits", "BOGUS", "INVALID_TIER_DISCOUNTED_UNITS"],
    ["selectionPriority", "BOGUS", "INVALID_TIER_SELECTION_PRIORITY"],
    ["stackingEnabled", "true", "INVALID_STACKING_FLAG"],
  ] as const) {
    const malformed = rule({ discountedUnits: "FROM_REACHED_THRESHOLD", selectionPriority: "CHEAPEST_FIRST", [field]: value } as unknown as Partial<TierRuleInput>);
    assert.ok(validateTierRuleStructure(malformed).includes(error), field);
  }
});
