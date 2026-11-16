import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { PrismaPg } from "@prisma/adapter-pg";
import pg from "pg";

import { createProductVariantOrderRepository } from "../../src/commerce/product-variant-order-repository.ts";
import { createStorefrontCatalogRepository } from "../../src/commerce/storefront-catalog.ts";
import { PrismaClient } from "../../src/generated/prisma/client.ts";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is required for database smoke tests");
}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const repository = createProductVariantOrderRepository(prisma);
const shopId = 910_081;
const PINK = "https://content.pancake.vn/images/9/1/0/pink.jpg";
const BEIGE = "https://content.pancake.vn/images/9/1/0/beige.jpg";

async function cleanup() {
  await prisma.productMirror.deleteMany({ where: { pancakeShopId: shopId } });
}

async function createProduct(key: string) {
  const now = new Date();
  const variant = (color: string, size: string, image: string) => ({
    pancakeVariationId: `${key}-${color}-${size}`,
    color,
    size,
    pancakeRetailPrice: 850_000,
    pancakeRetailPriceAfterDiscount: 850_000,
    pancakeImageUrls: [image],
    syncedAt: now,
  });
  return prisma.productMirror.create({
    data: {
      pancakeShopId: shopId,
      pancakeProductId: `vo-${key}`,
      slug: `vo-${key}`,
      name: `Variant order ${key}`,
      productCode: key.toUpperCase(),
      syncedAt: now,
      variants: {
        create: [
          variant("Be", "L", BEIGE),
          variant("Hồng", "S", PINK),
          variant("Be", "S", BEIGE),
          variant("Hồng", "M", PINK),
        ],
      },
    },
    select: { id: true },
  });
}

test("the editor state lists each color once and the stored order only among colors the product has", async () => {
  await cleanup();
  try {
    const { id } = await createProduct("state");
    assert.deepEqual(await repository.readEditorState(id), {
      productColors: ["Be", "Hồng"],
      colors: [],
    });

    await prisma.productVariantColorOrder.create({
      data: { productId: id, colors: ["hồng", "Xanh", "BE"] },
    });
    assert.deepEqual(await repository.readEditorState(id), {
      productColors: ["Be", "Hồng"],
      colors: ["Hồng", "Be"],
    });
  } finally {
    await cleanup();
  }
});

test("save stores the order in the catalog's spelling, replaces it, and an empty order removes the row", async () => {
  await cleanup();
  try {
    const { id } = await createProduct("save");

    assert.deepEqual(
      await repository.save(id, [
        { color: "Be", position: "2" },
        { color: "Hồng", position: "1" },
      ]),
      { ok: true, colors: ["Hồng", "Be"] },
    );
    assert.deepEqual((await repository.readEditorState(id)).colors, ["Hồng", "Be"]);

    assert.deepEqual(
      await repository.save(id, [
        { color: "be", position: "1" },
        { color: "Hồng", position: "" },
      ]),
      { ok: true, colors: ["Be"] },
    );
    assert.deepEqual((await repository.readEditorState(id)).colors, ["Be"]);

    assert.deepEqual(
      await repository.save(id, [
        { color: "Be", position: "" },
        { color: "Hồng", position: "" },
      ]),
      { ok: true, colors: [] },
    );
    assert.equal(await prisma.productVariantColorOrder.count({ where: { productId: id } }), 0);
  } finally {
    await cleanup();
  }
});

test("save refuses an unknown color, a bad position and a missing product, and changes nothing", async () => {
  await cleanup();
  try {
    const { id } = await createProduct("refuse");
    await repository.save(id, [{ color: "Hồng", position: "1" }]);

    assert.deepEqual(await repository.save(id, [{ color: "Xanh", position: "1" }]), {
      ok: false,
      reason: "unknown-color",
    });
    assert.deepEqual(await repository.save(id, [{ color: "Be", position: "0" }]), {
      ok: false,
      reason: "invalid",
    });
    assert.deepEqual(await repository.save("no-such-product", [{ color: "Be", position: "1" }]), {
      ok: false,
      reason: "product-not-found",
    });
    assert.deepEqual((await repository.readEditorState(id)).colors, ["Hồng"]);
  } finally {
    await cleanup();
  }
});

