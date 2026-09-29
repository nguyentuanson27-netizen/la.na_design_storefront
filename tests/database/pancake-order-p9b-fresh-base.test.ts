import assert from "node:assert/strict";
import test from "node:test";

import { PrismaPg } from "@prisma/adapter-pg";

import { createGuestCheckoutSnapshotService } from "../../src/commerce/guest-checkout-snapshot.ts";
import { createPancakeOrderSubmissionService } from "../../src/commerce/pancake-order-submit.ts";
import { acceptAnyRenderedQuote } from "../fixtures/rendered-quote-authority.ts";
import { PrismaClient } from "../../src/generated/prisma/client.ts";
import type { PancakeCatalogVariation } from "../../src/integrations/pancake/catalog-contract.ts";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for database smoke tests");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
const shopId = 920_007;
const now = new Date("2026-09-04T03:00:00.000Z");
const prefix = "u22-p9b";

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

function liveVariation(
  id: string,
  productId: string,
  retailPrice: number,
  retailPriceAfterDiscount = retailPrice,
): PancakeCatalogVariation {
  return {
    id,
    productId,
    displayId: `${id}-display`,
    barcode: `${id}-barcode`,
    fields: [],
    imageUrls: [],
    isHidden: false,
    isLocked: false,
    retailPrice,
    retailPriceAfterDiscount,
    product: { id: productId, name: productId },
    warehouseStocks: [{ warehouseId: `${id}-warehouse`, remainQuantity: 9 }],
    sellableStock: 9,
  };
}

async function seedVariant(label: string, mirroredBaseVnd: number) {
  const product = await prisma.productMirror.create({
    data: {
      pancakeShopId: shopId,
      pancakeProductId: `${prefix}-product-${label}`,
      slug: `${prefix}-${label}`,
      name: `P9B ${label}`,
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
          pancakeRetailPrice: mirroredBaseVnd,
          pancakeRetailPriceAfterDiscount: mirroredBaseVnd,
          syncedAt: now,
          warehouseStocks: {
            create: { pancakeWarehouseId: `${prefix}-wh-${label}`, quantity: 9, syncedAt: now },
          },
        },
      },
    },
    include: { variants: true },
  });
  return { product, variant: product.variants[0]! };
}

async function seedCampaign(
  variantId: string,
  campaign: (
    | { discountType: "PERCENTAGE"; percentageValue: number }
    | { discountType: "FIXED_PRICE"; fixedPriceVnd: bigint }
  ) & {
    /**
     * The activity window, defaulting to one already open at `now`.
     *
     * Overridable because a campaign that is always active cannot exercise its own boundaries: the
     * plan requires start and end transitions *during* checkout, which only exist when the window
     * edge falls between the instant the buyer's quote was rendered and the instant submission
     * revalidates it.
     */
    startsAt?: Date;
    endsAt?: Date;
  },
) {
  const startsAt = campaign.startsAt ?? new Date(now.getTime() - 60_000);
  return prisma.promotionCampaign.create({
    data: {
      kind: "PROMOTION",
      name: `${prefix}-${campaign.discountType}`,
      discountType: campaign.discountType,
      percentageValue: "percentageValue" in campaign ? campaign.percentageValue : null,
      fixedPriceVnd: "fixedPriceVnd" in campaign ? campaign.fixedPriceVnd : null,
      startsAt,
      endsAt: campaign.endsAt ?? new Date(now.getTime() + 600_000),
      isEnabled: true,
      enabledAt: startsAt,
      targets: { create: { variantId } },
    },
  });
}

async function createDraft(variantId: string, publicCode: string) {
  const cart = await prisma.cart.create({
    data: {
      expiresAt: new Date(now.getTime() + 600_000),
      items: { create: { variantId, quantity: 1 } },
    },
  });
  const result = await createGuestCheckoutSnapshotService(prisma, {
    checkoutInputValidated: true,
    verifyRenderedQuote: acceptAnyRenderedQuote,
  }).create({ cartId: cart.id, shopId, publicCode, checkoutInput, now });
  assert.equal(result.ok, true, "the DRAFT must be snapshotted before submission");
  return cart;
}

