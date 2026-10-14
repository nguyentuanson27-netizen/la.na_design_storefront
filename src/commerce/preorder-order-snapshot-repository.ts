import { FULFILLMENT } from "../brand/index.ts";
import type { Prisma } from "../generated/prisma/client.ts";
import {
  buildPreorderOrderSnapshot,
  type PreorderSnapshotLineInput,
} from "./preorder-order-snapshot.ts";

type TransactionClient = Prisma.TransactionClient;

/**
 * I7 confirmation boundary.
 *
 * READY/PREORDER is NOT re-derived here. The atomic capacity transaction already made that decision
 * while holding the variant lock and persisted it on VariantCapacityReservation. Confirmation only
 * copies that accepted fact into immutable order history.
 *
 * A reservation with no acceptedPreorderState is a rolling-deploy / pre-I7 row. Likewise, an order
 * with no reservation was never given I7 capacity authority. In both cases the truthful historical
 * state is "no I7 snapshot"; current stock/policy must never be used to fabricate one.
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
        select: { variantId: true, quantity: true },
      },
      // GQ20 -- a benefit order's gifts are not paid lines but they hold and consume stock like any
      // other unit. Null for every legacy order, which therefore reads exactly as before.
      quoteSnapshot: {
        select: { lines: { where: { role: "GIFT" as const }, select: { variantId: true, quantity: true } } },
      },
      capacityReservations: {
        orderBy: [{ variantId: "asc" }],
        select: {
          variantId: true,
          quantity: true,
          acceptedPreorderState: true,
        },
      },
    },
  });
  if (!order || order.lines.length === 0) {
    throw new Error("I7 cannot snapshot a confirmed order without order lines");
  }

  // No accepted capacity authority means no truthful I7 history. This is intentionally not an
  // error: older application versions and lower-level integrations can confirm orders without I7
  // metadata during a rolling deployment, and I7 explicitly forbids backfilling by inference.
  if (order.capacityReservations.length === 0) return;
  if (order.capacityReservations.some((reservation) => reservation.acceptedPreorderState === null)) {
    return;
  }

  const reservationByVariantId = new Map(
    order.capacityReservations.map((reservation) => [reservation.variantId, reservation]),
  );
  // One entry per variant, in first-seen order. A legacy order has one line per variant, so this is
  // the identity; a benefit order may have several paid price segments of a variant plus gift units of
  // it, which the reservation (one row per variant) already holds as a single quantity.
  const demandByVariantId = new Map<string, number>();
  for (const line of [...order.lines, ...(order.quoteSnapshot?.lines ?? [])]) {
    demandByVariantId.set(line.variantId, (demandByVariantId.get(line.variantId) ?? 0) + line.quantity);
  }
  if (reservationByVariantId.size !== demandByVariantId.size) {
    throw new Error("I7 accepted reservation set does not match confirmed order lines");
  }

  const snapshotInputs: PreorderSnapshotLineInput[] = [];
  for (const [variantId, quantity] of demandByVariantId) {
    const reservation = reservationByVariantId.get(variantId);
    if (!reservation || reservation.quantity !== quantity) {
      throw new Error(`I7 accepted reservation does not match order line ${variantId}`);
    }
    snapshotInputs.push({
      variantId,
      quantity,
      isPreorderSale: reservation.acceptedPreorderState === "PREORDER",
    });
  }

  const snapshot = buildPreorderOrderSnapshot({
    confirmedAt,
    lines: snapshotInputs,
    shippingEstimate: FULFILLMENT.delivery.estimateDays,
  });

  await tx.orderPreorderSnapshot.create({
    data: {
      orderId,
      confirmedAt: snapshot.confirmedAt,
      preorderReadyAt: snapshot.preorderReadyAt,
      shippingInnerCityMinDays: snapshot.shippingInnerCityMinDays,
      shippingInnerCityMaxDays: snapshot.shippingInnerCityMaxDays,
      shippingOtherProvinceMinDays: snapshot.shippingOtherProvinceMinDays,
      shippingOtherProvinceMaxDays: snapshot.shippingOtherProvinceMaxDays,
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
