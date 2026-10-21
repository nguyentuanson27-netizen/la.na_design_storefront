import assert from "node:assert/strict";
import test from "node:test";
import { readShippingQuote, type ShippingCampaignRow } from "../../src/commerce/shipping-campaign-repository.ts";

const now = new Date("2026-10-20T12:00:00Z");
const row: ShippingCampaignRow = { id: "shipping", pancakeShopId: 123, name: "Two paid units", revision: 1, isEnabled: true, enabledAt: now, disabledAt: null, startsAt: now, endsAt: null, minimumQuantity: 2, priority: 0, stackingEnabled: true, categoryKeys: ["aoDai", "setDo"], includeProductIds: [], excludeProductIds: [] };
function fake(rows = [row]) {
  const reads: string[] = [];
  const client = {
    $executeRaw: async () => { reads.push("lock"); return 0; },
    shippingPromotionCampaign: { findMany: async (args: { where: { pancakeShopId: number }; take: number }) => {
      reads.push("shipping"); assert.equal(args.where.pancakeShopId, 123); assert.equal(args.take, 51); return rows;
    } },
    variantMirror: { findMany: async (args: { where: { product: { pancakeShopId: number } } }) => {
      reads.push("variants"); assert.equal(args.where.product.pancakeShopId, 123);
      return [{ id: "v-a", productId: "p-a" }, { id: "v-b", productId: "p-b" }];
    } },
    productCategoryMembership: { findMany: async () => { reads.push("membership"); return [{ productId: "p-a", categoryKey: "aoDaiTet" }, { productId: "p-b", categoryKey: "setQuanAo" }]; } },
  } as unknown as Parameters<typeof readShippingQuote>[0]["client"];
  return { client, reads };
}
const input = { shopId: 123, now, policy: { feeVnd: 30000 }, hasOtherPromotions: false, paidItems: [{ variantId: "v-a", quantity: 1 }, { variantId: "v-b", quantity: 1 }] };

test("repository derives eligibility from paid variants and canonical memberships without gift campaign reads", async () => {
  const { client, reads } = fake();
  const result = await readShippingQuote({ ...input, client });
  assert.equal(result.feeVnd, 0);
  assert.equal(result.campaign?.qualifyingQuantity, 2);
  assert.deepEqual(reads, ["lock", "shipping", "variants", "membership"]);
});
test("no active campaign returns the base fee without requiring category reads", async () => {
  const { client, reads } = fake([]);
  assert.equal((await readShippingQuote({ ...input, client })).feeVnd, 30000);
  assert.deepEqual(reads, ["lock", "shipping"]);
});
test("campaign and membership lookup failures are not converted to paid shipping", async () => {
  for (const boundary of ["shippingPromotionCampaign", "productCategoryMembership"] as const) {
    const { client } = fake();
    Object.assign(client[boundary], { findMany: async () => { throw new Error("unavailable"); } });
    await assert.rejects(readShippingQuote({ ...input, client }), /unavailable/);
  }
});
test("unresolved paid identity, overflow and oversize candidate reads fail closed", async () => {
  const { client } = fake();
  Object.assign(client.variantMirror, { findMany: async () => [] });
  await assert.rejects(readShippingQuote({ ...input, client }), /identity/);
  await assert.rejects(readShippingQuote({ ...input, client: fake(Array.from({ length: 51 }, () => row)).client }), /bound/);
  await assert.rejects(readShippingQuote({ ...input, client: fake([]).client, paidItems: [{ variantId: "v-a", quantity: Number.MAX_SAFE_INTEGER }, { variantId: "v-b", quantity: 1 }] }), /overflow/);
});
test("a shipping campaign edit does not borrow the scope of another promotion", async () => {
  const before = await readShippingQuote({ ...input, client: fake().client });
  const changed = await readShippingQuote({ ...input, client: fake([{ ...row, revision: 2, categoryKeys: ["aoDai"] }]).client });
  assert.equal(before.feeVnd, 0);
  assert.equal(changed.feeVnd, 30000);
  assert.equal((await readShippingQuote({ ...input, client: fake().client, hasOtherPromotions: true })).feeVnd, 0);
});