/** A gateway whose catalog reports `freshBaseVnd`, counting any create-order attempt. */
function gatewayWithFreshBase(variationId: string, productId: string, freshBaseVnd: number) {
  const created: unknown[] = [];
  return {
    created,
    gateway: {
      async fetchVariations() {
        return [liveVariation(variationId, productId, freshBaseVnd)];
      },
      async createOrder(request: unknown) {
        created.push(request);
        return { id: 900_001 };
      },
    },
  };
}

function submissionService(
  gateway: Parameters<typeof createPancakeOrderSubmissionService>[1],
  submittedAt: Date = now,
  client: PrismaClient = prisma,
) {
  return createPancakeOrderSubmissionService(client, gateway, { now: () => submittedAt });
}

test("P9b a promoted DRAFT is compared against the fresh effective quote, not raw Pancake retail", async () => {
  // The whole point of the unit. Mirror base 500k with a 20% campaign gives a DRAFT at 400k. The
  // fresh Pancake base is unchanged at 500k, so nothing has actually drifted — but a comparison
  // against raw retail would see 400k != 500k and refuse a correctly priced order.
  const { product, variant } = await seedVariant("effective", 500_000);
  await seedCampaign(variant.id, { discountType: "PERCENTAGE", percentageValue: 20 });
  const publicCode = `${prefix}-effective-order`;
  await createDraft(variant.id, publicCode);

  const draft = await prisma.orderMirror.findUniqueOrThrow({
    where: { publicCode },
    include: { lines: true },
  });
  assert.equal(draft.lines[0]!.unitPriceVnd, BigInt(400_000));

  const { created, gateway } = gatewayWithFreshBase(
    variant.pancakeVariationId,
    product.pancakeProductId,
    500_000,
  );
  const result = await submissionService(gateway).submit({ publicCode, shopId });

  assert.equal(result.ok, true, "an unchanged effective quote must not be refused");
  assert.equal(created.length, 1, "the order must reach Pancake exactly once");
});

test("P9b a fresher base recalculates a percentage campaign and reprices the DRAFT", async () => {
  const { product, variant } = await seedVariant("percentage", 500_000);
  await seedCampaign(variant.id, { discountType: "PERCENTAGE", percentageValue: 20 });
  const publicCode = `${prefix}-percentage-order`;
  await createDraft(variant.id, publicCode);

  // Pancake now reports 600k. The campaign still applies, so the fresh effective price is 480k.
  const { created, gateway } = gatewayWithFreshBase(
    variant.pancakeVariationId,
    product.pancakeProductId,
    600_000,
  );
  const result = await submissionService(gateway).submit({ publicCode, shopId });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.state, "DRAFT");
  assert.equal(result.reason, "PRICE_CHANGED");
  assert.equal(created.length, 0, "a drifted price must never reach Pancake");

  const repriced = await prisma.orderMirror.findUniqueOrThrow({
    where: { publicCode },
    include: { lines: true },
  });
  assert.equal(repriced.state, "DRAFT", "the order stays reconfirmable, never terminally rejected");
  assert.equal(repriced.syncErrorCode, "PRICE_CHANGED");
  assert.equal(repriced.lines.length, 1);
  assert.equal(repriced.lines[0]!.unitPriceVnd, BigInt(480_000), "20% off the fresher 600k base");
  assert.equal(repriced.lines[0]!.baseUnitPriceVnd, BigInt(600_000));
  assert.equal(repriced.lines[0]!.lineTotalVnd, BigInt(480_000));
  assert.equal(repriced.merchandiseSubtotalVnd, BigInt(480_000));
  assert.equal(
    repriced.totalVnd,
    BigInt(480_000) + repriced.shippingFeeVnd!,
    "totals are refreshed together with the line, never left disagreeing",
  );
});

