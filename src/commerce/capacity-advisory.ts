/**
 * The advisory capacity read model: what listing cards, the PDP and the cart may offer a buyer.
 *
 * ADR 0014 §2 keeps the authoritative decision at the commit boundary, inside
 * `reserveOrderCapacity()`, and nothing here changes that: this module takes no lock and grants
 * nothing. What it removes is the *disagreement* between the surfaces and that authority. The
 * authority subtracts every reservation resource that still holds capacity from mirrored stock; the
 * surfaces used to read mirrored stock alone, so a variant whose last unit another buyer had just
 * reserved was still shown as buyable and only refused at checkout. Reading the same holds under
 * the same rule makes "shown as available" and "accepted at checkout" differ only by what changed in
 * between, which is the one gap an advisory read cannot close.
 *
 * The rule is `resourceHoldsCapacity()` itself, the one the reservation transaction applies, read
 * per **resource** (`CapacityReservationResource`), so a FULL SET's hold lands on the component
 * variants it actually consumes, exactly as `reserveOrderCapacity()` counts it. A `COMMITTED` hold
 * stops counting at its durable mirror handoff (`mirroredAt`, written by the catalog sync through
 * `handOffMirroredCapacity()`), so the surfaces and the authority retire it at the same sync.
 *
 * `buildVariantStockCte()` in `storefront-catalog.ts` is the SQL projection of this model for the
 * listing filters that must decide availability before they paginate; the database parity suite pins
 * the two together.
 */

import type { Prisma } from "../generated/prisma/client.ts";
import { resourceHoldsCapacity, type SellingMode } from "./capacity-policy.ts";
import {
  deriveCompositeCapacitySnapshot,
  deriveCompositeSellableStock,
  type CompositeCapacitySnapshot,
} from "./composite-capacity.ts";

export type AdvisoryHoldReadClient = Pick<Prisma.TransactionClient, "capacityReservationResource">;

export type AdvisoryCapacityReadClient = AdvisoryHoldReadClient &
  Pick<Prisma.TransactionClient, "compositeComponentMirror">;

/**
 * Units of each variant still held by reservations that count, keyed by every requested id (a
 * variant nobody has reserved maps to 0).
 *
 * The database filter only narrows the rows: `RELEASED` never holds and a handed-off `COMMITTED`
 * resource no longer does. `resourceHoldsCapacity()` makes the decision on what comes back.
 */
export async function readAdvisoryHeldQuantities(
  client: AdvisoryHoldReadClient,
  variantIds: readonly string[],
): Promise<ReadonlyMap<string, number>> {
  const ids = [...new Set(variantIds)];
  const held = new Map<string, number>(ids.map((id) => [id, 0]));
  if (ids.length === 0) return held;

  const resources = await client.capacityReservationResource.findMany({
    where: {
      variantId: { in: ids },
      OR: [
        { reservation: { state: { in: ["RESERVED", "SUBMITTING", "UNKNOWN"] } } },
        { reservation: { state: "COMMITTED" }, mirroredAt: null },
      ],
    },
    select: {
      variantId: true,
      quantity: true,
      mirroredAt: true,
      reservation: { select: { state: true } },
    },
  });

  for (const resource of resources) {
    const holds = resourceHoldsCapacity({
      state: resource.reservation.state,
      mirroredAt: resource.mirroredAt,
    });
    if (!holds) continue;
    held.set(resource.variantId, (held.get(resource.variantId) ?? 0) + resource.quantity);
  }
  return held;
}

type AdvisoryStockVariant = Readonly<{
  id: string;
  sellableStock: number;
  compositeCapacity?: CompositeCapacitySnapshot;
}>;

type AdvisoryStockProduct<V extends AdvisoryStockVariant> = Readonly<{
  variants: readonly V[];
  productCapacity?: Readonly<{
    sellingMode: SellingMode;
    negativeStockLimit: number;
    isComposite: boolean;
  }>;
}>;

/**
 * Replaces each variant's mirrored `sellableStock` with the advisory figure, so a card, a PDP
 * option and a cart line advertise the same number for the same variant:
 *
 * - a standalone variant: mirrored stock minus its held units. It may go negative, because
 *   `OVERSELL`/`PREORDER` limits are judged against exactly that figure by `evaluateVariantCapacity()`;
 * - a composite parent: the whole sets its components can still supply after their own holds
 *   (`deriveCompositeSellableStock()`). The parent's own mirrored stock is not what a set sale
 *   spends, so it is not consulted — the same resources `reserveOrderCapacity()` locks.
 */
export async function withAdvisorySellableStock<
  V extends AdvisoryStockVariant,
  P extends AdvisoryStockProduct<V>,
>(client: AdvisoryCapacityReadClient, shopId: number, products: readonly P[]): Promise<P[]> {
  const variantIds = products.flatMap((product) => product.variants.map(({ id }) => id));
  if (variantIds.length === 0) return [...products];

  const edges = await client.compositeComponentMirror.findMany({
    where: { parentVariantId: { in: variantIds } },
    orderBy: [{ parentVariantId: "asc" }, { componentVariantId: "asc" }],
    select: {
      parentVariantId: true,
      quantity: true,
      componentVariant: {
        select: {
          id: true,
          isPresent: true,
          product: { select: { pancakeShopId: true, isPresent: true } },
          warehouseStocks: { select: { quantity: true } },
        },
      },
    },
  });
  const edgesByParentId = new Map<string, (typeof edges)[number][]>();
  for (const edge of edges) {
    const list = edgesByParentId.get(edge.parentVariantId) ?? [];
    list.push(edge);
    edgesByParentId.set(edge.parentVariantId, list);
  }

  const held = await readAdvisoryHeldQuantities(client, [
    ...variantIds.filter((id) => !edgesByParentId.has(id)),
    ...edges.map((edge) => edge.componentVariant.id),
  ]);

  return products.map((product) => ({
    ...product,
    variants: product.variants.map((variant) => {
      const components = edgesByParentId.get(variant.id);
      const componentInputs = components?.map((edge) => ({
        requiredQuantity: edge.quantity,
        activeReservedQuantity: held.get(edge.componentVariant.id) ?? 0,
        componentVariant: edge.componentVariant,
      }));
      const sellableStock = componentInputs
        ? deriveCompositeSellableStock({ shopId, components: componentInputs })
        : variant.sellableStock - (held.get(variant.id) ?? 0);
      const compositeCapacity =
        componentInputs && product.productCapacity?.isComposite
          ? deriveCompositeCapacitySnapshot({
              shopId,
              components: componentInputs,
              sellingMode: product.productCapacity.sellingMode,
              negativeStockLimit: product.productCapacity.negativeStockLimit,
            })
          : undefined;
      return { ...variant, sellableStock, compositeCapacity };
    }),
  }));
}
