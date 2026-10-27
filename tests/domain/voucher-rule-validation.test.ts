import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_VOUCHER_BUDGET_VND,
  MAX_VOUCHER_USES,
  MAX_VOUCHER_VND,
  normalizeVoucherCode,
  validateVoucherCampaign,
  type VoucherCampaignValues,
} from "../../src/commerce/voucher-rule-validation.ts";

const base = {
  name: "Giảm 30K đơn Đầm",
  kind: "MERCHANDISE",
  issuance: "AUTO",
  visibility: "PUBLIC",
  discount: { type: "FIXED_AMOUNT_VND", amountVnd: 30_000 },
  minEligibleSubtotalVnd: 600_000,
  scope: { mode: "ALL_SHOP" },
};

function valid(overrides: Record<string, unknown> = {}): VoucherCampaignValues {
  const result = validateVoucherCampaign({ ...base, ...overrides });
  assert.equal(result.ok, true, JSON.stringify(result));
  return (result as { value: VoucherCampaignValues }).value;
}

function issues(overrides: Record<string, unknown> = {}): string[] {
  const result = validateVoucherCampaign({ ...base, ...overrides });
  assert.equal(result.ok, false);
  return (result as unknown as { issues: readonly { code: string; field: string }[] }).issues.map(
    (issue) => `${issue.code}@${issue.field}`,
  );
}

test("a complete fixed-amount AUTO/PUBLIC voucher normalizes and freezes", () => {
  const value = valid({ name: "  Giảm 30K đơn Đầm  " });
  assert.equal(value.name, "Giảm 30K đơn Đầm");
  assert.equal(value.code, null);
  assert.equal(value.maxUses, null);
  assert.equal(value.maxBudgetVnd, null);
  assert.equal(Object.isFrozen(value), true);
  assert.equal(Object.isFrozen(value.discount), true);
});

test("fixed discount needs a threshold strictly above the amount (AC-07)", () => {
  assert.deepEqual(issues({ minEligibleSubtotalVnd: null }), ["fixed-min-required@minEligibleSubtotalVnd"]);
  assert.deepEqual(issues({ minEligibleSubtotalVnd: 30_000 }), ["fixed-min-not-above-amount@minEligibleSubtotalVnd"]);
  assert.deepEqual(issues({ minEligibleSubtotalVnd: 29_999 }), ["fixed-min-not-above-amount@minEligibleSubtotalVnd"]);
  valid({ minEligibleSubtotalVnd: 30_001 });
});

test("fixed amount must be a positive whole VND within bounds", () => {
  for (const amountVnd of [0, -1, 1.5, "30000", Number.NaN, MAX_VOUCHER_VND + 1]) {
    assert.ok(
      issues({ discount: { type: "FIXED_AMOUNT_VND", amountVnd } }).includes("fixed-amount-invalid@discount.amountVnd"),
      String(amountVnd),
    );
  }
});

test("percentage is 1..99 whole percent with an optional positive cap", () => {
  const percentage = (percent: unknown, maxDiscountVnd?: unknown) => ({
    discount: { type: "PERCENTAGE", percent, maxDiscountVnd },
    minEligibleSubtotalVnd: null,
  });
  assert.deepEqual(valid(percentage(10)).discount, { type: "PERCENTAGE", percent: 10, maxDiscountVnd: null });
  assert.deepEqual(valid(percentage(99, 100_000)).discount, { type: "PERCENTAGE", percent: 99, maxDiscountVnd: 100_000 });
  for (const percent of [0, 100, -5, 10.5, "10", Number.NaN]) {
    assert.ok(issues(percentage(percent)).includes("percent-invalid@discount.percent"), String(percent));
  }
  for (const cap of [0, -1, 1.5, "100", MAX_VOUCHER_VND + 1]) {
    assert.ok(issues(percentage(10, cap)).includes("max-discount-invalid@discount.maxDiscountVnd"), String(cap));
  }
});

test("percentage and fixed discounts refuse each other's fields", () => {
  assert.ok(
    issues({ discount: { type: "FIXED_AMOUNT_VND", amountVnd: 10_000, maxDiscountVnd: 5_000 } }).includes(
      "discount-fields-mismatch@discount",
    ),
  );
  assert.ok(
    issues({ discount: { type: "PERCENTAGE", percent: 10, amountVnd: 10_000 }, minEligibleSubtotalVnd: null }).includes(
      "discount-fields-mismatch@discount",
    ),
  );
  assert.ok(issues({ discount: { type: "BOGO" } }).includes("discount-type-invalid@discount.type"));
  assert.ok(issues({ discount: undefined }).includes("discount-required@discount"));
});

test("SHIPPING_FREE has no merchandise discount and an optional threshold", () => {
  const value = valid({ kind: "SHIPPING_FREE", discount: undefined, minEligibleSubtotalVnd: 500_000 });
  assert.equal(value.discount, null);
  assert.equal(valid({ kind: "SHIPPING_FREE", discount: undefined, minEligibleSubtotalVnd: undefined }).minEligibleSubtotalVnd, null);
  assert.ok(issues({ kind: "SHIPPING_FREE" }).includes("discount-not-allowed@discount"));
});