test("P9b a fixed-price campaign is revalidated against the fresher base, not blindly kept", async () => {
  // FIXED_PRICE stays the configured final price only while it is actually a discount. A fresher
  // base below it means the campaign no longer discounts anything, and the buyer should get the
  // cheaper base rather than the now-higher configured price.
  const { product, variant } = await seedVariant("fixed", 500_000);
  await seedCampaign(variant.id, { discountType: "FIXED_PRICE", fixedPriceVnd: BigInt(400_000) });
  const publicCode = `${prefix}-fixed-order`;
  await createDraft(variant.id, publicCode);

  const draft = await prisma.orderMirror.findUniqueOrThrow({
    where: { publicCode },
    include: { lines: true },
  });
  assert.equal(draft.lines[0]!.unitPriceVnd, BigInt(400_000));

  const { created, gateway } = gatewayWithFreshBase(
    variant.pancakeVariationId,
    product.pancakeProductId,
    350_000,
  );
  const result = await submissionService(gateway).submit({ publicCode, shopId });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.state, "DRAFT");
  assert.equal(result.reason, "PRICE_CHANGED");
  assert.equal(created.length, 0);

  const repriced = await prisma.orderMirror.findUniqueOrThrow({
    where: { publicCode },
    include: { lines: true },
  });
  assert.equal(repriced.lines[0]!.unitPriceVnd, BigInt(350_000));
  assert.equal(repriced.lines[0]!.baseUnitPriceVnd, BigInt(350_000));
  assert.equal(
    repriced.lines[0]!.promotionCampaignId,
    null,
    "a campaign that no longer discounts must not be recorded as one",
  );
});

test("P9b the fresher base is written back, so reconfirming terminates instead of looping", async () => {
  // Without this, the mirror still says 500k: the buyer reconfirms, the snapshot re-derives 500k
  // from stale mirror data, submission finds 600k again, and the handshake never ends.
  const { product, variant } = await seedVariant("loop", 500_000);
  const publicCode = `${prefix}-loop-order`;
  const cart = await createDraft(variant.id, publicCode);

  const first = gatewayWithFreshBase(
    variant.pancakeVariationId,
    product.pancakeProductId,
    600_000,
  );
  const refused = await submissionService(first.gateway).submit({ publicCode, shopId });
  assert.equal(refused.ok, false);
  if (refused.ok) return;
  assert.equal(refused.reason, "PRICE_CHANGED");

  const mirrored = await prisma.variantMirror.findUniqueOrThrow({ where: { id: variant.id } });
  assert.equal(
    mirrored.pancakeRetailPrice,
    600_000,
    "checkout observed a fresher trusted base and must record it as the latest",
  );
  assert.equal(
    mirrored.pancakeRetailPriceAfterDiscount,
    600_000,
    "the after-discount column carries what Pancake reported, never a copy of the base",
  );

  // The buyer reconfirms: the snapshot now re-derives the same 600k the submission will check.
  const resnapshot = await createGuestCheckoutSnapshotService(prisma, {
    checkoutInputValidated: true,
    verifyRenderedQuote: acceptAnyRenderedQuote,
  }).create({ cartId: cart.id, shopId, publicCode, checkoutInput, now });
  assert.equal(resnapshot.ok, true);

  const second = gatewayWithFreshBase(
    variant.pancakeVariationId,
    product.pancakeProductId,
    600_000,
  );
  const result = await submissionService(second.gateway).submit({ publicCode, shopId });
  assert.equal(result.ok, true, "the second, explicit confirmation must succeed");
  assert.equal(second.created.length, 1);
});

