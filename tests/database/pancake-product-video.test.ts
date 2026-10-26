import assert from "node:assert/strict";
import test from "node:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../src/generated/prisma/client.ts";
import { createCatalogMirrorRepository } from "../../src/commerce/catalog-mirror-repository.ts";
import { createStorefrontProductDetailRepository } from "../../src/commerce/storefront-product-detail.ts";
import { syncPancakeCatalog } from "../../src/commerce/catalog-sync.ts";
import { parsePancakeCatalogVariations } from "../../src/integrations/pancake/catalog-contract.ts";
import { VIDEO_A, VIDEO_B, VIDEO_POSTER, videoVariation, videoPage } from "../fixtures/pancake-video.ts";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
const repository = createCatalogMirrorRepository(prisma);
const shopId = 910_216;
const productId = "video-db-product";
const now = new Date("2026-10-26T00:00:00Z");
const oldFlag = process.env.LA_PDP_PANCAKE_VIDEO_ENABLED;
function snapshot(videos: unknown[]) {
  return parsePancakeCatalogVariations(videoPage(videos.map((v, i) => videoVariation(`video-db-v${i}`, productId, v)))).variations;
}
async function sync(videos: unknown[]) {
  return repository.syncSnapshot({ shopId, syncedAt: now, variations: snapshot(videos) });
}
async function read() { return prisma.productMirror.findUniqueOrThrow({ where: { pancakeProductId: productId } }); }
async function cleanup() {
  await prisma.productMirror.deleteMany({ where: { pancakeShopId: shopId } });
  await prisma.catalogSyncState.deleteMany({ where: { pancakeShopId: shopId } });
}
test.beforeEach(cleanup);
test.afterEach(async () => { await cleanup(); if (oldFlag === undefined) delete process.env.LA_PDP_PANCAKE_VIDEO_ENABLED; else process.env.LA_PDP_PANCAKE_VIDEO_ENABLED = oldFlag; });
test.after(() => prisma.$disconnect());

test("new mirror defaults UNKNOWN; complete snapshots atomically set, preserve, clear and restore video without touching editorial/commerce", async () => {
  await prisma.productMirror.create({ data: { pancakeShopId: shopId, pancakeProductId: productId, slug: "video-db-product", name: "Before sync", syncedAt: now, content: { create: { editorialDescription: "Website-owned copy" } } } });
  assert.equal((await read()).pancakeVideoSyncState, "UNKNOWN");
  assert.equal((await read()).pancakeVideoUrl, null);
  for (const [videos, state, url] of [
    [[[VIDEO_A], [VIDEO_A]], "READY", VIDEO_A],
    [[[VIDEO_A], undefined], "UNKNOWN", VIDEO_A],
    [[[VIDEO_A], [VIDEO_A]], "READY", VIDEO_A],
    [[null, []], "NONE", null],
    [[[VIDEO_A], [VIDEO_A]], "READY", VIDEO_A],
    [[[VIDEO_A], null], "CONFLICT", null],
    [[[VIDEO_A], [VIDEO_A]], "READY", VIDEO_A],
    [[[VIDEO_A], [VIDEO_B]], "CONFLICT", null],
    [[[VIDEO_A], [VIDEO_A]], "READY", VIDEO_A],
    [[[VIDEO_A.replace(".mp4", ".mov")], [VIDEO_A.replace(".mp4", ".mov")]], "UNSUPPORTED", null],
  ] as const) {
    const result = await sync([...videos]);
    const row = await read();
    assert.equal(row.pancakeVideoSyncState, state);
    assert.equal(row.pancakeVideoUrl, url);
    assert.equal(result.videoSyncCounts.states[state], 1);
    assert.equal(await prisma.productContent.count({ where: { productId: row.id, editorialDescription: "Website-owned copy" } }), 1);
    assert.equal(await prisma.variantMirror.count({ where: { productId: row.id, pancakeRetailPrice: 500_000, pancakeRetailPriceAfterDiscount: 450_000 } }), 2);
    assert.equal(await prisma.warehouseStock.count({ where: { variant: { productId: row.id }, quantity: 4 } }), 2);
    await sync([...videos]);
    assert.equal((await read()).pancakeVideoSyncState, state, "idempotent replay");
  }
});

