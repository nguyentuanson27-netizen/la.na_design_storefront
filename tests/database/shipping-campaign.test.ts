import assert from "node:assert/strict";
import test from "node:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../../src/generated/prisma/client.ts";
import { AuthorizationError } from "../../src/auth/authorization.ts";
import { createShippingCampaignAdminService } from "../../src/commerce/shipping-campaign-admin.ts";
import { readShippingQuote } from "../../src/commerce/shipping-campaign-repository.ts";
import { readBenefitCheckoutRender } from "../../src/commerce/benefit-checkout-render.ts";
import { createStorefrontCartRepository } from "../../src/commerce/storefront-cart-repository.ts";
import { buildRenderedCheckoutQuoteFacts } from "../../src/commerce/checkout-quote.ts";
import { issueRenderedQuoteProof, verifyRenderedQuoteProof } from "../../src/commerce/checkout-quote-proof.ts";
import { createGuestCheckoutSnapshotService } from "../../src/commerce/guest-checkout-snapshot.ts";
import { createPancakeOrderSubmissionService } from "../../src/commerce/pancake-order-submit.ts";
import type { PancakeCatalogVariation } from "../../src/integrations/pancake/catalog-contract.ts";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for shipping campaign database tests");
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const shopId = 980_198;
const now = new Date("2026-10-20T12:00:00Z");
const admin = { user: { id: "shipping-admin-test", role: "ADMIN" }, session: { id: "shipping-session-test" } };
const env = { LA_GIFT_QUANTITY_PROMOTIONS_ENABLED: "false", LA_SHIPPING_FEE_VND: "30000", LA_FREE_SHIPPING_SUBTOTAL_VND: "1000000", LA_FREE_SHIPPING_MIN_QUANTITY: "3", LA_FREE_SHIPPING_MIN_SET_QUANTITY: "2" };
const values = { name: "Shipping test campaign", minimumQuantity: 2, priority: 0, stackingEnabled: false,
  startsAt: null, endsAt: null, scope: { mode: "DYNAMIC_CATEGORY" as const, categoryKeys: ["aoDai", "setDo"], includeProductIds: [], excludeProductIds: [] } };
const service = createShippingCampaignAdminService(prisma, shopId);
const secret = "shipping-test-secret-at-least-32-characters-long";
const input = { name: "Shipping Test", phone: "0901234567", provinceRef: "province-01", communeRef: "commune-01", detail: "12 Test Street", note: null, shippingFee: 0, qualifyingSetQuantity: 999 };