test("P9b the write-back records Pancake's own after-discount, not a copy of the base", async () => {
  // The central resolver ignores this column, but the Merchant identity audit and the default
  // equality-gated price rule read it. Writing the base into it would hand them an observation no
  // upstream ever sent.
  const { product, variant } = await seedVariant("afterdiscount", 500_000);
  const publicCode = `${prefix}-afterdiscount-order`;
  await createDraft(variant.id, publicCode);

  const created: unknown[] = [];
  const result = await submissionService({
    async fetchVariations() {
      return [liveVariation(variant.pancakeVariationId, product.pancakeProductId, 600_000, 550_000)];
    },
    async createOrder(request: unknown) {
      created.push(request);
      return { id: 900_002 };
    },
  }).submit({ publicCode, shopId });

  assert.equal(result.ok, false);
  assert.equal(created.length, 0);

  const mirrored = await prisma.variantMirror.findUniqueOrThrow({ where: { id: variant.id } });
  assert.equal(mirrored.pancakeRetailPrice, 600_000);
  assert.equal(mirrored.pancakeRetailPriceAfterDiscount, 550_000);
});

test("P9b an unusable fresher base fails closed without repricing to nonsense", async () => {
  const { product, variant } = await seedVariant("invalid", 500_000);
  const publicCode = `${prefix}-invalid-order`;
  await createDraft(variant.id, publicCode);

  const { created, gateway } = gatewayWithFreshBase(
    variant.pancakeVariationId,
    product.pancakeProductId,
    0,
  );
  const result = await submissionService(gateway).submit({ publicCode, shopId });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.reason, "PRICE_UNAVAILABLE");
  assert.equal(created.length, 0);

  const after = await prisma.orderMirror.findUniqueOrThrow({
    where: { publicCode },
    include: { lines: true },
  });
  assert.equal(
    after.lines[0]!.unitPriceVnd,
    BigInt(500_000),
    "an unusable base must leave the confirmed line untouched",
  );
});

test("P9b repeated upstream drift repeats the handshake rather than sticking", async () => {
  const { product, variant } = await seedVariant("repeat", 500_000);
  const publicCode = `${prefix}-repeat-order`;
  const cart = await createDraft(variant.id, publicCode);

  for (const freshBase of [600_000, 700_000]) {
    const drift = gatewayWithFreshBase(
      variant.pancakeVariationId,
      product.pancakeProductId,
      freshBase,
    );
    const refusal = await submissionService(drift.gateway).submit({ publicCode, shopId });
    assert.equal(refusal.ok, false, `drift to ${freshBase} must reconfirm again`);
    if (refusal.ok) return;
    assert.equal(refusal.reason, "PRICE_CHANGED");
    assert.equal(drift.created.length, 0);

    const repriced = await prisma.orderMirror.findUniqueOrThrow({
      where: { publicCode },
      include: { lines: true },
    });
    assert.equal(repriced.lines[0]!.unitPriceVnd, BigInt(freshBase));

    const resnapshot = await createGuestCheckoutSnapshotService(prisma, {
      checkoutInputValidated: true,
      verifyRenderedQuote: acceptAnyRenderedQuote,
    }).create({ cartId: cart.id, shopId, publicCode, checkoutInput, now });
    assert.equal(resnapshot.ok, true);
  }

  const settled = gatewayWithFreshBase(
    variant.pancakeVariationId,
    product.pancakeProductId,
    700_000,
  );
  assert.equal((await submissionService(settled.gateway).submit({ publicCode, shopId })).ok, true);
  assert.equal(settled.created.length, 1);
});

