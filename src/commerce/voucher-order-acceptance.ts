import type { Prisma } from "../generated/prisma/client.ts";

import { voucherAttemptKey } from "./voucher-hold-service.ts";
import { parseVoucherOrderSnapshot, type VoucherOrderSnapshot } from "./voucher-order-snapshot.ts";
import { GIFT_SLOTS_VARIATION } from "./voucher-quote-facts.ts";
import { voucherQuoteDigest, type VoucherProofBinding, type VoucherProofFacts, type VoucherProofLine } from "./voucher-quote-proof.ts";

/**
 * Voucher v1 (V13, ADR 0018 D-3 step 3; several merchandise vouchers per ADR 0020): the order is accepted and its vouchers are consumed in ONE transaction.
 *
 * What an order carries is declared, not guessed. The checkout snapshot (V18) records the V10 voucher snapshot on
 * the DRAFT order (`recordVoucherOrderSnapshot`, insert-only, DRAFT-only, by trigger). An order without that row is
 * a plain order: acceptance writes nothing and needs no secret, so every no-voucher order behaves as before. An
 * order WITH the row can never be accepted as a plain one: either its vouchers are consumed, or it is refused.
 *
 * The caller opens the transaction at the submission write boundary, after capacity is reserved and the order has
 * moved to `POS_SUBMITTING`, and runs `acceptWithin(tx, ...)` as the last statement before committing. Inside it:
 *
 *   lock the order; lock the cart; lock the declared campaigns ascending by id; lock the attempt's HELD holds;
 *   check each declared voucher has a hold, in its own slot, that is still HELD, unexpired by the DATABASE clock, on the cart's
 *   current `paidRevision`, for the declared campaign revision and amount; check the digest the holds promised
 *   equals the digest recomputed from the order's FROZEN quote rows and that the declared money is the quote's;
 *   then insert the `OrderAcceptance` marker, move each hold to CONSUMED, insert its `VoucherRedemption` and move
 *   the campaign counters reserved -> redeemed.
 *
 * Nothing is written before every check passed, and a refusal is a plain result: the caller rolls its own
 * transaction back, so a refused order has no marker, no consumption and no POS write, and its holds stay HELD
 * until their own expiry (AC-17/AC-18/AC-38). The order row lock plus the marker's unique `orderId` make a replay,
 * a double click or a second tab read the winner's result instead of consuming twice.
 *
 * Like every settle path this never consults the feature flag or the verified-shop list: a hold that was granted
 * is honoured, whatever the switch says now.
 */

export type VoucherAcceptanceFailureReason =
  | "ORDER_NOT_FOUND"
  /** The order has no guest cart to prove ownership and revision against. */
  | "CART_UNAVAILABLE"
  /** The cart's paid lines moved after the hold was taken (ABA-safe: a changed-and-restored cart too). */
  | "CART_CHANGED"
  /** A declared voucher has no live hold of this attempt (expired, released, swapped, edited) or its campaign is gone. */
  | "HOLD_UNAVAILABLE"
  /** The order's frozen quote is not the one the holds promised, or the declaration is not the quote's money. */
  | "QUOTE_MISMATCH";

export type AcceptedVoucher = Readonly<{ kind: "MERCHANDISE" | "SHIPPING_FREE"; slot: string; campaignId: string; campaignRevision: number; holdId: string; amountVnd: number }>;

export type VoucherAcceptanceResult =
  | Readonly<{ ok: true; applied: false }>
  | Readonly<{ ok: true; applied: true; replayed: boolean; acceptedAt: Date; vouchers: readonly AcceptedVoucher[] }>
  | Readonly<{ ok: false; reason: VoucherAcceptanceFailureReason }>;

type HoldRow = {
  id: string;
  campaignId: string;
  campaignRevision: number;
  pancakeShopId: number;
  kind: "MERCHANDISE" | "SHIPPING_FREE";
  slot: string;
  quoteDigest: string;
  paidRevision: bigint;
  heldDiscountVnd: bigint;
  expiresAt: Date;
};

