import type { Prisma, PrismaClient } from "../generated/prisma/client.ts";

import { PANCAKE_ORDER_CANCELLED_STATUSES, isPancakeOrderCancelledStatus } from "../integrations/pancake/order-readback.ts";

/**
 * Voucher v1 (V14, ADR 0018 D-4): a redemption is refunded once, from a trusted signal only.
 *
 * A refund is one compare-and-set per redemption (`refundedAt IS NULL -> now()`) plus the matching move of the
 * campaign's `redeemed*` counters, in one transaction. A duplicate, replayed or out-of-order signal matches zero
 * rows and changes nothing. The database trigger already makes a refund final. Only counters move: a refund never
 * touches a campaign's own state, so an expired or disabled campaign stays that way while its quota and budget are
 * returned (AC-19/AC-27).
 *
 * Trusted signals, and nothing else (everything below is "pending", never a refund):
 *
 *  - `POS_REJECTED`  the local order is `REJECTED`. After the website accepted an order that can only be a definitive
 *                    refusal (a 4xx on create) or reconciliation's confirmed absence of the marker in Pancake.
 *  - `POS_CANCELLED` the order's mirrored Pancake status is a cancelled code (7: the cancel we issue ourselves through the
 *                    API; 6 "Đã hủy": a cancel by staff in the Pancake UI, observed 2026-10-26) with a complete, shop-verified
 *                    status record written by the status reconciliation. Other terminal codes (returned, removed...) are
 *                    NOT mapped and therefore never refund.
 *  - `ADMIN_CANCEL`  an authenticated Admin cancel; the caller supplies the audit evidence (no screen exists yet).
 *
 * `SYNC_UNKNOWN`, a timeout, a network error or an unmapped status is not a signal. Like every settle path this never
 * reads the feature flag or the verified-shop list: whatever was consumed is settled whatever the switch says.
 */

export type VoucherRefundReason = "POS_REJECTED" | "POS_CANCELLED" | "ADMIN_CANCEL";

export type VoucherRefundResult =
  | Readonly<{ ok: true; refunded: number; alreadyRefunded: number }>
  | Readonly<{ ok: false; reason: "ORDER_NOT_FOUND" | "NO_REDEMPTION" | "NOT_A_TRUSTED_SIGNAL" | "INVALID_EVIDENCE" }>;

const EVIDENCE_MAX = 500;

