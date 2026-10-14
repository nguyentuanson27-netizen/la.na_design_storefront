/**
 * Persistence for the buyer's gift choices (GQ11).
 *
 * THIS IS A LOW-LEVEL PRIMITIVE, NOT AN AUTHORITY. It stores and reads choices; it does not decide
 * whether a choice is *allowed* (campaign active, variant in the allowlist, within the entitlement,
 * in stock, the buyer's cart). Only the gift selection mutation (GQ12) may call `setCartGiftSelection`,
 * after it has read the live campaign and validated scope, entitlement and stock under the cart lock.
 * Nothing read from here is a price or an entitlement.
 *
 * `freshness: "CURRENT"` means only that the stored revision equals the campaign's revision now. It
 * does NOT mean the buyer approved the current rule, and an empty `issues` list does NOT mean the
 * choice is valid or consented. Callers (GQ12, cart UI, checkout, quote proof) must recompute the
 * entitlement and obtain the buyer's explicit confirmation themselves; they must never treat a row, a
 * CURRENT freshness or an empty `issues` as consent.
 *
 * Revision rule (no silent re-approval): a write is accepted only when the revision it supplies is the
 * campaign's LIVE revision, checked in the same statement while the campaign row is share-locked.
 * A future revision is refused, so an admin bump can never turn an old choice CURRENT; a bump leaves
 * existing rows STALE until a write supplies the live revision.
 *
 * Lifecycle rule (FR-06, nothing silently lost): rows cascade only from the cart (the cart is gone).
 * A hard delete of a chosen variant or campaign is RESTRICTed by the database, so a choice is never
 * erased as an implicit opt-out. Catalog sync only soft-deletes (`isPresent`/`isActive` false) and
 * campaigns are disabled, not deleted; the list reports those as `issues` so the buyer is told.
 *
 * Writes are single statements keyed by the `(cart, campaign, variant)` unique key, so concurrent
 * writers cannot create a duplicate or push a quantity past its bound. They set an absolute quantity
 * (idempotent on retry) rather than add to one.
 */

import { randomUUID } from "node:crypto";

import type { Prisma, PrismaClient } from "../generated/prisma/client.ts";

/** A client or a transaction. */
type Client =
  | Pick<PrismaClient, "cartGiftSelection" | "giftQuantityCampaign" | "$queryRaw">
  | Pick<Prisma.TransactionClient, "cartGiftSelection" | "giftQuantityCampaign" | "$queryRaw">;

/** Same as the `CartGiftSelection_quantity_check` CHECK and the per-campaign gift cap (`maxGiftsPerOrder <= 100`). */
export const MAX_GIFT_SELECTION_QUANTITY = 100;
/** One cart never holds more distinct gift choices than this; a read past it fails closed. */
export const MAX_GIFT_SELECTION_LINES = 100;
const MAX_ID_LENGTH = 64;
const MAX_CAMPAIGN_REVISION = 2_147_483_647;
const POSTGRES_FOREIGN_KEY_VIOLATION = "23503";

export type GiftSelectionFreshness = "CURRENT" | "STALE";

/**
 * A stored choice. `campaignRevision` is the revision the buyer chose under; `currentCampaignRevision`
 * is the campaign's revision now. Neither is a price or an entitlement.
 */
/**
 * Why a stored choice must be shown to the buyer rather than relied on. Empty does NOT mean valid or
 * approved. Stock here is the mirrored warehouse total only (composite and reserved capacity are
 * GQ10/GQ12's call), so `NO_MIRRORED_STOCK` is an advisory signal that errs towards telling the buyer.
 */
export type GiftSelectionIssue = "STALE_REVISION" | "CAMPAIGN_DISABLED" | "VARIANT_INACTIVE" | "NO_MIRRORED_STOCK";

export type CartGiftSelectionRecord = Readonly<{
  campaignId: string;
  variantId: string;
  quantity: number;
  campaignRevision: number;
  currentCampaignRevision: number;
  /** Revision match only. NOT buyer approval. */
  freshness: GiftSelectionFreshness;
  campaignEnabled: boolean;
  variantActive: boolean;
  mirroredStock: number;
  issues: readonly GiftSelectionIssue[];
}>;

export type CartGiftSelectionKey = Readonly<{ cartId: string; campaignId: string; variantId: string }>;

export type GiftSelectionWriteFailure = "INVALID_KEY" | "INVALID_QUANTITY" | "INVALID_REVISION" | "REFERENCE_NOT_FOUND" | "REVISION_MISMATCH";

function validKey(key: CartGiftSelectionKey): boolean {
  return [key.cartId, key.campaignId, key.variantId].every(
    (value) => typeof value === "string" && value.length > 0 && value.length <= MAX_ID_LENGTH,
  );
}

