import type { Prisma } from "../generated/prisma/client.ts";
import {
  classifyCompositeComponentSku,
  type CompositeComponentKindLabel,
} from "./storefront-projection.ts";

/**
 * PR #81 — the single authority for "this 2-piece composite is a sellable subset of one active
 * 3-piece combo". PDP discovery, the cart and the checkout snapshot all ask this module, so the
 * three boundaries cannot drift into similar-but-different interpretations of the same rule.
 *
 * It fails closed. A subset is authorized only when:
 *
 * - it has exactly two distinct components whose roles are exactly `{ÁO, CV}` (SET VÁY) or
 *   `{ÁO, QUẦN}` (SET QUẦN); and
 * - ONE parent variant — present, active, on a present and active product, and not the subset
 *   itself — has exactly three distinct components with roles `{ÁO, CV, QUẦN}` and contains every
 *   component of the subset; and
 * - every edge on both sides has `CompositeComponentMirror.quantity === 1`. Quantity is commerce
 *   truth (ADR 0014 reserves `lineQuantity × quantity` physical units), so `{ÁO x2, CV x1}` is not
 *   the 2-piece SET VÁY it would otherwise look like. Multiplier-aware subsets are deliberately not
 *   modelled: anything other than one unit per piece fails closed.
 *
 * Checking each component against *some* active parent is not enough: Áo could belong to COMBO A
 * and Váy to COMBO B while no single combo contains both, and that pairing is not a subset of
 * anything the shop sells.
 */

export type CompositeSubSetKind = "SET VÁY" | "SET QUẦN";

export const COMPOSITE_SUB_SET_KIND_KEYS: Readonly<Record<CompositeSubSetKind, string>> = {
  "SET VÁY": "sub-set-vay",
  "SET QUẦN": "sub-set-quan",
};

export const COMPOSITE_SUB_SET_ORDER: readonly CompositeSubSetKind[] = ["SET VÁY", "SET QUẦN"];

export type CompositeSubSetPiece = Readonly<{
  componentVariantId: string;
  /** Units of this component the composite consumes (`CompositeComponentMirror.quantity`). */
  quantity: number;
  /** The component's website SKU, falling back to its Pancake display id, as PDP grouping does. */
  roleSku: string | null;
}>;

export type CompositeSubSetComboCandidate = Readonly<{
  variantId: string;
  isSellable: boolean;
  components: readonly CompositeSubSetPiece[];
}>;

function rolesOf(pieces: readonly CompositeSubSetPiece[]): CompositeComponentKindLabel[] | null {
  const ids = new Set(pieces.map((piece) => piece.componentVariantId));
  if (ids.size !== pieces.length) return null;
  if (!pieces.every((piece) => piece.quantity === 1)) return null;

  const roles: CompositeComponentKindLabel[] = [];
  for (const piece of pieces) {
    const role = classifyCompositeComponentSku(piece.roleSku);
    if (role === null) return null;
    roles.push(role);
  }
  return new Set(roles).size === roles.length ? roles : null;
}

/** The subset kind a component list has the exact shape of, or `null`. */
export function classifyCompositeSubSetShape(
  pieces: readonly CompositeSubSetPiece[],
): CompositeSubSetKind | null {
  if (pieces.length !== 2) return null;
  const roles = rolesOf(pieces);
  if (roles === null || !roles.includes("ÁO LẺ")) return null;
  if (roles.includes("CV LẺ")) return "SET VÁY";
  if (roles.includes("QUẦN LẺ")) return "SET QUẦN";
  return null;
}

/** Whether a component list is exactly one unit each of one ÁO, one CV and one QUẦN. */
export function isThreePieceComboShape(pieces: readonly CompositeSubSetPiece[]): boolean {
  if (pieces.length !== 3) return false;
  const roles = rolesOf(pieces);
  return (
    roles !== null &&
    roles.includes("ÁO LẺ") &&
    roles.includes("CV LẺ") &&
    roles.includes("QUẦN LẺ")
  );
}