const fail = (reason: VoucherAcceptanceFailureReason) => Object.freeze({ ok: false as const, reason });

/** Declares the order's vouchers. Called by the checkout snapshot in the transaction that creates the DRAFT order. */
export async function recordVoucherOrderSnapshot(
  tx: Prisma.TransactionClient,
  input: Readonly<{ orderId: string; snapshot: VoucherOrderSnapshot }>,
): Promise<void> {
  const parsed = parseVoucherOrderSnapshot(input.snapshot);
  if (parsed === null || (parsed.merchandise.length === 0 && parsed.shipping === null)) throw new TypeError("A voucher order snapshot must declare at least one voucher");
  await tx.orderVoucherSnapshot.create({ data: { orderId: input.orderId, snapshot: parsed as unknown as Prisma.InputJsonValue } });
}

const toAccepted = (hold: HoldRow): AcceptedVoucher =>
  Object.freeze({ kind: hold.kind, slot: hold.slot, campaignId: hold.campaignId, campaignRevision: hold.campaignRevision, holdId: hold.id, amountVnd: Number(hold.heldDiscountVnd) });

/** `readAttemptSecret` is called only for an order that declares vouchers, so plain orders never need it. */
export function createVoucherOrderAcceptance(options: Readonly<{ readAttemptSecret: () => string }>) {
  async function acceptWithin(tx: Prisma.TransactionClient, input: Readonly<{ orderId: string }>): Promise<VoucherAcceptanceResult> {
    // Lock order: order (two acceptances of one order queue here) -> cart -> campaigns ascending -> holds, the hold
    // service's own order after its cart lock.
    const orders = await tx.$queryRaw<Array<{ id: string; sourceCartId: string | null; pancakeShopId: number | null; shippingFeeVnd: bigint | null; totalVnd: bigint | null }>>`
      SELECT "id", "sourceCartId", "pancakeShopId", "shippingFeeVnd", "totalVnd" FROM "OrderMirror" WHERE "id" = ${input.orderId} FOR UPDATE`;
    const order = orders[0];
    if (!order) return fail("ORDER_NOT_FOUND");

    const declared = await tx.orderVoucherSnapshot.findUnique({ where: { orderId: input.orderId }, select: { snapshot: true } });
    if (!declared) return Object.freeze({ ok: true as const, applied: false as const });
    const snapshot = parseVoucherOrderSnapshot(declared.snapshot);
    if (snapshot === null || (snapshot.merchandise.length === 0 && snapshot.shipping === null)) return fail("QUOTE_MISMATCH");
    if (order.sourceCartId === null) return fail("CART_UNAVAILABLE");

    const intended = [
      ...snapshot.merchandise.map((entry) => ({ kind: "MERCHANDISE" as const, slot: entry.slot, campaignId: entry.campaignId, campaignRevision: entry.campaignRevision, amountVnd: entry.amountVnd })),
      ...(snapshot.shipping ? [{ kind: "SHIPPING_FREE" as const, slot: "SHIPPING_FREE", campaignId: snapshot.shipping.campaignId, campaignRevision: snapshot.shipping.campaignRevision, amountVnd: snapshot.shipping.waivedFeeVnd }] : []),
    ];

    const carts = await tx.$queryRaw<Array<{ paidRevision: bigint }>>`
      SELECT "paidRevision" FROM "Cart" WHERE "id" = ${order.sourceCartId} AND "userId" IS NULL FOR UPDATE`;
    const cart = carts[0];

    const accepted = await tx.$queryRaw<Array<{ acceptedAt: Date }>>`SELECT "acceptedAt" FROM "OrderAcceptance" WHERE "orderId" = ${input.orderId}`;
    if (accepted[0]) {
      // Replay (retry, double click, second tab): the winner's work stands; report it, write nothing.
      const consumed = await tx.$queryRaw<Array<HoldRow>>`
        SELECT h."id", h."campaignId", h."campaignRevision", h."pancakeShopId", h."kind"::text AS "kind", h."slot", h."quoteDigest", h."paidRevision", h."heldDiscountVnd", h."expiresAt"
        FROM "VoucherHold" h JOIN "VoucherRedemption" r ON r."holdId" = h."id"
        WHERE r."orderId" = ${input.orderId} AND h."state" = 'CONSUMED' ORDER BY h."slot"`;
      const same = consumed.length === intended.length && intended.every((want) => consumed.some((got) => got.slot === want.slot && got.campaignId === want.campaignId && Number(got.heldDiscountVnd) === want.amountVnd));
      return same ? Object.freeze({ ok: true as const, applied: true as const, replayed: true, acceptedAt: accepted[0].acceptedAt, vouchers: consumed.map(toAccepted) }) : fail("HOLD_UNAVAILABLE");
    }

    if (!cart) return fail("CART_UNAVAILABLE");
    const attemptKey = voucherAttemptKey(order.sourceCartId, options.readAttemptSecret());

    const campaigns = new Set<string>();
    for (const id of [...new Set(intended.map((want) => want.campaignId))].sort()) {
      const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "VoucherCampaign" WHERE "id" = ${id} FOR UPDATE`;
      if (rows[0]) campaigns.add(id);
    }
    const live = await tx.$queryRaw<HoldRow[]>`
      SELECT "id", "campaignId", "campaignRevision", "pancakeShopId", "kind"::text AS "kind", "slot", "quoteDigest", "paidRevision", "heldDiscountVnd", "expiresAt"
      FROM "VoucherHold" WHERE "attemptKey" = ${attemptKey} AND "state" = 'HELD' ORDER BY "slot" FOR UPDATE`;
    const clock = await tx.$queryRaw<Array<{ now: Date }>>`SELECT date_trunc('milliseconds', clock_timestamp()) AS "now"`;
    const now = clock[0]!.now;

    // Each declared voucher must be exactly the live hold of its slot: same campaign, same revision, same amount.
    const consume: HoldRow[] = [];
    for (const want of intended) {
      const hold = live.find((candidate) => candidate.slot === want.slot);
      if (
        !hold || !campaigns.has(want.campaignId) || hold.campaignId !== want.campaignId || hold.campaignRevision !== want.campaignRevision ||
        Number(hold.heldDiscountVnd) !== want.amountVnd || hold.expiresAt.getTime() <= now.getTime() ||
        (order.pancakeShopId !== null && hold.pancakeShopId !== order.pancakeShopId)
      ) {
        return fail("HOLD_UNAVAILABLE");
      }
      consume.push(hold);
    }
    if (consume.some((hold) => hold.paidRevision !== cart.paidRevision)) return fail("CART_CHANGED");

    const quote = await tx.orderQuoteSnapshot.findUnique({ where: { orderId: input.orderId }, include: { lines: true } });
    if (!quote) return fail("QUOTE_MISMATCH");
    // The declaration is the quote's own money, and the order mirror agrees with the frozen quote.
    if (
      order.totalVnd !== quote.totalVnd || order.shippingFeeVnd !== quote.shippingFeeVnd ||
      BigInt(snapshot.paidAfterVnd) !== quote.paidSubtotalVnd || BigInt(snapshot.shippingFeeVnd) !== quote.shippingFeeVnd || BigInt(snapshot.totalVnd) !== quote.totalVnd
    ) {
      return fail("QUOTE_MISMATCH");
    }

    // The digest every hold stored is the digest of the PREVIEW facts. Recompute it from the order's own frozen
    // rows (paid segments, the NUMBER of gift slots, the three money figures, the declared vouchers): a checkout
    // that priced anything differently, or carries a different voucher, cannot produce the same bytes. The gift
    // VARIATION is deliberately not part of it -- gift A -> B at the same count is the checkout proof's business.
    const proofLines: VoucherProofLine[] = quote.lines
      .filter((line) => line.role === "PAID")
      .map((line) => ({ pancakeVariationId: line.pancakeVariationId, quantity: line.quantity, unitPriceVnd: Number(line.unitPriceVnd), role: "PAID" as const }));
    const giftSlots = quote.lines.filter((line) => line.role === "GIFT").reduce((sum, line) => sum + line.quantity, 0);
    if (giftSlots > 0) proofLines.push({ pancakeVariationId: GIFT_SLOTS_VARIATION, quantity: giftSlots, unitPriceVnd: 0, role: "GIFT" });
    const bindingOf = (hold: HoldRow): VoucherProofBinding => ({ campaignId: hold.campaignId, campaignRevision: hold.campaignRevision, amountVnd: Number(hold.heldDiscountVnd), hold: null });
    const shippingHold = consume.find((candidate) => candidate.kind === "SHIPPING_FREE");
    // In the declared (application) order: the same vouchers in another order are another quote.
    const merchandiseBindings = snapshot.merchandise.map((entry) => bindingOf(consume.find((candidate) => candidate.slot === entry.slot)!));
    let digest: string;
    try {
      const facts: VoucherProofFacts = {
        state: "PREVIEW",
        paidRevision: cart.paidRevision,
        lines: proofLines,
        paidSubtotalVnd: Number(quote.paidSubtotalVnd),
        shippingFeeVnd: Number(quote.shippingFeeVnd),
        totalVnd: Number(quote.totalVnd),
        merchandise: merchandiseBindings,
        shipping: shippingHold ? bindingOf(shippingHold) : null,
      };
      digest = voucherQuoteDigest(facts);
    } catch {
      return fail("QUOTE_MISMATCH");
    }
    if (consume.some((hold) => hold.quoteDigest !== digest)) return fail("QUOTE_MISMATCH");

    // --- every check passed: write ---------------------------------------------------------------------------
    await tx.$executeRaw`
      INSERT INTO "OrderAcceptance" ("id", "orderId", "quoteDigest", "acceptedAt")
      VALUES (${`oa_${crypto.randomUUID()}`}, ${input.orderId}, ${quote.quoteDigest}, ${now})`;
    for (const hold of consume) {
      const consumed = await tx.$executeRaw`
        UPDATE "VoucherHold" SET "state" = 'CONSUMED', "consumedAt" = ${now}, "orderId" = ${input.orderId}
        WHERE "id" = ${hold.id} AND "state" = 'HELD'`;
      if (consumed !== 1) throw new Error("A voucher hold changed state while it was locked");
      await tx.$executeRaw`
        INSERT INTO "VoucherRedemption" ("id", "campaignId", "campaignRevision", "kind", "slot", "orderId", "holdId", "amountVnd", "websiteAcceptedAt")
        VALUES (${`vr_${crypto.randomUUID()}`}, ${hold.campaignId}, ${hold.campaignRevision}, ${hold.kind}::"VoucherKind", ${hold.slot}, ${input.orderId}, ${hold.id}, ${hold.heldDiscountVnd}, ${now})`;
      await tx.$executeRaw`
        UPDATE "VoucherCampaign" SET "reservedUses" = "reservedUses" - 1, "reservedVnd" = "reservedVnd" - ${hold.heldDiscountVnd},
          "redeemedUses" = "redeemedUses" + 1, "redeemedVnd" = "redeemedVnd" + ${hold.heldDiscountVnd}
        WHERE "id" = ${hold.campaignId}`;
    }
    return Object.freeze({ ok: true as const, applied: true as const, replayed: false, acceptedAt: now, vouchers: consume.map(toAccepted) });
  }

  return { acceptWithin };
}

export type VoucherOrderAcceptance = ReturnType<typeof createVoucherOrderAcceptance>;
