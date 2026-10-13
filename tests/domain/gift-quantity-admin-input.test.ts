import assert from "node:assert/strict";
import test from "node:test";

import { parseGiftQuantityDraftForm } from "../../src/commerce/gift-quantity-admin-input.ts";
import { validateDraftShape } from "../../src/commerce/gift-quantity-admin-service.ts";
import {
  MAX_SCOPE_CATEGORIES,
  MAX_SCOPE_EXCLUDED_PRODUCTS,
  MAX_SCOPE_INCLUDED_PRODUCTS,
} from "../../src/commerce/gift-quantity-scope.ts";

function form(entries: Array<[string, string]>): FormData {
  const data = new FormData();
  for (const [key, value] of entries) data.append(key, value);
  return data;
}
const base: Array<[string, string]> = [["kind", "GIFT_ITEM"], ["name", "Tặng khi mua 2"], ["scopeMode", "DYNAMIC_CATEGORY"]];

test("a minimal valid form parses with the sent values and no coercion", () => {
  const parsed = parseGiftQuantityDraftForm(form([...base, ["giftTrigger", "QUANTITY"], ["categoryKey", "vayDam"], ["includeProductId", " p1 "], ["excludeProductId", "p2"]]));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.value.categoryKeys, ["vayDam"]);
  assert.deepEqual(parsed.value.includeProductIds, ["p1"], "trimmed, not truncated");
  assert.deepEqual(parsed.value.excludeProductIds, ["p2"]);
  assert.equal(parsed.value.giftTrigger, "QUANTITY");
  assert.equal(parsed.value.subtotalScope, null);
  assert.equal(parsed.value.startsAt, null);
});

test("enums are exact allowlists: anything else is refused, never coerced", () => {
  const reasonOf = (entries: Array<[string, string]>) => {
    const parsed = parseGiftQuantityDraftForm(form(entries));
    return parsed.ok ? "ok" : parsed.reason;
  };
  assert.equal(reasonOf([["kind", "PROMOTION"], ["scopeMode", "DYNAMIC_CATEGORY"]]), "INVALID_KIND");
  assert.equal(reasonOf([["kind", "gift_item"], ["scopeMode", "DYNAMIC_CATEGORY"]]), "INVALID_KIND");
  assert.equal(reasonOf([["kind", "GIFT_ITEM"]]), "INVALID_SCOPE_MODE");
  assert.equal(reasonOf([["kind", "GIFT_ITEM"], ["scopeMode", "EVERYTHING"]]), "INVALID_SCOPE_MODE");
  assert.equal(reasonOf([...base, ["giftTrigger", "SOMETIMES"]]), "INVALID_GIFT_TRIGGER");
  assert.equal(reasonOf([...base, ["giftTrigger", "ORDER_SUBTOTAL"], ["subtotalScope", "SOME"]]), "INVALID_SUBTOTAL_SCOPE");
  assert.equal(reasonOf([...base, ["startsAt", "2026-02-30T10:00"]]), "INVALID_DATE_TIME");
  assert.equal(reasonOf([...base, ["endsAt", "tomorrow"]]), "INVALID_DATE_TIME");
});

test("Vietnam time dates are parsed strictly", () => {
  const parsed = parseGiftQuantityDraftForm(form([...base, ["startsAt", "2026-10-20T07:00"]]));
  assert.equal(parsed.ok && parsed.value.startsAt?.toISOString(), "2026-10-20T00:00:00.000Z");
});

test("a tier never carries gift fields, and a stray subtotal scope is dropped unless the trigger is ORDER_SUBTOTAL", () => {
  const tier = parseGiftQuantityDraftForm(form([["kind", "QUANTITY_TIER"], ["scopeMode", "DYNAMIC_CATEGORY"], ["giftTrigger", "QUANTITY"], ["subtotalScope", "ALL_PAID_LINES"]]));
  assert.equal(tier.ok && tier.value.giftTrigger, null);
  assert.equal(tier.ok && tier.value.subtotalScope, null);
  const gift = parseGiftQuantityDraftForm(form([...base, ["giftTrigger", "QUANTITY"], ["subtotalScope", "ALL_PAID_LINES"]]));
  assert.equal(gift.ok && gift.value.subtotalScope, null);
});

test("lists are capped one past their bound so the validator can report the overflow; oversized ids are kept", () => {
  const many = (field: string, n: number): Array<[string, string]> => Array.from({ length: n }, (_, i) => [field, `id-${i}`]);
  const parsed = parseGiftQuantityDraftForm(form([
    ...base,
    ...many("categoryKey", MAX_SCOPE_CATEGORIES + 10),
    ...many("includeProductId", MAX_SCOPE_INCLUDED_PRODUCTS + 10),
    ...many("excludeProductId", MAX_SCOPE_EXCLUDED_PRODUCTS + 10),
    ["includeProductId", "x".repeat(200)],
  ]));
  assert.ok(parsed.ok);
  if (!parsed.ok) return;
  assert.equal(parsed.value.categoryKeys.length, MAX_SCOPE_CATEGORIES + 1);
  assert.equal(parsed.value.includeProductIds.length, MAX_SCOPE_INCLUDED_PRODUCTS + 1);
  assert.equal(parsed.value.excludeProductIds.length, MAX_SCOPE_EXCLUDED_PRODUCTS + 1);
  const oversized = parseGiftQuantityDraftForm(form([...base, ["includeProductId", "x".repeat(200)]]));
  assert.equal(oversized.ok && oversized.value.includeProductIds[0]!.length, 200);
});

