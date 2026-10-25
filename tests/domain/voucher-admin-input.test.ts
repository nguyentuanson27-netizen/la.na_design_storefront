import assert from "node:assert/strict";
import test from "node:test";

import { describeVoucherAdminReason } from "../../src/commerce/voucher-admin-feedback.ts";
import { parseVoucherCampaignForm, parseVoucherCopyCode, parseVoucherIdentity } from "../../src/commerce/voucher-admin-input.ts";
import { validateVoucherCampaign } from "../../src/commerce/voucher-rule-validation.ts";

function form(fields: Record<string, string | string[]>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) for (const item of Array.isArray(value) ? value : [value]) data.append(key, item);
  return data;
}

const fixed = {
  name: "Giảm 30K", kind: "MERCHANDISE", issuance: "AUTO", visibility: "PUBLIC",
  discountType: "FIXED_AMOUNT_VND", amountVnd: "30000", minEligibleSubtotalVnd: "600000",
  scopeMode: "ALL_SHOP", startsAt: "", endsAt: "", maxUses: "", maxBudgetVnd: "",
};

function parsedInput(fields: Record<string, string | string[]>) {
  const parsed = parseVoucherCampaignForm(form(fields));
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  return (parsed as { input: Record<string, unknown> }).input;
}

test("a complete fixed-amount form parses and validates end to end", () => {
  const result = validateVoucherCampaign(parsedInput(fixed));
  assert.equal(result.ok, true, JSON.stringify(result));
});

test("percentage, shipping and code forms map to the validation input", () => {
  const pct = validateVoucherCampaign(parsedInput({ ...fixed, discountType: "PERCENTAGE", percent: "10", maxDiscountVnd: "100000", minEligibleSubtotalVnd: "" }));
  assert.equal(pct.ok, true, JSON.stringify(pct));
  const ship = validateVoucherCampaign(parsedInput({ ...fixed, kind: "SHIPPING_FREE", minEligibleSubtotalVnd: "500000", discountType: "FIXED_AMOUNT_VND", amountVnd: "9" }));
  assert.equal(ship.ok, true, JSON.stringify(ship));
  const code = validateVoucherCampaign(parsedInput({ ...fixed, issuance: "CODE", code: "kol50", visibility: "PRIVATE" }));
  assert.equal(code.ok, true, JSON.stringify(code));
  assert.equal((code as { value: { code: string } }).value.code, "KOL50");
});

test("an AUTO voucher ignores a stray code field instead of persisting it", () => {
  const result = validateVoucherCampaign(parsedInput({ ...fixed, code: "SNEAKY1" }));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal((result as { value: { code: null } }).value.code, null);
});

test("targeted scope collects repeated checkbox and picker fields", () => {
  const result = validateVoucherCampaign(
    parsedInput({ ...fixed, scopeMode: "TARGETED", categoryKey: ["vayDam", "phuKien"], includeProductId: ["p1"], excludeProductId: ["p2"] }),
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual((result as { value: { scope: unknown } }).value.scope, { mode: "TARGETED", categoryKeys: ["vayDam", "phuKien"], includeProductIds: ["p1"], excludeProductIds: ["p2"] });
});

test("numbers are strict digits: separators, exponents, signs, decimals and zero fail validation", () => {
  for (const amountVnd of ["30,000", "3e4", "-30000", "30000.5", "0", "030000", " ", "abc"]) {
    const result = validateVoucherCampaign(parsedInput({ ...fixed, amountVnd }));
    assert.equal(result.ok, false, amountVnd);
  }
  assert.equal(validateVoucherCampaign(parsedInput({ ...fixed, maxUses: "1e3" })).ok, false);
  assert.equal(validateVoucherCampaign(parsedInput({ ...fixed, maxBudgetVnd: "0" })).ok, false);
});

test("a repeated scalar field is refused, never merged", () => {
  const dup = form(fixed);
  dup.append("name", "second name");
  const result = validateVoucherCampaign((parseVoucherCampaignForm(dup) as { input: Record<string, unknown> }).input);
  assert.equal(result.ok, false);
});

test("dates are Vietnam local time and strict; a bad one is a window issue", () => {
  const ok = parsedInput({ ...fixed, startsAt: "2026-11-01T09:00", endsAt: "2026-11-02T09:00" });
  assert.equal((ok.startsAt as Date).toISOString(), "2026-11-01T02:00:00.000Z");
  assert.deepEqual(parseVoucherCampaignForm(form({ ...fixed, startsAt: "01/11/2026" })), { ok: false, issues: [{ code: "window-invalid", field: "window" }] });
  assert.equal(validateVoucherCampaign(parsedInput({ ...fixed, startsAt: "2026-11-02T09:00", endsAt: "2026-11-01T09:00" })).ok, false);
});

test("identity and copy-code parsing are strict", () => {
  assert.deepEqual(parseVoucherIdentity(form({ campaignId: "abc_1-2", revision: "3" })), { id: "abc_1-2", revision: 3 });
  for (const bad of [{ campaignId: "bad id", revision: "1" }, { campaignId: "a", revision: "0" }, { campaignId: "a", revision: "2147483647" }, { campaignId: "a" }, { revision: "1" }] as Record<string, string>[]) {
    assert.equal(parseVoucherIdentity(form(bad)), null);
  }
  assert.equal(parseVoucherIdentity(form({ campaignId: ["a", "b"], revision: "1" })), null);
  assert.equal(parseVoucherCopyCode(form({ code: " newcode1 " })), " newcode1 ");
  assert.equal(parseVoucherCopyCode(form({ code: "" })), null);
  assert.equal(parseVoucherCopyCode(form({ code: ["a", "b"] })), null);
});

test("feedback maps known codes to text and never echoes an unknown one", () => {
  assert.match(describeVoucherAdminReason("CAP_BELOW_COMMITTED"), /thấp hơn/);
  assert.match(describeVoucherAdminReason("VALIDATION", "fixed-min-not-above-amount"), /lớn hơn số tiền giảm/);
  const evil = "<script>alert(1)</script>";
  assert.doesNotMatch(describeVoucherAdminReason(evil), /script/);
  assert.doesNotMatch(describeVoucherAdminReason("VALIDATION", evil), /script/);
  assert.equal(describeVoucherAdminReason("__proto__"), describeVoucherAdminReason("unknown"));
});
