import assert from "node:assert/strict";
import test from "node:test";

import { MAX_STACK_PRIORITY, preflightStackPriority } from "../../src/commerce/gift-quantity-stack-priority.ts";

const NOW = new Date("2026-10-14T00:00:00.000Z");

/** A client that only counts what the preflight asks of the database. */
function fakeClient(options: { campaignKind?: "QUANTITY_TIER" | "GIFT_ITEM" | null; tierConflict?: boolean; legacyConflict?: boolean } = {}) {
  const calls = { campaignLookups: 0, tierConflicts: 0, legacyConflicts: 0 };
  const client = {
    giftQuantityCampaign: {
      findUnique: async () => {
        calls.campaignLookups += 1;
        return options.campaignKind ? { kind: options.campaignKind } : null;
      },
      findFirst: async () => {
        calls.tierConflicts += 1;
        return options.tierConflict ? { id: "other" } : null;
      },
    },
    legacyPromotionStackConsent: {
      findFirst: async () => {
        calls.legacyConflicts += 1;
        return options.legacyConflict ? { campaignId: "legacy" } : null;
      },
    },
  };
  return { client: client as unknown as Parameters<typeof preflightStackPriority>[0], calls };
}
const touched = (calls: ReturnType<typeof fakeClient>["calls"]) => calls.campaignLookups + calls.tierConflicts + calls.legacyConflicts;

test("a malformed campaign id is INVALID without touching the database and never throws", async () => {
  const objectWithoutPrototype = Object.create(null) as Record<string, unknown>;
  for (const campaignId of [undefined, 7, 0, true, {}, [], ["a"], objectWithoutPrototype, Symbol("x"), () => "x", "", "x".repeat(200)]) {
    const { client, calls } = fakeClient({ campaignKind: "QUANTITY_TIER" });
    assert.equal(await preflightStackPriority(client, { priority: 17, campaignId, now: NOW }), "INVALID", String(typeof campaignId));
    assert.equal(touched(calls), 0, "no query for a malformed id");
  }
});

test("a malformed priority is INVALID without touching the database", async () => {
  for (const priority of [undefined, null, "17", 1.5, -1, MAX_STACK_PRIORITY + 1, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, {}, [17]]) {
    const { client, calls } = fakeClient({ campaignKind: "QUANTITY_TIER" });
    assert.equal(await preflightStackPriority(client, { priority, campaignId: null, now: NOW }), "INVALID", String(priority));
    assert.equal(touched(calls), 0);
  }
});

test("a valid create check (null id) skips the campaign lookup and reports availability or a conflict", async () => {
  const free = fakeClient();
  assert.equal(await preflightStackPriority(free.client, { priority: 0, campaignId: null, now: NOW }), "AVAILABLE");
  assert.equal(free.calls.campaignLookups, 0);
  assert.equal(await preflightStackPriority(fakeClient({ tierConflict: true }).client, { priority: MAX_STACK_PRIORITY, campaignId: null, now: NOW }), "CONFLICT");
  assert.equal(await preflightStackPriority(fakeClient({ legacyConflict: true }).client, { priority: 5, campaignId: null, now: NOW }), "CONFLICT");
});

test("a valid edit check requires an existing tier campaign", async () => {
  const edit = fakeClient({ campaignKind: "QUANTITY_TIER" });
  assert.equal(await preflightStackPriority(edit.client, { priority: 17, campaignId: "campaign-1", now: NOW }), "AVAILABLE");
  assert.equal(edit.calls.campaignLookups, 1);
  assert.equal(await preflightStackPriority(fakeClient({ campaignKind: "QUANTITY_TIER", tierConflict: true }).client, { priority: 17, campaignId: "campaign-1", now: NOW }), "CONFLICT");
  const gift = fakeClient({ campaignKind: "GIFT_ITEM" });
  assert.equal(await preflightStackPriority(gift.client, { priority: 17, campaignId: "campaign-1", now: NOW }), "INVALID");
  assert.equal(gift.calls.tierConflicts + gift.calls.legacyConflicts, 0, "a gift or missing campaign stops before the conflict query");
  assert.equal(await preflightStackPriority(fakeClient({ campaignKind: null }).client, { priority: 17, campaignId: "missing", now: NOW }), "INVALID");
});
