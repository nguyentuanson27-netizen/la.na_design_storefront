import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

/**
 * Voucher v1 V20 -- the website-to-POS convergence run against the LIVE Pancake shop.
 *
 * Unlike `pnpm pancake:voucher:accept` (which sends fixture lines straight to the POS), this drives the PRODUCTION
 * composition end to end: hold -> rendered benefit quote and proof -> DRAFT -> POS re-derivation -> acceptance at the
 * write boundary -> real create -> real read-back verification, then cancels the POS order, lets the REAL status
 * reconciliation observe status 7 and refund the vouchers, and runs it again to show nothing is refunded twice.
 *
 * Safety model (same family as the other POS probes):
 *  - refuses CI; needs `GQ_POS_PROBE_APPROVED=shop:<id>` for the configured shop;
 *  - refuses any database that is not on localhost: it writes a scratch cart, vouchers and orders to the DATABASE_URL;
 *  - at most `MAX_ORDERS` POS orders (the owner approved 10 on 2026-10-26; this run plans 3), one create per case and
 *    never a retry (Pancake has no idempotency key);
 *  - every order is marked in its note as a test and cancelled on EVERY path after creation; an order that is not
 *    confirmed cancelled stops the run and exits 3. The one exception is asked for by name by the owner:
 *    `V20_LEAVE_OPEN_FOR_STAFF=1` with `V20_ONLY_CASE=<id>` creates exactly ONE order and leaves it open on purpose so
 *    staff can cancel it by hand in the Pancake UI; the scratch website rows are kept, and a second run with
 *    `V20_OBSERVE_ORDER=<pancake order id>` (no create) reads back what status Pancake reports and what the real status
 *    reconciliation does with it;
 *  - no key and no customer data in the report.
 */

export const MAX_ORDERS = 10;
const MARKER = "TEST AUTOMATION VOUCHER V20";

type CaseDefinition = Readonly<{
  id: string;
  purpose: string;
  quantity: number;
  merchandiseVoucherVnd: number;
  freeShipping: boolean;
}>;

export const CASES: readonly CaseDefinition[] = Object.freeze([
  { id: "C1_MERCHANDISE_AND_FREESHIP", purpose: "2 units, a merchandise voucher and a free-shipping voucher: lines carry the voucher price, the fee is waived", quantity: 2, merchandiseVoucherVnd: 10_000, freeShipping: true },
  { id: "C2_UNEVEN_SPLIT_FEE_KEPT", purpose: "3 units and a 10.000 voucher that does not divide: two price segments; no free-shipping voucher, so the fee stays", quantity: 3, merchandiseVoucherVnd: 10_000, freeShipping: false },
]);

type Check = Readonly<{ name: string; ok: boolean; detail: string }>;
type CaseReport = {
  caseId: string;
  checks: Check[];
  pancakeOrderId: string | null;
  cleanup: string;
  passed: boolean;
};

const nodeEnv = (name: string): string | undefined => process.env[name]?.trim() || undefined;

