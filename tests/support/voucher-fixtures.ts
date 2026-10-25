import { createHash } from "node:crypto";

import type { PrismaClient } from "../../src/generated/prisma/client.ts";

/**
 * Shared fixtures for the voucher database tests. Every test file owns one shop id, so campaigns, holds and
 * redemptions from parallel files never meet, and cleanup only ever touches its own shop.
 */
export function createVoucherFixtures(prisma: PrismaClient, shopId: number, prefix: string) {
  let counter = 0;
  const token = () => `${prefix}-${process.pid}-${(counter += 1)}`;
  const hex = (seed: string) => createHash("sha256").update(seed).digest("hex");

  const base = {
    pancakeShopId: shopId,
    kind: "MERCHANDISE" as const,
    issuance: "AUTO" as const,
    visibility: "PUBLIC" as const,
    discountType: "FIXED_AMOUNT_VND" as const,
    fixedAmountVnd: BigInt(30_000),
    minEligibleSubtotalVnd: BigInt(600_000),
    scopeMode: "ALL_SHOP" as const,
    isEnabled: true,
    enabledAt: new Date("2026-10-01T00:00:00Z"),
  };

  /** An ACTIVE campaign by default; pass overrides for anything else. */
  const campaign = (data: Record<string, unknown> = {}) =>
    prisma.voucherCampaign.create({ data: { name: `${prefix} ${token()}`, ...base, ...data } as never });

  const shippingCampaign = (data: Record<string, unknown> = {}) =>
    campaign({ kind: "SHIPPING_FREE", discountType: null, fixedAmountVnd: null, minEligibleSubtotalVnd: null, ...data });

  const hold = (campaignId: string, data: Record<string, unknown> = {}) => {
    const createdAt = new Date();
    return prisma.voucherHold.create({
      data: {
        campaignId, campaignRevision: 1, pancakeShopId: shopId, kind: "MERCHANDISE", attemptKey: hex(token()), quoteDigest: hex("q"),
        paidRevision: BigInt(1), heldDiscountVnd: BigInt(30_000), createdAt, expiresAt: new Date(createdAt.getTime() + 600_000), ...data,
      } as never,
    });
  };

  /** Removes everything this shop's fixtures created; the ledger is append-only, so triggers are suspended for this transaction. */
  const cleanup = () =>
    prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
      await tx.voucherRedemption.deleteMany({ where: { campaign: { pancakeShopId: shopId } } });
      await tx.voucherHold.deleteMany({ where: { campaign: { pancakeShopId: shopId } } });
      await tx.voucherCampaign.deleteMany({ where: { pancakeShopId: shopId } });
    });

  return { token, hex, campaign, shippingCampaign, hold, cleanup, base };
}
