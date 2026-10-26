"use server";

import { cookies } from "next/headers";
import { readAuthServerConfig } from "../auth/config.ts";
import { prisma } from "../db/prisma.ts";
import { readPancakeShopId } from "../integrations/pancake/config.ts";
import { readAnonymousCartCookie } from "./anonymous-cart-cookie.ts";
import { createVoucherHoldFlow } from "./voucher-hold-flow.ts";

/**
 * Voucher v1 (V12): the ONLY entry that can hold quota or issue a submit-capable voucher proof (spec §5.1, TG-12,
 * ADR 0019 D-4). A Server Action is POST-only and origin-checked by Next, so a GET, a `<Link>` prefetch, a hover, a
 * reload or a crawler cannot reach it. The cart is the HttpOnly bearer cookie, never an argument. The browser names
 * only the total it was shown; every amount, voucher and expiry is derived by the server, and the flow answers
 * "preview only" until both the feature gate and the shop's POS acceptance allow a real hold.
 *
 * The answer carries the signed HELD proof for the checkout form (same pattern as the checkout quote proof); it
 * returns no money the server did not compute and nothing about other buyers or campaigns.
 */

const MAX_TOTAL_VND = 100_000_000_000;

function parseExpectedTotal(input: unknown): number | null {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return null;
  const value = (input as { expectedTotalVnd?: unknown }).expectedTotalVnd;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= MAX_TOTAL_VND ? value : null;
}

export async function holdStorefrontVouchers(input: unknown) {
  const expectedTotalVnd = parseExpectedTotal(input);
  const cartId = readAnonymousCartCookie(await cookies());
  if (expectedTotalVnd === null) return { ok: false, reason: "INVALID_INPUT" } as const;
  if (cartId === null) return { ok: false, reason: "CART_UNAVAILABLE" } as const;
  const secret = readAuthServerConfig().secret;
  const flow = createVoucherHoldFlow(prisma, { shopId: readPancakeShopId(), attemptSecret: secret, proofSecret: secret });
  const result = await flow.hold({ cartId, expectedTotalVnd });
  if (!result.ok) return result;
  if (result.state === "NONE") return { ok: true, state: "NONE", totalPayableVnd: result.totalPayableVnd } as const;
  return { ok: true, state: "HELD", proof: result.proof, expiresAtMs: result.expiresAtMs, totalPayableVnd: result.totalPayableVnd } as const;
}
