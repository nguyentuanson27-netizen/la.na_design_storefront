import assert from "node:assert/strict";
import test from "node:test";
import { prisma } from "../../src/db/prisma.ts";
import { createAnonymousCartService } from "../../src/commerce/anonymous-cart.ts";
import { readCartGiftState } from "../../src/commerce/cart-gift-selection.ts";
import { resolveBenefitCheckoutQuote } from "../../src/commerce/benefit-checkout-quote.ts";
import { buildRenderedCheckoutQuoteFacts } from "../../src/commerce/checkout-quote.ts";
import { issueUpsellQuoteProof, type UpsellIntent } from "../../src/commerce/promotion-upsell-proof.ts";
import { createPromotionUpsellService, UPSELL_BANNER_MAX_QUOTES, UPSELL_MAX_QUOTES } from "../../src/commerce/promotion-upsell.ts";
import { acquireCatalogSyncLock } from "../../src/commerce/catalog-sync-lock.ts";
import { lockRevision } from "../../src/commerce/promotion-activation-service.ts";

const SHOP = 929171;
const PREFIX = "ups171-";
const secret = "upsell-integration-secret-more-than-thirty-two-bytes";
const env = { LA_PROMOTION_UPSELL_ENABLED: "true", LA_GIFT_QUANTITY_PROMOTIONS_ENABLED: "true", LA_PANCAKE_LINE_LEVEL_PRICING_VERIFIED_SHOP_IDS: String(SHOP) };
let cartId = "", paidId = "", candidateProductId = "", giftId = "";
const campaignId = `${PREFIX}campaign`;
const metrics: unknown[] = [];
const store = () => ({ get: (name: string) => name === "la_cart" ? { value: cartId } : undefined });
const service = () => createPromotionUpsellService(prisma, store(), { shopId: SHOP, secret, env, metric: (m) => metrics.push(m) });
async function product(id: string, price = 100000, sizes = ["S"]) {
  return prisma.productMirror.create({ data: { pancakeShopId: SHOP, pancakeProductId: `${PREFIX}${id}`, slug: `${PREFIX}${id}`, name: `Áo ${id}`, syncedAt: new Date(), variants: { create: sizes.map((size, i) => ({ pancakeVariationId: `${PREFIX}${id}-${size}`, color: "Hồng", size, isActive: true, isPresent: true, pancakeRetailPrice: price + i * 10000, pancakeRetailPriceAfterDiscount: price + i * 10000, syncedAt: new Date(), warehouseStocks: { create: { pancakeWarehouseId: `${PREFIX}warehouse`, quantity: 20, syncedAt: new Date() } } })) } }, include: { variants: true } });
}
async function cleanup() {
  await prisma.cart.deleteMany({ where: { items: { some: { variant: { product: { pancakeShopId: SHOP } } } } } });
  await prisma.giftQuantityCampaign.deleteMany({ where: { id: { startsWith: PREFIX } } });
  await prisma.productMirror.deleteMany({ where: { pancakeShopId: SHOP } });
}
async function proof() {
  return prisma.$transaction(async (tx) => {
    const result = await resolveBenefitCheckoutQuote({ tx, cartId, shopId: SHOP, now: new Date(), env });
    if (result.kind === "BENEFIT") return issueUpsellQuoteProof({ kind: "BENEFIT", facts: result.facts }, cartId, secret)!;
    assert.equal(result.kind, "LEGACY");
    const state = await readCartGiftState(tx, cartId, SHOP, new Date(), env);
    const facts = buildRenderedCheckoutQuoteFacts(state.quote.lines);
    assert.ok(facts);
    return issueUpsellQuoteProof({ kind: "LEGACY", facts }, cartId, secret)!;
  });
}
async function offer() {
  const model = await service().get(await proof());
  assert.ok(model?.offer, JSON.stringify(metrics));
  return model;
}
async function intent(): Promise<UpsellIntent> { return (await offer()).offer!.products[0]!.variants[0]!.intent; }

