import assert from "node:assert/strict";
import test from "node:test";

import { PrismaPg } from "@prisma/adapter-pg";

import { createProductReviewRepository } from "../../src/commerce/product-review-repository.ts";
import { parseProductReviewInput } from "../../src/commerce/product-review.ts";
import { PrismaClient } from "../../src/generated/prisma/client.ts";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for database smoke tests");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const repository = createProductReviewRepository(prisma);

const SHOP_ID = 920_551;
const suffix = `${process.pid}`;
const syncedAt = new Date("2026-11-01T00:00:00.000Z");
const NOW = new Date("2026-11-08T03:00:00.000Z");
const photo = (n: number) => `https://content.pancake.vn/1/2/3/4/db-review-${n}.jpg`;

let productId = "";
let otherProductId = "";
let productSlug = "";

async function cleanup() {
  await prisma.orderMirror.deleteMany({ where: { publicCode: { startsWith: `RV-${suffix}` } } });
  await prisma.productMirror.deleteMany({ where: { pancakeShopId: SHOP_ID } });
}

function value(overrides: Record<string, unknown> = {}) {
  const parsed = parseProductReviewInput(
    {
      rating: "5",
      authorName: "Lan A.",
      body: "Vải mềm, lên form đẹp.",
      source: "ZALO",
      fit: "TRUE_TO_SIZE",
      sizeLabel: "M",
      reviewedAt: "2026-11-05",
      status: "PUBLISHED",
      consent: "on",
      imageUrls: "",
      ...overrides,
    },
    NOW,
  );
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  if (!parsed.ok) throw new Error("unreachable");
  return parsed.value;
}

async function seedOrder(code: string, state: "CONFIRMED" | "DRAFT", lineProductId: string, bySlug: string | null) {
  const variant = await prisma.variantMirror.findFirstOrThrow({ where: { productId: lineProductId } });
  const order = await prisma.orderMirror.create({
    data: {
      publicCode: code,
      state,
      checkoutSnapshottedAt: syncedAt,
      guestName: "Khách",
      guestPhone: "0900000000",
      provinceRef: "1",
      districtRef: "2",
      communeRef: "3",
      addressDetail: "1 Phố Huế",
      note: "",
      merchandiseSubtotalVnd: BigInt(500_000),
      shippingFeeVnd: BigInt(0),
      totalVnd: BigInt(500_000),
    },
  });
  await prisma.orderLineSnapshot.create({
    data: {
      orderId: order.id,
      variantId: variant.id,
      pancakeVariationId: variant.pancakeVariationId,
      metaContentId: bySlug,
      productName: "Váy",
      size: "M",
      quantity: 1,
      unitPriceVnd: BigInt(500_000),
      lineTotalVnd: BigInt(500_000),
    },
  });
}

test.before(async () => {
  await cleanup();
  const [first, second] = await Promise.all(
    ["a", "b"].map((key) =>
      prisma.productMirror.create({
        data: {
          pancakeShopId: SHOP_ID,
          pancakeProductId: `review-${key}-${suffix}`,
          slug: `review-${key}-${suffix}`,
          name: `Review product ${key}`,
          isPresent: true,
          isActive: true,
          syncedAt,
          variants: {
            create: {
              pancakeVariationId: `review-${key}-variant-${suffix}`,
              color: "Ink",
              size: "M",
              isPresent: true,
              isActive: true,
              syncedAt,
            },
          },
        },
      }),
    ),
  );
  productId = first.id;
  otherProductId = second.id;
  productSlug = first.slug;
});
test.beforeEach(async () => {
  await prisma.productReview.deleteMany({ where: { productId: { in: [productId, otherProductId] } } });
});
test.after(async () => {
  await cleanup();
  await prisma.$disconnect();
});

test("the page reads published reviews only, newest review first, with the summary computed from them", async () => {
  await repository.create(productId, value({ rating: "4", authorName: "Cũ", reviewedAt: "2026-10-01" }));
  await repository.create(productId, value({ rating: "5", authorName: "Mới", reviewedAt: "2026-11-05" }));
  await repository.create(productId, value({ rating: "1", authorName: "Nháp", status: "DRAFT" }));
  await repository.create(otherProductId, value({ authorName: "Khác" }));

  const section = await repository.readSection(productId);
  assert.ok(section);
  assert.equal(section.count, 2, "a draft and another product's review are not counted");
  assert.deepEqual(section.items.map((item) => item.authorName), ["Mới", "Cũ"]);
  assert.equal(section.summary, null, "two reviews are below the minimum for an average");
});

test("a product with no published review has no section", async () => {
  assert.equal(await repository.readSection(productId), null);
  await repository.create(productId, value({ status: "DRAFT" }));
  assert.equal(await repository.readSection(productId), null);
});

