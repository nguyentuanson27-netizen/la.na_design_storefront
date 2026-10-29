import assert from "node:assert/strict";
import test from "node:test";

import { PrismaPg } from "@prisma/adapter-pg";

import { buildRenderedCheckoutQuoteFacts } from "../../src/commerce/checkout-quote.ts";
import {
  issueRenderedQuoteProof,
  verifyRenderedQuoteProof,
  type RenderedQuoteProofFacts,
} from "../../src/commerce/checkout-quote-proof.ts";
import { createGuestCheckoutSnapshotService } from "../../src/commerce/guest-checkout-snapshot.ts";
import { createStorefrontCartRepository } from "../../src/commerce/storefront-cart-repository.ts";
import { PrismaClient } from "../../src/generated/prisma/client.ts";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is required for database smoke tests");
}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const shopId = 920_007;
const now = new Date("2026-09-03T05:00:00.000Z");
const prefix = "u21-p9a";
const secret = "u21-p9a-server-secret-at-least-32-characters";

const checkoutInput = {
  name: "Nguyễn Văn A",
  phone: "0901234567",
  provinceRef: "province-01",
  districtRef: "district-001",
  communeRef: "commune-0001",
  detail: "12 Đường A",
  note: null,
};

async function cleanup() {
  await prisma.orderMirror.deleteMany({ where: { publicCode: { startsWith: prefix } } });
  await prisma.cart.deleteMany({
    where: { items: { some: { variant: { pancakeVariationId: { startsWith: prefix } } } } },
  });
  await prisma.promotionCampaign.deleteMany({ where: { name: { startsWith: prefix } } });
  await prisma.productMirror.deleteMany({ where: { pancakeProductId: { startsWith: prefix } } });
}

test.before(cleanup);
test.afterEach(cleanup);
test.after(async () => {
  await cleanup();
  await prisma.$disconnect();
});

async function seedProduct(label: string, retailPriceVnd: number) {
  return prisma.productMirror.create({
    data: {
      pancakeShopId: shopId,
      pancakeProductId: `${prefix}-product-${label}`,
      slug: `${prefix}-${label}`,
      name: `P9A Product ${label}`,
      isPresent: true,
      isActive: true,
      syncedAt: now,
      variants: {
        create: {
          pancakeVariationId: `${prefix}-variation-${label}`,
          color: "Black",
          size: "M",
          isPresent: true,
          isActive: true,
          pancakeRetailPrice: retailPriceVnd,
          pancakeRetailPriceAfterDiscount: retailPriceVnd,
          syncedAt: now,
          warehouseStocks: {
            create: {
              pancakeWarehouseId: `${prefix}-warehouse-${label}`,
              quantity: 10,
              syncedAt: now,
            },
          },
        },
      },
    },
    include: { variants: true },
  });
}

async function seedCart(variantId: string, quantity = 1) {
  return prisma.cart.create({
    data: {
      expiresAt: new Date(now.getTime() + 600_000),
      items: { create: { variantId, quantity } },
    },
  });
}

/** Ends at `+60s`, so moving the clock past it models a sale expiring mid-checkout. */
async function seedExpiringFixedPromotion(variantId: string, fixedPriceVnd: bigint) {
  return prisma.promotionCampaign.create({
    data: {
      kind: "FLASH_SALE",
      name: `${prefix}-flash`,
      discountType: "FIXED_PRICE",
      percentageValue: null,
      fixedPriceVnd,
      startsAt: new Date(now.getTime() - 60_000),
      endsAt: new Date(now.getTime() + 60_000),
      isEnabled: true,
      enabledAt: new Date(now.getTime() - 60_000),
      targets: { create: { variantId } },
    },
  });
}

/**
 * What the checkout page does: resolve the cart through the same repository the render uses and
 * project it into the bounded quote facts the proof is issued over.
 */
async function renderQuote(cartId: string, at: Date): Promise<RenderedQuoteProofFacts> {
  const items = await prisma.cartItem.findMany({
    where: { cartId },
    select: { variantId: true, quantity: true },
  });
  const lines = await createStorefrontCartRepository(prisma).getLines({ shopId, items, now: at });
  const quote = buildRenderedCheckoutQuoteFacts(lines);
  assert.ok(quote, "render must be able to quote this cart");
  return quote;
}

