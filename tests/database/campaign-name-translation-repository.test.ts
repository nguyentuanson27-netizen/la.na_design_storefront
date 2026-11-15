import assert from "node:assert/strict";
import test from "node:test";

import { PrismaPg } from "@prisma/adapter-pg";

import { createCampaignNameTranslationRepository } from "../../src/commerce/campaign-name-translation-repository.ts";
import { PrismaClient } from "../../src/generated/prisma/client.ts";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is required for database smoke tests");
}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const repository = createCampaignNameTranslationRepository(prisma);
const shopId = 910_071;
const otherShopId = 910_072;
const PAST = new Date("2026-11-01T00:00:00.000Z");
const NAMES = ["CNT mùa thu", "CNT chung", "CNT freeship"];
const EXTRA = ["CNT riêng tư", "CNT đã tắt", "CNT đã hết hạn", "CNT mồ côi", "CNT đã đổi tên", "CNT chưa bắt đầu", "CNT shop khác", "CNT freeship shop khác", "CNT khuyến mãi A", "CNT khuyến mãi B", "CNT khuyến mãi B theo biến thể", "CNT quà cố định A", "CNT quà cố định B", "CNT quà theo danh mục"];

async function cleanup() {
  await prisma.campaignNameTranslation.deleteMany({ where: { source: { in: [...NAMES, ...EXTRA] } } });
  await prisma.voucherCampaign.deleteMany({ where: { pancakeShopId: { in: [shopId, otherShopId] } } });
  await prisma.shippingPromotionCampaign.deleteMany({ where: { pancakeShopId: { in: [shopId, otherShopId] } } });
  await prisma.promotionCampaign.deleteMany({ where: { name: { in: EXTRA } } });
  await prisma.giftQuantityCampaign.deleteMany({ where: { name: { in: EXTRA } } });
  await prisma.productMirror.deleteMany({ where: { pancakeShopId: { in: [shopId, otherShopId] } } });
}

async function seed() {
  await prisma.voucherCampaign.create({
    data: {
      pancakeShopId: shopId, kind: "MERCHANDISE", issuance: "AUTO", visibility: "PUBLIC", discountType: "FIXED_AMOUNT_VND",
      scopeMode: "ALL_SHOP", isEnabled: true, enabledAt: PAST, name: NAMES[0]!, fixedAmountVnd: BigInt(50_000), minEligibleSubtotalVnd: BigInt(600_000),
    },
  });
  await prisma.voucherCampaign.create({
    data: {
      pancakeShopId: shopId, kind: "MERCHANDISE", issuance: "AUTO", visibility: "PUBLIC", discountType: "FIXED_AMOUNT_VND",
      scopeMode: "ALL_SHOP", isEnabled: true, enabledAt: PAST, name: NAMES[1]!, fixedAmountVnd: BigInt(20_000), minEligibleSubtotalVnd: BigInt(600_000),
    },
  });
  // The same name on a different kind of campaign is one row in the list.
  await prisma.shippingPromotionCampaign.create({
    data: { pancakeShopId: shopId, name: NAMES[1]!, isEnabled: true, enabledAt: PAST, minimumQuantity: 1, priority: 1, stackingEnabled: false, categoryKeys: ["vayDam"] },
  });
  await prisma.shippingPromotionCampaign.create({
    data: { pancakeShopId: shopId, name: NAMES[2]!, isEnabled: true, enabledAt: PAST, minimumQuantity: 2, priority: 2, stackingEnabled: false, categoryKeys: ["vayDam"] },
  });
}

test.beforeEach(cleanup);
test.afterEach(cleanup);
test.after(async () => prisma.$disconnect());

test("every campaign name in use is listed once, with its kinds and its English", async () => {
  await seed();
  await repository.save({ source: NAMES[0]!, text: "Autumn offer" }, "en");

  const rows = (await repository.listNames("en", shopId)).filter((row) => NAMES.includes(row.source));
  assert.deepEqual(
    rows.map((row) => ({ source: row.source, kinds: row.kinds, text: row.text })).sort((a, b) => a.source.localeCompare(b.source)),
    [
      { source: "CNT chung", kinds: ["SHIPPING", "VOUCHER"], text: "" },
      { source: "CNT freeship", kinds: ["SHIPPING"], text: "" },
      { source: "CNT mùa thu", kinds: ["VOUCHER"], text: "Autumn offer" },
    ],
  );
});

test("saving replaces and an empty text removes", async () => {
  await seed();
  await repository.save({ source: NAMES[0]!, text: "Autumn offer" }, "en");
  await repository.save({ source: NAMES[0]!, text: "Autumn deal" }, "en");
  await repository.save({ source: NAMES[1]!, text: "Everything" }, "en");

  const stored = (await repository.listNames("en", shopId)).filter((row) => NAMES.includes(row.source) && row.text !== "");
  assert.deepEqual(stored.map((row) => [row.source, row.text]).sort(), [
    ["CNT chung", "Everything"],
    ["CNT mùa thu", "Autumn deal"],
  ]);

  await repository.save({ source: NAMES[1]!, text: "" }, "en");
  assert.equal((await repository.listNames("en", shopId)).find((row) => row.source === NAMES[1])?.text, "");
});

