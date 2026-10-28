import assert from "node:assert/strict";
import test from "node:test";

import { describeVoucherAdminReason } from "../../src/commerce/voucher-admin-feedback.ts";
import { parseVoucherCampaignForm, parseVoucherTypeForm, parseVoucherTypeIdentity } from "../../src/commerce/voucher-admin-input.ts";
import { validateVoucherCampaign } from "../../src/commerce/voucher-rule-validation.ts";
import { findLadderConflict, validateVoucherType, type LadderTier } from "../../src/commerce/voucher-type-rules.ts";

function form(fields: Record<string, string | string[]>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) for (const item of Array.isArray(value) ? value : [value]) data.append(key, item);
  return data;
}

const validType = { name: "  Theo đơn hàng ", priority: 2, issuance: "AUTO", visibility: "PUBLIC" };
const issuesOf = (input: unknown) => {
  const result = validateVoucherType(input);
  assert.equal(result.ok, false, JSON.stringify(result));
  return (result as unknown as { issues: readonly { code: string; field: string }[] }).issues.map((issue) => `${issue.code}@${issue.field}`);
};

test("a complete type normalizes and freezes", () => {
  const result = validateVoucherType(validType);
  assert.equal(result.ok, true, JSON.stringify(result));
  const value = (result as { value: Record<string, unknown> }).value;
  assert.deepEqual(value, { name: "Theo đơn hàng", priority: 2, issuance: "AUTO", visibility: "PUBLIC", code: null });
  assert.equal(Object.isFrozen(value), true);
  const code = validateVoucherType({ ...validType, issuance: "CODE", visibility: "PRIVATE", code: " kol-ladder " });
  assert.equal(code.ok && code.value.code, "KOL-LADDER");
});

test("a type's name, priority and distribution are bounded", () => {
  assert.deepEqual(issuesOf({ ...validType, name: "   " }), ["name-invalid@name"]);
  for (const priority of [0, 1001, -1, 1.5, "2", Number.NaN, null, undefined]) assert.deepEqual(issuesOf({ ...validType, priority }), ["type-priority-invalid@priority"], String(priority));
  assert.deepEqual(issuesOf({ ...validType, issuance: "AUTO", visibility: "PRIVATE" }), ["private-requires-code@visibility"]);
  assert.deepEqual(issuesOf({ ...validType, code: "ABC" }), ["code-not-allowed@code"]);
  assert.deepEqual(issuesOf({ ...validType, issuance: "CODE" }), ["code-required@code"]);
  assert.deepEqual(issuesOf({ ...validType, issuance: "CODE", code: "no" }), ["code-invalid@code"]);
  assert.deepEqual(issuesOf({ ...validType, issuance: "SOMETIMES" }), ["issuance-invalid@issuance"]);
  assert.deepEqual(issuesOf(null), ["input-invalid@input"]);
  assert.deepEqual(issuesOf([]), ["input-invalid@input"]);
});

test("the type form parses to the validation input and refuses a repeated or non-numeric field", () => {
  const parsed = parseVoucherTypeForm(form({ name: "Theo đơn", priority: "3", issuance: "CODE", visibility: "PRIVATE", code: "abc123" }));
  assert.equal(parsed.ok, true);
  assert.deepEqual((parsed as { input: unknown }).input, { name: "Theo đơn", priority: 3, issuance: "CODE", visibility: "PRIVATE", code: "abc123" });
  const result = validateVoucherType((parsed as { input: unknown }).input);
  assert.equal(result.ok, true);
  for (const priority of ["", "0", "1e3", "-2", "1.5", "99999"]) {
    const input = (parseVoucherTypeForm(form({ ...validType, priority })) as { input: unknown }).input;
    assert.equal(validateVoucherType(input).ok, false, priority);
  }
  const repeated = parseVoucherTypeForm(form({ name: ["A", "B"], priority: "1", issuance: "AUTO", visibility: "PUBLIC" }));
  assert.equal(validateVoucherType((repeated as { input: unknown }).input).ok, false);
  assert.deepEqual(parseVoucherTypeIdentity(form({ typeId: "type_1-A", revision: "3" })), { id: "type_1-A", revision: 3 });
  const badIdentities: Array<Record<string, string | string[]>> = [{}, { typeId: "ok" }, { typeId: "ok", revision: "0" }, { typeId: "ok", revision: "1.5" }, { typeId: "ok", revision: ["1", "2"] }, { typeId: "ok", revision: "2147483647" }, { typeId: "bad id", revision: "1" }, { typeId: ["a", "b"], revision: "1" }, { typeId: "x".repeat(65), revision: "1" }];
  for (const bad of badIdentities) assert.equal(parseVoucherTypeIdentity(form(bad)), null);
});