function assertSafeToRun(shopId: number): void {
  if (process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true") throw new Error("refuses to run in CI");
  if (process.env.GQ_POS_PROBE_APPROVED !== `shop:${shopId}`) throw new Error(`requires GQ_POS_PROBE_APPROVED=shop:${shopId}`);
  const url = nodeEnv("DATABASE_URL");
  if (!url) throw new Error("DATABASE_URL is required");
  const host = new URL(url).hostname;
  if (host !== "localhost" && host !== "127.0.0.1" && host !== "::1") throw new Error("refuses a non-local DATABASE_URL: this run writes scratch rows");
}

async function main(): Promise<number> {
  const [
    { PrismaClient },
    { PrismaPg },
    { readPancakeConfig },
    { PancakeClient },
    { createPancakeOrderGateway },
    { parsePancakeCreateOrderResponse },
    { listPancakeNewProvinces, listPancakeNewCommunes },
    { readBenefitCheckoutRender },
    { issueBenefitQuoteProof, verifyBenefitQuoteProof },
    { createGuestCheckoutSnapshotService },
    { createGuestCheckoutSubmitService },
    { createPancakeOrderSubmissionService },
    { createCapacityReservationRepository },
    { createStorefrontCartRepository },
    { createVoucherHoldFlow },
    { createVoucherHoldService },
    { createVoucherOrderAcceptance },
    { readVoucherPreview },
    { createPancakeOrderStatusReconciliationService },
    { createVoucherRedemptionService },
    { validateProbeVariation, PROBE_VARIATION_ENV, PROBE_PRODUCT_CODE_ENV },
  ] = await Promise.all([
    import("../src/generated/prisma/client.ts"),
    import("@prisma/adapter-pg"),
    import("../src/integrations/pancake/config.ts"),
    import("../src/integrations/pancake/client.ts"),
    import("../src/integrations/pancake/order-gateway.ts"),
    import("../src/integrations/pancake/order-create.ts"),
    import("../src/integrations/pancake/geo.ts"),
    import("../src/commerce/benefit-checkout-render.ts"),
    import("../src/commerce/checkout-quote-proof.ts"),
    import("../src/commerce/guest-checkout-snapshot.ts"),
    import("../src/commerce/guest-checkout-submit.ts"),
    import("../src/commerce/pancake-order-submit.ts"),
    import("../src/commerce/capacity-reservation.ts"),
    import("../src/commerce/storefront-cart-repository.ts"),
    import("../src/commerce/voucher-hold-flow.ts"),
    import("../src/commerce/voucher-hold-service.ts"),
    import("../src/commerce/voucher-order-acceptance.ts"),
    import("../src/commerce/voucher-preview.ts"),
    import("../src/commerce/pancake-order-status-reconciliation.ts"),
    import("../src/commerce/voucher-redemption-service.ts"),
    import("./pancake-gift-quantity-capability-probe.ts"),
  ]);

  const config = readPancakeConfig(process.env);
  const SHOP = config.shopId;
  assertSafeToRun(SHOP);
  const variationId = nodeEnv(PROBE_VARIATION_ENV);
  const productCode = nodeEnv(PROBE_PRODUCT_CODE_ENV);
  if (!variationId || !productCode) throw new Error(`${PROBE_VARIATION_ENV} and ${PROBE_PRODUCT_CODE_ENV} are required`);
  const runId = (nodeEnv("GQ_POS_PROBE_RUN_ID") ?? randomUUID().slice(0, 8)).slice(0, 16);

  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });
  const client = new PancakeClient({ apiKey: config.apiKey });
  const realGateway = createPancakeOrderGateway(client);

  // Observe mode: no create, no cancel. What status does Pancake report for an order a person cancelled by hand, and what does
  // the REAL status reconciliation do with it (it refunds only on the one trusted code)?
  const observeId = nodeEnv("V20_OBSERVE_ORDER");
  if (observeId) {
    try {
      const order = await prisma.orderMirror.findFirst({ where: { pancakeShopId: SHOP, pancakeOrderId: observeId } });
      if (!order) throw new Error("no website order row for that Pancake order id (the scratch database of the run that created it is needed)");
      const redemptions = createVoucherRedemptionService(prisma as never);
      const before = await prisma.voucherRedemption.findMany({ where: { orderId: order.id } });
      const read = await realGateway.readOrder(SHOP, observeId).catch(() => null);
      const reconcile = createPancakeOrderStatusReconciliationService(prisma as never, realGateway as never, {
        shopId: SHOP,
        async onTrustedCancel({ orderId }: { orderId: string }) { await redemptions.refundOrder({ orderId, reason: "POS_CANCELLED" }); },
      } as never);
      const result = await reconcile.reconcile({ orderId: order.id });
      const after = await prisma.voucherRedemption.findMany({ where: { orderId: order.id } });
      const mirrored = await prisma.orderMirror.findUniqueOrThrow({ where: { id: order.id }, select: { state: true, pancakeStatus: true } });
      console.log("VOUCHER_STAFF_CANCEL_OBSERVATION_BEGIN");
      console.log(JSON.stringify({ pancakeOrderId: observeId, pancakeStatusReadBack: (read as { status?: unknown } | null)?.status ?? null, mirrored, reconcileOk: (result as { ok?: boolean }).ok === true, redemptionsBefore: before.length, refundedBefore: before.filter((row) => row.refundedAt !== null).length, refundedAfter: after.filter((row) => row.refundedAt !== null).length, refundReasons: after.map((row) => row.refundReason) }, null, 2));
      console.log("VOUCHER_STAFF_CANCEL_OBSERVATION_END");
      return 0;
    } finally {
      await prisma.$disconnect();
    }
  }

  // Preflight (reads only): the variation, its live price and stock, and a real two-level address.
  const variations = await client.getJson(`/shops/${SHOP}/products/variations`, { search: productCode });
  const leaveOpen = nodeEnv("V20_LEAVE_OPEN_FOR_STAFF") === "1";
  const onlyCase = nodeEnv("V20_ONLY_CASE");
  const activeCases = onlyCase ? CASES.filter((entry) => entry.id === onlyCase) : CASES;
  if (onlyCase && activeCases.length !== 1) throw new Error(`V20_ONLY_CASE must name one of: ${CASES.map((entry) => entry.id).join(", ")}`);
  if (leaveOpen && activeCases.length !== 1) throw new Error("V20_LEAVE_OPEN_FOR_STAFF=1 needs V20_ONLY_CASE: it creates exactly one order");
  const maxUnits = Math.max(...activeCases.map((entry) => entry.quantity));
  validateProbeVariation(variations, variationId, maxUnits);
  const live = (await realGateway.fetchVariations(SHOP, [variationId]))[0];
  if (!live || !Number.isSafeInteger(live.retailPrice) || live.retailPrice < 50_000) throw new Error("the probe variation has no usable live price");
  const unitPrice = live.retailPrice;
  const provinces = await listPancakeNewProvinces(client, { countryCode: "84" });
  const province = provinces[0];
  if (!province) throw new Error("no province from Pancake geo");
  const commune = (await listPancakeNewCommunes(client, { provinceId: province.id }))[0];
  if (!commune) throw new Error("no commune from Pancake geo");

  const SECRET = `v20-live-${randomUUID()}-secret-material`;
  const P = "v20live";
  const ENV = {
    LA_GIFT_QUANTITY_PROMOTIONS_ENABLED: "true",
    LA_VOUCHER_ENABLED: "true",
    LA_PANCAKE_VOUCHER_VERIFIED_SHOP_IDS: String(SHOP),
    LA_PANCAKE_LINE_LEVEL_PRICING_VERIFIED_SHOP_IDS: String(SHOP),
  } as const;
  // Campaign rows for the scratch database (no dependency on tests/, which the production image does not contain).
  const campaignBase = {
    pancakeShopId: SHOP, issuance: "AUTO", visibility: "PUBLIC", scopeMode: "ALL_SHOP", isEnabled: true, enabledAt: new Date("2026-10-01T00:00:00Z"),
  } as const;
  const f = {
    campaign: (data: Record<string, unknown>) =>
      prisma.voucherCampaign.create({ data: { ...campaignBase, kind: "MERCHANDISE", discountType: "FIXED_AMOUNT_VND", ...data } as never }),
    shippingCampaign: (data: Record<string, unknown>) =>
      prisma.voucherCampaign.create({ data: { ...campaignBase, kind: "SHIPPING_FREE", discountType: null, fixedAmountVnd: null, ...data } as never }),
  };
  const flow = createVoucherHoldFlow(prisma as never, { shopId: SHOP, attemptSecret: SECRET, proofSecret: SECRET, env: ENV });
  const holdService = createVoucherHoldService(prisma as never, { attemptSecret: SECRET, env: ENV });
  const acceptance = createVoucherOrderAcceptance({ readAttemptSecret: () => SECRET });

  const createdOrderIds: string[] = [];
  const cancelledOrderIds = new Set<string>();
  let creates = 0;
  // The only door to the POS write: counts, caps and records every create, whatever the production code does.
  const gateway = {
    ...realGateway,
    fetchVariations: realGateway.fetchVariations,
    resolveTwoLevelAddressNames: realGateway.resolveTwoLevelAddressNames,
    readOrder: realGateway.readOrder,
    async createOrder(request: Parameters<typeof realGateway.createOrder>[0]) {
      if (creates >= MAX_ORDERS) throw new Error("order cap reached");
      if (!String((request as { note?: unknown }).note ?? "").includes(MARKER)) throw new Error("refuses to create an order that is not marked as a test");
      creates += 1;
      const response = await realGateway.createOrder(request);
      try { createdOrderIds.push(parsePancakeCreateOrderResponse(response)); } catch { /* the DB row, or a marker search, will find it */ }
      return response;
    },
  };

  const cleanupWebsite = async () => {
    const orderIds = (await prisma.orderMirror.findMany({ where: { pancakeShopId: SHOP, publicCode: { startsWith: P } }, select: { id: true } })).map((order) => order.id);
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
      if (orderIds.length > 0) {
        await tx.$executeRaw`DELETE FROM "VoucherRedemption" WHERE "orderId" = ANY(${orderIds})`;
        await tx.$executeRaw`DELETE FROM "OrderAcceptance" WHERE "orderId" = ANY(${orderIds})`;
        await tx.$executeRaw`DELETE FROM "OrderVoucherSnapshot" WHERE "orderId" = ANY(${orderIds})`;
        await tx.$executeRaw`DELETE FROM "OrderPreorderLineSnapshot" WHERE "snapshotId" IN (SELECT "id" FROM "OrderPreorderSnapshot" WHERE "orderId" = ANY(${orderIds}))`;
        await tx.$executeRaw`DELETE FROM "OrderPreorderSnapshot" WHERE "orderId" = ANY(${orderIds})`;
        await tx.$executeRaw`DELETE FROM "OrderQuoteDiscountStep" WHERE "lineRowId" IN (SELECT l."id" FROM "OrderQuoteLine" l JOIN "OrderQuoteSnapshot" s ON s."id" = l."snapshotId" WHERE s."orderId" = ANY(${orderIds}))`;
        await tx.$executeRaw`DELETE FROM "OrderQuoteLine" WHERE "snapshotId" IN (SELECT "id" FROM "OrderQuoteSnapshot" WHERE "orderId" = ANY(${orderIds}))`;
        await tx.$executeRaw`DELETE FROM "OrderQuoteEntitlement" WHERE "snapshotId" IN (SELECT "id" FROM "OrderQuoteSnapshot" WHERE "orderId" = ANY(${orderIds}))`;
        await tx.$executeRaw`DELETE FROM "OrderQuoteSnapshot" WHERE "orderId" = ANY(${orderIds})`;
        await tx.$executeRaw`DELETE FROM "CapacityReservationResource" WHERE "reservationId" IN (SELECT "id" FROM "VariantCapacityReservation" WHERE "orderId" = ANY(${orderIds}))`;
        await tx.$executeRaw`DELETE FROM "VariantCapacityReservation" WHERE "orderId" = ANY(${orderIds})`;
        await tx.$executeRaw`DELETE FROM "OrderLineSnapshot" WHERE "orderId" = ANY(${orderIds})`;
        await tx.$executeRaw`DELETE FROM "OrderMirror" WHERE "id" = ANY(${orderIds})`;
      }
      await tx.$executeRaw`DELETE FROM "VoucherHold" WHERE "campaignId" IN (SELECT "id" FROM "VoucherCampaign" WHERE "pancakeShopId" = ${SHOP})`;
      await tx.$executeRaw`DELETE FROM "VoucherCampaign" WHERE "pancakeShopId" = ${SHOP}`;
    });
    await prisma.cart.deleteMany({ where: { items: { some: { variant: { product: { pancakeShopId: SHOP } } } } } });
    await prisma.shippingPromotionCampaign.deleteMany({ where: { pancakeShopId: SHOP } });
    await prisma.productMirror.deleteMany({ where: { pancakeShopId: SHOP } });
  };

  const cancelEverythingCreated = async (): Promise<string[]> => {
    const left: string[] = [];
    for (const id of createdOrderIds) {
      if (cancelledOrderIds.has(id)) continue;
      try { await realGateway.cancelOrder(SHOP, id); cancelledOrderIds.add(id); } catch { left.push(id); }
    }
    return left;
  };

  const reports: CaseReport[] = [];
  let openOrders: string[] = [];
  let leftOpen: { pancakeOrderId: string; websiteOrderId: string } | null = null;
  try {
    for (const definition of activeCases) {
      await cleanupWebsite();
      const checks: Check[] = [];
      const check = (name: string, ok: boolean, detail: string) => { checks.push({ name, ok, detail }); return ok; };
      const report: CaseReport = { caseId: definition.id, checks, pancakeOrderId: null, cleanup: "NOT_CREATED", passed: false };
      reports.push(report);

      // Seed: the REAL variation (same id, live price and stock), a cart, and the vouchers.
      const product = await prisma.productMirror.create({
        data: {
          pancakeShopId: SHOP, pancakeProductId: live.product.id, slug: `${P}-${runId.toLowerCase()}`, name: "V20 convergence", isActive: true, isPresent: true, syncedAt: new Date(),
          variants: { create: { pancakeVariationId: variationId, color: "Test", size: "M", isActive: true, isPresent: true, pancakeRetailPrice: unitPrice, pancakeRetailPriceAfterDiscount: unitPrice, syncedAt: new Date(),
            warehouseStocks: { create: { pancakeWarehouseId: `${P}-wh`, quantity: Math.max(live.sellableStock ?? 0, 10), syncedAt: new Date() } } } },
        },
        include: { variants: true },
      });
      const cartId = (await prisma.cart.create({ data: { expiresAt: new Date(Date.now() + 86_400_000), items: { create: { variantId: product.variants[0]!.id, quantity: definition.quantity } } } })).id;
      const merchandise = await f.campaign({ name: "V20 giảm tiền hàng", fixedAmountVnd: BigInt(definition.merchandiseVoucherVnd), minEligibleSubtotalVnd: BigInt(definition.merchandiseVoucherVnd + 1), maxUses: 5, maxBudgetVnd: BigInt(5_000_000) });
      const shipping = definition.freeShipping ? await f.shippingCampaign({ name: "V20 freeship", minEligibleSubtotalVnd: BigInt(1), maxUses: 5, maxBudgetVnd: BigInt(5_000_000) }) : null;

      // Hold exactly as the shopper's one deliberate click does.
      const preview = await readVoucherPreview({ client: prisma as never, cartId, shopId: SHOP, now: new Date(), env: ENV, ownHolds: await holdService.readOwnLiveHolds(cartId) });
      if (!check("preview", preview.enabled === true && preview.ok === true, "voucher preview available") || !preview.enabled || !preview.ok) { break; }
      const held = await flow.hold({ cartId, expectedQuoteDigest: preview.quoteDigest!, acknowledged: false });
      if (!check("hold", held.ok === true && held.state === "HELD", JSON.stringify(held).slice(0, 200))) { break; }

      // The rendered quote the checkout page would show, and the proof that binds it.
      const items = await prisma.cartItem.findMany({ where: { cartId }, select: { variantId: true, quantity: true } });
      const lines = await createStorefrontCartRepository(prisma as never).getLines({ shopId: SHOP, items, now: new Date() });
      const rendered = await readBenefitCheckoutRender({ client: prisma as never, cartId, lines, shopId: SHOP, now: new Date(), secret: SECRET, env: ENV });
      if (!check("render", rendered.kind === "BENEFIT", `render kind ${rendered.kind}`) || rendered.kind !== "BENEFIT") { break; }
      const expectedPaid = unitPrice * definition.quantity - definition.merchandiseVoucherVnd;
      const fee = rendered.facts.shippingFeeVnd;
      check("quote money", rendered.facts.paidSubtotalVnd === expectedPaid && rendered.facts.totalVnd === expectedPaid + fee, `paid ${rendered.facts.paidSubtotalVnd} (expected ${expectedPaid}), fee ${fee}, total ${rendered.facts.totalVnd}`);
      check("fee waived only with a free-shipping voucher", definition.freeShipping ? fee === 0 : fee > 0, `fee ${fee}`);
      const proof = issueBenefitQuoteProof({ quote: rendered.facts, cartId, secret: SECRET });

      // The production submit path with the real gateway.
      const snapshot = createGuestCheckoutSnapshotService(prisma as never, {
        checkoutInputValidated: true, env: ENV, voucher: { attemptSecret: SECRET },
        verifyRenderedQuote: () => ({ ok: false, reason: "PROOF_UNVERIFIED" }) as never,
        benefits: {
          verifyBenefitQuote: (currentQuote: never) => verifyBenefitQuoteProof({ proof, cartId, currentQuote, secret: SECRET }),
          verifyNonclaimAcknowledgement: () => ({ ok: false, reason: "ACK_MISSING" }) as never,
        },
      } as never);
      const pos = createPancakeOrderSubmissionService(prisma as never, gateway as never, {
        lineLevelPricingVerifiedShopIds: [SHOP], env: ENV, voucher: { attemptSecret: SECRET },
        onConfirmed: async () => undefined,
        async acceptAtWriteBoundary(tx: never, order: { id: string }) { return (await acceptance.acceptWithin(tx, { orderId: order.id })).ok; },
      } as never);
      let counter = 0;
      const service = createGuestCheckoutSubmitService({
        snapshot, orderSubmission: pos, generatePublicCode: () => `${P}-${runId}-${(counter += 1)}`,
        capacity: createCapacityReservationRepository(prisma as never), clock: () => new Date(),
      } as never);
      const result = await service.submit({
        cartId, shopId: SHOP, now: new Date(),
        checkoutInput: { name: "Test Automation", phone: "0900000000", provinceRef: province.id, districtRef: null, communeRef: commune.id, detail: "Dia chi test tu dong - Xin huy don", note: `${MARKER} ${runId} ${definition.id} - DO NOT SHIP - HUY DON` },
      } as never);
      const order = await prisma.orderMirror.findFirst({ where: { sourceCartId: cartId }, orderBy: { createdAt: "desc" } });
      report.pancakeOrderId = order?.pancakeOrderId ?? createdOrderIds.at(-1) ?? null;
      if (!check("website result", (result as { ok?: boolean }).ok === true && order?.state === "CONFIRMED", JSON.stringify(result).slice(0, 200)) || !order) {
        report.cleanup = (await cancelEverythingCreated()).length === 0 ? "CANCELLED_OR_NONE" : "CLEANUP_UNCONFIRMED";
        break;
      }
      check("website money", order.totalVnd === BigInt(expectedPaid + fee) && order.shippingFeeVnd === BigInt(fee), `order total ${order.totalVnd}, fee ${order.shippingFeeVnd}`);
      check("accepted and consumed", (await prisma.orderAcceptance.count({ where: { orderId: order.id } })) === 1 && (await prisma.voucherRedemption.count({ where: { orderId: order.id } })) === (shipping ? 2 : 1), "marker + redemptions");

      // What the POS actually stored, read back from the live shop.
      const posId = order.pancakeOrderId!;
      const readBack = await realGateway.readOrder(SHOP, posId);
      check("POS goods total equals the website's goods total", readBack.totalPriceVnd === expectedPaid, `POS total ${readBack.totalPriceVnd}, website goods ${expectedPaid}, website fee ${fee}`);
      check("POS lines sum to the goods", readBack.lines.reduce((sum, line) => sum + line.quantity * line.unitPriceVnd, 0) === expectedPaid, readBack.lines.map((line) => `${line.quantity}x${line.unitPriceVnd}`).join(", "));
      check("POS line price differs from list price (the voucher is in the lines)", readBack.lines.every((line) => line.unitPriceVnd < unitPrice), `list ${unitPrice}`);

      // Owner-requested exception: leave this one order open so staff can cancel it by hand in the Pancake UI.
      if (leaveOpen && checks.every((entry) => entry.ok)) {
        report.cleanup = "LEFT_OPEN_FOR_STAFF_CANCEL";
        report.passed = true;
        leftOpen = { pancakeOrderId: posId, websiteOrderId: order.id };
        break;
      }

      // Cancel in the POS, observe status 7 through the REAL reconciliation, and see the refund happen once.
      let cancelled = false;
      try { await realGateway.cancelOrder(SHOP, posId); cancelledOrderIds.add(posId); cancelled = true; } catch { cancelled = false; }
      report.cleanup = cancelled ? "CANCELLED_STATUS_7" : "CLEANUP_UNCONFIRMED";
      if (!check("POS order cancelled", cancelled, report.cleanup)) { openOrders = await cancelEverythingCreated(); break; }
      const redemptions = createVoucherRedemptionService(prisma as never);
      const reconcile = createPancakeOrderStatusReconciliationService(prisma as never, realGateway as never, {
        shopId: SHOP,
        async onTrustedCancel({ orderId }: { orderId: string }) { await redemptions.refundOrder({ orderId, reason: "POS_CANCELLED" }); },
      } as never);
      const first = await reconcile.reconcile({ orderId: order.id });
      const afterFirst = await prisma.voucherRedemption.findMany({ where: { orderId: order.id } });
      check("status 7 observed and vouchers refunded once", (first as { ok?: boolean }).ok === true && afterFirst.length > 0 && afterFirst.every((row) => row.refundedAt !== null && row.refundReason === "POS_CANCELLED"), JSON.stringify(first).slice(0, 160));
      const counters = await prisma.voucherCampaign.findMany({ where: { id: { in: [merchandise.id, ...(shipping ? [shipping.id] : [])] } } });
      check("counters returned", counters.every((row) => row.redeemedUses === 0 && row.reservedUses === 0 && row.redeemedVnd === BigInt(0)), counters.map((row) => `${row.redeemedUses}/${row.reservedUses}`).join(" "));
      const stamps = afterFirst.map((row) => row.refundedAt?.toISOString());
      await reconcile.reconcile({ orderId: order.id });
      const afterSecond = await prisma.voucherRedemption.findMany({ where: { orderId: order.id } });
      check("a second reconciliation refunds nothing more", afterSecond.every((row, index) => row.refundedAt?.toISOString() === stamps[index]), "refundedAt unchanged");
      report.passed = checks.every((entry) => entry.ok);
      if (!report.passed) break;
    }
  } finally {
    // An order left open on purpose is the only one not cancelled here, and its scratch rows are kept for the observation run.
    if (leftOpen === null) {
      openOrders = [...openOrders, ...(await cancelEverythingCreated())];
      try { await cleanupWebsite(); } catch { /* scratch rows only */ }
    }
    await prisma.$disconnect();
  }

  const noOrderOpen = openOrders.length === 0 && leftOpen === null;
  const allPassed = (noOrderOpen || leftOpen !== null) && openOrders.length === 0 && reports.length === activeCases.length && reports.every((entry) => entry.passed);
  console.log("VOUCHER_CONVERGENCE_LIVE_BEGIN");
  console.log(JSON.stringify({ runId, timestamp: new Date().toISOString(), shopId: SHOP, variationId, unitPriceVnd: unitPrice, ordersCreated: creates, orderCap: MAX_ORDERS, cases: reports, allPassed, noOrderMayBeOpen: noOrderOpen, openOrderIds: openOrders }, null, 2));
  console.log("VOUCHER_CONVERGENCE_LIVE_END");
  if (leftOpen !== null) console.log(`ORDER LEFT OPEN ON PURPOSE for the owner to cancel by hand in Pancake: pancakeOrderId=${leftOpen.pancakeOrderId} (note contains "${MARKER}"). Then run V20_OBSERVE_ORDER=${leftOpen.pancakeOrderId}.`);
  return openOrders.length > 0 ? 3 : allPassed ? 0 : 2;
}

function isDirectExecution(): boolean {
  const entrypoint = process.argv[1];
  return entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href;
}

if (isDirectExecution()) {
  main().then((code) => process.exit(code), (error) => {
    console.error(`Voucher convergence run failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