test.beforeEach(async () => {
  await cleanup(); metrics.length = 0;
  const paid = await product("paid"); const candidate = await product("candidate", 100000, ["S", "M"]); const gift = await product("gift", 1000);
  paidId = paid.variants[0]!.id; candidateProductId = candidate.id; giftId = gift.variants[0]!.id;
  cartId = (await prisma.cart.create({ data: { expiresAt: new Date(Date.now() + 86400000), items: { create: { variantId: paidId, quantity: 2 } } } })).id;
  await prisma.giftQuantityCampaign.create({ data: { id: campaignId, kind: "GIFT_ITEM", name: "Mua 3 tặng khăn", isEnabled: true, enabledAt: new Date(), scopeMode: "DYNAMIC_CATEGORY", categoryKeys: [], targets: { create: [paid.id, candidate.id].map((productId) => ({ productId, role: "INCLUDE" })) }, giftTrigger: "QUANTITY", minimumQuantity: 3, maxGiftsPerOrder: 2, allowDuplicateGifts: true, giftOptions: { create: { variantId: giftId } } } });
});
test.afterEach(cleanup);
test.after(async () => prisma.$disconnect());

test("TG-01: disabled or unverified POS reads nothing", async () => {
  for (const overrides of [{ LA_PROMOTION_UPSELL_ENABLED: undefined }, { LA_GIFT_QUANTITY_PROMOTIONS_ENABLED: "false" }, { LA_PANCAKE_LINE_LEVEL_PRICING_VERIFIED_SHOP_IDS: "" }]) {
    const closed = createPromotionUpsellService({} as typeof prisma, { get() { throw new Error("must not read cookie"); } }, { shopId: SHOP, secret, env: { ...env, ...overrides } });
    assert.equal(await closed.get(""), null);
  }
});
test("TG-02/05/06/07: dynamic explicit INCLUDE, no category; +1 quote and shipping parity, distinct sizes, no writes", async () => {
  const before = await prisma.cartItem.findMany({ where: { cartId } });
  const model = await offer();
  assert.equal(model.offer!.products.length, 1);
  assert.equal(model.offer!.products[0]!.productId, candidateProductId);
  assert.deepEqual(model.offer!.products[0]!.variants.map((v) => v.deltaVnd).sort((a,b) => a-b), [100000, 110000]);
  assert.deepEqual(await prisma.cartItem.findMany({ where: { cartId } }), before);
  assert.equal(JSON.stringify(model).includes(cartId), false);
});
test("TG-08/09/10: two tabs/double click commit exactly one, new gift is manual and COD is not created", async () => {
  const i = await intent();
  const ordersBefore = await prisma.orderMirror.count();
  const results = await Promise.all([service().add(i), service().add(i)]);
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.equal(await prisma.cartItem.count({ where: { cartId } }), 2);
  assert.equal(await prisma.cartGiftSelection.count({ where: { cartId } }), 0);
  assert.equal(await prisma.orderMirror.count(), ordersBefore);
  const success = results.find((r) => r.ok)!;
  assert.ok(success.ok); assert.deepEqual(success.newGiftCampaignIds, [campaignId]);
});
test("TG-10: recovery marker matches only the next paid revision and reload exposes actual unlocked gifts", async () => {
  const model = await offer();
  assert.notEqual(model.nextPaidCartKey, model.paidCartKey);
  const added = await service().add(model.offer!.products[0]!.variants[0]!.intent);
  assert.ok(added.ok);
  const reloaded = await service().get(await proof());
  assert.equal(reloaded?.paidCartKey, model.nextPaidCartKey);
  assert.equal(reloaded?.giftPicker.campaigns.find((c) => c.campaignId === campaignId)?.entitled, 1);
  await prisma.cartItem.updateMany({ where: { cartId, variantId: paidId }, data: { quantity: 1 } });
  assert.notEqual((await service().get(await proof()))?.paidCartKey, model.nextPaidCartKey);
});
test("TG-09/11: revision survives A→B→A and invalidates intent and UI key", async () => {
  const model = await offer(); const i = model.offer!.products[0]!.variants[0]!.intent;
  const carts = createAnonymousCartService(prisma);
  await carts.setItemQuantity({ cartId, variantId: paidId, quantity: 1, now: new Date() });
  await carts.setItemQuantity({ cartId, variantId: paidId, quantity: 2, now: new Date() });
  assert.equal((await service().add(i)).ok, false);
  assert.notEqual((await offer()).paidCartKey, model.paidCartKey);
});
test("TG-09: corrupted, cross-cart, expired and changed-variant proofs never write", async () => {
  const i = await intent();
  for (const input of [{ ...i, proof: "bad.proof" }, { ...i, variantId: paidId }, { ...i, issuedAt: i.issuedAt - 300001 }, { ...i, cartId }, { ...i, price: 1 }]) assert.equal((await service().add(input)).ok, false);
  const original = cartId;
  cartId = (await prisma.cart.create({ data: { expiresAt: new Date(Date.now() + 86400000), items: { create: { variantId: paidId, quantity: 2 } } } })).id;
  assert.equal((await service().add(i)).ok, false);
  assert.equal(await prisma.cartItem.count({ where: { cartId } }), 1);
  cartId = original;
});
test("TG-06: exclusion wins before the bounded pool, sold-out and already-paid products are never offered", async () => {
  await prisma.giftQuantityTarget.update({ where: { campaignId_productId: { campaignId, productId: candidateProductId } }, data: { role: "EXCLUDE" } });
  assert.equal((await service().get(await proof()))?.offer ?? null, null);
  assert.equal((await service().getBanner(await proof()))?.offerName, null, "excluded products cannot be offered by the lighter banner path");
  await prisma.giftQuantityTarget.update({ where: { campaignId_productId: { campaignId, productId: candidateProductId } }, data: { role: "INCLUDE" } });
  await prisma.warehouseStock.updateMany({ where: { variant: { productId: candidateProductId } }, data: { quantity: 0 } });
  assert.equal((await service().get(await proof()))?.offer ?? null, null);
  assert.equal((await service().getBanner(await proof()))?.offerName, null, "sold-out products cannot be offered by the lighter banner path");
});
test("TG-09: catalog stock synchronization serialized before add rejects a stale READY offer", async () => {
  const i = await intent(); let release!: () => void; let ready!: () => void;
  const isReady = new Promise<void>((r) => ready = r); const released = new Promise<void>((r) => release = r);
  const sync = prisma.$transaction(async (tx) => { await acquireCatalogSyncLock(tx, SHOP); ready(); await released; await tx.warehouseStock.updateMany({ where: { variantId: i.variantId }, data: { quantity: 0 } }); });
  await isReady;
  const add = service().add(i);
  await new Promise((r) => setTimeout(r, 50)); release();
  const [, result] = await Promise.all([sync, add]);
  assert.equal(result.ok, false);
  assert.equal(await prisma.cartItem.count({ where: { cartId } }), 1);
});
test("TG-09: a publication disable committed while add waits invalidates candidate and paid products", async () => {
  const paid = await prisma.variantMirror.findUniqueOrThrow({ where: { id: paidId }, select: { productId: true } });
  for (const productId of [candidateProductId, paid.productId]) {
    const i = await intent(); let release!: () => void; let ready!: () => void;
    const isReady = new Promise<void>((r) => ready = r); const released = new Promise<void>((r) => release = r);
    const edit = prisma.$transaction(async (tx) => { await tx.productMirror.update({ where: { id: productId }, data: { isActive: false } }); ready(); await released; });
    await isReady; const add = service().add(i);
    await new Promise((r) => setTimeout(r, 50)); release();
    const [, result] = await Promise.all([edit, add]);
    assert.equal(result.ok, false);
    assert.equal(await prisma.cartItem.count({ where: { cartId } }), 1);
    await prisma.productMirror.update({ where: { id: productId }, data: { isActive: true } });
  }
});
test("TG-09: global promotion edit lock covers concurrent disable, including rows not yet active", async () => {
  const i = await intent(); let release!: () => void; let ready!: () => void;
  const isReady = new Promise<void>((r) => ready = r); const released = new Promise<void>((r) => release = r);
  const edit = prisma.$transaction(async (tx) => { await lockRevision(tx); ready(); await released; await tx.giftQuantityCampaign.update({ where: { id: campaignId }, data: { isEnabled: false, revision: { increment: 1 } } }); });
  await isReady;
  const add = service().add(i);
  await new Promise((r) => setTimeout(r, 50)); release();
  const [, result] = await Promise.all([edit, add]);
  assert.equal(result.ok, false);
  assert.equal(await prisma.cartItem.count({ where: { cartId } }), 1);
});
test("TG-01: blocked recommendation query hits deadline and returns null; existing quote stays usable", async () => {
  let release!: () => void; let ready!: () => void;
  const isReady = new Promise<void>((r) => ready = r); const released = new Promise<void>((r) => release = r);
  const rendered = await proof();
  const blocker = prisma.$transaction(async (tx) => { await tx.$executeRaw`LOCK TABLE "GiftQuantityCampaign" IN ACCESS EXCLUSIVE MODE`; ready(); await released; }, { timeout: 10000 });
  await isReady;
  const started = Date.now();
  try { assert.equal(await service().get(rendered), null); assert.ok(Date.now() - started < 3000); }
  finally { release(); await blocker; }
  assert.equal(await proof(), rendered);
});