const fixedFields = { name: "Mốc 500K", kind: "MERCHANDISE", issuance: "AUTO", visibility: "PUBLIC", discountType: "FIXED_AMOUNT_VND", amountVnd: "30000", minEligibleSubtotalVnd: "500000", scopeMode: "ALL_SHOP", startsAt: "", endsAt: "", maxUses: "", maxBudgetVnd: "" };

test("a tier form carries its type; only a merchandise voucher can have one", () => {
  const ok = parseVoucherCampaignForm(form({ ...fixedFields, typeId: "type_A" }));
  assert.equal(ok.ok, true);
  assert.equal((ok as unknown as { input: { typeId: unknown } }).input.typeId, "type_A");
  const validated = validateVoucherCampaign((ok as { input: unknown }).input);
  assert.equal(validated.ok && validated.value.typeId, "type_A");
  assert.equal((parseVoucherCampaignForm(form(fixedFields)) as unknown as { input: { typeId: unknown } }).input.typeId, null, "blank is a plain voucher");
  assert.deepEqual(parseVoucherCampaignForm(form({ ...fixedFields, typeId: ["a", "b"] })), { ok: false, issues: [{ code: "type-invalid", field: "typeId" }] });
  const shipping = validateVoucherCampaign((parseVoucherCampaignForm(form({ ...fixedFields, kind: "SHIPPING_FREE", typeId: "type_A" })) as { input: unknown }).input);
  assert.deepEqual(shipping.ok ? null : shipping.issues.map((issue) => issue.code), ["type-not-allowed"]);
  const bad = validateVoucherCampaign((parseVoucherCampaignForm(form({ ...fixedFields, typeId: "bad id" })) as { input: unknown }).input);
  assert.deepEqual(bad.ok ? null : bad.issues.map((issue) => issue.code), ["type-invalid"]);
});

const fixedTier = (id: string, min: number | null, amountVnd: number, scopeKey = "all"): LadderTier => ({ id, minEligibleSubtotalVnd: min, discount: { type: "FIXED_AMOUNT_VND", amountVnd }, scopeKey });
const percentTier = (id: string, min: number | null, percent: number, scopeKey = "all", maxDiscountVnd: number | null = null): LadderTier => ({ id, minEligibleSubtotalVnd: min, discount: { type: "PERCENTAGE", percent, maxDiscountVnd }, scopeKey });

test("ladder rule: a higher threshold must give a strictly higher discount, and thresholds are distinct", () => {
  const live = [fixedTier("a500", 500_000, 30_000), fixedTier("a1m", 1_000_000, 80_000)];
  assert.equal(findLadderConflict(fixedTier("a2m", 2_000_000, 200_000), live), null, "a clean third rung");
  assert.equal(findLadderConflict(fixedTier("mid", 700_000, 50_000), live), null, "a rung between the two");
  assert.equal(findLadderConflict(fixedTier("dup", 500_000, 40_000), live), "a500", "same threshold");
  assert.equal(findLadderConflict(fixedTier("worse", 2_000_000, 80_000), live), "a1m", "a higher threshold must give MORE");
  assert.equal(findLadderConflict(fixedTier("dominated", 600_000, 30_000), live), "a500", "never reached: the cheaper rung already gives as much");
  assert.equal(findLadderConflict(fixedTier("too-good", 400_000, 90_000), live), "a500", "pointless rungs above it: it would beat them at a lower threshold");
  assert.equal(findLadderConflict(fixedTier("a500", 500_000, 30_000), live), null, "a tier is never in conflict with itself");
});

test("ladder rule compares like with like: same scope and the same kind of discount only", () => {
  const live = [fixedTier("a500", 500_000, 30_000, "dresses")];
  assert.equal(findLadderConflict(fixedTier("other-scope", 500_000, 10_000, "bags"), live), null);
  assert.equal(findLadderConflict(percentTier("percent", 500_000, 5, "dresses"), live), null, "a percentage is not compared with a fixed amount");
  const percents = [percentTier("p5", 500_000, 5), percentTier("p10", 1_000_000, 10)];
  assert.equal(findLadderConflict(percentTier("p7", 700_000, 7), percents), null);
  assert.equal(findLadderConflict(percentTier("p4", 900_000, 4), percents), "p5");
  assert.equal(findLadderConflict({ id: "none", minEligibleSubtotalVnd: 1, discount: null, scopeKey: "all" }, percents), null, "shipping has no ladder");
  assert.equal(findLadderConflict(percentTier("nomin", null, 3), [percentTier("p5", 500_000, 5)]), null, "no threshold counts as 0");
});