test("hidden/locked/out-of-stock variations participate, and reactivation updates video", async () => {
  await sync([[VIDEO_A], [VIDEO_A]]);
  const variations = snapshot([[VIDEO_A], null]);
  variations[1]!.isHidden = true;
  variations[1]!.isLocked = true;
  variations[1]!.warehouseStocks[0]!.remainQuantity = 0;
  variations[1]!.sellableStock = 0;
  await repository.syncSnapshot({ shopId, syncedAt: now, variations });
  assert.equal((await read()).pancakeVideoSyncState, "CONFLICT");
  assert.equal((await read()).pancakeVideoUrl, null);
  await repository.syncSnapshot({ shopId, syncedAt: now, variations: [] });
  assert.equal((await read()).isPresent, false);
  await sync([[VIDEO_A], [VIDEO_A]]);
  assert.equal((await read()).isPresent, true);
  assert.equal((await read()).pancakeVideoSyncState, "READY");
});

test("PDP read returns only READY validated video with opt-in and photography", async () => {
  await sync([[VIDEO_A]]);
  const product = await read();
  await prisma.productMirror.update({ where: { id: product.id }, data: { isActive: true } });
  await prisma.variantMirror.updateMany({ where: { productId: product.id }, data: { isActive: true } });
  const detail = createStorefrontProductDetailRepository(prisma);
  const get = () => detail.getProductBySlug({ shopId, slug: product.slug });
  delete process.env.LA_PDP_PANCAKE_VIDEO_ENABLED;
  assert.equal((await get())?.video, null);
  process.env.LA_PDP_PANCAKE_VIDEO_ENABLED = "true";
  assert.deepEqual((await get())?.video, { src: VIDEO_A, poster: VIDEO_POSTER });
  await sync([undefined]);
  assert.equal((await read()).pancakeVideoUrl, VIDEO_A);
  assert.equal((await get())?.video, null);
  await prisma.productMirror.update({ where: { id: product.id }, data: { pancakeVideoSyncState: "READY", pancakeVideoUrl: "https://evil.test/a.mp4" } });
  assert.equal((await get())?.video, null);
  await prisma.productMirror.update({ where: { id: product.id }, data: { pancakeVideoUrl: VIDEO_A, primaryImageUrl: null } });
  await prisma.variantMirror.updateMany({ where: { productId: product.id }, data: { pancakeImageUrls: [] } });
  assert.equal((await get())?.video, null);
});

test("failed/incomplete pagination and rolled-back writes cannot transition READY", async () => {
  await sync([[VIDEO_A]]);
  for (const failure of ["fetch", "count", "commerce"]) {
    const client = { async getJson(_endpoint: string, query?: Readonly<Record<string, string | number | boolean>>) {
      if (query?.page_number === 1) return videoPage([videoVariation("video-db-v0", productId, null)], { total_pages: 2, total_entries: 2 });
      if (failure === "fetch") throw new Error("page unavailable");
      return videoPage(failure === "count" ? [] : [{ ...videoVariation("video-db-v1", productId, null), retail_price: "bad" }], { page_number: 2, total_pages: 2, total_entries: 2 });
    } };
    await assert.rejects(() => syncPancakeCatalog({ client, repository, shopId }));
    assert.equal((await read()).pancakeVideoSyncState, "READY");
    assert.equal((await read()).pancakeVideoUrl, VIDEO_A);
  }
  const variations = snapshot([null]);
  variations[0]!.displayId = "invalid\u0000text"; // PostgreSQL text write fails after the product row update.
  await assert.rejects(() => repository.syncSnapshot({ shopId, syncedAt: now, variations }));
  assert.equal((await read()).pancakeVideoSyncState, "READY");
  assert.equal((await read()).pancakeVideoUrl, VIDEO_A);
});

test("a different shop cannot take over a product video or its commerce rows", async () => {
  await sync([[VIDEO_A]]);
  await assert.rejects(() => repository.syncSnapshot({ shopId: shopId + 1, syncedAt: now, variations: snapshot([null]) }), /another shop/);
  assert.equal((await read()).pancakeShopId, shopId);
  assert.equal((await read()).pancakeVideoUrl, VIDEO_A);
});