test("an average appears once enough published reviews exist", async () => {
  for (const rating of ["5", "5", "5", "4", "3"]) {
    await repository.create(productId, value({ rating, authorName: `Khách ${rating}` }));
  }
  const section = await repository.readSection(productId);
  assert.equal(section?.summary?.average, 4.4);
  assert.deepEqual([...(section?.summary?.distribution ?? [])], [3, 1, 1, 0, 0]);
});

test("photographs and the original review date survive the round trip", async () => {
  await repository.create(productId, value({ imageUrls: `${photo(1)}\n${photo(2)}`, reviewedAt: "2026-10-20" }));
  const [saved] = await repository.listForAdmin(productId);
  assert.deepEqual(saved?.imageUrls, [photo(1), photo(2)]);
  assert.equal(saved?.reviewedAt.toISOString(), "2026-10-20T05:00:00.000Z");
  const section = await repository.readSection(productId);
  assert.equal(section?.items[0]?.dateLabel, "20/10/2026");
  assert.equal(section?.photos.length, 2);
});

test("editing, hiding and deleting act only on this product's own review", async () => {
  const { id } = await repository.create(productId, value({ authorName: "Gốc" }));

  assert.equal(await repository.update(otherProductId, id, value({ authorName: "Giả" })), false);
  assert.equal(await repository.setStatus(otherProductId, id, "DRAFT"), false);
  assert.equal(await repository.remove(otherProductId, id), false);
  assert.equal((await repository.findForAdmin(productId, id))?.authorName, "Gốc");
  assert.equal(await repository.findForAdmin(otherProductId, id), null);

  assert.equal(await repository.update(productId, id, value({ authorName: "Sửa" })), true);
  assert.equal((await repository.findForAdmin(productId, id))?.authorName, "Sửa");

  assert.equal(await repository.setStatus(productId, id, "DRAFT"), true);
  assert.equal(await repository.readSection(productId), null, "a hidden review leaves the page");
  assert.equal(await repository.setStatus(productId, id, "PUBLISHED"), true);
  assert.equal((await repository.readSection(productId))?.count, 1);

  assert.equal(await repository.remove(productId, id), true);
  assert.equal(await repository.readSection(productId), null);
});

test("only a confirmed order that contains the product verifies a review", async () => {
  await seedOrder(`RV-${suffix}-OK`, "CONFIRMED", productId, productSlug);
  await seedOrder(`RV-${suffix}-VARIANT`, "CONFIRMED", productId, null);
  await seedOrder(`RV-${suffix}-DRAFT`, "DRAFT", productId, productSlug);
  await seedOrder(`RV-${suffix}-OTHER`, "CONFIRMED", otherProductId, `review-b-${suffix}`);

  assert.equal(await repository.checkOrderForProduct(productId, `RV-${suffix}-OK`), "OK");
  assert.equal(
    await repository.checkOrderForProduct(productId, `RV-${suffix}-VARIANT`),
    "OK",
    "an order line with no source slug still verifies through its variant's product",
  );
  assert.equal(await repository.checkOrderForProduct(productId, `RV-${suffix}-DRAFT`), "ORDER_NOT_CONFIRMED");
  assert.equal(await repository.checkOrderForProduct(productId, `RV-${suffix}-OTHER`), "ORDER_LACKS_PRODUCT");
  assert.equal(await repository.checkOrderForProduct(productId, `RV-${suffix}-MISSING`), "ORDER_NOT_FOUND");
});

test("the database itself refuses a star count outside 1..5", async () => {
  const row = {
    productId,
    authorName: "Lan A.",
    body: "Đẹp",
    source: "ZALO" as const,
    reviewedAt: new Date("2026-11-05T05:00:00.000Z"),
    consentConfirmedAt: NOW,
  };
  await assert.rejects(prisma.productReview.create({ data: { ...row, rating: 6 } }));
  await assert.rejects(prisma.productReview.create({ data: { ...row, rating: 0 } }));
  await assert.rejects(prisma.productReview.create({ data: { ...row, rating: 5, heightCm: 50 } }));
  assert.equal((await prisma.productReview.create({ data: { ...row, rating: 5 } })).rating, 5);
});

test("deleting a product removes its reviews", async () => {
  const temp = await prisma.productMirror.create({
    data: {
      pancakeShopId: SHOP_ID,
      pancakeProductId: `review-temp-${suffix}`,
      slug: `review-temp-${suffix}`,
      name: "Temp",
      isPresent: true,
      isActive: true,
      syncedAt,
    },
  });
  await repository.create(temp.id, value());
  await prisma.productMirror.delete({ where: { id: temp.id } });
  assert.equal(await prisma.productReview.count({ where: { productId: temp.id } }), 0);
});
