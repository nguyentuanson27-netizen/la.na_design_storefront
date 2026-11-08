import assert from "node:assert/strict";
import test from "node:test";

import { PrismaPg } from "@prisma/adapter-pg";

import { EMPTY_PRODUCT_TRANSLATION } from "../../src/commerce/product-translation.ts";
import { createProductTranslationRepository } from "../../src/commerce/product-translation-repository.ts";
import { PrismaClient } from "../../src/generated/prisma/client.ts";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is required for database smoke tests");
}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const repository = createProductTranslationRepository(prisma);
const shopId = 910_070;
const syncedAt = new Date("2026-11-08T03:00:00.000Z");

async function cleanup() {
  // ProductTranslation rows go with their product (ON DELETE CASCADE).
  await prisma.productMirror.deleteMany({ where: { pancakeShopId: shopId } });
}

async function makeProduct(slug: string) {
  return prisma.productMirror.create({
    data: { pancakeShopId: shopId, pancakeProductId: `${slug}-ext`, slug, name: `Tên ${slug}`, syncedAt },
  });
}

test.beforeEach(cleanup);
test.afterEach(cleanup);
test.after(async () => prisma.$disconnect());

test("a product with no translation reads as the empty one", async () => {
  const product = await makeProduct("tr-none");
  assert.deepEqual(await repository.read(product.id, "en"), EMPTY_PRODUCT_TRANSLATION);
  assert.equal((await repository.readMany([product.id], "en")).size, 0);
});

test("a saved translation is read back, singly, in bulk and by slug", async () => {
  const product = await makeProduct("tr-saved");
  const other = await makeProduct("tr-other");
  await repository.save(product.id, "en", {
    ...EMPTY_PRODUCT_TRANSLATION,
    name: "Modern ao dai",
    craftDetails: ["Hand stitched"],
    material: "Silk",
  });

  const one = await repository.read(product.id, "en");
  assert.equal(one.name, "Modern ao dai");
  assert.deepEqual(one.craftDetails, ["Hand stitched"]);
  assert.equal(one.material, "Silk");
  assert.equal(one.editorialDescription, null);

  const many = await repository.readMany([product.id, other.id, product.id], "en");
  assert.equal(many.size, 1, "only the product that has one, and a repeated id is read once");
  assert.equal(many.get(product.id)?.name, "Modern ao dai");

  const byName = await repository.readNamesBySlug(["tr-saved", "tr-other", "missing"], "en");
  assert.deepEqual([...byName], [["tr-saved", "Modern ao dai"]]);
});

test("saving again replaces the fields rather than adding a second row", async () => {
  const product = await makeProduct("tr-update");
  await repository.save(product.id, "en", { ...EMPTY_PRODUCT_TRANSLATION, name: "First", material: "Cotton" });
  await repository.save(product.id, "en", { ...EMPTY_PRODUCT_TRANSLATION, name: "Second" });

  const read = await repository.read(product.id, "en");
  assert.equal(read.name, "Second");
  assert.equal(read.material, null, "a field cleared in the form is cleared in the row");
  assert.equal(await prisma.productTranslation.count({ where: { productId: product.id } }), 1);
});

test("saving an empty translation removes the row", async () => {
  const product = await makeProduct("tr-clear");
  await repository.save(product.id, "en", { ...EMPTY_PRODUCT_TRANSLATION, name: "Something" });
  await repository.save(product.id, "en", EMPTY_PRODUCT_TRANSLATION);
  assert.equal(await prisma.productTranslation.count({ where: { productId: product.id } }), 0);
});

test("the database refuses a translation into the default language, and deleting the product removes it", async () => {
  const product = await makeProduct("tr-guard");
  await assert.rejects(
    prisma.productTranslation.create({ data: { productId: product.id, locale: "vi", name: "x" } }),
  );
  await repository.save(product.id, "en", { ...EMPTY_PRODUCT_TRANSLATION, name: "x" });
  await prisma.productMirror.delete({ where: { id: product.id } });
  assert.equal(await prisma.productTranslation.count({ where: { productId: product.id } }), 0);
});
