import type { PrismaClient } from "../generated/prisma/client.ts";
import { createStorefrontCatalogRepository } from "./storefront-catalog.ts";
import {
  buildStorefrontProductProjection,
  resolveCompositeComponentGroupLabel,
  type StorefrontCompositeComponentGroup,
  type StorefrontCompositeSubSetGroup,
} from "./storefront-projection.ts";
import {
  COMPOSITE_SUB_SET_KIND_KEYS,
  COMPOSITE_SUB_SET_ORDER,
  isThreePieceComboShape,
  resolveCompositeSubSetAuthority,
  toCompositeSubSetPiece,
  type CompositeSubSetComboCandidate,
  type CompositeSubSetKind,
} from "./composite-subset-authority.ts";
import type { StorefrontVariantFacts } from "./storefront-product.ts";
import { buildPromotionalStorefrontPricing } from "./storefront-promotion-projection.ts";
import { readApplicablePromotionCampaignsBatched } from "./promotion-candidate-batching.ts";
import { vietnamCalendarDate } from "./availability-cycle.ts";
import { readVariantAvailabilityDates } from "./availability-cycle-repository.ts";
import { resolveSellingPolicy } from "./capacity-policy.ts";
import {
  deriveCompositeCapacitySnapshot,
  deriveCompositeSellableStock,
  type CompositeCapacitySnapshot,
} from "./composite-capacity.ts";
import { readAdvisoryHeldQuantities } from "./capacity-advisory.ts";

function sumWarehouseStocks(stocks: readonly { quantity: number }[]): number {
  let total = 0;
  for (const stock of stocks) {
    if (!Number.isFinite(stock.quantity)) {
      throw new Error("Storefront projection contains malformed warehouse quantity");
    }
    total += stock.quantity;
    if (!Number.isFinite(total)) {
      throw new Error("Storefront projection stock total is outside numeric bounds");
    }
  }
  return total;
}

