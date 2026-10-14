import assert from "node:assert/strict";
import test from "node:test";
import { parseGiftChoice, createCartGiftSelectionService } from "../../src/commerce/cart-gift-selection.ts";
import type { PrismaClient } from "../../src/generated/prisma/client.ts";

const valid = { campaignId: "campaign-1", variantId: "variant-1", quantity: 1, campaignRevision: 1 };
test("gift payload rejects authority fields, malformed identifiers, quantities and revisions", () => {
  assert.deepEqual(parseGiftChoice(valid), valid);
  assert.deepEqual(parseGiftChoice({ ...valid, quantity: 0 }), { ...valid, quantity: 0 });
  for (const input of [null, [], { ...valid, cartId: "forged" }, { ...valid, entitled: 100 }, { ...valid, price: 0 },
    ...[-1, 101, 1.5, NaN, "1"].map((quantity) => ({ ...valid, quantity })),
    ...[0, -1, 1.5, "1", 2_147_483_648].map((campaignRevision) => ({ ...valid, campaignRevision })),
    { ...valid, campaignId: " bad " }, { ...valid, variantId: "x".repeat(65) }, { ...valid, variantId: "<script>" }]) {
    assert.equal(parseGiftChoice(input), null);
  }
});
test("OFF never reads database; absent/malformed cookie never starts a transaction", async () => {
  const db = new Proxy({}, { get() { throw new Error("Must not read"); } }) as PrismaClient;
  for (const flag of [undefined, "false", "TRUE", "1"]) {
    const service = createCartGiftSelectionService(db, { get: () => undefined }, { shopId: 1, env: { LA_GIFT_QUANTITY_PROMOTIONS_ENABLED: flag } });
    assert.deepEqual(await service.get(), { enabled: false });
    assert.deepEqual(await service.set(valid), { ok: false, reason: "FEATURE_DISABLED" });
  }
  for (const value of [undefined, "forged", ""]) {
    const service = createCartGiftSelectionService(db, { get: () => value === undefined ? undefined : { value } }, { shopId: 1, env: { LA_GIFT_QUANTITY_PROMOTIONS_ENABLED: "true" } });
    assert.deepEqual(await service.set(valid), { ok: false, reason: "CART_UNAVAILABLE" });
  }
});