test("minimum, when given, is a positive whole VND within bounds", () => {
  for (const minimum of [0, -1, 1.5, "600000", MAX_VOUCHER_VND + 1]) {
    assert.ok(issues({ minEligibleSubtotalVnd: minimum }).includes("min-subtotal-invalid@minEligibleSubtotalVnd"), String(minimum));
  }
});

test("PRIVATE requires a CODE and AUTO must be PUBLIC", () => {
  assert.ok(issues({ issuance: "AUTO", visibility: "PRIVATE" }).includes("private-requires-code@visibility"));
  const priv = valid({ issuance: "CODE", visibility: "PRIVATE", code: "kol50" });
  assert.equal(priv.code, "KOL50");
  assert.equal(valid({ issuance: "CODE", visibility: "PUBLIC", code: "HELLO-10" }).code, "HELLO-10");
});

test("a CODE voucher needs a canonical code and an AUTO voucher must not carry one", () => {
  assert.ok(issues({ issuance: "CODE" }).includes("code-required@code"));
  assert.ok(issues({ issuance: "CODE", code: "ab" }).includes("code-invalid@code"));
  assert.ok(issues({ issuance: "CODE", code: "has space" }).includes("code-invalid@code"));
  assert.ok(issues({ issuance: "CODE", code: "x".repeat(33) }).includes("code-invalid@code"));
  assert.ok(issues({ issuance: "AUTO", code: "SAVE10" }).includes("code-not-allowed@code"));
});

test("normalizeVoucherCode trims, upper-cases and bounds", () => {
  assert.equal(normalizeVoucherCode("  kol_50-a "), "KOL_50-A");
  assert.equal(normalizeVoucherCode("ABC"), "ABC");
  assert.equal(normalizeVoucherCode("AB"), null);
  assert.equal(normalizeVoucherCode("ĐẦM10"), null);
  assert.equal(normalizeVoucherCode("A".repeat(33)), null);
  assert.equal(normalizeVoucherCode(null), null);
  assert.equal(normalizeVoucherCode(12345), null);
});

test("window must be a real interval; open bounds are allowed", () => {
  const a = new Date("2026-11-01T00:00:00Z");
  const b = new Date("2026-12-01T00:00:00Z");
  valid({ startsAt: a, endsAt: b });
  valid({ startsAt: a, endsAt: null });
  valid({ startsAt: null, endsAt: b });
  assert.ok(issues({ startsAt: b, endsAt: a }).includes("window-invalid@window"));
  assert.ok(issues({ startsAt: a, endsAt: a }).includes("window-invalid@window"));
  assert.ok(issues({ startsAt: new Date("nope") }).includes("window-invalid@window"));
  assert.ok(issues({ startsAt: "2026-11-01" }).includes("window-invalid@window"));
});

test("maxUses and maxBudget are optional positive whole numbers within bounds", () => {
  const value = valid({ maxUses: 100, maxBudgetVnd: 1_000_000 });
  assert.equal(value.maxUses, 100);
  assert.equal(value.maxBudgetVnd, 1_000_000);
  for (const bad of [0, -1, 1.5, "10", MAX_VOUCHER_USES + 1]) {
    assert.ok(issues({ maxUses: bad }).includes("max-uses-invalid@maxUses"), String(bad));
  }
  for (const bad of [0, -1, 1.5, "10", MAX_VOUCHER_BUDGET_VND + 1]) {
    assert.ok(issues({ maxBudgetVnd: bad }).includes("max-budget-invalid@maxBudgetVnd"), String(bad));
  }
});

test("scope problems are reported under scope.* and the scope is normalized", () => {
  assert.ok(issues({ scope: { mode: "TARGETED" } }).includes("scope-empty@scope.scope"));
  assert.ok(issues({ scope: { mode: "ALL_SHOP", categoryKeys: ["vayDam"] } }).includes("scope-all-shop-with-targets@scope.scope"));
  assert.deepEqual(valid({ scope: { mode: "ALL_SHOP", excludeProductIds: ["p1"] } }).scope, {
    mode: "ALL_SHOP",
    excludeProductIds: ["p1"],
  });
});

test("name, kind, issuance and visibility are required enums", () => {
  assert.ok(issues({ name: "   " }).includes("name-invalid@name"));
  assert.ok(issues({ name: undefined }).includes("name-invalid@name"));
  assert.ok(issues({ kind: "GIFT" }).includes("kind-invalid@kind"));
  assert.ok(issues({ issuance: "LINK" }).includes("issuance-invalid@issuance"));
  assert.ok(issues({ visibility: "SECRET" }).includes("visibility-invalid@visibility"));
});

test("non-object input and several problems at once are reported together", () => {
  for (const input of [null, undefined, "voucher", 5, []]) {
    assert.deepEqual(validateVoucherCampaign(input), { ok: false, issues: [{ code: "input-invalid", field: "input" }] });
  }
  const all = issues({ name: "", maxUses: 0, minEligibleSubtotalVnd: null });
  assert.ok(all.length >= 3, all.join(","));
});
