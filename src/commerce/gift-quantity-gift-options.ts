/**
 * Read-only gift option lookups for the admin form (GQ13b): a bounded variant search to build the
 * allowlist, and the labels of an allowlist already stored.
 *
 * Nothing here decides what may be saved or published. `gift-quantity-gift-rule.ts` does, and
 * re-checks everything on the server. These reads only tell the operator what a variant is and why
 * the publish rules (ADR 0016 D-04: READY stock, never composite, present and active) would refuse
 * it, so a bad choice is visible before the save instead of after the refusal.
 */

import type { PrismaClient } from "../generated/prisma/client.ts";
import { isBoundedPromotionIdentifier } from "./promotion-activation.ts";

export const GIFT_OPTION_SEARCH_LIMIT = 50;
const MAX_SEARCH_LENGTH = 120;
const MAX_LABEL_LOOKUP = 500;

export type GiftOptionUnavailableReason = "INACTIVE" | "COMPOSITE" | "NO_STOCK";

export type GiftOptionCandidate = Readonly<{
  id: string;
  productId: string;
  productName: string;
  /** "Product - colour / size (sku)", already safe to render. */
  label: string;
  /** Mirrored warehouse stock; advisory (the cart nets reservations and paid demand on every read). */
  stock: number;
  /** Null when the variant satisfies today's publish rules. */
  unavailable: GiftOptionUnavailableReason | null;
}>;

const optionSelection = {
  id: true,
  productId: true,
  sku: true,
  color: true,
  size: true,
  isPresent: true,
  isActive: true,
  product: { select: { name: true, isPresent: true, isActive: true } },
  compositeComponents: { select: { componentVariantId: true }, take: 1 },
  warehouseStocks: { select: { quantity: true } },
} as const;

type OptionRow = Readonly<{
  id: string;
  productId: string;
  sku: string | null;
  color: string | null;
  size: string | null;
  isPresent: boolean;
  isActive: boolean;
  product: Readonly<{ name: string; isPresent: boolean; isActive: boolean }>;
  compositeComponents: readonly unknown[];
  warehouseStocks: readonly Readonly<{ quantity: number }>[];
}>;

/** Same order of checks as `giftOptionErrors`, so the hint and the publish refusal can never disagree. */
function toCandidate(row: OptionRow): GiftOptionCandidate {
  const stock = row.warehouseStocks.reduce((sum, entry) => sum + entry.quantity, 0);
  const attributes = [row.color, row.size].filter((part): part is string => typeof part === "string" && part.trim().length > 0).join(" / ");
  const sku = row.sku && row.sku.trim().length > 0 ? ` (${row.sku.trim()})` : "";
  const unavailable: GiftOptionUnavailableReason | null =
    !row.isPresent || !row.isActive || !row.product.isPresent || !row.product.isActive
      ? "INACTIVE"
      : row.compositeComponents.length > 0
        ? "COMPOSITE"
        : stock < 1
          ? "NO_STOCK"
          : null;
  return {
    id: row.id,
    productId: row.productId,
    productName: row.product.name,
    label: `${row.product.name}${attributes.length > 0 ? ` - ${attributes}` : ""}${sku}`,
    stock,
    unavailable,
  };
}

/**
 * Bounded variant search inside one shop (the cart only ever reads that shop's variants). Unusable
 * variants are returned, flagged, rather than hidden, so the operator learns why one is missing.
 */
export async function searchGiftOptionCandidates(
  client: Pick<PrismaClient, "variantMirror">,
  input: Readonly<{ shopId: number; search: unknown }>,
): Promise<readonly GiftOptionCandidate[]> {
  const trimmed = typeof input.search === "string" ? input.search.trim().slice(0, MAX_SEARCH_LENGTH) : "";
  const rows = await client.variantMirror.findMany({
    where: {
      isPresent: true,
      product: { pancakeShopId: input.shopId, isPresent: true },
      ...(trimmed.length > 0
        ? {
            OR: [
              { sku: { contains: trimmed, mode: "insensitive" as const } },
              { color: { contains: trimmed, mode: "insensitive" as const } },
              { size: { contains: trimmed, mode: "insensitive" as const } },
              { product: { name: { contains: trimmed, mode: "insensitive" as const } } },
            ],
          }
        : {}),
    },
    orderBy: [{ product: { name: "asc" } }, { sku: "asc" }, { id: "asc" }],
    take: GIFT_OPTION_SEARCH_LIMIT,
    select: optionSelection,
  });
  return rows.map(toCandidate);
}

/** Labels (and today's availability) of an allowlist already stored; unknown ids are simply absent. */
export async function readGiftOptionCandidates(
  client: Pick<PrismaClient, "variantMirror">,
  variantIds: readonly string[],
): Promise<readonly GiftOptionCandidate[]> {
  const ids = [...new Set(variantIds)].filter((id) => isBoundedPromotionIdentifier(id)).slice(0, MAX_LABEL_LOOKUP);
  if (ids.length === 0) return [];
  const rows = await client.variantMirror.findMany({
    where: { id: { in: ids } },
    orderBy: [{ product: { name: "asc" } }, { sku: "asc" }, { id: "asc" }],
    select: optionSelection,
  });
  return rows.map(toCandidate);
}
