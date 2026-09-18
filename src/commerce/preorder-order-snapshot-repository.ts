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
  if (reservationByVariantId.size !== order.lines.length) {
    throw new Error("I7 accepted reservation set does not match confirmed order lines");
  }

  const snapshotInputs: PreorderSnapshotLineInput[] = [];
  for (const line of order.lines) {
    const reservation = reservationByVariantId.get(line.variantId);
    if (!reservation || reservation.quantity !== line.quantity) {
      throw new Error(`I7 accepted reservation does not match order line ${line.variantId}`);
    }
    snapshotInputs.push({
      variantId: line.variantId,
      quantity: line.quantity,
      isPreorderSale: reservation.acceptedPreorderState === "PREORDER",
    });
  }

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