async function cleanup() {
  await prisma.orderMirror.deleteMany({ where: { pancakeShopId: shopId } });
  await prisma.cart.deleteMany({ where: { items: { some: { variant: { product: { pancakeShopId: shopId } } } } } });
  await prisma.shippingPromotionCampaign.deleteMany({ where: { pancakeShopId: shopId } });
  await prisma.productMirror.deleteMany({ where: { pancakeShopId: shopId } });
}
async function fixture(quantity = 2) {
  const product = await prisma.productMirror.create({ data: {
    pancakeShopId: shopId, pancakeProductId: "shipping-product", slug: "shipping-db-test", name: "Shipping product", isActive: true, isPresent: true, syncedAt: now,
    variants: { create: { pancakeVariationId: "shipping-variation", color: "Black", size: "M", isPresent: true, isActive: true, pancakeRetailPrice: 450000, pancakeRetailPriceAfterDiscount: 450000, syncedAt: now,
      warehouseStocks: { create: { pancakeWarehouseId: "shipping-warehouse", quantity: 50, syncedAt: now } } } },
  }, include: { variants: true } });
  const variant = product.variants[0]!;
  await prisma.productCategoryMembership.create({ data: { productId: product.id, categoryKey: "aoDaiTet" } });
  const cart = await prisma.cart.create({ data: { expiresAt: new Date("2027-01-01T00:00:00Z"), items: { create: { variantId: variant.id, quantity } } } });
  const items = [{ variantId: variant.id, quantity }];
  return { product, variant, cart, items };
}
async function campaign(endsAt: Date | null = null) {
  const created = await service.create(admin, { ...values, endsAt }, now);
  assert.ok(created.ok);
  assert.equal((await service.get(admin, created.id))?.isEnabled, false);
  assert.ok((await service.setEnabled(admin, created.id, 1, true, now)).ok);
  return created.id;
}
async function quote(f: Awaited<ReturnType<typeof fixture>>, at = now, client = prisma) {
  const lines = await createStorefrontCartRepository(client).getLines({ shopId, items: f.items, now: at });
  const render = await readBenefitCheckoutRender({ client, cartId: f.cart.id, lines, shopId, now: at, env, secret });
  assert.equal(render.kind, "LEGACY", "a shipping-only order does not need gift/tier POS capability");
  assert.ok(render.kind === "LEGACY");
  const facts = buildRenderedCheckoutQuoteFacts(lines, { shippingQuote: render.shippingQuote, shippingPolicy: { feeVnd: 30000 } });
  assert.ok(facts);
  return { lines, facts, shipping: render.shippingQuote, proof: issueRenderedQuoteProof({ quote: facts, cartId: f.cart.id, secret })! };
}
async function snapshot(f: Awaited<ReturnType<typeof fixture>>, proof: string, at = now, client = prisma) {
  return createGuestCheckoutSnapshotService(client, { env, checkoutInputValidated: true,
    verifyRenderedQuote: (currentQuote) => verifyRenderedQuoteProof({ proof, cartId: f.cart.id, currentQuote, secret }),
  }).create({ cartId: f.cart.id, shopId, publicCode: `shipping-${f.cart.id}`, checkoutInput: input, now: at });
}
function variation(): PancakeCatalogVariation {
  return { id: "shipping-variation", productId: "shipping-product", displayId: "shipping-display", barcode: "shipping-barcode", fields: [], imageUrls: [], isHidden: false, isLocked: false,
    retailPrice: 450000, retailPriceAfterDiscount: 450000, product: { id: "shipping-product", name: "Shipping product" },
    warehouseStocks: [{ warehouseId: "shipping-warehouse", remainQuantity: 50 }], sellableStock: 50 };
}

test.before(cleanup);
test.afterEach(cleanup);
test.after(async () => { await cleanup(); await prisma.$disconnect(); });

test("no campaign ignores retired env and browser fee/quantity even on a high-value three-item order", async () => {
  const f = await fixture(3);
  const seen = await quote(f);
  assert.equal(seen.facts.shippingFeeVnd, 30000);
  const draft = await snapshot(f, seen.proof);
  assert.ok(draft.ok);
  assert.equal(draft.order.shippingFeeVnd, BigInt(30000));
  assert.equal(draft.order.totalVnd, BigInt(1380000));
});

test("shipping-only cart/render/proof/draft/Pancake agree with the gift feature OFF, and confirmed history is stable", async () => {
  const f = await fixture();
  const id = await campaign();
  const seen = await quote(f);
  assert.equal(seen.shipping.campaign?.id, id);
  assert.equal(seen.facts.shippingFeeVnd, 0);
  const draft = await snapshot(f, seen.proof);
  assert.ok(draft.ok);
  let creates = 0;
  const submit = createPancakeOrderSubmissionService(prisma, {
    fetchVariations: async () => [variation()],
    resolveTwoLevelAddressNames: async () => ({ provinceName: "Test province", communeName: "Test commune" }),
    createOrder: async (request) => { creates++; assert.equal(request.shipping_fee, 0); return { id: 980198001 }; },
  }, { env, now: () => now });
  const result = await submit.submit({ publicCode: draft.order.publicCode, shopId });
  assert.equal(result.ok, true, JSON.stringify(result));
  const stored = await prisma.orderMirror.findUniqueOrThrow({ where: { id: draft.order.id } });
  assert.equal(stored.shippingBaseFeeVnd, BigInt(30000));
  assert.equal(stored.shippingPromotionCampaignId, id);
  assert.equal(stored.shippingPromotionRevision, 2);
  assert.equal(stored.totalVnd, BigInt(900000));
  await service.setEnabled(admin, id, 2, false, now);
  assert.equal((await submit.submit({ publicCode: draft.order.publicCode, shopId })).ok, true);
  assert.equal(creates, 1, "a confirmed retry cannot create another order or reprice history");
  assert.equal((await prisma.orderMirror.findUniqueOrThrow({ where: { id: stored.id } })).shippingFeeVnd, BigInt(0));
});

