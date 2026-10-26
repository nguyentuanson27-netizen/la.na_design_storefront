import { readAuthServerConfig } from "../auth/config.ts";
import type { PrismaClient } from "../generated/prisma/client.ts";

import { createVoucherHoldService } from "./voucher-hold-service.ts";
import type { OwnVoucherHold } from "./voucher-preview.ts";

/**
 * The live holds of this cart's own attempt, for the READ paths (picker, cart): the preview must keep an
 * entitlement the shopper already holds in play, or the digest it shows would differ from the one the hold POST
 * recomputes. Read-only. Any failure is "none": the preview then simply shows what is currently takeable.
 */
export async function readCartOwnVoucherHolds(client: PrismaClient, cartId: string): Promise<readonly OwnVoucherHold[]> {
  try {
    return await createVoucherHoldService(client, { attemptSecret: readAuthServerConfig().secret }).readOwnLiveHolds(cartId);
  } catch {
    return [];
  }
}

/** When the earliest of this cart's live holds expires (database clock), for the checkout's "held until"; null when none or unreadable. */
export async function readCartHeldUntilMs(client: PrismaClient, cartId: string): Promise<number | null> {
  try {
    const holds = await createVoucherHoldService(client, { attemptSecret: readAuthServerConfig().secret }).readOwnLiveHoldFactsIn(client, cartId);
    return holds.length === 0 ? null : Math.min(...holds.map((hold) => hold.expiresAt.getTime()));
  } catch {
    return null;
  }
}
