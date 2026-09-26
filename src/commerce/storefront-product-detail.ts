import type { PrismaClient } from "../generated/prisma/client.ts";
import { createStorefrontCatalogRepository } from "./storefront-catalog.ts";
import {
  buildStorefrontProductProjection,
  resolveCompositeComponentGroupLabel,
  type StorefrontCompositeComponentGroup,
  type StorefrontCompositeSubSetGroup,
} from "./storefront-projection.ts";
import type { StorefrontVariantFacts } from "./storefront-product.ts";
import { buildPromotionalStorefrontPricing } from "./storefront-promotion-projection.ts";
import { readApplicablePromotionCampaignsBatched } from "./promotion-candidate-batching.ts";
import { vietnamCalendarDate } from "./availability-cycle.ts";
import { readVariantAvailabilityDates } from "./availability-cycle-repository.ts";
import { resolveSellingPolicy } from "./capacity-policy.ts";
import { deriveCompositeSellableStock } from "./composite-capacity.ts";

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
    const groups = new Map<
      string,
      {
        sortLabel: string;
        skus: (string | null)[];
        variants: Map<string, StorefrontVariantFacts>;
      }
    >();

    const compositeStockByVariantId = new Map<string, number>();
    for (const parent of parentRelations) {
      if (parent.compositeComponents.length > 0) {
        compositeStockByVariantId.set(
          parent.id,
          deriveCompositeSellableStock({
            shopId,
            components: parent.compositeComponents.map((edge) => ({
              requiredQuantity: edge.quantity,
              componentVariant: edge.componentVariant,
            })),
          }),
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
            sellableStock: sumWarehouseStocks(component.warehouseStocks),
            retailPrice: component.pancakeRetailPrice,
            retailPriceAfterDiscount: component.pancakeRetailPriceAfterDiscount,
          });
        }
      }
    }

    const effectiveParentVariants = product.variants.map((v) => {
      const derived = compositeStockByVariantId.get(v.id);
      return derived !== undefined ? { ...v, sellableStock: derived } : v;
    });

    const componentGroups: StorefrontCompositeComponentGroup[] = [...groups.values()]
      .sort((left, right) => left.sortLabel.localeCompare(right.sortLabel, "vi"))
      .flatMap((group) => {
        const label = resolveCompositeComponentGroupLabel(group.skus);
        return label === null
          ? []
          : [{ label, variants: [...group.variants.values()] }];
      });

    // Discover sibling composite subsets (e.g. Set Váy, Set Quần) sharing components with this combo
    let subSetGroups: StorefrontCompositeSubSetGroup[] = [];
    const siblingVariantMpnMap: Record<string, string | null> = {};
    const siblingVariantSkuMap: Record<string, string | null> = {};
    const siblingPricedVariantIds: string[] = [];

    const componentProductIds = [...groups.keys()];
    const componentVariantIds = [
      ...new Set(
        parentRelations.flatMap((parent) =>
          parent.compositeComponents.map((edge) => edge.componentVariant.id),
        ),
      ),
    ];

    if (componentProductIds.length >= 3) {
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
              componentVariantId: { in: componentVariantIds },
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
              id: true,
              name: true,
            },
          },
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

      const siblingProductMap = new Map<
        string,
        {
          name: string;
          variants: typeof siblingRelations;
          usedCompProductIds: Set<string>;
        }
      >();

      for (const sib of siblingRelations) {
        if (sib.compositeComponents.length === 0) continue;
        let entry = siblingProductMap.get(sib.product.id);
        if (!entry) {
          entry = {
            name: sib.product.name,
            variants: [],
            usedCompProductIds: new Set(),
          };
          siblingProductMap.set(sib.product.id, entry);
        }
        entry.variants.push(sib);
        for (const edge of sib.compositeComponents) {
          entry.usedCompProductIds.add(edge.componentVariant.product.id);
        }
        siblingVariantMpnMap[sib.id] = sib.pancakeDisplayId;
        siblingVariantSkuMap[sib.id] = sib.sku;
        siblingPricedVariantIds.push(sib.id);
      }

      const candidateSets: {
        label: string;
        kindKey: string;
        order: number;
        variants: StorefrontVariantFacts[];
      }[] = [];

      for (const entry of siblingProductMap.values()) {
        const isStrictSubset =
          entry.usedCompProductIds.size > 0 &&
          entry.usedCompProductIds.size < componentProductIds.length &&
          [...entry.usedCompProductIds].every((cId) => componentProductIds.includes(cId));

        if (!isStrictSubset) continue;

        const n = entry.name.toUpperCase();
        let label: string | null = null;
        let kindKey: string | null = null;
        let order = 99;

        if (n.includes("SET VÁY") || n.includes("SET VAY") || /(^|\s)SV[0-9]/i.test(entry.name)) {
          label = "SET VÁY";
          kindKey = "sub-set-vay";
          order = 1;
        } else if (n.includes("SET QUẦN") || n.includes("SET SQ") || /(^|\s)SQ[0-9]/i.test(entry.name)) {
          label = "SET QUẦN";
          kindKey = "sub-set-quan";
          order = 2;
        }

        if (label && kindKey) {
          const variants: StorefrontVariantFacts[] = entry.variants.map((v) => ({
            id: v.id,
            pancakeVariationId: v.pancakeVariationId,
            color: v.color,
            size: v.size,
            sellableStock: deriveCompositeSellableStock({
              shopId,
              components: v.compositeComponents.map((edge) => ({
                requiredQuantity: edge.quantity,
                componentVariant: edge.componentVariant,
              })),
            }),
            retailPrice: v.pancakeRetailPrice,
            retailPriceAfterDiscount: v.pancakeRetailPriceAfterDiscount,
          }));

          candidateSets.push({ label, kindKey, order, variants });
        }
      }

      candidateSets.sort((a, b) => a.order - b.order);
      subSetGroups = candidateSets.map((c) => ({
        label: c.label,
        kindKey: c.kindKey,
        variants: c.variants,
      }));
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
          [...compositeStockByVariantId.entries()].map(([id, stock]) => [id, stock > 0]),
        ),
        ...Object.fromEntries(
          subSetGroups.flatMap((group) =>
            group.variants.map((v) => [v.id, (v.sellableStock ?? 0) > 0]),
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
        sellingPolicy: resolveSellingPolicy(sellingPolicyRow),
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
        colorDimensionLabel:
          parentRelations.some(
            (v) =>
              /SD007|SD023/i.test(v.pancakeDisplayId ?? "") ||
              /SD007|SD023/i.test(v.sku ?? ""),
          ) || /007|023/i.test(`${product.slug} ${product.name}`)
            ? "Màu quần"
            : "Màu",
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