/**
 * Sets the buyer's chosen quantity for one gift. Absolute and idempotent: one
 * `INSERT .. SELECT .. ON CONFLICT DO UPDATE` on the `(cart, campaign, variant)` key, so concurrent
 * callers leave exactly one row holding one writer's quantity and revision (last writer wins), never a sum.
 *
 * `campaignRevision` must be the campaign's live revision (GIFT_ITEM campaigns only). The campaign row
 * is share-locked in the same statement, so a concurrent admin bump waits for the write and a bump that
 * already committed makes it fail: a wrong or future revision is never stored. Otherwise
 * `REVISION_MISMATCH`. `REFERENCE_NOT_FOUND` means the campaign (or a gift campaign of that id), the cart
 * or the variant does not exist. Inside an interactive transaction a database error aborts that
 * transaction (PostgreSQL), so treat `REFERENCE_NOT_FOUND` from a missing cart/variant as final there.
 *
 * Authorization, scope, entitlement and stock are NOT checked here: see the module note.
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
  let written: Array<{ id: string }>;
  try {
    written = await client.$queryRaw<Array<{ id: string }>>`
      INSERT INTO "CartGiftSelection" ("id", "cartId", "campaignId", "campaignKind", "variantId", "quantity", "campaignRevision", "updatedAt")
      SELECT ${randomUUID()}, ${input.cartId}, c."id", 'GIFT_ITEM', ${input.variantId}, ${input.quantity}, c."revision", NOW()
      FROM "GiftQuantityCampaign" c
      WHERE c."id" = ${input.campaignId} AND c."kind" = 'GIFT_ITEM' AND c."revision" = ${input.campaignRevision}
      FOR SHARE OF c
      ON CONFLICT ("cartId", "campaignId", "variantId")
      DO UPDATE SET "quantity" = EXCLUDED."quantity", "campaignRevision" = EXCLUDED."campaignRevision", "updatedAt" = NOW()
      RETURNING "id"`;
  } catch (error) {
    if (isForeignKeyViolation(error)) return { ok: false, reason: "REFERENCE_NOT_FOUND" };
    throw error;
  }
  if (written.length > 0) return { ok: true };
  const campaign = await client.giftQuantityCampaign.findFirst({
    where: { id: input.campaignId, kind: "GIFT_ITEM" },
    select: { id: true },
  });
  return { ok: false, reason: campaign === null ? "REFERENCE_NOT_FOUND" : "REVISION_MISMATCH" };
}

function isForeignKeyViolation(error: unknown): boolean {
  const e = error as { code?: unknown; meta?: { code?: unknown; driverAdapterError?: { cause?: { originalCode?: unknown } } } } | null;
  return (
    e?.meta?.code === POSTGRES_FOREIGN_KEY_VIOLATION ||
    e?.meta?.driverAdapterError?.cause?.originalCode === POSTGRES_FOREIGN_KEY_VIOLATION ||
    (typeof (error as { message?: unknown } | null)?.message === "string" && /foreign key constraint|23503/i.test((error as Error).message))
  );
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
 * The cart's gift choices in a stable order, with the facts the buyer must be told about (stale
 * revision, disabled campaign, inactive or unstocked variant). A choice is reported, never dropped or
 * repaired. Bounded: a cart with more than the bound is a defect, not a case to truncate, so it fails
 * closed instead of quietly dropping the rest.
 */
export async function listCartGiftSelections(client: Client, cartId: string): Promise<readonly CartGiftSelectionRecord[]> {
  if (typeof cartId !== "string" || cartId.length === 0 || cartId.length > MAX_ID_LENGTH) return [];
  const rows = await client.cartGiftSelection.findMany({
    where: { cartId },
    orderBy: [{ campaignId: "asc" }, { variantId: "asc" }],
    take: MAX_GIFT_SELECTION_LINES + 1,
    select: {
      campaignId: true,
      variantId: true,
      quantity: true,
      campaignRevision: true,
      campaign: { select: { revision: true, isEnabled: true } },
      variant: { select: { isActive: true, isPresent: true, warehouseStocks: { select: { quantity: true } } } },
    },
  });
  if (rows.length > MAX_GIFT_SELECTION_LINES) throw new CartGiftSelectionBoundError();
  return rows.map((row) => {
    const freshness = classifyGiftSelectionFreshness(row, row.campaign.revision);
    const variantActive = row.variant.isActive && row.variant.isPresent;
    const mirroredStock = row.variant.warehouseStocks.reduce((total, stock) => total + stock.quantity, 0);
    const issues: GiftSelectionIssue[] = [];
    if (freshness === "STALE") issues.push("STALE_REVISION");
    if (!row.campaign.isEnabled) issues.push("CAMPAIGN_DISABLED");
    if (!variantActive) issues.push("VARIANT_INACTIVE");
    if (!(mirroredStock > 0)) issues.push("NO_MIRRORED_STOCK");
    return {
      campaignId: row.campaignId,
      variantId: row.variantId,
      quantity: row.quantity,
      campaignRevision: row.campaignRevision,
      currentCampaignRevision: row.campaign.revision,
      freshness,
      campaignEnabled: row.campaign.isEnabled,
      variantActive,
      mirroredStock,
      issues,
    };
  });
}

/** A choice made under another revision of its campaign is stale: shown, never silently applied. */
export function classifyGiftSelectionFreshness(
  selection: Readonly<{ campaignRevision: number }>,
  currentCampaignRevision: number,
): GiftSelectionFreshness {
  return selection.campaignRevision === currentCampaignRevision ? "CURRENT" : "STALE";
}
