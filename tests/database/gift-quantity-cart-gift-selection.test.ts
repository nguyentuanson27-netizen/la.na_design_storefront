import assert from "node:assert/strict";
import test from "node:test";

import { PrismaPg } from "@prisma/adapter-pg";

import {
  CartGiftSelectionBoundError,
  classifyGiftSelectionFreshness,
  clearCartGiftSelections,
  listCartGiftSelections,
  MAX_GIFT_SELECTION_QUANTITY,
  removeCartGiftSelection,
  setCartGiftSelection,
} from "../../src/commerce/cart-gift-selection-repository.ts";
import { PrismaClient } from "../../src/generated/prisma/client.ts";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for database smoke tests");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const P = "gq11";
const SHOP = 920_947;
const NOW = new Date("2026-10-13T00:00:00.000Z");

async function cleanup() {
  await prisma.$executeRaw`DELETE FROM "Cart" WHERE "id" LIKE ${`${P}-%`}`;
  await prisma.$executeRaw`DELETE FROM "GiftQuantityCampaign" WHERE "id" LIKE ${`${P}-%`}`;
  await prisma.$executeRaw`DELETE FROM "VariantMirror" WHERE "id" LIKE ${`${P}-%`}`;
  await prisma.$executeRaw`DELETE FROM "ProductMirror" WHERE "id" LIKE ${`${P}-%`}`;
}