test("only names of public, switched-on, running campaigns are published; private, off, ended and orphan are not", async () => {
  await seed();
  const base = {
    pancakeShopId: shopId, kind: "MERCHANDISE" as const, issuance: "AUTO" as const, discountType: "FIXED_AMOUNT_VND" as const,
    scopeMode: "ALL_SHOP" as const, enabledAt: PAST, fixedAmountVnd: BigInt(10_000), minEligibleSubtotalVnd: BigInt(600_000),
  };
  await prisma.voucherCampaign.create({ data: { ...base, visibility: "PRIVATE", issuance: "CODE", code: "CNTPRIV", isEnabled: true, name: "CNT riêng tư" } });
  await prisma.voucherCampaign.create({ data: { ...base, visibility: "PUBLIC", isEnabled: false, name: "CNT đã tắt" } });
  await prisma.voucherCampaign.create({ data: { ...base, visibility: "PUBLIC", isEnabled: true, endsAt: new Date("2026-11-02T00:00:00.000Z"), name: "CNT đã hết hạn" } });
  for (const source of [NAMES[0]!, "CNT riêng tư", "CNT đã tắt", "CNT đã hết hạn", "CNT mồ côi"]) {
    await repository.save({ source, text: `EN ${source}` }, "en");
  }

  const published = (await repository.readPublic("en", shopId, new Date("2026-11-15T00:00:00.000Z"))).map((row) => row.source);
  assert.deepEqual(published.filter((source) => source.startsWith("CNT")).sort(), [NAMES[0]!]);

  // The admin still sees every name in use, and a name only a private voucher carries cannot be translated.
  const listed = new Map((await repository.listNames("en", shopId)).map((row) => [row.source, row]));
  assert.equal(listed.get("CNT riêng tư")?.translatable, false);
  assert.deepEqual(listed.get("CNT riêng tư")?.kinds, ["PRIVATE_VOUCHER"]);
  assert.equal(listed.get(NAMES[0]!)?.translatable, true);
  assert.equal(listed.has("CNT mồ côi"), false);

  await prisma.voucherCampaign.deleteMany({ where: { pancakeShopId: shopId } });
});

test("a campaign that starts tomorrow is not published until it starts", async () => {
  await seed();
  const startsAt = new Date("2026-11-16T00:00:00.000Z");
  await prisma.voucherCampaign.create({
    data: {
      pancakeShopId: shopId, kind: "MERCHANDISE", issuance: "AUTO", visibility: "PUBLIC", discountType: "FIXED_AMOUNT_VND",
      scopeMode: "ALL_SHOP", enabledAt: PAST, isEnabled: true, startsAt, name: "CNT chưa bắt đầu",
      fixedAmountVnd: BigInt(10_000), minEligibleSubtotalVnd: BigInt(600_000),
    },
  });
  await prisma.shippingPromotionCampaign.create({
    data: { pancakeShopId: shopId, name: "CNT chưa bắt đầu", isEnabled: true, enabledAt: PAST, startsAt, minimumQuantity: 3, priority: 3, stackingEnabled: false, categoryKeys: ["vayDam"] },
  });
  await repository.save({ source: "CNT chưa bắt đầu", text: "Not yet" }, "en");

  const before = await repository.readPublic("en", shopId, new Date("2026-11-15T12:00:00.000Z"));
  assert.equal(before.some((row) => row.source === "CNT chưa bắt đầu"), false);
  const after = await repository.readPublic("en", shopId, new Date("2026-11-16T00:00:01.000Z"));
  assert.equal(after.some((row) => row.source === "CNT chưa bắt đầu"), true);
});

test("only this shop's vouchers and freeship campaigns publish a name", async () => {
  await seed();
  await prisma.voucherCampaign.create({
    data: {
      pancakeShopId: otherShopId, kind: "MERCHANDISE", issuance: "AUTO", visibility: "PUBLIC", discountType: "FIXED_AMOUNT_VND",
      scopeMode: "ALL_SHOP", enabledAt: PAST, isEnabled: true, name: "CNT shop khác",
      fixedAmountVnd: BigInt(10_000), minEligibleSubtotalVnd: BigInt(600_000),
    },
  });
  await prisma.shippingPromotionCampaign.create({
    data: { pancakeShopId: otherShopId, name: "CNT freeship shop khác", isEnabled: true, enabledAt: PAST, minimumQuantity: 1, priority: 1, stackingEnabled: false, categoryKeys: ["vayDam"] },
  });
  for (const source of [NAMES[0]!, "CNT shop khác", "CNT freeship shop khác"]) {
    await repository.save({ source, text: `EN ${source}` }, "en");
  }
  const now = new Date("2026-11-15T00:00:00.000Z");

  const here = (await repository.readPublic("en", shopId, now)).map((row) => row.source).filter((source) => source.startsWith("CNT"));
  assert.deepEqual(here, [NAMES[0]!]);
  const there = (await repository.readPublic("en", otherShopId, now)).map((row) => row.source).filter((source) => source.startsWith("CNT")).sort();
  assert.deepEqual(there, ["CNT freeship shop khác", "CNT shop khác"]);

  // The admin list is the shop's own as well.
  const listed = (await repository.listNames("en", shopId)).map((row) => row.source);
  assert.equal(listed.includes("CNT shop khác"), false);
  assert.equal(listed.includes(NAMES[0]!), true);
});

