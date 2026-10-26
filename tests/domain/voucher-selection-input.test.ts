import assert from "node:assert/strict";
import test from "node:test";

import { parseVoucherCodeInput, parseVoucherSelectionInput } from "../../src/commerce/voucher-selection-input.ts";

test("a selection carries only a group, a mode and a voucher id (or null for 'no voucher')", () => {
  assert.deepEqual(parseVoucherSelectionInput({ group: "MERCHANDISE", mode: "MANUAL", voucherId: "abc_1-2" }), { group: "MERCHANDISE", mode: "MANUAL", voucherId: "abc_1-2" });
  assert.deepEqual(parseVoucherSelectionInput({ group: "SHIPPING_FREE", mode: "MANUAL", voucherId: null }), { group: "SHIPPING_FREE", mode: "MANUAL", voucherId: null });
  assert.deepEqual(parseVoucherSelectionInput({ group: "SHIPPING_FREE", mode: "AUTO" }), { group: "SHIPPING_FREE", mode: "AUTO", voucherId: null });
});

test("money, revisions, cart ids and any extra key are refused, not ignored", () => {
  for (const extra of ["discountVnd", "amountVnd", "totalVnd", "revision", "campaignRevision", "cartId", "shopId", "held", "price"]) {
    assert.equal(parseVoucherSelectionInput({ group: "MERCHANDISE", mode: "AUTO", [extra]: 1 }), null, extra);
  }
});

test("bad shapes fail closed", () => {
  for (const bad of [null, undefined, "x", 1, [], {}, { group: "GIFT", mode: "AUTO" }, { group: "MERCHANDISE", mode: "SOMETIMES" }, { group: "MERCHANDISE", mode: "MANUAL", voucherId: "bad id" }, { group: "MERCHANDISE", mode: "MANUAL", voucherId: 7 }, { group: "MERCHANDISE", mode: "AUTO", voucherId: "x" }, { group: "MERCHANDISE", mode: "MANUAL", voucherId: "x".repeat(65) }]) {
    assert.equal(parseVoucherSelectionInput(bad), null);
  }
});

test("a code is one bounded string and nothing else", () => {
  assert.equal(parseVoucherCodeInput({ code: "KOL50" }), "KOL50");
  assert.equal(parseVoucherCodeInput({ code: " kol50 " }), " kol50 ");
  for (const bad of [null, {}, { code: "" }, { code: "   " }, { code: 5 }, { code: "x".repeat(65) }, { code: "A", extra: 1 }, []]) assert.equal(parseVoucherCodeInput(bad), null);
});

import { parseVoucherDraftInput } from "../../src/commerce/voucher-selection-input.ts";

test("the picker draft is one intent per group and nothing else", () => {
  const draft = { merchandise: { mode: "MANUAL", voucherId: "m1" }, shipping: { mode: "AUTO", voucherId: null } };
  assert.deepEqual(parseVoucherDraftInput(draft), draft);
  assert.deepEqual(parseVoucherDraftInput({ merchandise: { mode: "AUTO" }, shipping: { mode: "MANUAL", voucherId: null } }), { merchandise: { mode: "AUTO", voucherId: null }, shipping: { mode: "MANUAL", voucherId: null } });
  for (const bad of [null, {}, { merchandise: draft.merchandise }, { ...draft, total: 1 }, { ...draft, merchandise: { mode: "AUTO", voucherId: "x" } }, { ...draft, shipping: { mode: "MANUAL", voucherId: "bad id" } }, { ...draft, shipping: { mode: "MANUAL", voucherId: null, discountVnd: 5 } }]) {
    assert.equal(parseVoucherDraftInput(bad), null);
  }
});

test("the picker's commit carries the version of the saved choice it was built on, and a consent only as a digest and an explicit yes", async () => {
  const { parseVoucherCommitInput } = await import("../../src/commerce/voucher-selection-input.ts");
  const draft = { merchandise: { mode: "MANUAL", voucherId: "m1" }, shipping: { mode: "AUTO", voucherId: null } };
  const digest = "a".repeat(64);
  const version = "c".repeat(64);
  assert.deepEqual(parseVoucherCommitInput({ ...draft, selection: version }), { draft, consentDigest: null, selectionVersion: version });
  assert.deepEqual(parseVoucherCommitInput({ ...draft, selection: version, consent: { acknowledged: true, expectedQuoteDigest: digest } }), { draft, consentDigest: digest, selectionVersion: version });
  // A commit without the version it was built on (or with a malformed one) is refused whole: it could overwrite a newer choice.
  for (const selection of [undefined, "", "abc", "C".repeat(64), 5, null]) {
    assert.equal(parseVoucherCommitInput({ ...draft, selection }), null, String(selection));
  }
  assert.equal(parseVoucherCommitInput(draft), null);
  // Anything else is refused whole: a "no", a short digest, an extra key, a price or a list of gifts.
  for (const consent of [{ acknowledged: false, expectedQuoteDigest: digest }, { acknowledged: true, expectedQuoteDigest: "abc" }, { acknowledged: true }, { acknowledged: true, expectedQuoteDigest: digest, gifts: [] }, "yes", null]) {
    assert.equal(parseVoucherCommitInput({ ...draft, selection: version, consent }), null, JSON.stringify(consent));
  }
  assert.equal(parseVoucherCommitInput({ ...draft, selection: version, totalVnd: 1 }), null);
});
