import type { Prisma } from "../generated/prisma/client.ts";

// Separate from catalog-sync (1277934572) and product-slug (1277934573).
export const SHIPPING_CAMPAIGN_LOCK_NAMESPACE = 1_277_934_574;

/** Call inside the quote's transaction. Administration uses the exclusive side of this shop-scoped lock. */
export async function lockShippingCampaignRead(tx: Pick<Prisma.TransactionClient, "$executeRaw">, shopId: number): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(${SHIPPING_CAMPAIGN_LOCK_NAMESPACE}, ${shopId})`;
}