test("a promotion or gift campaign is placed by what it applies to, not published to every shop", async () => {
  await seed();
  const syncedAt = new Date("2026-11-01T00:00:00.000Z");
  const productOf = (slug: string, pancakeShopId: number) =>
    prisma.productMirror.create({
      data: {
        pancakeShopId, pancakeProductId: `${slug}-ext`, slug, name: slug, syncedAt,
        variants: { create: { pancakeVariationId: `${slug}-var`, color: "Đen", size: "M", syncedAt } },
      },
      include: { variants: true },
    });
  const here = await productOf("cnt-here", shopId);
  const there = await productOf("cnt-there", otherShopId);
  const promotion = (name: string, targets: object) =>
    prisma.promotionCampaign.create({
      data: { kind: "PROMOTION", name, discountType: "PERCENTAGE", percentageValue: 10, isEnabled: true, enabledAt: PAST, targets: { create: targets } },
    });
  await promotion("CNT khuyến mãi A", { productId: here.id });
  await promotion("CNT khuyến mãi B", { productId: there.id });
  await promotion("CNT khuyến mãi B theo biến thể", { variantId: there.variants[0]!.id });

  const gift = (name: string, scope: object, frozenProductId?: string) =>
    prisma.giftQuantityCampaign.create({
      data: {
        kind: "QUANTITY_TIER", name, isEnabled: true, enabledAt: PAST, tierUnit: "PERCENTAGE",
        tierDiscountedUnits: "ALL_ELIGIBLE_UNITS", tierSelectionPriority: null,
        tiers: { create: [{ minQuantity: 2, discountValue: 5 }] },
        ...scope,
        ...(frozenProductId === undefined
          ? {}
          : { frozenAt: PAST, frozenCampaignRevision: 1, frozen: { create: { productId: frozenProductId } } }),
      },
    });
  await gift("CNT quà cố định A", { scopeMode: "FIXED_PRODUCT_SET", categoryKeys: [] }, here.id);
  await gift("CNT quà cố định B", { scopeMode: "FIXED_PRODUCT_SET", categoryKeys: [] }, there.id);
  await gift("CNT quà theo danh mục", { scopeMode: "DYNAMIC_CATEGORY", categoryKeys: ["setVay"] });
  for (const name of ["CNT khuyến mãi A", "CNT khuyến mãi B", "CNT khuyến mãi B theo biến thể", "CNT quà cố định A", "CNT quà cố định B", "CNT quà theo danh mục"]) {
    await repository.save({ source: name, text: `EN ${name}` }, "en");
  }
  const now = new Date("2026-11-15T00:00:00.000Z");
  const names = async (shop: number) =>
    (await repository.readPublic("en", shop, now)).map((row) => row.source).filter((source) => source.startsWith("CNT")).sort();

  // Shop A: its own promotion and fixed gift, plus the one over a category (which applies wherever it is read).
  assert.deepEqual((await names(shopId)).filter((n) => /khuyến mãi|quà/.test(n)), ["CNT khuyến mãi A", "CNT quà cố định A", "CNT quà theo danh mục"]);
  // Shop B: the promotions on its products (product and variant targets) and its fixed gift.
  assert.deepEqual((await names(otherShopId)).filter((n) => /khuyến mãi|quà/.test(n)), [
    "CNT khuyến mãi B", "CNT khuyến mãi B theo biến thể", "CNT quà cố định B", "CNT quà theo danh mục",
  ]);

  // The admin's list is the shop's own as well.
  const listed = (await repository.listNames("en", shopId)).map((row) => row.source);
  for (const gone of ["CNT khuyến mãi B", "CNT khuyến mãi B theo biến thể", "CNT quà cố định B"]) assert.equal(listed.includes(gone), false, gone);
  for (const kept of ["CNT khuyến mãi A", "CNT quà cố định A", "CNT quà theo danh mục"]) assert.equal(listed.includes(kept), true, kept);
});

test("a translation whose campaign was renamed is no longer listed, and the database refuses another language", async () => {
  await seed();
  await repository.save({ source: "CNT đã đổi tên", text: "Renamed" }, "en");
  assert.equal((await repository.listNames("en", shopId)).some((row) => row.source === "CNT đã đổi tên"), false);

  await assert.rejects(
    prisma.campaignNameTranslation.create({ data: { source: NAMES[0]!, locale: "vi", text: "x" } }),
    /locale_check|violates check constraint/i,
  );
  await assert.rejects(
    prisma.campaignNameTranslation.create({ data: { source: NAMES[0]!, locale: "en", text: "   " } }),
    /text_check|violates check constraint/i,
  );
});
