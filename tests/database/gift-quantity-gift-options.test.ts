import assert from "node:assert/strict";
import test from "node:test";

import { PrismaPg } from "@prisma/adapter-pg";

import { createGiftQuantityAdminRepository } from "../../src/commerce/gift-quantity-admin-repository.ts";
import { createDraftGiftQuantityCampaign } from "../../src/commerce/gift-quantity-admin-service.ts";
import { GIFT_OPTION_SEARCH_LIMIT, readGiftOptionCandidates, searchGiftOptionCandidates } from "../../src/commerce/gift-quantity-gift-options.ts";
import { PrismaClient } from "../../src/generated/prisma/client.ts";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for database smoke tests");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const P = "gq13b";
const SHOP = 920_949;
const OTHER_SHOP = 920_950;
const SYNCED = new Date("2026-10-01T00:00:00.000Z");
const ADMIN = { user: { id: "admin-1", role: "ADMIN" }, session: { id: "s-1" } } as const;

async function cleanup() {
  await prisma.giftQuantityCampaign.deleteMany({ where: { name: { startsWith: P } } });
  await prisma.productMirror.deleteMany({ where: { pancakeShopId: { in: [SHOP, OTHER_SHOP] } } });
}

async function product(suffix: string, options: Readonly<{ shop?: number; name?: string; stock?: number; sku?: string; color?: string; size?: string; variantActive?: boolean; productActive?: boolean; present?: boolean; productPresent?: boolean }> = {}) {
  const { shop = SHOP, name = `GQ13b ${suffix}`, stock = 5, sku = `${P}-${suffix}-sku`, color = "Black", size = "M", variantActive = true, productActive = true, present = true, productPresent = true } = options;
  const created = await prisma.productMirror.create({
    data: {
      pancakeShopId: shop, pancakeProductId: `${P}-${suffix}`, slug: `${P}-${suffix}`, name, isActive: productActive, isPresent: productPresent, syncedAt: SYNCED,
      variants: {
        create: {
          pancakeVariationId: `${P}-${suffix}-var`, sku, color, size, isActive: variantActive, isPresent: present, pancakeRetailPrice: 100_000, syncedAt: SYNCED,
          warehouseStocks: stock > 0 ? { create: [{ pancakeWarehouseId: `${P}-a`, quantity: Math.ceil(stock / 2), syncedAt: SYNCED }, { pancakeWarehouseId: `${P}-b`, quantity: Math.floor(stock / 2), syncedAt: SYNCED }] } : undefined,
        },
      },
    },
    include: { variants: true },
  });
  return created.variants[0]!.id;
}

test.beforeEach(cleanup);
test.afterEach(cleanup);
test.after(async () => prisma.$disconnect());

const search = (text: unknown, shopId = SHOP) => searchGiftOptionCandidates(prisma, { shopId, search: text });

test("search is limited to the configured shop and to variants and products still present", async () => {
  const mine = await product("mine");
  await product("foreign", { shop: OTHER_SHOP });
  await product("gone", { present: false });
  await product("gone-product", { productPresent: false });
  const ids = (await search("")).map((candidate) => candidate.id);
  assert.deepEqual(ids, [mine]);
  assert.deepEqual((await search("", OTHER_SHOP)).map((candidate) => candidate.productName), ["GQ13b foreign"]);
});

test("search matches sku, colour, size and product name case-insensitively, and an empty query lists the shop", async () => {
  const a = await product("alpha", { name: "Váy Hoa Nhí", sku: "SKU-ROSE-01", color: "Hồng", size: "S" });
  const b = await product("beta", { name: "Áo Sơ Mi", sku: "SKU-BLUE-02", color: "Xanh", size: "L" });
  assert.deepEqual((await search("rose")).map((candidate) => candidate.id), [a]);
  assert.deepEqual((await search("XANH")).map((candidate) => candidate.id), [b]);
  assert.deepEqual((await search("hoa nhí")).map((candidate) => candidate.id), [a]);
  assert.deepEqual((await search("o")).map((candidate) => candidate.id).sort(), [a, b].sort(), "a single letter matches substrings across fields");
  assert.deepEqual(await search("no-such-text"), []);
  assert.equal((await search("")).length, 2);
});

test("a malformed query is just an empty one, and the length is bounded", async () => {
  await product("one");
  for (const value of [undefined, null, 7, {}, [], ["x"], true]) assert.equal((await search(value)).length, 1, JSON.stringify(value));
  assert.equal((await search("x".repeat(5_000))).length, 0, "an oversized term is cut, not rejected, and matches nothing");
});