function snapshotService(proof: unknown, cartId: string) {
  return createGuestCheckoutSnapshotService(prisma, {
    checkoutInputValidated: true,
    verifyRenderedQuote: (currentQuote) =>
      verifyRenderedQuoteProof({ proof, cartId, currentQuote, secret }),
  });
}

test("P9a a proof over the rendered quote lets an unchanged submission through", async () => {
  const product = await seedProduct("steady", 500_000);
  const cart = await seedCart(product.variants[0]!.id);
  const publicCode = `${prefix}-steady-order`;

  const quote = await renderQuote(cart.id, now);
  const proof = issueRenderedQuoteProof({ quote, cartId: cart.id, secret });

  const result = await snapshotService(proof, cart.id).create({
    cartId: cart.id,
    shopId,
    publicCode,
    checkoutInput,
    now,
  });

  assert.equal(result.ok, true);
  const persisted = await prisma.orderMirror.findUniqueOrThrow({
    where: { publicCode },
    include: { lines: true },
  });
  assert.equal(persisted.state, "DRAFT");
  assert.equal(persisted.lines[0]!.unitPriceVnd, BigInt(500_000));
});

test("P9a buyer saw 400k, the sale ends, and the first submit refuses at 500k with a fresh proof", async () => {
  const product = await seedProduct("flash", 500_000);
  const variant = product.variants[0]!;
  await seedExpiringFixedPromotion(variant.id, BigInt(400_000));
  const cart = await seedCart(variant.id);
  const publicCode = `${prefix}-flash-order`;

  // Rendered while the flash sale is live.
  const seenQuote = await renderQuote(cart.id, now);
  assert.equal(seenQuote.items[0]!.unitPriceVnd, 400_000);
  const seenProof = issueRenderedQuoteProof({ quote: seenQuote, cartId: cart.id, secret });

  // Submitted after it ended. The proof is genuine and correctly bound — it is simply stale.
  const afterSale = new Date(now.getTime() + 120_000);
  const refused = await snapshotService(seenProof, cart.id).create({
    cartId: cart.id,
    shopId,
    publicCode,
    checkoutInput,
    now: afterSale,
  });

  assert.equal(refused.ok, false);
  if (refused.ok) return;
  assert.equal(refused.reason, "QUOTE_UNPROVEN");
  if (refused.reason !== "QUOTE_UNPROVEN") return;
  assert.equal(refused.quoteReason, "PRICE_CHANGED");
  assert.equal(refused.refreshedQuote.items[0]!.unitPriceVnd, 500_000);

  assert.equal(
    await prisma.orderMirror.count({ where: { sourceCartId: cart.id } }),
    0,
    "an unproven price must leave no order behind at all, submit-capable or otherwise",
  );

  // The explicit second submission, carrying the proof issued for the price just shown, succeeds.
  const freshProof = issueRenderedQuoteProof({
    quote: refused.refreshedQuote,
    cartId: cart.id,
    secret,
  });
  const accepted = await snapshotService(freshProof, cart.id).create({
    cartId: cart.id,
    shopId,
    publicCode,
    checkoutInput,
    now: afterSale,
  });

  assert.equal(accepted.ok, true);
  if (!accepted.ok) return;
  assert.equal(accepted.order.totalVnd, BigInt(refused.refreshedQuote.totalVnd));
  const persisted = await prisma.orderMirror.findUniqueOrThrow({
    where: { publicCode },
    include: { lines: true },
  });
  assert.equal(persisted.lines[0]!.unitPriceVnd, BigInt(500_000));
});