test("P9b a campaign starting mid-checkout reprices, while the same quote before the start does not", async () => {
  // A start boundary crossed between render and submission. The Pancake base is pinned at 500k in
  // both legs and the campaign fixture is identical, so the *only* variable is which side of
  // `startsAt` the submission instant falls on. That is what makes this a boundary test rather than
  // a price test: an implementation that ignored the window, or one that read no campaigns at all,
  // cannot produce both legs.
  const { product, variant } = await seedVariant("starts", 500_000);
  await seedCampaign(variant.id, {
    discountType: "PERCENTAGE",
    percentageValue: 20,
    startsAt: new Date(now.getTime() + 120_000),
    endsAt: new Date(now.getTime() + 900_000),
  });

  const beforeCode = `${prefix}-starts-before-order`;
  await createDraft(variant.id, beforeCode);
  const draft = await prisma.orderMirror.findUniqueOrThrow({
    where: { publicCode: beforeCode },
    include: { lines: true },
  });
  assert.equal(
    draft.lines[0]!.unitPriceVnd,
    BigInt(500_000),
    "the campaign had not started when the quote was rendered",
  );

  const before = gatewayWithFreshBase(
    variant.pancakeVariationId,
    product.pancakeProductId,
    500_000,
  );
  const beforeResult = await submissionService(
    before.gateway,
    new Date(now.getTime() + 60_000),
  ).submit({ publicCode: beforeCode, shopId });
  assert.equal(beforeResult.ok, true, "submitting while the sale is still pending must not drift");
  assert.equal(before.created.length, 1);

  const afterCode = `${prefix}-starts-after-order`;
  await createDraft(variant.id, afterCode);
  const after = gatewayWithFreshBase(variant.pancakeVariationId, product.pancakeProductId, 500_000);
  const result = await submissionService(after.gateway, new Date(now.getTime() + 300_000)).submit({
    publicCode: afterCode,
    shopId,
  });

  assert.equal(result.ok, false, "once the sale opens, the rendered quote is stale");
  if (result.ok) return;
  assert.equal(result.state, "DRAFT");
  assert.equal(result.reason, "PRICE_CHANGED");
  assert.equal(after.created.length, 0, "a quote the buyer has not agreed to must never reach Pancake");
  assert.ok("repricedQuote" in result, "a repriced DRAFT must carry the refreshed money");
  assert.equal(
    result.repricedQuote.merchandiseSubtotalVnd,
    400_000,
    "the buyer is offered the now-live sale price",
  );

  const repriced = await prisma.orderMirror.findUniqueOrThrow({
    where: { publicCode: afterCode },
    include: { lines: true },
  });
  assert.equal(repriced.state, "DRAFT");
  assert.equal(repriced.syncErrorCode, "PRICE_CHANGED");
  assert.equal(repriced.lines[0]!.unitPriceVnd, BigInt(400_000));
  assert.equal(repriced.lines[0]!.baseUnitPriceVnd, BigInt(500_000));
  assert.equal(repriced.merchandiseSubtotalVnd, BigInt(400_000));
  assert.equal(repriced.totalVnd, BigInt(400_000) + repriced.shippingFeeVnd!);
});

