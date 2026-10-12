import assert from "node:assert/strict";
import test from "node:test";

import { PrismaPg } from "@prisma/adapter-pg";
import { createNewArrivalsRepository } from "../../src/commerce/new-arrivals-repository.ts";
import { MerchandisingError } from "../../src/commerce/merchandising-input.ts";
import { PrismaClient } from "../../src/generated/prisma/client.ts";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for database smoke tests");
const client = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const repo = createNewArrivalsRepository(client);
const shopId = 935_301;
const foreignShopId = 935_302;
const prefix = "manual-new-arrivals-db-";
const syncedAt = new Date("2026-10-01T00:00:00.000Z");

async function cleanup() {
  await client.productMirror.deleteMany({ where: { pancakeProductId: { startsWith: prefix } } });
}
async function seed(name: string, shop: number = shopId) {
  return client.productMirror.create({
    data: { pancakeShopId: shop, pancakeProductId: prefix + name, slug: prefix + name, name, syncedAt },
    select: { id: true },
  });
}

test.beforeEach(cleanup);
test.afterEach(cleanup);
test.after(async () => client.$disconnect());

test("new arrivals stay empty until selected; admin order and removal control the storefront", async () => {
  const a = await seed("a");
  const b = await seed("b");
  assert.equal((await repo.listVisiblePage({ shopId, page: 1, pageSize: 24 })).totalProducts, 0);

  await repo.applyChange({ shopId, operation: "add", productId: b.id });
  await repo.applyChange({ shopId, operation: "add", productId: a.id });
  assert.deepEqual((await repo.listVisiblePage({ shopId, page: 1, pageSize: 24 })).ids, [b.id, a.id]);
  await repo.applyChange({ shopId, operation: "move-up", productId: a.id });
  assert.deepEqual((await repo.listVisiblePage({ shopId, page: 1, pageSize: 24 })).ids, [a.id, b.id]);

  await client.productMirror.update({ where: { id: a.id }, data: { isActive: false } });
  const visible = await repo.listVisiblePage({ shopId, page: 1, pageSize: 24 });
  assert.deepEqual(visible.ids, [b.id]);
  assert.equal(visible.totalProducts, 1);
  assert.equal((await repo.listForAdmin(shopId)).length, 2);

  await repo.applyChange({ shopId, operation: "remove", productId: a.id });
  assert.equal((await repo.listForAdmin(shopId)).length, 1);
});

test("pagination occurs after visibility filtering, without backfilling unselected products", async () => {
  const ids: string[] = [];
  for (let i = 0; i < 26; i++) {
    const p = await seed("batch-" + i);
    ids.push(p.id);
  }
  await client.newArrivalProduct.createMany({
    data: ids.map((productId, position) => ({ productId, position })),
  });
  await client.productMirror.update({ where: { id: ids[0]! }, data: { isPresent: false } });

  const page1 = await repo.listVisiblePage({ shopId, page: 1, pageSize: 24 });
  const page2 = await repo.listVisiblePage({ shopId, page: 2, pageSize: 24 });
  assert.equal(page1.totalProducts, 25);
  assert.equal(page1.totalPages, 2);
  assert.deepEqual(page1.ids, ids.slice(1, 25));
  assert.deepEqual(page2.ids, [ids[25]]);
});

test("foreign products and invalid changes are rejected without clearing existing selections", async () => {
  const local = await seed("local");
  const foreign = await seed("foreign", foreignShopId);
  await repo.applyChange({ shopId, operation: "add", productId: local.id });
  await assert.rejects(
    () => repo.applyChange({ shopId, operation: "add", productId: foreign.id }),
    (error: unknown) => error instanceof MerchandisingError && error.reason === "merchandising-invalid-product",
  );
  assert.deepEqual((await repo.listVisiblePage({ shopId, page: 1, pageSize: 24 })).ids, [local.id]);
});