async function seed() {
  await prisma.$executeRawUnsafe(
    `INSERT INTO "ProductMirror" ("id","pancakeShopId","pancakeProductId","slug","name","syncedAt","createdAt","updatedAt")
     VALUES ($1,$2,$3,$4,'GQ11 product',NOW(),NOW(),NOW())`,
    `${P}-p`, SHOP, `${P}-p-ext`, `${P}-p-slug`,
  );
  for (const v of ["v1", "v2"]) {
    await prisma.variantMirror.create({ data: { id: `${P}-${v}`, pancakeVariationId: `${P}-${v}-var`, productId: `${P}-p`, pancakeRetailPrice: 100_000, syncedAt: NOW } });
  }
  await prisma.cart.create({ data: { id: `${P}-cart`, expiresAt: new Date("2027-01-01T00:00:00Z") } });
  await prisma.cart.create({ data: { id: `${P}-cart2`, expiresAt: new Date("2027-01-01T00:00:00Z") } });
  await prisma.$executeRawUnsafe(
    `INSERT INTO "GiftQuantityCampaign" ("id","kind","name","scopeMode","categoryKeys","giftTrigger","minimumQuantity","updatedAt")
     VALUES ($1,'GIFT_ITEM','GQ11 gift','DYNAMIC_CATEGORY',ARRAY['setVay']::text[],'QUANTITY',2,NOW())`, `${P}-gift`,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO "GiftQuantityCampaign" ("id","kind","name","scopeMode","categoryKeys","tierUnit","tierDiscountedUnits","updatedAt")
     VALUES ($1,'QUANTITY_TIER','GQ11 tier','DYNAMIC_CATEGORY',ARRAY['setVay']::text[],'PERCENTAGE','ALL_ELIGIBLE_UNITS',NOW())`, `${P}-tier`,
  );
}

const key = (overrides: Partial<{ cartId: string; campaignId: string; variantId: string }> = {}) => ({
  cartId: `${P}-cart`, campaignId: `${P}-gift`, variantId: `${P}-v1`, ...overrides,
});
const count = (where: object = {}) => prisma.cartGiftSelection.count({ where: { cartId: { startsWith: P }, ...where } });

test.beforeEach(async () => {
  await cleanup();
  await seed();
});
test.afterEach(cleanup);
test.after(async () => prisma.$disconnect());

test("a gift choice is independent of the paid line for the same variant", async () => {
  await prisma.cartItem.create({ data: { cartId: `${P}-cart`, variantId: `${P}-v1`, quantity: 2 } });
  assert.deepEqual(await setCartGiftSelection(prisma, { ...key(), quantity: 1, campaignRevision: 1 }), { ok: true });
  const paid = await prisma.cartItem.findMany({ where: { cartId: `${P}-cart` } });
  assert.deepEqual(paid.map((item) => [item.variantId, item.quantity]), [[`${P}-v1`, 2]], "the paid quantity is untouched");
  assert.deepEqual(await listCartGiftSelections(prisma, `${P}-cart`), [
    { campaignId: `${P}-gift`, variantId: `${P}-v1`, quantity: 1, campaignRevision: 1, currentCampaignRevision: 1, freshness: "CURRENT" },
  ]);
});

test("set is absolute and idempotent: the same call twice leaves one row, a new quantity replaces it", async () => {
  await setCartGiftSelection(prisma, { ...key(), quantity: 2, campaignRevision: 1 });
  await setCartGiftSelection(prisma, { ...key(), quantity: 2, campaignRevision: 1 });
  assert.equal(await count(), 1);
  await setCartGiftSelection(prisma, { ...key(), quantity: 3, campaignRevision: 2 });
  assert.deepEqual(await listCartGiftSelections(prisma, `${P}-cart`), [
    { campaignId: `${P}-gift`, variantId: `${P}-v1`, quantity: 3, campaignRevision: 2, currentCampaignRevision: 1, freshness: "STALE" },
  ]);
});

test("many gifts and campaigns per cart are kept apart and carts do not see each other's choices", async () => {
  await setCartGiftSelection(prisma, { ...key(), quantity: 1, campaignRevision: 1 });
  await setCartGiftSelection(prisma, { ...key({ variantId: `${P}-v2` }), quantity: 2, campaignRevision: 1 });
  await setCartGiftSelection(prisma, { ...key({ cartId: `${P}-cart2` }), quantity: 5, campaignRevision: 1 });
  assert.equal((await listCartGiftSelections(prisma, `${P}-cart`)).length, 2);
  assert.deepEqual((await listCartGiftSelections(prisma, `${P}-cart2`)).map((row) => row.quantity), [5]);
});

test("concurrent writers cannot create a duplicate or exceed the bound", async () => {
  await Promise.all(
    Array.from({ length: 24 }, (_, index) => setCartGiftSelection(prisma, { ...key(), quantity: (index % 3) + 1, campaignRevision: 1 })),
  );
  assert.equal(await count(), 1, "one row regardless of interleaving");
  const [row] = await listCartGiftSelections(prisma, `${P}-cart`);
  assert.ok(row !== undefined && row.quantity >= 1 && row.quantity <= 3, "the stored quantity is one of the written ones, not a sum");
});

test("concurrent first inserts for distinct and identical keys leave one row per key", async () => {
  const variants = [`${P}-v1`, `${P}-v2`];
  const results = await Promise.all(
    Array.from({ length: 32 }, (_, index) =>
      setCartGiftSelection(prisma, { ...key({ variantId: variants[index % 2] }), quantity: (index % 5) + 1, campaignRevision: 1 }),
    ),
  );
  assert.ok(results.every((result) => result.ok), "no writer sees a unique-violation error");
  assert.equal(await count(), 2);
  assert.equal(await count({ variantId: `${P}-v1` }), 1);
  assert.equal(await count({ variantId: `${P}-v2` }), 1);
});

test("the database, not the caller, stops concurrent increments at the quantity bound", async () => {
  await setCartGiftSelection(prisma, { ...key(), quantity: 1, campaignRevision: 1 });
  // A writer that adds instead of setting: 150 racing +1 on a row that may hold at most 100.
  const outcomes = await Promise.allSettled(
    Array.from({ length: 150 }, () =>
      prisma.$executeRawUnsafe(
        `UPDATE "CartGiftSelection" SET "quantity" = "quantity" + 1 WHERE "cartId" = $1 AND "campaignId" = $2 AND "variantId" = $3`,
        `${P}-cart`, `${P}-gift`, `${P}-v1`,
      ),
    ),
  );
  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, MAX_GIFT_SELECTION_QUANTITY - 1);
  assert.equal(outcomes.filter((outcome) => outcome.status === "rejected").length, 150 - (MAX_GIFT_SELECTION_QUANTITY - 1));
  const [row] = await listCartGiftSelections(prisma, `${P}-cart`);
  assert.equal(row?.quantity, MAX_GIFT_SELECTION_QUANTITY);
  assert.equal(await count(), 1);
});

test("concurrent gift writes and paid-line writes for the same variant never touch each other", async () => {
  await prisma.cartItem.create({ data: { cartId: `${P}-cart`, variantId: `${P}-v1`, quantity: 1 } });
  await Promise.all([
    ...Array.from({ length: 12 }, (_, index) => setCartGiftSelection(prisma, { ...key(), quantity: (index % 4) + 1, campaignRevision: 1 })),
    ...Array.from({ length: 12 }, (_, index) =>
      prisma.cartItem.update({ where: { cartId_variantId: { cartId: `${P}-cart`, variantId: `${P}-v1` } }, data: { quantity: index + 1 } }),
    ),
  ]);
  assert.equal(await count(), 1);
  assert.equal(await prisma.cartItem.count({ where: { cartId: `${P}-cart` } }), 1);
});

test("bounds are refused before the database and again by its CHECKs", async () => {
  for (const quantity of [0, -1, 1.5, 101, 2_147_483_648, Number.NaN]) {
    const result = await setCartGiftSelection(prisma, { ...key(), quantity, campaignRevision: 1 });
    assert.deepEqual(result, { ok: false, reason: "INVALID_QUANTITY" }, String(quantity));
  }
  for (const campaignRevision of [0, -3, 1.2, 2_147_483_648]) {
    const result = await setCartGiftSelection(prisma, { ...key(), quantity: 1, campaignRevision });
    assert.deepEqual(result, { ok: false, reason: "INVALID_REVISION" }, String(campaignRevision));
  }
  assert.deepEqual(await setCartGiftSelection(prisma, { ...key({ cartId: "" }), quantity: 1, campaignRevision: 1 }), { ok: false, reason: "INVALID_KEY" });
  assert.deepEqual(await setCartGiftSelection(prisma, { ...key({ variantId: "x".repeat(65) }), quantity: 1, campaignRevision: 1 }), { ok: false, reason: "INVALID_KEY" });
  assert.equal(await count(), 0);
  // The database refuses what a bypassing writer would try.
  for (const [quantity, revision] of [[0, 1], [101, 1], [1, 0]]) {
    await assert.rejects(
      prisma.$executeRawUnsafe(
        `INSERT INTO "CartGiftSelection" ("id","cartId","campaignId","variantId","quantity","campaignRevision","updatedAt") VALUES ($1,$2,$3,$4,$5,$6,NOW())`,
        `${P}-raw-${quantity}-${revision}`, `${P}-cart`, `${P}-gift`, `${P}-v1`, quantity, revision,
      ),
    );
  }
});

test("only a gift campaign can be referenced: a tier campaign, an unknown cart, campaign or variant are refused", async () => {
  const refused = { ok: false, reason: "REFERENCE_NOT_FOUND" };
  assert.deepEqual(await setCartGiftSelection(prisma, { ...key({ campaignId: `${P}-tier` }), quantity: 1, campaignRevision: 1 }), refused);
  assert.deepEqual(await setCartGiftSelection(prisma, { ...key({ cartId: `${P}-nope` }), quantity: 1, campaignRevision: 1 }), refused);
  assert.deepEqual(await setCartGiftSelection(prisma, { ...key({ campaignId: `${P}-nope` }), quantity: 1, campaignRevision: 1 }), refused);
  assert.deepEqual(await setCartGiftSelection(prisma, { ...key({ variantId: `${P}-nope` }), quantity: 1, campaignRevision: 1 }), refused);
  assert.equal(await count(), 0);
  // The tier campaign is also refused for a writer that bypasses the repository and lies about the kind.
  await assert.rejects(
    prisma.$executeRawUnsafe(
      `INSERT INTO "CartGiftSelection" ("id","cartId","campaignId","campaignKind","variantId","quantity","campaignRevision","updatedAt") VALUES ($1,$2,$3,'QUANTITY_TIER',$4,1,1,NOW())`,
      `${P}-raw-tier`, `${P}-cart`, `${P}-tier`, `${P}-v1`,
    ),
  );
  assert.equal(await count(), 0);
});

test("the unique key refuses a duplicate that bypasses the repository", async () => {
  await setCartGiftSelection(prisma, { ...key(), quantity: 1, campaignRevision: 1 });
  await assert.rejects(
    prisma.$executeRawUnsafe(
      `INSERT INTO "CartGiftSelection" ("id","cartId","campaignId","variantId","quantity","campaignRevision","updatedAt") VALUES ($1,$2,$3,$4,1,1,NOW())`,
      `${P}-raw-dup`, `${P}-cart`, `${P}-gift`, `${P}-v1`,
    ),
    /CartGiftSelection_cartId_campaignId_variantId_key|unique/i,
  );
  assert.equal(await count(), 1);
});

test("a choice goes stale when the campaign revision moves and is never repaired in place", async () => {
  await setCartGiftSelection(prisma, { ...key(), quantity: 2, campaignRevision: 1 });
  await prisma.giftQuantityCampaign.update({ where: { id: `${P}-gift` }, data: { revision: { increment: 1 } } });
  const [row] = await listCartGiftSelections(prisma, `${P}-cart`);
  assert.deepEqual(row, { campaignId: `${P}-gift`, variantId: `${P}-v1`, quantity: 2, campaignRevision: 1, currentCampaignRevision: 2, freshness: "STALE" });
  // Reading changed nothing; only an explicit set under the new revision makes it current again.
  assert.equal((await prisma.cartGiftSelection.findFirstOrThrow({ where: { cartId: `${P}-cart` } })).campaignRevision, 1);
  await setCartGiftSelection(prisma, { ...key(), quantity: 2, campaignRevision: 2 });
  assert.equal((await listCartGiftSelections(prisma, `${P}-cart`))[0]?.freshness, "CURRENT");
});

test("remove and clear are idempotent; clearing one campaign leaves the others", async () => {
  await prisma.$executeRawUnsafe(
    `INSERT INTO "GiftQuantityCampaign" ("id","kind","name","scopeMode","categoryKeys","giftTrigger","minimumQuantity","updatedAt")
     VALUES ($1,'GIFT_ITEM','GQ11 gift 2','DYNAMIC_CATEGORY',ARRAY['setVay']::text[],'QUANTITY',2,NOW())`, `${P}-gift2`,
  );
  await setCartGiftSelection(prisma, { ...key(), quantity: 1, campaignRevision: 1 });
  await setCartGiftSelection(prisma, { ...key({ campaignId: `${P}-gift2` }), quantity: 1, campaignRevision: 1 });
  assert.deepEqual(await removeCartGiftSelection(prisma, key()), { removed: true });
  assert.deepEqual(await removeCartGiftSelection(prisma, key()), { removed: false });
  await setCartGiftSelection(prisma, { ...key(), quantity: 1, campaignRevision: 1 });
  assert.deepEqual(await clearCartGiftSelections(prisma, { cartId: `${P}-cart`, campaignId: `${P}-gift` }), { removed: 1 });
  assert.equal(await count(), 1);
  assert.deepEqual(await clearCartGiftSelections(prisma, { cartId: `${P}-cart` }), { removed: 1 });
  assert.deepEqual(await clearCartGiftSelections(prisma, { cartId: "" }), { removed: 0 });
});

test("rows go with their cart, campaign or variant; the paid line goes only with its cart", async () => {
  await prisma.cartItem.create({ data: { cartId: `${P}-cart`, variantId: `${P}-v1`, quantity: 1 } });
  await setCartGiftSelection(prisma, { ...key(), quantity: 1, campaignRevision: 1 });
  await setCartGiftSelection(prisma, { ...key({ variantId: `${P}-v2` }), quantity: 1, campaignRevision: 1 });
  await prisma.variantMirror.delete({ where: { id: `${P}-v2` } });
  assert.equal(await count(), 1);
  await prisma.giftQuantityCampaign.delete({ where: { id: `${P}-gift` } });
  assert.equal(await count(), 0);
  await prisma.giftQuantityCampaign.create({ data: { id: `${P}-gift`, kind: "GIFT_ITEM", name: "GQ11 gift", scopeMode: "DYNAMIC_CATEGORY", categoryKeys: ["setVay"], giftTrigger: "QUANTITY", minimumQuantity: 2 } });
  await setCartGiftSelection(prisma, { ...key(), quantity: 1, campaignRevision: 1 });
  await prisma.cart.delete({ where: { id: `${P}-cart` } });
  assert.equal(await count(), 0);
  assert.equal(await prisma.cartItem.count({ where: { cartId: `${P}-cart` } }), 0);
});

test("a cart holding more than the bound fails closed instead of being truncated", async () => {
  await prisma.$executeRawUnsafe(
    `INSERT INTO "ProductMirror" ("id","pancakeShopId","pancakeProductId","slug","name","syncedAt","createdAt","updatedAt")
     SELECT $1 || g, $2, $3 || g, $4 || g, 'GQ11 bulk', NOW(), NOW(), NOW() FROM generate_series(1,101) g`,
    `${P}-bulk-`, SHOP, `${P}-bulk-ext-`, `${P}-bulk-slug-`,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO "VariantMirror" ("id","pancakeVariationId","productId","isActive","syncedAt","createdAt","updatedAt")
     SELECT $1 || g, $2 || g, $1 || g, true, NOW(), NOW(), NOW() FROM generate_series(1,101) g`,
    `${P}-bulk-`, `${P}-bulk-var-`,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO "CartGiftSelection" ("id","cartId","campaignId","variantId","quantity","campaignRevision","updatedAt")
     SELECT $1 || g, $2, $3, $4 || g, 1, 1, NOW() FROM generate_series(1,101) g`,
    `${P}-sel-`, `${P}-cart`, `${P}-gift`, `${P}-bulk-`,
  );
  await assert.rejects(listCartGiftSelections(prisma, `${P}-cart`), CartGiftSelectionBoundError);
});

test("the table stores a choice only: no price or entitlement column exists, and staleness is a pure comparison", async () => {
  const columns = await prisma.$queryRaw<Array<{ column_name: string }>>`
    SELECT column_name FROM information_schema.columns WHERE table_name = 'CartGiftSelection' ORDER BY column_name`;
  assert.deepEqual(columns.map((column) => column.column_name), ["campaignId", "campaignKind", "campaignRevision", "cartId", "createdAt", "id", "quantity", "updatedAt", "variantId"]);
  assert.equal(classifyGiftSelectionFreshness({ campaignRevision: 3 }, 3), "CURRENT");
  assert.equal(classifyGiftSelectionFreshness({ campaignRevision: 3 }, 4), "STALE");
  assert.equal(classifyGiftSelectionFreshness({ campaignRevision: 3 }, 2), "STALE");
});
