/**
 * Persistence for the buyer's gift choices (GQ11).
 *
 * This module only stores and reads choices. It does not decide whether a choice is *allowed* --
 * campaign active, variant in the allowlist, within the entitlement, in stock -- which is GQ12's
 * authorization, recomputed from the live cart. Nothing read from here is ever a price or an
 * entitlement: a row says "the buyer picked this", and a row whose `campaignRevision` no longer
 * matches the campaign is reported stale for the buyer to re-confirm, never repaired in place.
 *
 * Writes are single statements keyed by the `(cart, campaign, variant)` unique key, so concurrent
 * writers cannot create a duplicate or push a quantity past its bound. They set an absolute quantity
 * (idempotent on retry) rather than add to one.
 */

import type { Prisma, PrismaClient } from "../generated/prisma/client.ts";

/** A client or a transaction. */
type Client = Pick<PrismaClient, "cartGiftSelection"> | Pick<Prisma.TransactionClient, "cartGiftSelection">;

/** Same as the `CartGiftSelection_quantity_check` CHECK and the per-campaign gift cap (`maxGiftsPerOrder <= 100`). */
export const MAX_GIFT_SELECTION_QUANTITY = 100;
/** One cart never holds more distinct gift choices than this; a read past it fails closed. */
export const MAX_GIFT_SELECTION_LINES = 100;
const MAX_ID_LENGTH = 64;
const MAX_CAMPAIGN_REVISION = 2_147_483_647;
const PRISMA_FOREIGN_KEY_VIOLATION = "P2003";

export type GiftSelectionFreshness = "CURRENT" | "STALE";

/**
 * A stored choice. `campaignRevision` is the revision the buyer chose under; `currentCampaignRevision`
 * is the campaign's revision now. Neither is a price or an entitlement.
 */
export type CartGiftSelectionRecord = Readonly<{
  campaignId: string;
  variantId: string;
  quantity: number;
  campaignRevision: number;
  currentCampaignRevision: number;
  freshness: GiftSelectionFreshness;
}>;

export type CartGiftSelectionKey = Readonly<{ cartId: string; campaignId: string; variantId: string }>;

export type GiftSelectionWriteFailure = "INVALID_KEY" | "INVALID_QUANTITY" | "INVALID_REVISION" | "REFERENCE_NOT_FOUND";

function validKey(key: CartGiftSelectionKey): boolean {
  return [key.cartId, key.campaignId, key.variantId].every(
    (value) => typeof value === "string" && value.length > 0 && value.length <= MAX_ID_LENGTH,
  );
}

/**
 * Sets the buyer's chosen quantity for one gift. Absolute and idempotent: it is a single
 * `INSERT .. ON CONFLICT DO UPDATE` on the `(cart, campaign, variant)` key, so concurrent callers
 * leave exactly one row holding one writer's quantity and revision (last writer wins), never a sum.
 *
 * `REFERENCE_NOT_FOUND` means the cart, the variant or the campaign does not exist, or the campaign
 * is not a gift campaign. Inside an interactive transaction the failed statement also aborts that
 * transaction (PostgreSQL), so treat it as final there. Whether the choice is *allowed* is GQ12's call.
 */
export async function setCartGiftSelection(
  client: Client,
  input: CartGiftSelectionKey & Readonly<{ quantity: number; campaignRevision: number }>,
): Promise<{ ok: true } | { ok: false; reason: GiftSelectionWriteFailure }> {
  if (!validKey(input)) return { ok: false, reason: "INVALID_KEY" };
  if (!Number.isSafeInteger(input.quantity) || input.quantity < 1 || input.quantity > MAX_GIFT_SELECTION_QUANTITY) {
    return { ok: false, reason: "INVALID_QUANTITY" };
  }
  if (!Number.isSafeInteger(input.campaignRevision) || input.campaignRevision < 1 || input.campaignRevision > MAX_CAMPAIGN_REVISION) {
    return { ok: false, reason: "INVALID_REVISION" };
  }
  try {
    await client.cartGiftSelection.upsert({
      where: { cartId_campaignId_variantId: { cartId: input.cartId, campaignId: input.campaignId, variantId: input.variantId } },
      create: {
        cartId: input.cartId,
        campaignId: input.campaignId,
        variantId: input.variantId,
        quantity: input.quantity,
        campaignRevision: input.campaignRevision,
      },
      update: { quantity: input.quantity, campaignRevision: input.campaignRevision },
    });
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === PRISMA_FOREIGN_KEY_VIOLATION) return { ok: false, reason: "REFERENCE_NOT_FOUND" };
    throw error;
  }
  return { ok: true };
}

/** Removes one gift choice. Removing a choice that is not there is a successful no-op. */
export async function removeCartGiftSelection(client: Client, key: CartGiftSelectionKey): Promise<{ removed: boolean }> {
  if (!validKey(key)) return { removed: false };
  const result = await client.cartGiftSelection.deleteMany({
    where: { cartId: key.cartId, campaignId: key.campaignId, variantId: key.variantId },
  });
  return { removed: result.count > 0 };
}

/** Removes every gift choice of one campaign in a cart (the buyer opted out of it entirely). */
export async function clearCartGiftSelections(
  client: Client,
  input: Readonly<{ cartId: string; campaignId?: string }>,
): Promise<{ removed: number }> {
  if (typeof input.cartId !== "string" || input.cartId.length === 0 || input.cartId.length > MAX_ID_LENGTH) return { removed: 0 };
  const result = await client.cartGiftSelection.deleteMany({
    where: { cartId: input.cartId, ...(input.campaignId === undefined ? {} : { campaignId: input.campaignId }) },
  });
  return { removed: result.count };
}

export class CartGiftSelectionBoundError extends Error {
  constructor() {
    super("A cart holds more gift selections than the bound allows");
    this.name = "CartGiftSelectionBoundError";
  }
}

/**
 * The cart's gift choices in a stable order. Bounded: a cart with more than the bound is a defect,
 * not a case to truncate, so it fails closed instead of quietly dropping the rest.
 */
export async function listCartGiftSelections(client: Client, cartId: string): Promise<readonly CartGiftSelectionRecord[]> {
  if (typeof cartId !== "string" || cartId.length === 0 || cartId.length > MAX_ID_LENGTH) return [];
  const rows = await client.cartGiftSelection.findMany({
    where: { cartId },
    orderBy: [{ campaignId: "asc" }, { variantId: "asc" }],
    take: MAX_GIFT_SELECTION_LINES + 1,
    select: { campaignId: true, variantId: true, quantity: true, campaignRevision: true, campaign: { select: { revision: true } } },
  });
  if (rows.length > MAX_GIFT_SELECTION_LINES) throw new CartGiftSelectionBoundError();
  return rows.map((row) => ({
    campaignId: row.campaignId,
    variantId: row.variantId,
    quantity: row.quantity,
    campaignRevision: row.campaignRevision,
    currentCampaignRevision: row.campaign.revision,
    freshness: classifyGiftSelectionFreshness(row, row.campaign.revision),
  }));
}

/** A choice made under another revision of its campaign is stale: shown, never silently applied. */
export function classifyGiftSelectionFreshness(
  selection: Readonly<{ campaignRevision: number }>,
  currentCampaignRevision: number,
): GiftSelectionFreshness {
  return selection.campaignRevision === currentCampaignRevision ? "CURRENT" : "STALE";
}