export function createVoucherRedemptionService(client: PrismaClient) {
  async function refundOrder(input: Readonly<{ orderId: string; reason: VoucherRefundReason; evidence?: string }>): Promise<VoucherRefundResult> {
    const { orderId, reason } = input;
    if (typeof orderId !== "string" || orderId.length === 0 || orderId.length > 128) return { ok: false, reason: "ORDER_NOT_FOUND" };
    if (reason !== "POS_REJECTED" && reason !== "POS_CANCELLED" && reason !== "ADMIN_CANCEL") return { ok: false, reason: "NOT_A_TRUSTED_SIGNAL" };
    if (reason === "ADMIN_CANCEL" && (typeof input.evidence !== "string" || input.evidence.trim().length === 0)) return { ok: false, reason: "INVALID_EVIDENCE" };

    return client.$transaction(async (tx: Prisma.TransactionClient): Promise<VoucherRefundResult> => {
      // The order row serialises every refund of one order, whichever signal arrives.
      const orders = await tx.$queryRaw<Array<{
        id: string; state: string; pancakeOrderId: string | null; pancakeShopId: number | null;
        pancakeSystemId: string | null; pancakeStatus: number | null; pancakeStatusUpdatedAt: string | null;
      }>>`SELECT "id", "state"::text AS "state", "pancakeOrderId", "pancakeShopId", "pancakeSystemId", "pancakeStatus", "pancakeStatusUpdatedAt"
          FROM "OrderMirror" WHERE "id" = ${orderId} FOR UPDATE`;
      const order = orders[0];
      if (!order) return { ok: false, reason: "ORDER_NOT_FOUND" };

      let evidence: string;
      if (reason === "POS_REJECTED") {
        if (order.state !== "REJECTED") return { ok: false, reason: "NOT_A_TRUSTED_SIGNAL" };
        evidence = `local-state:REJECTED`;
      } else if (reason === "POS_CANCELLED") {
        const complete = order.pancakeOrderId !== null && order.pancakeShopId !== null && order.pancakeSystemId !== null && order.pancakeStatusUpdatedAt !== null;
        if (!complete || !isPancakeOrderCancelledStatus(order.pancakeStatus)) return { ok: false, reason: "NOT_A_TRUSTED_SIGNAL" };
        evidence = `pancake:shop=${order.pancakeShopId};order=${order.pancakeOrderId};status=${order.pancakeStatus};updatedAt=${order.pancakeStatusUpdatedAt}`;
      } else {
        evidence = `admin:${input.evidence!.trim()}`;
      }
      evidence = evidence.slice(0, EVIDENCE_MAX);

      const redemptions = await tx.$queryRaw<Array<{ id: string; campaignId: string; amountVnd: bigint; refundedAt: Date | null }>>`
        SELECT "id", "campaignId", "amountVnd", "refundedAt" FROM "VoucherRedemption" WHERE "orderId" = ${orderId} ORDER BY "kind"::text`;
      if (redemptions.length === 0) return { ok: false, reason: "NO_REDEMPTION" };
      const open = redemptions.filter((row) => row.refundedAt === null);
      if (open.length === 0) return { ok: true, refunded: 0, alreadyRefunded: redemptions.length };

      // Campaign rows ascending by id, the order every ledger writer uses.
      for (const id of [...new Set(open.map((row) => row.campaignId))].sort()) {
        await tx.$queryRaw`SELECT "id" FROM "VoucherCampaign" WHERE "id" = ${id} FOR UPDATE`;
      }
      let refunded = 0;
      for (const row of open) {
        const changed = await tx.$executeRaw`
          UPDATE "VoucherRedemption" SET "refundedAt" = date_trunc('milliseconds', clock_timestamp()), "refundReason" = ${reason}, "refundEvidence" = ${evidence}
          WHERE "id" = ${row.id} AND "refundedAt" IS NULL`;
        if (changed !== 1) continue; // lost to a concurrent refund: it did the ledger move
        await tx.$executeRaw`
          UPDATE "VoucherCampaign" SET "redeemedUses" = "redeemedUses" - 1, "redeemedVnd" = "redeemedVnd" - ${row.amountVnd}
          WHERE "id" = ${row.campaignId}`;
        refunded += 1;
      }
      return { ok: true, refunded, alreadyRefunded: redemptions.length - refunded };
    });
  }

  /**
   * Settles REJECTED orders whose refund a crash or a lost hook left undone. Idempotent; safe to run on any schedule.
   * Returns how many redemptions were refunded.
   */
  async function sweepRejectedOrders(options: Readonly<{ limit?: number }> = {}): Promise<Readonly<{ scanned: number; refunded: number }>> {
    const limit = Math.max(1, Math.min(options.limit ?? 50, 500));
    const orders = await client.$queryRaw<Array<{ id: string }>>`
      SELECT DISTINCT o."id" FROM "OrderMirror" o JOIN "VoucherRedemption" r ON r."orderId" = o."id"
      WHERE o."state" = 'REJECTED' AND r."refundedAt" IS NULL LIMIT ${limit}`;
    let refunded = 0;
    for (const order of orders) {
      const result = await refundOrder({ orderId: order.id, reason: "POS_REJECTED" });
      if (result.ok) refunded += result.refunded;
    }
    return { scanned: orders.length, refunded };
  }

  /**
   * Settles redemptions of orders Pancake has cancelled whose refund a crash or a lost hook left undone: the status
   * reconciliation stores status 7 first and refunds second, and nothing re-reads an unchanged status. Only a candidate
   * list: `refundOrder` re-checks the trust (complete, shop-verified record at the cancelled code) under the order lock,
   * so `SYNC_UNKNOWN`, a half record or any other code is never refunded here. The candidate query already requires the
   * complete record, so incomplete rows can never fill the bounded batch and starve a valid cancelled order.
   */
  async function sweepCancelledOrders(options: Readonly<{ limit?: number }> = {}): Promise<Readonly<{ scanned: number; refunded: number }>> {
    const limit = Math.max(1, Math.min(options.limit ?? 50, 500));
    const orders = await client.$queryRaw<Array<{ id: string }>>`
      SELECT DISTINCT o."id" FROM "OrderMirror" o JOIN "VoucherRedemption" r ON r."orderId" = o."id"
      WHERE o."pancakeStatus" = ANY(${[...PANCAKE_ORDER_CANCELLED_STATUSES]}) AND o."state" <> 'REJECTED' AND r."refundedAt" IS NULL
        AND o."pancakeOrderId" IS NOT NULL AND o."pancakeShopId" IS NOT NULL AND o."pancakeSystemId" IS NOT NULL AND o."pancakeStatusUpdatedAt" IS NOT NULL
      ORDER BY o."id" LIMIT ${limit}`;
    let refunded = 0;
    for (const order of orders) {
      const result = await refundOrder({ orderId: order.id, reason: "POS_CANCELLED" });
      if (result.ok) refunded += result.refunded;
    }
    return { scanned: orders.length, refunded };
  }

  /** Both sweeps: what the scheduled `pnpm voucher:refund:sweep` runs. */
  async function sweep(options: Readonly<{ limit?: number }> = {}): Promise<Readonly<{ rejected: Readonly<{ scanned: number; refunded: number }>; cancelled: Readonly<{ scanned: number; refunded: number }> }>> {
    const rejected = await sweepRejectedOrders(options);
    const cancelled = await sweepCancelledOrders(options);
    return { rejected, cancelled };
  }

  return { refundOrder, sweepRejectedOrders, sweepCancelledOrders, sweep };
}

export type VoucherRedemptionService = ReturnType<typeof createVoucherRedemptionService>;
