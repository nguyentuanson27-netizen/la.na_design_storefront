import type { PrismaClient } from "../generated/prisma/client.ts";
import {
  resolveSellingPolicy,
  resolveVariantSellability,
  reservationHoldsCapacity,
} from "./capacity-policy.ts";
import type { Prisma } from "../generated/prisma/client.ts";
import { buildPreorderOrderSnapshot } from "./preorder-order-snapshot.ts";

type TransactionClient = Prisma.TransactionClient;

const snapshotLineSelection = {
  variantId: true,
  quantity: true,
} satisfies Prisma.OrderLineSnapshotSelect;

type SnapshotLine = Prisma.OrderLineSnapshotGetPayload<{
  select: typeof snapshotLineSelection;
}>;

function earliestObservationStart(stocks: readonly { syncedAt: Date }[]): Date | null {
  let earliest: Date | null = null;
  for (const stock of stocks) {
    if (earliest === null || stock.syncedAt.getTime() < earliest.getTime()) {
      earliest = stock.syncedAt;
    }
  }
  return earliest;
}

function sumStock(stocks: readonly { quantity: number }[]): number | null {
  let total = 0;
  for (const stock of stocks) {
    if (!Number.isSafeInteger(stock.quantity)) return null;
    total += stock.quantity;
    if (!Number.isSafeInteger(total)) return null;
  }
  return total;
}

/**
 * I7 confirmation boundary.
 *
 * The function reads current website-owned selling policy and current mirrored stock only to classify
 * the order line at confirmation time. It writes those facts into the dedicated immutable snapshot;
 * no later policy/stock read can change the persisted result.
 *
 * A missing policy row is intentionally resolved through the canonical STANDARD/-20 resolver. A
 * missing/invalid stock observation is treated as unavailable rather than fabricated.
 */
export async function createPreorderSnapshotAtConfirmation(
  tx: TransactionClient,
  orderId: string,
  confirmedAt: Date,
): Promise<void> {
  const existing = await tx.orderPreorderSnapshot.findUnique({
    where: { orderId },
    select: { id: true },
  });
  if (existing) return;

  const order = await tx.orderMirror.findUnique({
    where: { id: orderId },
    select: {
      lines: {
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: snapshotLineSelection,
      },
    },
  });
  if (!order || order.lines.length === 0) {
    throw new Error("I7 cannot snapshot a confirmed order without order lines");
  }

  const variantIds = [...new Set(order.lines.map((line) => line.variantId))];
  const variants = await tx.variantMirror.findMany({
    where: { id: { in: variantIds } },
    select: {
      id: true,
      warehouseStocks: { select: { quantity: true, syncedAt: true } },
      compositeComponents: { select: { parentVariantId: true }, take: 1 },
      product: {
        select: {
          sellingPolicy: { select: { sellingMode: true, negativeStockLimit: true } },
        },
      },
      capacityReservations: {
        where: { orderId: { not: orderId } },
        select: {
          quantity: true,
          state: true,
          committedAt: true,
        },
      },
    },
  });

  const byVariantId = new Map(variants.map((variant) => [variant.id, variant]));
  const snapshotInputs = order.lines.map((line) => {
    const variant = byVariantId.get(line.variantId);
    if (!variant) {
      throw new Error(`I7 cannot snapshot missing variant ${line.variantId}`);
    }

    const mirroredStock = sumStock(variant.warehouseStocks);
    const stockObservationStartedAt = earliestObservationStart(variant.warehouseStocks);
    if (mirroredStock === null) {
      throw new Error(`I7 cannot snapshot invalid mirrored stock for variant ${line.variantId}`);
    }

    const policy = resolveSellingPolicy(variant.product.sellingPolicy);
    let activeReservedQuantity = 0;
    for (const reservation of variant.capacityReservations) {
      if (
        reservationHoldsCapacity({
          state: reservation.state,
          committedAt: reservation.committedAt,
          stockObservationStartedAt,
        })
      ) {
        activeReservedQuantity += reservation.quantity;
      }
    }
    if (!Number.isSafeInteger(activeReservedQuantity) || activeReservedQuantity < 0) {
      throw new Error(`I7 cannot snapshot invalid active reservation quantity for variant ${line.variantId}`);
    }

    const sellability = resolveVariantSellability({
      mirroredStock,
      activeReservedQuantity,
      sellingMode: policy.sellingMode,
      negativeStockLimit: policy.negativeStockLimit,
      isComposite: variant.compositeComponents.length > 0,
    });

    return {
      variantId: line.variantId,
      quantity: line.quantity,
      isPreorderSale: sellability.isPreorderSale,
    };
  });

  const snapshot = buildPreorderOrderSnapshot({
    confirmedAt,
    lines: snapshotInputs,
  });

  await tx.orderPreorderSnapshot.create({
    data: {
      orderId,
      confirmedAt: snapshot.confirmedAt,
      preorderReadyAt: snapshot.preorderReadyAt,
      lines: {
        create: snapshot.lines.map((line) => ({
          variantId: line.variantId,
          quantity: line.quantity,
          state: line.state,
          preorderReadyAt: line.preorderReadyAt,
        })),
      },
    },
  });
}