test("TG-03: order-money gift 80% absolute threshold and +1 must actually reach it", async () => {
  await prisma.giftQuantityCampaign.update({ where: { id: campaignId }, data: { giftTrigger: "ORDER_SUBTOTAL", scopeMode: "GLOBAL_ALL_PAID_LINES", minimumQuantity: null, minimumSubtotalVnd: 250000, subtotalScope: "ALL_PAID_LINES", awardMode: "ONCE", targets: { deleteMany: {} } } });
  assert.ok((await offer()).offer);
  await prisma.variantMirror.updateMany({ where: { productId: candidateProductId }, data: { pancakeRetailPrice: 10000, pancakeRetailPriceAfterDiscount: 10000 } });
  assert.equal((await service().get(await proof()))?.offer ?? null, null, "80% near alone cannot make an under-threshold +1 valid");
});
test("TG-02/03: both quantity and money tier use actual canonical rung +1, including top rung", async () => {
  await prisma.giftQuantityCampaign.delete({ where: { id: campaignId } });
  const paid = await prisma.variantMirror.findUniqueOrThrow({ where: { id: paidId }, select: { productId: true } });
  await prisma.giftQuantityCampaign.create({ data: { id: campaignId, name: "Tier", kind: "QUANTITY_TIER", isEnabled: true, enabledAt: new Date(), scopeMode: "DYNAMIC_CATEGORY", categoryKeys: [], tierBasis: "QUANTITY", tierUnit: "PERCENTAGE", tierDiscountedUnits: "ALL_ELIGIBLE_UNITS", targets: { create: [paid.productId, candidateProductId].map((productId) => ({ productId, role: "INCLUDE" })) }, tiers: { create: { minQuantity: 3, discountValue: 10 } } } });
  const q = await offer();
  assert.equal(q.offer!.products[0]!.variants[0]!.deltaVnd, 70000);
  await prisma.giftQuantityCampaign.update({ where: { id: campaignId }, data: { scopeMode: "GLOBAL_ALL_PAID_LINES", tierBasis: "ORDER_SUBTOTAL", targets: { deleteMany: {} }, tiers: { deleteMany: {}, create: { minQuantity: 250000, discountValue: 10 } } } });
  assert.ok((await offer()).offer);
  await prisma.variantMirror.updateMany({ where: { productId: candidateProductId }, data: { pancakeRetailPrice: 10000, pancakeRetailPriceAfterDiscount: 10000 } });
  assert.equal((await service().get(await proof()))?.offer ?? null, null);
});
test("TG-06: fixed membership and expanded parent category discover descendant-only products", async () => {
  const paid = await prisma.variantMirror.findUniqueOrThrow({ where: { id: paidId }, select: { productId: true } });
  await prisma.giftQuantityCampaign.update({ where: { id: campaignId }, data: { scopeMode: "FIXED_PRODUCT_SET", frozenAt: new Date(), frozenCampaignRevision: 1, frozen: { create: [paid.productId, candidateProductId].map((productId) => ({ productId })) } } });
  assert.equal((await offer()).offer!.products[0]!.productId, candidateProductId);
  await prisma.giftQuantityCampaign.update({ where: { id: campaignId }, data: { scopeMode: "DYNAMIC_CATEGORY", categoryKeys: ["aoDai"], frozenAt: null, frozenCampaignRevision: null, targets: { deleteMany: {} } } });
  await prisma.productCategoryMembership.createMany({ data: [paid.productId, candidateProductId].map((productId) => ({ productId, categoryKey: "aoDaiCachTan" })) });
  assert.equal((await offer()).offer!.products[0]!.productId, candidateProductId);
});
test("TG-09: category reassignment under the shared catalog guard invalidates before commit", async () => {
  const paid = await prisma.variantMirror.findUniqueOrThrow({ where: { id: paidId }, select: { productId: true } });
  await prisma.giftQuantityCampaign.update({ where: { id: campaignId }, data: { categoryKeys: ["aoDai"], targets: { deleteMany: {} } } });
  await prisma.productCategoryMembership.createMany({ data: [paid.productId, candidateProductId].map((productId) => ({ productId, categoryKey: "aoDaiCachTan" })) });
  const i = await intent(); let release!: () => void; let ready!: () => void;
  const isReady = new Promise<void>((r) => ready = r); const released = new Promise<void>((r) => release = r);
  const edit = prisma.$transaction(async (tx) => { await acquireCatalogSyncLock(tx, SHOP); ready(); await released; await tx.productCategoryMembership.deleteMany({ where: { productId: candidateProductId } }); });
  await isReady; const add = service().add(i); await new Promise((r) => setTimeout(r, 50)); release();
  const [, result] = await Promise.all([edit, add]); assert.equal(result.ok, false);
});
test("UP-00/TG-06: representative 30-product, 3-size catalog; bounded output/quote work and aggregate latency evidence", async () => {
  const products = [];
  for (let n = 0; n < 30; n++) products.push(await product(`bounded-${n}`, 100000, ["S", "M", "L"]));
  await prisma.giftQuantityTarget.createMany({ data: products.map((p) => ({ campaignId, productId: p.id, role: "INCLUDE" })) });
  const times = [];
  const rendered = await proof();
  for (let n = 0; n < 3; n++) {
    const start = Date.now(); const model = await service().get(rendered); times.push(Date.now() - start);
    assert.ok(model?.offer, JSON.stringify(metrics));
    assert.equal(model.offer.products.length, 5);
    assert.ok(model.offer.products.every((p) => p.variants.length <= 3));
  }
  const banner = await service().getBanner(rendered);
  assert.equal(banner?.offerName, "Mua 3 tặng khăn");
  assert.equal(banner?.campaignId, campaignId);
  const bannerMetric = metrics.at(-1) as { event: string; quoteAttempts?: number };
  assert.equal(bannerMetric.event, "recommendation");
  assert.equal(bannerMetric.quoteAttempts, UPSELL_BANNER_MAX_QUOTES, "the compact banner uses exactly six quote attempts");
  const browse = await service().getBrowse(campaignId);
  const browseMetric = metrics.at(-1) as { event: string; quoteAttempts?: number };
  assert.equal(browseMetric.event, "recommendation");
  assert.equal(browseMetric.quoteAttempts, UPSELL_MAX_QUOTES, "the eligible-product browse caps the quote work at 20");
  assert.equal(browse?.offerName, "Mua 3 tặng khăn");
  assert.ok(browse?.products.some((p) => p.slug === `${PREFIX}candidate`));
  assert.deepEqual([...(browse?.products.find((p) => p.slug === `${PREFIX}candidate`)?.options ?? [])].sort(), ["Hồng / M", "Hồng / S"]);
  assert.equal(JSON.stringify(browse).includes(cartId), false);
  assert.equal(await service().getBrowse("nonexistent"), null);
  assert.match(banner?.paidCartKey ?? "", /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(Object.keys(banner ?? {}).sort(), ["campaignId", "offerName", "paidCartKey"], "banner mode must not build or serialize add intents");
  console.info("UP-00 fixture benchmark", { products: 33, maxDiscovered: 10, maxQuotes: 20, durationMs: times });
});

test("TG-04: an add that would lose an existing gift is discarded even when it reaches a tier", async () => {
  // An earned order-subtotal gift at 200k would disappear after a 50% quantity ladder.
  await prisma.giftQuantityCampaign.update({ where: { id: campaignId }, data: { giftTrigger: "ORDER_SUBTOTAL", scopeMode: "GLOBAL_ALL_PAID_LINES", minimumQuantity: null, minimumSubtotalVnd: 200000, subtotalScope: "ALL_PAID_LINES", awardMode: "ONCE", targets: { deleteMany: {} } } });
  await prisma.giftQuantityCampaign.create({ data: { id: `${PREFIX}tier`, name: "Tier", kind: "QUANTITY_TIER", isEnabled: true, enabledAt: new Date(), scopeMode: "DYNAMIC_CATEGORY", tierBasis: "QUANTITY", tierUnit: "PERCENTAGE", tierDiscountedUnits: "ALL_ELIGIBLE_UNITS", targets: { create: [{ productId: candidateProductId, role: "INCLUDE" }, { productId: (await prisma.variantMirror.findUniqueOrThrow({ where: { id: paidId } })).productId, role: "INCLUDE" }] }, tiers: { create: { minQuantity: 3, discountValue: 50 } } } });
  assert.equal((await service().get(await proof()))?.offer ?? null, null);
});
test("TG-05: tied campaigns use ID despite different priorities and display only the winning campaign's products", async () => {
  const second = await product("second", 100000);
  const paid = await prisma.variantMirror.findUniqueOrThrow({ where: { id: paidId } });
  await prisma.giftQuantityCampaign.update({ where: { id: campaignId }, data: { stackPriority: 20 } });
  await prisma.giftQuantityCampaign.create({ data: { id: `${PREFIX}a-winner`, name: "Second", kind: "GIFT_ITEM", isEnabled: true, enabledAt: new Date(), scopeMode: "DYNAMIC_CATEGORY", stackPriority: 30, targets: { create: [paid.productId, second.id].map((productId) => ({ productId, role: "INCLUDE" })) }, giftTrigger: "QUANTITY", minimumQuantity: 3, maxGiftsPerOrder: 1, allowDuplicateGifts: true, giftOptions: { create: { variantId: giftId } } } });
  const model = await offer();
  assert.equal(model.offer!.campaignId, `${PREFIX}a-winner`);
  assert.deepEqual(model.offer!.products.map((p) => p.productId), [second.id]);
});

test("TG-07: variant re-quote is read-only and refuses changed prices before enabling the add", async () => {
  const i = await intent();
  const quote = await service().requote(i); assert.ok(quote.ok);
  assert.equal(quote.variant.variantId, i.variantId);
  assert.equal(await prisma.cartItem.count({ where: { cartId } }), 1);
  await prisma.variantMirror.update({ where: { id: i.variantId }, data: { pancakeRetailPrice: 150000 } });
  assert.equal((await service().requote(i)).ok, false);
});
test("TG-06: a sold-out candidate does not suppress a different valid product", async () => {
  const other = await product("other");
  await prisma.giftQuantityTarget.create({ data: { campaignId, productId: other.id, role: "INCLUDE" } });
  await prisma.warehouseStock.updateMany({ where: { variant: { productId: candidateProductId } }, data: { quantity: 0 } });
  const model = await offer(); assert.deepEqual(model.offer!.products.map((p) => p.productId), [other.id]);
});
test("TG-09: locks remain held through the CartItem write, blocking global publish and stock sync until commit", async () => {
  const i = await intent();
  const paid = await prisma.variantMirror.findUniqueOrThrow({ where: { id: paidId }, select: { productId: true } });
  await prisma.$executeRawUnsafe(`CREATE FUNCTION upsell_test_pause_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."cartId" = '${cartId}' THEN PERFORM pg_sleep(0.8); END IF; RETURN NEW; END; $$`);
  await prisma.$executeRaw`CREATE TRIGGER upsell_test_pause_insert BEFORE INSERT ON "CartItem" FOR EACH ROW EXECUTE FUNCTION upsell_test_pause_insert()`;
  try {
    const add = service().add(i);
    let paused = false;
    for (let n = 0; n < 150; n++) {
      const rows = await prisma.$queryRaw<{ paused: boolean }[]>`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE wait_event = 'PgSleep' AND query LIKE '%INSERT%CartItem%') AS paused`;
      if (rows[0]?.paused) { paused = true; break; }
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok(paused);
    let published = false, synced = false, disabled = 0;
    const publish = prisma.$transaction(async (tx) => { await lockRevision(tx); published = true; await tx.giftQuantityCampaign.create({ data: { id: `${PREFIX}phantom`, kind: "GIFT_ITEM", name: "Published", isEnabled: true, enabledAt: new Date(), scopeMode: "GLOBAL_ALL_PAID_LINES", giftTrigger: "ORDER_SUBTOTAL", minimumSubtotalVnd: 100000, subtotalScope: "ALL_PAID_LINES", awardMode: "ONCE", allowDuplicateGifts: true, giftOptions: { create: { variantId: giftId } } } }); });
    const sync = prisma.$transaction(async (tx) => { await acquireCatalogSyncLock(tx, SHOP); synced = true; await tx.warehouseStock.updateMany({ where: { variantId: i.variantId }, data: { quantity: 0 } }); });
    // Publication-only writers do not take the catalog advisory lock or touch VariantMirror.
    const disable = Promise.all([candidateProductId, paid.productId].map((id) => prisma.productMirror.updateMany({ where: { id }, data: { isActive: false } }).then(() => { disabled++; })));
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(published, false); assert.equal(synced, false); assert.equal(disabled, 0);
    const [result] = await Promise.all([add, publish, sync, disable]); assert.equal(result.ok, true);
    assert.equal(await prisma.cartItem.count({ where: { cartId } }), 2);
  } finally {
    await prisma.$executeRaw`DROP TRIGGER upsell_test_pause_insert ON "CartItem"`;
    await prisma.$executeRaw`DROP FUNCTION upsell_test_pause_insert()`;
  }
});

test("TG-02: an equal-value next rung creates no new benefit and is not advertised", async () => {
  await prisma.giftQuantityCampaign.delete({ where: { id: campaignId } });
  const paid = await prisma.variantMirror.findUniqueOrThrow({ where: { id: paidId } });
  await prisma.giftQuantityCampaign.create({ data: { id: campaignId, name: "Same value", kind: "QUANTITY_TIER", isEnabled: true, enabledAt: new Date(), scopeMode: "DYNAMIC_CATEGORY", tierBasis: "QUANTITY", tierUnit: "PERCENTAGE", tierDiscountedUnits: "ALL_ELIGIBLE_UNITS", targets: { create: [paid.productId, candidateProductId].map((productId) => ({ productId, role: "INCLUDE" })) }, tiers: { create: [{ minQuantity: 2, discountValue: 10 }, { minQuantity: 3, discountValue: 10 }] } } });
  assert.equal((await service().get(await proof()))?.offer ?? null, null);
});