test("P9b a campaign ending mid-checkout reprices, while the same quote inside the window does not", async () => {
  // The end boundary, and the leg that costs real money if it is wrong: a buyer who rendered at the
  // sale price must not be sold at that price after the sale closes. Same fixture, same 500k base,
  // same rendered 400k DRAFT in both legs — only the submission instant moves across `endsAt`. The
  // window is half-open, so a submission exactly at `endsAt` is already outside it.
  const { product, variant } = await seedVariant("ends", 500_000);
  const endsAt = new Date(now.getTime() + 120_000);
  await seedCampaign(variant.id, {
    discountType: "PERCENTAGE",
    percentageValue: 20,
    startsAt: new Date(now.getTime() - 60_000),
    endsAt,
  });

  const insideCode = `${prefix}-ends-inside-order`;
  await createDraft(variant.id, insideCode);
  const draft = await prisma.orderMirror.findUniqueOrThrow({
    where: { publicCode: insideCode },
    include: { lines: true },
  });
  assert.equal(
    draft.lines[0]!.unitPriceVnd,
    BigInt(400_000),
    "the campaign was live when the quote was rendered",
  );

  const inside = gatewayWithFreshBase(variant.pancakeVariationId, product.pancakeProductId, 500_000);
  const insideResult = await submissionService(
    inside.gateway,
    new Date(now.getTime() + 60_000),
  ).submit({ publicCode: insideCode, shopId });
  assert.equal(insideResult.ok, true, "submitting inside the window honours the sale price");
  assert.equal(inside.created.length, 1);

  const afterCode = `${prefix}-ends-after-order`;
  await createDraft(variant.id, afterCode);
  const after = gatewayWithFreshBase(variant.pancakeVariationId, product.pancakeProductId, 500_000);
  const result = await submissionService(after.gateway, endsAt).submit({
    publicCode: afterCode,
    shopId,
  });

  assert.equal(result.ok, false, "an expired sale price is stale, not submittable");
  if (result.ok) return;
  assert.equal(result.state, "DRAFT");
  assert.equal(result.reason, "PRICE_CHANGED");
  assert.equal(after.created.length, 0, "an expired sale price must never reach Pancake");
  assert.ok("repricedQuote" in result, "a repriced DRAFT must carry the refreshed money");
  assert.equal(
    result.repricedQuote.merchandiseSubtotalVnd,
    500_000,
    "the buyer is asked to confirm the base the ended campaign no longer discounts",
  );

  const repriced = await prisma.orderMirror.findUniqueOrThrow({
    where: { publicCode: afterCode },
    include: { lines: true },
  });
  assert.equal(repriced.state, "DRAFT");
  assert.equal(repriced.syncErrorCode, "PRICE_CHANGED");
  assert.equal(repriced.lines[0]!.unitPriceVnd, BigInt(500_000));
  assert.equal(repriced.lines[0]!.baseUnitPriceVnd, BigInt(500_000));
  assert.equal(repriced.merchandiseSubtotalVnd, BigInt(500_000));
  assert.equal(repriced.totalVnd, BigInt(500_000) + repriced.shippingFeeVnd!);
});

test("P9b a campaign that ends while the live Pancake read is in flight is priced as ended", async () => {
  // The promotion instant belongs *after* the live read: a sale that closes while Pancake is still
  // answering must not be honoured on the strength of a clock read before the request went out.
  const { product, variant } = await seedVariant("ends-in-flight", 500_000);
  const endsAt = new Date(now.getTime() + 120_000);
  await seedCampaign(variant.id, {
    discountType: "PERCENTAGE",
    percentageValue: 20,
    startsAt: new Date(now.getTime() - 60_000),
    endsAt,
  });
  const publicCode = `${prefix}-ends-in-flight-order`;
  await createDraft(variant.id, publicCode);

  // Inside the window when submission starts; the sale ends during the live read.
  let clock = new Date(endsAt.getTime() - 100);
  const created: unknown[] = [];
  const service = createPancakeOrderSubmissionService(
    prisma,
    {
      async fetchVariations() {
        clock = new Date(endsAt.getTime() + 300);
        return [liveVariation(variant.pancakeVariationId, product.pancakeProductId, 500_000)];
      },
      async createOrder(request: unknown) {
        created.push(request);
        return { id: 900_002 };
      },
    },
    { now: () => clock },
  );

  const result = await service.submit({ publicCode, shopId });

  assert.equal(result.ok, false, "a sale that ended mid-read is not honoured");
  if (result.ok) return;
  assert.equal(result.state, "DRAFT");
  assert.equal(result.reason, "PRICE_CHANGED");
  assert.equal(created.length, 0, "the expired sale price never reaches Pancake");
  assert.ok("repricedQuote" in result);
  assert.equal(result.repricedQuote.merchandiseSubtotalVnd, 500_000);
});