test("the result set is bounded", async () => {
  for (let index = 0; index < GIFT_OPTION_SEARCH_LIMIT + 5; index += 1) await product(`bulk-${String(index).padStart(3, "0")}`);
  assert.equal((await search("")).length, GIFT_OPTION_SEARCH_LIMIT);
});

test("unusable variants are returned with the same reason the publish rules would give", async () => {
  const ok = await product("ok", { stock: 4 });
  const dry = await product("dry", { stock: 0 });
  const inactive = await product("inactive", { variantActive: false });
  const hidden = await product("hidden", { productActive: false });
  const combo = await product("combo");
  const part = await product("part");
  await prisma.compositeComponentMirror.create({ data: { parentVariantId: combo, componentVariantId: part, quantity: 1, syncedAt: SYNCED } });
  const byId = new Map((await search("")).map((candidate) => [candidate.id, candidate]));
  assert.equal(byId.get(ok)?.unavailable, null);
  assert.equal(byId.get(ok)?.stock, 4, "stock sums every warehouse");
  assert.equal(byId.get(dry)?.unavailable, "NO_STOCK");
  assert.equal(byId.get(inactive)?.unavailable, "INACTIVE");
  assert.equal(byId.get(hidden)?.unavailable, "INACTIVE");
  assert.equal(byId.get(combo)?.unavailable, null);
  assert.equal(byId.get(combo)?.stock, 5, "gift set capacity derives from its only child");
  assert.equal(byId.get(part)?.unavailable, null, "a component sold on its own is a normal variant");
});

test("labels read the product, colour / size and sku, and never contain ids", async () => {
  const id = await product("label", { name: "Váy Hoa", color: "Hồng", size: "M", sku: "ABC-1" });
  const [candidate] = await search("");
  assert.equal(candidate?.label, "Váy Hoa - Hồng / M (ABC-1)");
  assert.equal(candidate?.label.includes(id), false);
  const bare = await product("bare", { name: "Túi", color: "", size: "", sku: "" });
  const found = (await search("Túi")).find((entry) => entry.id === bare);
  assert.equal(found?.label, "Túi");
});

test("stored options are read back with today's availability, unknown or oversized ids are ignored", async () => {
  const ok = await product("kept", { stock: 3 });
  const dry = await product("kept-dry", { stock: 0 });
  const found = await readGiftOptionCandidates(prisma, [ok, dry, "missing-id", "x".repeat(300), ok]);
  assert.deepEqual(found.map((candidate) => [candidate.id, candidate.unavailable]).sort(), [[ok, null], [dry, "NO_STOCK"]].sort());
  assert.deepEqual(await readGiftOptionCandidates(prisma, []), []);
  assert.deepEqual(await readGiftOptionCandidates(prisma, ["missing-id"]), []);
});

test("the edit read-back returns the stored gift rule and its labelled options, and nothing for a tier", async () => {
  const a = await product("rb-a", { name: "GQ13b RB A" });
  const b = await product("rb-b", { name: "GQ13b RB B", stock: 0 });
  const created = await createDraftGiftQuantityCampaign({
    session: ADMIN,
    values: {
      kind: "GIFT_ITEM", name: `${P} readback`, startsAt: null, endsAt: null, scopeMode: "DYNAMIC_CATEGORY", categoryKeys: ["setVay"],
      includeProductIds: [], excludeProductIds: [], giftTrigger: "QUANTITY", subtotalScope: null, tierRule: null,
      giftRule: { minimumQuantity: 3, minimumSubtotalVnd: null, awardMode: null, maxGiftsPerOrder: 2, allowDuplicateGifts: true, variantIds: [b, a] },
    },
  });
  assert.equal(created.ok, true);
  const repository = createGiftQuantityAdminRepository(prisma);
  const detail = await repository.getCampaignForEdit((created as { campaignId: string }).campaignId);
  assert.deepEqual(detail?.giftRule, { minimumQuantity: 3, minimumSubtotalVnd: null, awardMode: null, maxGiftsPerOrder: 2, allowDuplicateGifts: true, variantIds: [a, b].sort() });
  assert.deepEqual(detail?.giftOptions.map((option) => [option.productName, option.unavailable]), [["GQ13b RB A", null], ["GQ13b RB B", "NO_STOCK"]]);
  assert.equal(detail?.tierRule, null);

  const tier = await prisma.giftQuantityCampaign.create({ data: { kind: "QUANTITY_TIER", name: `${P} tier`, tierUnit: "PERCENTAGE", tierDiscountedUnits: "ALL_ELIGIBLE_UNITS" } });
  const tierDetail = await repository.getCampaignForEdit(tier.id);
  assert.equal(tierDetail?.giftRule, null);
  assert.deepEqual(tierDetail?.giftOptions, []);
});
