import { createHash } from "node:crypto";

import type { PrismaClient } from "../generated/prisma/client.ts";

/**
 * Voucher v1 (V15): throttle for typed/linked voucher codes (spec §6, AC-13).
 *
 * Two buckets in the existing `rateLimit` table, consumed together BEFORE a code is looked up: one per cart
 * (so a single browser cannot grind through guesses) and one per shop (so spreading guesses over many fresh carts
 * does not escape the limit). The cart bucket key is a hash, never the cart id, so the cart's bearer identity does
 * not sit in a table. Every attempt counts, valid or not -- the limiter must not tell a guesser which codes exist.
 */

type RateLimitProfile = Readonly<{ name: string; cartMax: number; shopMax: number; windowMs: number }>;

const CODE_PROFILE: RateLimitProfile = { name: "voucher-code", cartMax: 10, shopMax: 300, windowMs: 60_000 };
/** Hold grants are idempotent, so a reload must not lock a real buyer out; a flood of fresh carts still hits the shop bucket (ADR 0019 D-5). */
const HOLD_PROFILE: RateLimitProfile = { name: "voucher-hold", cartMax: 20, shopMax: 600, windowMs: 60_000 };

export type VoucherCodeRateLimiter = Readonly<{
  consume(input: Readonly<{ cartId: string; shopId: number; now: Date }>): Promise<boolean>;
}>;

export function createVoucherCodeRateLimiter(client: PrismaClient): VoucherCodeRateLimiter {
  return createProfileLimiter(client, CODE_PROFILE);
}

/** The same two-bucket limiter with the hold profile and its own keys (a code throttle never spends hold budget). */
export function createVoucherHoldRateLimiter(client: PrismaClient): VoucherCodeRateLimiter {
  return createProfileLimiter(client, HOLD_PROFILE);
}

function createProfileLimiter(client: PrismaClient, profile: RateLimitProfile): VoucherCodeRateLimiter {
  async function bucket(key: string, now: Date, windowMs: number, max: number): Promise<boolean> {
    const nowMs = BigInt(now.getTime());
    const resetBefore = nowMs - BigInt(windowMs);
    const cap = max + 1;
    const rows = await client.$queryRaw<Array<{ count: number }>>`
      INSERT INTO "rateLimit" AS existing ("id", "key", "count", "lastRequest")
      VALUES (${key}, ${key}, 1, ${nowMs})
      ON CONFLICT ("id") DO UPDATE
      SET
        "count" = CASE
          WHEN existing."lastRequest" <= ${resetBefore} THEN 1
          ELSE LEAST(existing."count" + 1, ${cap})
        END,
        "lastRequest" = CASE
          WHEN existing."lastRequest" <= ${resetBefore} THEN ${nowMs}
          ELSE existing."lastRequest"
        END
      RETURNING "count"
    `;
    if (rows.length !== 1 || !Number.isSafeInteger(rows[0]?.count)) throw new Error("Voucher code rate-limit storage returned an invalid result");
    return rows[0].count <= max;
  }

  return {
    async consume({ cartId, shopId, now }) {
      if (typeof cartId !== "string" || cartId.length === 0 || cartId.length > 128) throw new TypeError("Voucher code rate limit needs a cart identity");
      if (!Number.isSafeInteger(shopId) || shopId <= 0) throw new TypeError("Voucher code rate limit needs a shop");
      if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new TypeError("Voucher code rate-limit time must be valid");
      const cartHash = createHash("sha256").update(`${profile.name}-cart:v1\0`).update(cartId).digest("hex");
      // Both buckets are consumed on every attempt: a refused attempt still counts against the other.
      const cartAllowed = await bucket(`${profile.name}-cart:${cartHash}`, now, profile.windowMs, profile.cartMax);
      const shopAllowed = await bucket(`${profile.name}-shop:${shopId}`, now, profile.windowMs, profile.shopMax);
      return cartAllowed && shopAllowed;
    },
  };
}