test("P9a a client that re-quotes itself at the current price still cannot bypass reconfirmation", async () => {
  const product = await seedProduct("tamper", 500_000);
  const variant = product.variants[0]!;
  await seedExpiringFixedPromotion(variant.id, BigInt(400_000));
  const cart = await seedCart(variant.id);
  const afterSale = new Date(now.getTime() + 120_000);

  const staleProof = issueRenderedQuoteProof({
    quote: await renderQuote(cart.id, now),
    cartId: cart.id,
    secret,
  });
  // The current, correct quote — but the client cannot mint a proof for it.
  const currentQuote = await renderQuote(cart.id, afterSale);
  assert.equal(currentQuote.items[0]!.unitPriceVnd, 500_000);

  const forgedCandidates: Array<[string, unknown]> = [
    ["stale but genuine", staleProof],
    ["self-minted under a guessed secret", issueRenderedQuoteProof({
      quote: currentQuote,
      cartId: cart.id,
      secret: "attacker-guessed-secret-at-least-32-characters",
    })],
    ["bound to a cart the client does not hold", issueRenderedQuoteProof({
      quote: currentQuote,
      cartId: "11111111-2222-4333-8444-555555555555",
      secret,
    })],
    ["absent entirely", null],
    ["a plausible-looking string", "cGF5bG9hZA.bWFj"],
  ];

  for (const [label, proof] of forgedCandidates) {
    const result = await snapshotService(proof, cart.id).create({
      cartId: cart.id,
      shopId,
      publicCode: `${prefix}-tamper-order`,
      checkoutInput,
      now: afterSale,
    });
    assert.equal(result.ok, false, `${label} must not authorise a DRAFT`);
    if (result.ok) return;
    assert.equal(result.reason, "QUOTE_UNPROVEN", label);
    assert.equal(
      await prisma.orderMirror.count({ where: { sourceCartId: cart.id } }),
      0,
      `${label} must leave no order behind`,
    );
  }

  // Only the server-issued proof for the current quote works.
  const honest = await snapshotService(
    issueRenderedQuoteProof({ quote: currentQuote, cartId: cart.id, secret }),
    cart.id,
  ).create({
    cartId: cart.id,
    shopId,
    publicCode: `${prefix}-tamper-order`,
    checkoutInput,
    now: afterSale,
  });
  assert.equal(honest.ok, true);
});

test("P9a re-submitting the same proof cannot get through before a refreshed render issues a new one", async () => {
  // The buyer clicks submit again immediately, before the refreshed order summary has installed the
  // proof for the quote it now shows. The only token the browser holds is still the one the current
  // render issued, so every such click has to fail closed — otherwise a fast second click would
  // confirm line facts (here a quantity, which the warning's total alone does not reveal) that the
  // buyer has not actually seen.
  const product = await seedProduct("double-click", 500_000);
  const variant = product.variants[0]!;
  const cart = await seedCart(variant.id, 1);
  const publicCode = `${prefix}-double-click-order`;

  const renderedProof = issueRenderedQuoteProof({
    quote: await renderQuote(cart.id, now),
    cartId: cart.id,
    secret,
  });
  assert.ok(renderedProof);

  await prisma.cartItem.update({
    where: { cartId_variantId: { cartId: cart.id, variantId: variant.id } },
    data: { quantity: 4 },
  });

  for (const attempt of [1, 2, 3]) {
    const result = await snapshotService(renderedProof, cart.id).create({
      cartId: cart.id,
      shopId,
      publicCode,
      checkoutInput,
      now,
    });
    assert.equal(result.ok, false, `attempt ${attempt} must not authorise a DRAFT`);
    if (result.ok || result.reason !== "QUOTE_UNPROVEN") return;
    assert.equal(result.quoteReason, "PRICE_CHANGED");
    assert.equal(result.refreshedQuote.totalQuantity, 4);
    assert.equal(
      await prisma.orderMirror.count({ where: { sourceCartId: cart.id } }),
      0,
      `attempt ${attempt} must leave no order behind`,
    );
  }

  // Only a proof issued over the quote as it now stands — what a refreshed render would hand over —
  // lets the buyer through.
  const refreshedRenderProof = issueRenderedQuoteProof({
    quote: await renderQuote(cart.id, now),
    cartId: cart.id,
    secret,
  });
  assert.ok(refreshedRenderProof);
  assert.notEqual(refreshedRenderProof, renderedProof);

  const accepted = await snapshotService(refreshedRenderProof, cart.id).create({
    cartId: cart.id,
    shopId,
    publicCode,
    checkoutInput,
    now,
  });
  assert.equal(accepted.ok, true);
  const persisted = await prisma.orderMirror.findUniqueOrThrow({
    where: { publicCode },
    include: { lines: true },
  });
  assert.equal(persisted.lines[0]!.quantity, 4);
});