/**
 * The subset kind this variant is authorized to be sold as, or `null` when it is not an exact
 * subset of one sellable 3-piece combo among `candidateCombos`.
 */
export function resolveCompositeSubSetAuthority({
  subSetVariantId,
  subSetComponents,
  candidateCombos,
}: Readonly<{
  subSetVariantId: string;
  subSetComponents: readonly CompositeSubSetPiece[];
  candidateCombos: readonly CompositeSubSetComboCandidate[];
}>): CompositeSubSetKind | null {
  const kind = classifyCompositeSubSetShape(subSetComponents);
  if (kind === null) return null;

  const authorized = candidateCombos.some((combo) => {
    if (!combo.isSellable || combo.variantId === subSetVariantId) return false;
    if (!isThreePieceComboShape(combo.components)) return false;
    const comboComponentIds = new Set(combo.components.map((piece) => piece.componentVariantId));
    return subSetComponents.every((piece) => comboComponentIds.has(piece.componentVariantId));
  });

  return authorized ? kind : null;
}

/**
 * The Prisma select a cart or checkout variant row needs so `isCompositeSubSetVariantAuthorized`
 * can decide from server truth. Reads each component's parents together with those parents' full
 * component lists, which is what "one same combo contains all of them" has to compare.
 */
export const compositeSubSetAuthorityComponentSelection = {
  orderBy: [{ componentVariantId: "asc" as const }],
  select: {
    componentVariantId: true,
    quantity: true,
    componentVariant: {
      select: {
        sku: true,
        pancakeDisplayId: true,
        compositeParents: {
          select: {
            parentVariant: {
              select: {
                id: true,
                isPresent: true,
                isActive: true,
                product: { select: { isPresent: true, isActive: true } },
                compositeComponents: {
                  select: {
                    componentVariantId: true,
                    quantity: true,
                    componentVariant: { select: { sku: true, pancakeDisplayId: true } },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
} satisfies Prisma.VariantMirror$compositeComponentsArgs;

type RolePieceRow = Readonly<{
  componentVariantId: string;
  quantity: number;
  componentVariant: Readonly<{ sku: string | null; pancakeDisplayId: string | null }>;
}>;

type AuthorityComponentRow = Readonly<{
  componentVariantId: string;
  quantity: number;
  componentVariant: Readonly<{
    sku: string | null;
    pancakeDisplayId: string | null;
    compositeParents: readonly Readonly<{
      parentVariant: Readonly<{
        id: string;
        isPresent: boolean;
        isActive: boolean;
        product: Readonly<{ isPresent: boolean; isActive: boolean }>;
        compositeComponents: readonly RolePieceRow[];
      }>;
    }>[];
  }>;
}>;

export function toCompositeSubSetPiece(row: RolePieceRow): CompositeSubSetPiece {
  return {
    componentVariantId: row.componentVariantId,
    quantity: row.quantity,
    roleSku: row.componentVariant.sku ?? row.componentVariant.pancakeDisplayId,
  };
}

/** Adapter over `compositeSubSetAuthorityComponentSelection` rows for the cart and checkout. */
export function resolveCompositeSubSetAuthorityFromRows({
  subSetVariantId,
  components,
}: Readonly<{
  subSetVariantId: string;
  components: readonly AuthorityComponentRow[];
}>): CompositeSubSetKind | null {
  const candidates = new Map<string, CompositeSubSetComboCandidate>();
  for (const component of components) {
    for (const { parentVariant } of component.componentVariant.compositeParents) {
      if (candidates.has(parentVariant.id)) continue;
      candidates.set(parentVariant.id, {
        variantId: parentVariant.id,
        isSellable:
          parentVariant.isPresent &&
          parentVariant.isActive &&
          parentVariant.product.isPresent &&
          parentVariant.product.isActive,
        components: parentVariant.compositeComponents.map(toCompositeSubSetPiece),
      });
    }
  }

  return resolveCompositeSubSetAuthority({
    subSetVariantId,
    subSetComponents: components.map(toCompositeSubSetPiece),
    candidateCombos: [...candidates.values()],
  });
}