export function createStorefrontProductDetailRepository(client: PrismaClient) {
  const catalog = createStorefrontCatalogRepository(client);

  async function getProductBySlug({
    shopId,
    slug,
    now = new Date(),
  }: { shopId: number; slug: string; now?: Date }) {
    const product = await catalog.getProductBySlug({ shopId, slug });
    if (!product) return null;

    // I9 — website-owned, and deliberately its own read rather than a widened catalog select: the
    // selling policy is not mirrored Pancake data and must not travel with it.
    const sellingPolicyRow = await client.productSellingPolicy.findUnique({
      where: { productId: product.id },
      select: { sellingMode: true, negativeStockLimit: true },
    });
    const sellingPolicy = resolveSellingPolicy(sellingPolicyRow);

    const parentRelations = await client.variantMirror.findMany({
      where: {
        productId: product.id,
        isPresent: true,
        isActive: true,
      },
      orderBy: [{ pancakeVariationId: "asc" }],
      select: {
        id: true,
        pancakeDisplayId: true,
        sku: true,
        compositeComponents: {
          orderBy: [{ componentVariantId: "asc" }],
          select: {
            quantity: true,
            componentVariant: {
              select: {
                id: true,
                pancakeVariationId: true,
                pancakeDisplayId: true,
                sku: true,
                color: true,
                size: true,
                isPresent: true,
                isActive: true,
                pancakeRetailPrice: true,
                pancakeRetailPriceAfterDiscount: true,
                product: {
                  select: {
                    id: true,
                    name: true,
                    pancakeShopId: true,
                    isPresent: true,
                  },
                },
                warehouseStocks: {
                  orderBy: [{ pancakeWarehouseId: "asc" }],
                  select: { quantity: true },
                },
              },
            },
          },
        },
      },
    });

    const hasCompositeGraph = parentRelations.some(
      (parent) => parent.compositeComponents.length > 0,
    );
    // The advisory capacity read model (`capacity-advisory.ts`): units other orders still hold on
    // each component, so a set option and a component option advertise what checkout would accept.
    // Parent variants already arrive with it from the catalog read.
    let heldByVariantId = await readAdvisoryHeldQuantities(
      client,
      parentRelations.flatMap((parent) =>
        parent.compositeComponents.map((edge) => edge.componentVariant.id),
      ),
    );
    const groups = new Map<
      string,
      {
        sortLabel: string;
        skus: (string | null)[];
        variants: Map<string, StorefrontVariantFacts>;
      }
    >();

    const compositeStockByVariantId = new Map<string, number>();
    const compositeCapacityByVariantId = new Map<string, CompositeCapacitySnapshot>();
    // Whether the mirror itself can state a set's availability to a vendor: a publication fact about
    // mirrored rows (`variantAvailabilityResolvedById`), so it is decided without local holds.
    const compositeResolvedByVariantId = new Map<string, boolean>();
    for (const parent of parentRelations) {
      if (parent.compositeComponents.length > 0) {
        compositeStockByVariantId.set(
          parent.id,
          deriveCompositeSellableStock({
            shopId,
            components: parent.compositeComponents.map((edge) => ({
              requiredQuantity: edge.quantity,
              activeReservedQuantity: heldByVariantId.get(edge.componentVariant.id) ?? 0,
              componentVariant: edge.componentVariant,
            })),
          }),
        );
        compositeCapacityByVariantId.set(
          parent.id,
          deriveCompositeCapacitySnapshot({
            shopId,
            components: parent.compositeComponents.map((edge) => ({
              requiredQuantity: edge.quantity,
              activeReservedQuantity: heldByVariantId.get(edge.componentVariant.id) ?? 0,
              componentVariant: edge.componentVariant,
            })),
            sellingMode: sellingPolicy.sellingMode,
            negativeStockLimit: sellingPolicy.negativeStockLimit,
          }),
        );
        compositeResolvedByVariantId.set(
          parent.id,
          deriveCompositeSellableStock({
            shopId,
            components: parent.compositeComponents.map((edge) => ({
              requiredQuantity: edge.quantity,
              componentVariant: edge.componentVariant,
            })),
          }) > 0,
        );
      }

      for (const edge of parent.compositeComponents) {
        const component = edge.componentVariant;
        if (
          component.product.pancakeShopId !== shopId ||
          !component.product.isPresent ||
          !component.isPresent ||
          !component.isActive
        ) {
          continue;
        }

        let group = groups.get(component.product.id);
        if (!group) {
          group = {
            // Preserve the existing child-product ordering so positional kind keys do not drift
            // merely because presentation labels became canonical roles.
            sortLabel: component.product.name,
            skus: [],
            variants: new Map(),
          };
          groups.set(component.product.id, group);
        }
        group.skus.push(component.sku ?? component.pancakeDisplayId);
        if (!group.variants.has(component.id)) {
          group.variants.set(component.id, {
            id: component.id,
            pancakeVariationId: component.pancakeVariationId,
            color: component.color,
            size: component.size,
            sellableStock:
              sumWarehouseStocks(component.warehouseStocks) -
              (heldByVariantId.get(component.id) ?? 0),
            retailPrice: component.pancakeRetailPrice,
            retailPriceAfterDiscount: component.pancakeRetailPriceAfterDiscount,
          });
        }
      }
    }

    const effectiveParentVariants = product.variants.map((v) => {
      const derived = compositeStockByVariantId.get(v.id);
      if (derived === undefined) return v;
      return {
        ...v,
        sellableStock: derived,
        compositeCapacity: compositeCapacityByVariantId.get(v.id),
      };
    });

    const componentGroups: StorefrontCompositeComponentGroup[] = [...groups.values()]
      .sort((left, right) => left.sortLabel.localeCompare(right.sortLabel, "vi"))
      .flatMap((group) => {
        const label = resolveCompositeComponentGroupLabel(group.skus);
        return label === null
          ? []
          : [{ label, variants: [...group.variants.values()] }];
      });

    // PR #81 — discover sibling SET VÁY / SET QUẦN composites of this combo. Which siblings are
    // offered is decided by the shared subset authority, the same one the cart and the checkout
    // snapshot apply, so the PDP never offers a variant a later boundary would refuse (or the
    // reverse). Only this product's own active 3-piece parent variants are candidate combos: a
    // subset of some *other* combo belongs on that combo's page, not this one.
    let subSetGroups: StorefrontCompositeSubSetGroup[] = [];
    const siblingVariantMpnMap: Record<string, string | null> = {};
    const siblingVariantSkuMap: Record<string, string | null> = {};

    const candidateCombos: CompositeSubSetComboCandidate[] = parentRelations
      .map((parent) => ({
        variantId: parent.id,
        // `getProductBySlug` only resolves a present, active product, and `parentRelations` only
        // reads its present, active variants.
        isSellable: true,
        components: parent.compositeComponents.map((edge) =>
          toCompositeSubSetPiece({
            componentVariantId: edge.componentVariant.id,
            quantity: edge.quantity,
            componentVariant: edge.componentVariant,
          }),
        ),
      }))
      .filter((combo) => isThreePieceComboShape(combo.components));
    const comboComponentVariantIds = [
      ...new Set(
        candidateCombos.flatMap((combo) =>
          combo.components.map((piece) => piece.componentVariantId),
        ),
      ),
    ];

    if (comboComponentVariantIds.length > 0) {
      const siblingRelations = await client.variantMirror.findMany({
        where: {
          product: {
            pancakeShopId: shopId,
            isPresent: true,
            id: { not: product.id },
          },
          isPresent: true,
          isActive: true,
          compositeComponents: {
            some: {
              componentVariantId: { in: comboComponentVariantIds },
            },
          },
        },
        orderBy: [{ pancakeVariationId: "asc" }],
        select: {
          id: true,
          pancakeVariationId: true,
          pancakeDisplayId: true,
          sku: true,
          color: true,
          size: true,
          pancakeRetailPrice: true,
          pancakeRetailPriceAfterDiscount: true,
          product: {
            select: {
              sellingPolicy: { select: { sellingMode: true, negativeStockLimit: true } },
            },
          },
          compositeComponents: {
            orderBy: [{ componentVariantId: "asc" }],
            select: {
              quantity: true,
              componentVariantId: true,
              componentVariant: {
                select: {
                  id: true,
                  sku: true,
                  pancakeDisplayId: true,
                  isPresent: true,
                  product: {
                    select: {
                      pancakeShopId: true,
                      isPresent: true,
                    },
                  },
                  warehouseStocks: {
                    orderBy: [{ pancakeWarehouseId: "asc" }],
                    select: { quantity: true },
                  },
                },
              },
            },
          },
        },
      });

      // An accepted sibling is an exact subset of one of this product's combos, so its components
      // are normally already covered; anything not yet read is read once rather than assumed free.
      const unreadComponentIds = siblingRelations.flatMap((sibling) =>
        sibling.compositeComponents
          .map((edge) => edge.componentVariant.id)
          .filter((id) => !heldByVariantId.has(id)),
      );
      if (unreadComponentIds.length > 0) {
        heldByVariantId = new Map([
          ...heldByVariantId,
          ...(await readAdvisoryHeldQuantities(client, unreadComponentIds)),
        ]);
      }

      const variantsByKind = new Map<CompositeSubSetKind, StorefrontVariantFacts[]>();
      for (const sibling of siblingRelations) {
        const kind = resolveCompositeSubSetAuthority({
          subSetVariantId: sibling.id,
          subSetComponents: sibling.compositeComponents.map(toCompositeSubSetPiece),
          candidateCombos,
        });
        if (kind === null) continue;

        const siblingSellingPolicy = resolveSellingPolicy(sibling.product.sellingPolicy);
        const variants = variantsByKind.get(kind) ?? [];
        variants.push({
          id: sibling.id,
          pancakeVariationId: sibling.pancakeVariationId,
          color: sibling.color,
          size: sibling.size,
          sellableStock: deriveCompositeSellableStock({
            shopId,
            components: sibling.compositeComponents.map((edge) => ({
              requiredQuantity: edge.quantity,
              activeReservedQuantity: heldByVariantId.get(edge.componentVariant.id) ?? 0,
              componentVariant: edge.componentVariant,
            })),
          }),
          compositeCapacity: deriveCompositeCapacitySnapshot({
            shopId,
            components: sibling.compositeComponents.map((edge) => ({
              requiredQuantity: edge.quantity,
              activeReservedQuantity: heldByVariantId.get(edge.componentVariant.id) ?? 0,
              componentVariant: edge.componentVariant,
            })),
            sellingMode: siblingSellingPolicy.sellingMode,
            negativeStockLimit: siblingSellingPolicy.negativeStockLimit,
          }),
          retailPrice: sibling.pancakeRetailPrice,
          retailPriceAfterDiscount: sibling.pancakeRetailPriceAfterDiscount,
        });
        compositeResolvedByVariantId.set(
          sibling.id,
          deriveCompositeSellableStock({
            shopId,
            components: sibling.compositeComponents.map((edge) => ({
              requiredQuantity: edge.quantity,
              componentVariant: edge.componentVariant,
            })),
          }) > 0,
        );
        variantsByKind.set(kind, variants);
        siblingVariantMpnMap[sibling.id] = sibling.pancakeDisplayId;
        siblingVariantSkuMap[sibling.id] = sibling.sku;
      }

      subSetGroups = COMPOSITE_SUB_SET_ORDER.flatMap((kind) => {
        const variants = variantsByKind.get(kind);
        return variants
          ? [{ label: kind, kindKey: COMPOSITE_SUB_SET_KIND_KEYS[kind], variants }]
          : [];
      });
    }

    const pricedVariantIds = [
      ...new Set([
        ...effectiveParentVariants.map((variant) => variant.id),
        ...subSetGroups.flatMap((group) => group.variants.map((variant) => variant.id)),
        ...componentGroups.flatMap((group) => group.variants.map((variant) => variant.id)),
      ]),
    ];
    // Keep every DB query inside the candidate repository's 200-id safety cap, while resolving the
    // complete PDP projection. This is bounded batching, not a per-option lookup.
    const { campaignsByVariantId } = await readApplicablePromotionCampaignsBatched({
      variantIds: pricedVariantIds,
    });

    return {
      ...product,
      variants: effectiveParentVariants,
      variantAvailabilityResolvedById: {
        ...product.variantAvailabilityResolvedById,
        ...Object.fromEntries(
          [...compositeStockByVariantId.keys()].map((id) => [
            id,
            compositeResolvedByVariantId.get(id) === true,
          ]),
        ),
        ...Object.fromEntries(
          subSetGroups.flatMap((group) =>
            group.variants.map((v) => [v.id, compositeResolvedByVariantId.get(v.id) === true]),
          ),
        ),
      },
      // ADR 0008: the mirrored Pancake `display_id` is the manufacturer MPN authority. Keep this
      // server-only map separate from `projection.options` so the purchase-panel client contract does
      // not grow a Merchant/SEO-only fact just to let JSON-LD identify each variant.
      variantMpnById: {
        ...Object.fromEntries(
          parentRelations.map((variant) => [variant.id, variant.pancakeDisplayId]),
        ),
        ...siblingVariantMpnMap,
      },
      // U32a: the website-owned SKU, kept in its own server-only map for the same reason. It rides
      // the select that already read this row, so publishing it costs no additional query. It is a
      // different fact from the MPN above and must never be substituted for it.
      variantSkuById: {
        ...Object.fromEntries(
          parentRelations.map((variant) => [variant.id, variant.sku]),
        ),
        ...siblingVariantSkuMap,
      },
      projection: buildStorefrontProductProjection({
        parentVariants: effectiveParentVariants,
        subSetGroups,
        componentGroups,
        hasCompositeGraph,
        // I9 — the same two inputs the Merchant feed supplies, because the page's JSON-LD and the
        // feed have to publish one answer (ADR 0011 § parity). The policy decides whether a
        // sold-out variant is a preorder sale at all; the cycle date decides whether that sale is
        // publishable as `backorder`. Reading the dates here is a READ — a page render must never
        // move a cycle, or the published date would depend on who last looked.
        sellingPolicy,
        availabilityDates: {
          byVariantId: await readVariantAvailabilityDates(
            client,
            product.variants.map((variant) => variant.id),
          ),
          today: vietnamCalendarDate(now),
        },
        // The PDP's price authority. Passing the default rule here would quietly un-promote every
        // surface built from this projection — the panel, and the variant structured data that
        // reads the same options. That wiring is gated by `tests/a11y-runtime/pdp-promotion.spec.ts`
        // (a rendering fact, so it lives in the browser suite); the domain suites cover what each
        // consumer does with the options, not which rule produced them.
        pricingRule: buildPromotionalStorefrontPricing({ campaignsByVariantId, now }),
      }),
    };
  }

  return { getProductBySlug };
}

export async function countProjectedCompositeParentVariations(
  client: PrismaClient,
  shopId: number,
): Promise<number> {
  return client.variantMirror.count({
    where: {
      product: { pancakeShopId: shopId },
      compositeComponents: { some: {} },
    },
  });
}