test("P9b a promotion-candidate read failure returns the order to retryable DRAFT, not a stranded claim", async () => {
  // The claim has already moved the row to VALIDATING, but nothing has been sent to Pancake yet, so
  // a transient database failure here is exactly as recoverable as the fresh-catalog read failure
  // beside it. Left unguarded it escapes with the row still VALIDATING, and the recovery sweep later
  // converts that to a terminal REJECTED / VALIDATION_INTERRUPTED — killing an order that could
  // simply have been retried.
  const { product, variant } = await seedVariant("candidate-outage", 500_000);
  const publicCode = `${prefix}-candidate-outage-order`;
  await createDraft(variant.id, publicCode);

  const failingClient = new Proxy(prisma, {
    get(target, property, receiver) {
      if (property === "promotionTarget") {
        return {
          findMany: () => Promise.reject(new Error("simulated promotion-candidate read outage")),
        };
      }
      return Reflect.get(target, property, receiver);
    },
  }) as PrismaClient;

  const { created, gateway } = gatewayWithFreshBase(
    variant.pancakeVariationId,
    product.pancakeProductId,
    500_000,
  );
  const result = await submissionService(gateway, now, failingClient).submit({
    publicCode,
    shopId,
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.state, "DRAFT", "a pre-write dependency outage must not strand the checkout");
  assert.equal(result.reason, "VALIDATION_UNAVAILABLE");
  assert.equal(created.length, 0, "nothing may reach Pancake when pricing could not be resolved");

  const recovered = await prisma.orderMirror.findUniqueOrThrow({ where: { publicCode } });
  assert.equal(recovered.state, "DRAFT", "the buyer can retry immediately, without a 15-minute wait");
  assert.equal(recovered.syncErrorCode, "VALIDATION_UNAVAILABLE");
});

test("P9b a fresher base behind an unchanged fixed price still refreshes the audit and the mirror", async () => {
  // Provenance drift with no money drift. The buyer's 400k is a FIXED_PRICE campaign, and it stays
  // 400k when Pancake's base moves 500k -> 600k because 400k is still a discount against the higher
  // base. Nothing the buyer agreed to has changed, so this must NOT become a PRICE_CHANGED
  // handshake — but the submission has just observed a fresher trusted base, and finalizing a line
  // that records 500k would put a number in the immutable audit that no upstream ever reported.
  const { product, variant } = await seedVariant("provenance-base", 500_000);
  await seedCampaign(variant.id, { discountType: "FIXED_PRICE", fixedPriceVnd: BigInt(400_000) });
  const publicCode = `${prefix}-provenance-base-order`;
  await createDraft(variant.id, publicCode);

  const draft = await prisma.orderMirror.findUniqueOrThrow({
    where: { publicCode },
    include: { lines: true },
  });
  assert.equal(draft.lines[0]!.unitPriceVnd, BigInt(400_000));
  assert.equal(draft.lines[0]!.baseUnitPriceVnd, BigInt(500_000), "the DRAFT saw the older base");

  const { created, gateway } = gatewayWithFreshBase(
    variant.pancakeVariationId,
    product.pancakeProductId,
    600_000,
  );
  const result = await submissionService(gateway).submit({ publicCode, shopId });

  assert.equal(result.ok, true, "unchanged buyer money must not force a reconfirmation");
  assert.equal(created.length, 1, "the order must still reach Pancake");

  const finalized = await prisma.orderMirror.findUniqueOrThrow({
    where: { publicCode },
    include: { lines: true },
  });
  assert.equal(
    finalized.lines[0]!.unitPriceVnd,
    BigInt(400_000),
    "the price the buyer agreed to is untouched",
  );
  assert.equal(
    finalized.lines[0]!.baseUnitPriceVnd,
    BigInt(600_000),
    "the finalized audit records the base this submission actually observed",
  );
  assert.equal(finalized.merchandiseSubtotalVnd, BigInt(400_000), "money is unchanged");

  const mirrored = await prisma.variantMirror.findUniqueOrThrow({ where: { id: variant.id } });
  assert.equal(
    mirrored.pancakeRetailPrice,
    600_000,
    "a fresher trusted base is not observed and then thrown away",
  );
});

test("P9b a same-price campaign handover records the campaign that actually applied", async () => {
  // Two campaigns meeting at one half-open boundary with the same final price: A ends exactly as B
  // begins. The money never moves, so this is invisible to a price comparison — but the finalized
  // line would name campaign A while campaign B is what was live at submission, which is a false
  // answer to "which promotion sold this item".
  const { product, variant } = await seedVariant("provenance-campaign", 500_000);
  const handover = new Date(now.getTime() + 120_000);
  const campaignA = await seedCampaign(variant.id, {
    discountType: "FIXED_PRICE",
    fixedPriceVnd: BigInt(400_000),
    startsAt: new Date(now.getTime() - 60_000),
    endsAt: handover,
  });
  const campaignB = await seedCampaign(variant.id, {
    discountType: "FIXED_PRICE",
    fixedPriceVnd: BigInt(400_000),
    startsAt: handover,
    endsAt: new Date(now.getTime() + 900_000),
  });
  const publicCode = `${prefix}-provenance-campaign-order`;
  await createDraft(variant.id, publicCode);

  const draft = await prisma.orderMirror.findUniqueOrThrow({
    where: { publicCode },
    include: { lines: true },
  });
  assert.equal(draft.lines[0]!.unitPriceVnd, BigInt(400_000));
  assert.equal(
    draft.lines[0]!.promotionCampaignId,
    campaignA.id,
    "campaign A was live when the quote was rendered",
  );

  const { created, gateway } = gatewayWithFreshBase(
    variant.pancakeVariationId,
    product.pancakeProductId,
    500_000,
  );
  const result = await submissionService(gateway, handover).submit({ publicCode, shopId });

  assert.equal(result.ok, true, "identical money must not force a reconfirmation");
  assert.equal(created.length, 1);

  const finalized = await prisma.orderMirror.findUniqueOrThrow({
    where: { publicCode },
    include: { lines: true },
  });
  assert.equal(finalized.lines[0]!.unitPriceVnd, BigInt(400_000));
  assert.equal(
    finalized.lines[0]!.promotionCampaignId,
    campaignB.id,
    "the audit names the campaign the submission-time resolver actually selected",
  );
  assert.equal(finalized.lines[0]!.promotionFixedPriceVnd, BigInt(400_000));
});

test("P9b a submission with nothing stale writes no provenance correction at all", async () => {
  // Guards the hot path. The provenance refresh must fire only when the finalized line would
  // actually misreport something; if the comparison were too eager it would be idempotent enough to
  // keep every other test green while adding a write to every checkout, so this pins the negative.
  const { product, variant } = await seedVariant("provenance-quiet", 500_000);
  await seedCampaign(variant.id, { discountType: "PERCENTAGE", percentageValue: 20 });
  const publicCode = `${prefix}-provenance-quiet-order`;
  await createDraft(variant.id, publicCode);

  let lineAuditWrites = 0;
  const countingClient = new Proxy(prisma, {
    get(target, property, receiver) {
      if (property === "orderLineSnapshot") {
        const model = Reflect.get(target, property, receiver) as PrismaClient["orderLineSnapshot"];
        return new Proxy(model, {
          get(modelTarget, modelProperty, modelReceiver) {
            if (modelProperty === "updateMany") lineAuditWrites += 1;
            return Reflect.get(modelTarget, modelProperty, modelReceiver);
          },
        });
      }
      return Reflect.get(target, property, receiver);
    },
  }) as PrismaClient;

  const { created, gateway } = gatewayWithFreshBase(
    variant.pancakeVariationId,
    product.pancakeProductId,
    500_000,
  );
  const result = await submissionService(gateway, now, countingClient).submit({
    publicCode,
    shopId,
  });

  assert.equal(result.ok, true);
  assert.equal(created.length, 1);
  assert.equal(lineAuditWrites, 0, "an unchanged order must not rewrite its own audit");
});