test("a campaign threshold edit invalidates the rendered amount before any new draft is written", async () => {
  const f = await fixture();
  const id = await campaign();
  const seen = await quote(f);
  assert.ok((await service.edit(admin, id, 2, { ...values, minimumQuantity: 3 }, now)).ok);
  const result = await snapshot(f, seen.proof);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.reason === "QUOTE_UNPROVEN");
  assert.equal(result.quoteReason, "PRICE_CHANGED");
  assert.equal(result.refreshedQuote?.shippingFeeVnd, 30000);
  assert.equal(await prisma.orderMirror.count({ where: { sourceCartId: f.cart.id } }), 0);
});

test("expiry during the final address read requotes instead of sending an outdated shipping fee", async () => {
  const f = await fixture();
  const end = new Date(now.getTime() + 1000);
  await campaign(end);
  const seen = await quote(f);
  const draft = await snapshot(f, seen.proof);
  assert.ok(draft.ok);
  let clock = now;
  let creates = 0;
  const result = await createPancakeOrderSubmissionService(prisma, {
    fetchVariations: async () => [variation()],
    resolveTwoLevelAddressNames: async () => { clock = end; return { provinceName: "Test province", communeName: "Test commune" }; },
    createOrder: async () => { creates++; return { id: 1 }; },
  }, { env, now: () => clock }).submit({ publicCode: draft.order.publicCode, shopId });
  assert.equal(result.ok, false);
  assert.equal(creates, 0);
  const stored = await prisma.orderMirror.findUniqueOrThrow({ where: { id: draft.order.id } });
  assert.equal(stored.state, "DRAFT");
  assert.equal(stored.shippingFeeVnd, BigInt(30000));
  assert.equal(stored.purchaseOccurredAt, null);
});

test("an unavailable campaign read does not turn into a base-fee quote or a submit-capable order", async () => {
  const f = await fixture();
  await campaign();
  const seen = await quote(f);
  const failing = prisma.$extends({ query: { shippingPromotionCampaign: { async findMany() { throw new Error("simulated campaign outage"); } } } }) as unknown as PrismaClient;
  const render = await readBenefitCheckoutRender({ client: failing, cartId: f.cart.id, lines: seen.lines, shopId, now, env, secret });
  assert.deepEqual(render, { kind: "UNAVAILABLE", reason: "BENEFITS_UNAVAILABLE" });
  const result = await snapshot(f, seen.proof, now, failing);
  assert.deepEqual(result, { ok: false, reason: "BENEFIT_CHECKOUT_UNAVAILABLE" });
  assert.equal(await prisma.orderMirror.count({ where: { sourceCartId: f.cart.id } }), 0);
});

test("real admin writes respect authorization, shop ownership and optimistic revisions", async () => {
  await assert.rejects(service.create(null, values, now), AuthorizationError);
  const id = await campaign();
  const otherShop = createShippingCampaignAdminService(prisma, shopId + 1);
  assert.deepEqual(await otherShop.setEnabled(admin, id, 2, false, now), { ok: false, reason: "NOT_FOUND" });
  const results = await Promise.all([service.edit(admin, id, 2, { ...values, minimumQuantity: 3 }, now), service.edit(admin, id, 2, { ...values, minimumQuantity: 4 }, now)]);
  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.equal(results.filter((result) => !result.ok && result.reason === "STALE_REVISION").length, 1);
  assert.equal((await service.get(admin, id))?.revision, 3);
});

test("an accepted quote holds the shared shipping lock until its transaction completes", async () => {
  const f = await fixture();
  const id = await campaign();
  let release!: () => void;
  let acquired!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  const locked = new Promise<void>((resolve) => { acquired = resolve; });
  const reading = prisma.$transaction(async (tx) => {
    const result = await readShippingQuote({ client: tx, shopId, now, paidItems: f.items, hasOtherPromotions: false, policy: { feeVnd: 30000 } });
    acquired(); await released; return result;
  });
  await locked;
  const writing = service.edit(admin, id, 2, { ...values, minimumQuantity: 3 }, now);
  try {
    assert.equal(await Promise.race([writing.then(() => "finished"), new Promise<string>((resolve) => setTimeout(() => resolve("waiting"), 75))]), "waiting");
  } finally { release(); }
  assert.equal((await reading).feeVnd, 0);
  assert.ok((await writing).ok);
  assert.equal((await quote(f)).facts.shippingFeeVnd, 30000);
});