test("P9a render and submit persist no proof state of any kind", async () => {
  const product = await seedProduct("stateless", 500_000);
  const cart = await seedCart(product.variants[0]!.id);

  const proofModels = Object.keys(prisma).filter(
    (key) => !key.startsWith("$") && !key.startsWith("_") && /proof|nonce/i.test(key),
  );
  assert.deepEqual(proofModels, [], "the schema must carry no quote-proof or nonce model");

  const quote = await renderQuote(cart.id, now);
  const proof = issueRenderedQuoteProof({ quote, cartId: cart.id, secret });
  // Issuing is pure: repeating it writes nothing and yields the same bytes.
  assert.equal(issueRenderedQuoteProof({ quote, cartId: cart.id, secret }), proof);

  const before = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*)::bigint AS count FROM "OrderMirror"
  `;
  assert.deepEqual(
    verifyRenderedQuoteProof({ proof, cartId: cart.id, currentQuote: quote, secret }),
    { ok: true },
  );
  const after = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT COUNT(*)::bigint AS count FROM "OrderMirror"
  `;
  assert.equal(after[0]!.count, before[0]!.count, "verification must write nothing");
});

test("P9a a quantity change the buyer did not see is refused like a price change", async () => {
  const product = await seedProduct("quantity", 500_000);
  const variant = product.variants[0]!;
  const cart = await seedCart(variant.id, 1);

  const proof = issueRenderedQuoteProof({
    quote: await renderQuote(cart.id, now),
    cartId: cart.id,
    secret,
  });

  await prisma.cartItem.update({
    where: { cartId_variantId: { cartId: cart.id, variantId: variant.id } },
    data: { quantity: 3 },
  });

  const result = await snapshotService(proof, cart.id).create({
    cartId: cart.id,
    shopId,
    publicCode: `${prefix}-quantity-order`,
    checkoutInput,
    now,
  });

  assert.equal(result.ok, false);
  if (result.ok || result.reason !== "QUOTE_UNPROVEN") return;
  assert.equal(result.quoteReason, "PRICE_CHANGED");
  assert.equal(result.refreshedQuote.totalQuantity, 3);
  assert.equal(await prisma.orderMirror.count({ where: { sourceCartId: cart.id } }), 0);
});


test("list-basis rollback re-quotes 562000 to 590000 after disable; a direct OFF would be 442500", async () => {
 process.env.LIST_PRICE_DISPLAY="true";process.env.LIST_PRICE_CAMPAIGN_BASIS="true";
 try {
  const product=await seedProduct("list-rollback",590000), cart=await seedCart(product.variants[0]!.id);
  const campaign=await prisma.promotionCampaign.create({data:{kind:"PROMOTION",name:prefix+"-list-rollback",discountType:"PERCENTAGE",percentageValue:25,isEnabled:true,enabledAt:now,targets:{create:{variantId:product.variants[0]!.id}}}});
  const seen=await renderQuote(cart.id,now);assert.equal(seen.items[0]!.unitPriceVnd,562000);
  const proof=issueRenderedQuoteProof({quote:seen,cartId:cart.id,secret});
  process.env.LIST_PRICE_CAMPAIGN_BASIS="false";
  assert.equal((await renderQuote(cart.id,now)).items[0]!.unitPriceVnd,442500);
  process.env.LIST_PRICE_CAMPAIGN_BASIS="true";
  const { disablePromotionCampaign }=await import("../../src/commerce/promotion-activation-service.ts");
  assert.ok((await disablePromotionCampaign({campaignId:campaign.id,session:{user:{id:"test-admin",role:"ADMIN"},session:{id:"test"}},now,client:prisma})).ok);
  process.env.LIST_PRICE_CAMPAIGN_BASIS="false";
  const result=await snapshotService(proof,cart.id).create({cartId:cart.id,shopId,publicCode:prefix+"-list-rollback-order",checkoutInput,now});
  assert.ok(!result.ok);assert.equal(result.reason,"QUOTE_UNPROVEN");
  if(result.reason!=="QUOTE_UNPROVEN")return;
  assert.equal(result.quoteReason,"PRICE_CHANGED");assert.equal(result.refreshedQuote.items[0]!.unitPriceVnd,590000);
  const fresh=issueRenderedQuoteProof({quote:result.refreshedQuote,cartId:cart.id,secret});
  assert.ok((await snapshotService(fresh,cart.id).create({cartId:cart.id,shopId,publicCode:prefix+"-list-rollback-order",checkoutInput,now})).ok);
 } finally {delete process.env.LIST_PRICE_DISPLAY;delete process.env.LIST_PRICE_CAMPAIGN_BASIS;}
});
