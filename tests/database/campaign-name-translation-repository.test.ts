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
const PAST = new Date("2026-11-01T00:00:00.000Z");
const NAMES = ["CNT mùa thu", "CNT chung", "CNT freeship"];

async function cleanup() {
  await prisma.campaignNameTranslation.deleteMany({ where: { source: { in: [...NAMES, "CNT đã đổi tên"] } } });
  await prisma.voucherCampaign.deleteMany({ where: { pancakeShopId: shopId } });
  await prisma.shippingPromotionCampaign.deleteMany({ where: { pancakeShopId: shopId } });
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

  const rows = (await repository.listNames("en")).filter((row) => NAMES.includes(row.source));
  assert.deepEqual(
    rows.map((row) => ({ source: row.source, kinds: row.kinds, text: row.text })).sort((a, b) => a.source.localeCompare(b.source)),
    [
      { source: "CNT chung", kinds: ["SHIPPING", "VOUCHER"], text: "" },
      { source: "CNT freeship", kinds: ["SHIPPING"], text: "" },
      { source: "CNT mùa thu", kinds: ["VOUCHER"], text: "Autumn offer" },
    ],
  );
});

test("saving replaces, an empty text removes, and readAll returns what is stored", async () => {
  await seed();
  await repository.save({ source: NAMES[0]!, text: "Autumn offer" }, "en");
  await repository.save({ source: NAMES[0]!, text: "Autumn deal" }, "en");
  await repository.save({ source: NAMES[1]!, text: "Everything" }, "en");

  const stored = (await repository.readAll("en")).filter((row) => NAMES.includes(row.source));
  assert.deepEqual(stored.sort((a, b) => a.source.localeCompare(b.source)), [
    { source: "CNT chung", text: "Everything" },
    { source: "CNT mùa thu", text: "Autumn deal" },
  ]);

  await repository.save({ source: NAMES[1]!, text: "" }, "en");
  assert.equal((await repository.readAll("en")).filter((row) => row.source === NAMES[1]).length, 0);
});

test("a translation whose campaign was renamed is no longer listed, and the database refuses another language", async () => {
  await seed();
  await repository.save({ source: "CNT đã đổi tên", text: "Renamed" }, "en");
  assert.equal((await repository.listNames("en")).some((row) => row.source === "CNT đã đổi tên"), false);

  await assert.rejects(
    prisma.campaignNameTranslation.create({ data: { source: NAMES[0]!, locale: "vi", text: "x" } }),
    /locale_check|violates check constraint/i,
  );
  await assert.rejects(
    prisma.campaignNameTranslation.create({ data: { source: NAMES[0]!, locale: "en", text: "   " } }),
    /text_check|violates check constraint/i,
  );
});