test("clear removes the order; deleting the product removes it too", async () => {
  await cleanup();
  try {
    const { id } = await createProduct("clear");
    await repository.save(id, [{ color: "Be", position: "1" }]);
    await repository.clear(id);
    assert.equal(await prisma.productVariantColorOrder.count({ where: { productId: id } }), 0);

    await repository.save(id, [{ color: "Be", position: "1" }]);
    await prisma.productMirror.delete({ where: { id } });
    assert.equal(await prisma.productVariantColorOrder.count({ where: { productId: id } }), 0);
  } finally {
    await cleanup();
  }
});

test("the storefront listing follows the stored order: pink first, and unordered products are untouched", async () => {
  await cleanup();
  try {
    const ordered = await createProduct("listed-a");
    const plain = await createProduct("listed-b");
    await repository.save(ordered.id, [
      { color: "Hồng", position: "1" },
      { color: "Be", position: "2" },
    ]);

    const catalog = createStorefrontCatalogRepository(prisma);
    const products = await catalog.listProducts({ shopId, limit: 10 });
    const orderedProduct = products.find((product) => product.id === ordered.id);
    const plainProduct = products.find((product) => product.id === plain.id);
    assert.ok(orderedProduct && plainProduct);

    assert.equal(orderedProduct.media.primary?.url, PINK);
    assert.equal(orderedProduct.media.gallery[0]?.url, PINK);
    assert.equal(orderedProduct.media.gallery[1]?.url, BEIGE);
    assert.deepEqual(
      orderedProduct.variants.map((variant) => `${variant.color}-${variant.size}`),
      ["Hồng-S", "Hồng-M", "Be-S", "Be-L"],
    );

    // No stored order: the variants keep the order the catalog gave (by Pancake variation id).
    assert.deepEqual(
      plainProduct.variants.map((variant) => `${variant.color}-${variant.size}`),
      ["Be-L", "Be-S", "Hồng-M", "Hồng-S"],
    );
  } finally {
    await cleanup();
  }
});

test("the migration orders SV612 pink-first, leaves other products alone and can be re-run", async () => {
  const migration = readFileSync(
    new URL(
      "../../prisma/migrations/20261116100000_add_product_variant_color_order/migration.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const seed = migration.slice(migration.indexOf("INSERT INTO"));
  assert.ok(seed.startsWith("INSERT INTO"));

  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query("BEGIN");
    // The database may already hold a real SV612; the seed is exercised on rows of our own.
    await client.query(`DELETE FROM "ProductMirror" WHERE upper(btrim("productCode")) = 'SV612'`);
    for (const [id, code] of [
      ["vo-mig-sv612", " sv612 "],
      ["vo-mig-other", "SV6120"],
      ["vo-mig-none", null],
    ] as const) {
      await client.query(
        `INSERT INTO "ProductMirror" (id, "pancakeProductId", slug, name, "productCode", "pancakeShopId", "syncedAt", "updatedAt")
         VALUES ($1, $1, $1, $1, $2, $3, now(), now())`,
        [id, code, shopId],
      );
    }
    await client.query(seed);
    await client.query(seed);

    const { rows } = await client.query<{ productId: string; colors: string[] }>(
      `SELECT "productId", colors FROM "ProductVariantColorOrder" WHERE "productId" LIKE 'vo-mig-%'`,
    );
    assert.deepEqual(rows, [{ productId: "vo-mig-sv612", colors: ["Hồng", "Be"] }]);
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
});


test("search suggestions show the first ordered color's photo; a product without an order keeps the Pancake order", async () => {
  const previousShopId = process.env.PANCAKE_SHOP_ID;
  process.env.PANCAKE_SHOP_ID = String(shopId);
  await cleanup();
  try {
    const { createStorefrontSearchSuggestionFinder } = await import(
      "../../src/commerce/storefront-search-repository.ts"
    );
    const find = createStorefrontSearchSuggestionFinder(prisma, shopId);
    const ordered = await createProduct("search-ordered");
    const plain = await createProduct("search-plain");
    await repository.save(ordered.id, [{ color: "Hồng", position: "1" }]);

    const suggestions = await find("variant order search-");
    const primaryOf = (id: string) => suggestions.find((item) => item.id === id)?.primaryImageUrl;
    // Pancake order puts Be's variation ids first, so only the stored order can bring pink forward.
    assert.equal(primaryOf(ordered.id), PINK);
    assert.equal(primaryOf(plain.id), BEIGE);
  } finally {
    if (previousShopId === undefined) delete process.env.PANCAKE_SHOP_ID;
    else process.env.PANCAKE_SHOP_ID = previousShopId;
    await cleanup();
  }
});

test.after(async () => {
  await cleanup();
  await prisma.$disconnect();
});
