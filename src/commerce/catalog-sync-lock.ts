import type { Prisma } from "../generated/prisma/client.ts";

const MAX_POSTGRES_INTEGER = 2_147_483_647;

/**
 * Existing shop-scoped catalog-sync advisory lock.
 *
 * I9 policy writes join the same boundary so a catalog transaction cannot read one selling policy
 * and later persist an availability cycle after an admin has committed another policy. The lock is
 * deliberately shop-scoped because catalog sync already owns that boundary; reusing it is simpler
 * and safer than introducing a second locking scheme just for availability.
 */
export const CATALOG_SYNC_LOCK_NAMESPACE = 1_277_934_572;

function requireCatalogLockShopId(shopId: number): number {
  if (!Number.isSafeInteger(shopId) || shopId <= 0 || shopId > MAX_POSTGRES_INTEGER) {
    throw new TypeError("Catalog sync lock shop id must fit a positive PostgreSQL INTEGER");
  }
  return shopId;
}

export async function acquireCatalogSyncLock(
  tx: Pick<Prisma.TransactionClient, "$executeRaw">,
  shopId: number,
): Promise<void> {
  const safeShopId = requireCatalogLockShopId(shopId);
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${CATALOG_SYNC_LOCK_NAMESPACE}, ${safeShopId})`;
}