test("the Admin says what each new refusal means, in plain words", () => {
  for (const reason of ["TYPE_NOT_FOUND", "TYPE_LIMIT_REACHED"]) assert.notEqual(describeVoucherAdminReason(reason), describeVoucherAdminReason("NOPE"), reason);
  for (const issue of ["type-invalid", "type-not-allowed", "type-priority-invalid", "ladder-conflict"]) assert.notEqual(describeVoucherAdminReason("VALIDATION", issue), describeVoucherAdminReason("VALIDATION"), issue);
});

test("ladder rule counts the cap of a percentage rung: a higher percent with a LOWER cap is refused (review of #222)", () => {
  // 500K: 5% capped at 50K; 1M: 10% capped at 10K. On a 1M cart the upper rung saves 10K and the lower 50K, so AUTO would pick the lower one.
  const lower = [percentTier("p5", 500_000, 5, "all", 50_000)];
  assert.equal(findLadderConflict(percentTier("p10-low-cap", 1_000_000, 10, "all", 10_000), lower), "p5");
  assert.equal(findLadderConflict(percentTier("p10-no-cap", 1_000_000, 10), lower), null, "no cap is the highest cap");
  assert.equal(findLadderConflict(percentTier("p10-same-cap", 1_000_000, 10, "all", 50_000), lower), "p5", "at 1M both already save the 50K cap: the upper rung adds nothing (review of #222)");
  assert.equal(findLadderConflict(percentTier("p10-high-cap", 1_000_000, 10, "all", 100_000), lower), null);
  // Judged from the other side too: adding the LOWER rung against a live upper one.
  const upper = [percentTier("p10", 1_000_000, 10, "all", 10_000)];
  assert.equal(findLadderConflict(percentTier("p5-big-cap", 500_000, 5, "all", 50_000), upper), "p10");
  assert.equal(findLadderConflict(percentTier("p5-small-cap", 500_000, 5, "all", 5_000), upper), null);
});

test("ladder rule judges benefit where the rung is reached, not only the percent and the cap on paper", () => {
  const lower = [percentTier("p5-cap50", 500_000, 5, "all", 50_000)];
  // From 1M up both give exactly 50K (the cap), whatever the percents say.
  assert.equal(findLadderConflict(percentTier("p10-cap50", 1_000_000, 10, "all", 50_000), lower), "p5-cap50");
  assert.equal(findLadderConflict(percentTier("p20-cap50", 2_000_000, 20, "all", 50_000), lower), "p5-cap50");
  // A higher threshold that is reached before the lower rung's cap does save more at its threshold: 300K x 5% = 15K, 400K x 10% = 40K.
  assert.equal(findLadderConflict(percentTier("p10-early", 400_000, 10, "all", 50_000), [percentTier("p5-low", 300_000, 5, "all", 50_000)]), null);
  // Equal cap but the lower rung's cap is out of reach at the upper threshold, so the extra percent is real.
  assert.equal(findLadderConflict(percentTier("p10-cap100", 1_000_000, 10, "all", 100_000), [percentTier("p5-cap100", 500_000, 5, "all", 100_000)]), null, "1M: 50K vs 100K");
  // No cap on either: only a higher percent is better.
  assert.equal(findLadderConflict(percentTier("p10", 1_000_000, 10), [percentTier("p5", 500_000, 5)]), null);
  assert.equal(findLadderConflict(percentTier("p5-again", 1_000_000, 5), [percentTier("p5", 500_000, 5)]), "p5");
});

test("ladder rule: the same percent is fine when the higher rung has a higher cap, never when it adds nothing", () => {
  const lower = [percentTier("p10-cap50", 500_000, 10, "all", 50_000)];
  assert.equal(findLadderConflict(percentTier("p10-cap100", 1_000_000, 10, "all", 100_000), lower), null, "the cap rises: better on big carts");
  assert.equal(findLadderConflict(percentTier("p10-cap50-again", 1_000_000, 10, "all", 50_000), lower), "p10-cap50", "identical saving at a higher threshold");
  assert.equal(findLadderConflict(percentTier("p10-nocap", 1_000_000, 10), [percentTier("p10-nocap-low", 500_000, 10)]), "p10-nocap-low", "no cap on both and the same percent");
  assert.equal(findLadderConflict(percentTier("p8-nocap", 1_000_000, 8), [percentTier("p10-cap", 500_000, 10, "all", 50_000)]), "p10-cap", "a lower percent never beats a higher one");
});