test("a global scope with targets is passed through, not repaired: the server refuses the contradiction", () => {
  const parsed = parseGiftQuantityDraftForm(form([
    ["kind", "GIFT_ITEM"], ["name", "x"], ["scopeMode", "GLOBAL_ALL_PAID_LINES"], ["giftTrigger", "ORDER_SUBTOTAL"], ["subtotalScope", "ALL_PAID_LINES"], ["categoryKey", "vayDam"],
  ]));
  assert.ok(parsed.ok);
  if (parsed.ok) assert.deepEqual(parsed.value.categoryKeys, ["vayDam"]);
});

test("non-string entries (File uploads) are ignored", () => {
  const data = form(base);
  data.append("categoryKey", new Blob(["x"]), "x.txt");
  const parsed = parseGiftQuantityDraftForm(data);
  assert.ok(parsed.ok);
  if (parsed.ok) assert.deepEqual(parsed.value.categoryKeys, []);
});

const v = (overrides: Partial<Parameters<typeof validateDraftShape>[0]> = {}) => ({
  kind: "GIFT_ITEM" as const, name: "Tên", startsAt: null, endsAt: null, scopeMode: "DYNAMIC_CATEGORY" as const,
  categoryKeys: [], includeProductIds: [], excludeProductIds: [], giftTrigger: null, subtotalScope: null, ...overrides,
});

test("draft shape: global scope exists only for gift ORDER_SUBTOTAL + ALL_PAID_LINES", () => {
  assert.deepEqual(validateDraftShape(v({ scopeMode: "GLOBAL_ALL_PAID_LINES", giftTrigger: "ORDER_SUBTOTAL", subtotalScope: "ALL_PAID_LINES" })), []);
  assert.deepEqual(validateDraftShape(v({ scopeMode: "GLOBAL_ALL_PAID_LINES", giftTrigger: "ORDER_SUBTOTAL", subtotalScope: "ELIGIBLE_PAID_LINES" })), ["SUBTOTAL_SCOPE_MISMATCH"]);
  assert.deepEqual(validateDraftShape(v({ scopeMode: "GLOBAL_ALL_PAID_LINES", giftTrigger: "ORDER_SUBTOTAL" })), ["SUBTOTAL_SCOPE_MISMATCH"]);
  assert.deepEqual(validateDraftShape(v({ scopeMode: "GLOBAL_ALL_PAID_LINES", giftTrigger: "QUANTITY" })), ["GLOBAL_SCOPE_NOT_ALLOWED"]);
  assert.deepEqual(validateDraftShape(v({ scopeMode: "GLOBAL_ALL_PAID_LINES" })), ["GLOBAL_SCOPE_NOT_ALLOWED"]);
  assert.deepEqual(validateDraftShape(v({ kind: "QUANTITY_TIER", scopeMode: "GLOBAL_ALL_PAID_LINES" })), ["GLOBAL_SCOPE_NOT_ALLOWED"]);
});

test("draft shape: ALL_PAID_LINES needs global, ELIGIBLE_PAID_LINES needs a real scope; incomplete drafts are fine", () => {
  assert.deepEqual(validateDraftShape(v({ giftTrigger: "ORDER_SUBTOTAL", subtotalScope: "ALL_PAID_LINES" })), ["SUBTOTAL_SCOPE_MISMATCH"]);
  assert.deepEqual(validateDraftShape(v({ giftTrigger: "ORDER_SUBTOTAL", subtotalScope: "ELIGIBLE_PAID_LINES" })), []);
  assert.deepEqual(validateDraftShape(v({ giftTrigger: "ORDER_SUBTOTAL" })), []);
  assert.deepEqual(validateDraftShape(v({ giftTrigger: "QUANTITY" })), []);
  assert.deepEqual(validateDraftShape(v()), [], "nothing chosen yet");
});

test("draft shape: name and tier rules", () => {
  assert.deepEqual(validateDraftShape(v({ name: "   " })), ["EMPTY_NAME"]);
  assert.deepEqual(validateDraftShape(v({ name: "x".repeat(121) })), ["NAME_TOO_LONG"]);
  assert.deepEqual(validateDraftShape(v({ kind: "QUANTITY_TIER", giftTrigger: "QUANTITY" })), ["GIFT_FIELDS_ON_TIER"]);
  assert.deepEqual(validateDraftShape(v({ kind: "QUANTITY_TIER" })), []);
});
