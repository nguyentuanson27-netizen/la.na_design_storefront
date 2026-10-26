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
