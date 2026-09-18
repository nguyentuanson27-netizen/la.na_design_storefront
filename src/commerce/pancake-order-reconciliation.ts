import type { PrismaClient } from "../generated/prisma/client.ts";
import type {
  MarkerSearchResult,
  OrderSearchOptions,
} from "../integrations/pancake/order-search.ts";

export type PancakeOrderReconciliationGateway = {
  searchOrderByMarker(
    shopId: number,
    marker: string,
    options?: OrderSearchOptions,
  ): Promise<MarkerSearchResult>;
};

export type PancakeOrderReconciliationDependencies = {
  client: PrismaClient;
  gateway: PancakeOrderReconciliationGateway;
  clock?: () => Date;
};

export type OrderReconciliationResult =
  | { ok: true; state: "CONFIRMED"; pancakeOrderId: string; reservationsCommitted: number }
  | { ok: false; state: "REJECTED"; reason: "ORDER_REJECTED"; reservationsReleased: number }
  | {
      ok: false;
      state: "SYNC_UNKNOWN";
      reason: "AMBIGUOUS";
      detail: string;
      reservationsUnknown: number;
    }
  | { ok: false; state?: string; reason: "ORDER_NOT_FOUND" | "ORDER_NOT_IN_SYNC_UNKNOWN" };

export type BatchReconciliationResult = {
  scanned: number;
  confirmed: number;
  rejected: number;
  ambiguous: number;
};

export function createPancakeOrderReconciliationService({
  client,
  gateway,
  clock = () => new Date(),
}: PancakeOrderReconciliationDependencies) {
  async function reconcileOrder(publicCode: string): Promise<OrderReconciliationResult> {
    const order = await client.orderMirror.findUnique({
      where: { publicCode },
      select: {
        id: true,
        publicCode: true,
        state: true,
        pancakeShopId: true,
        pancakeOrderId: true,
      },
    });

    if (!order) {
      return { ok: false, reason: "ORDER_NOT_FOUND" };
    }

    // Already settled: converge any remaining UNKNOWN or SUBMITTING reservations
    if (order.state === "CONFIRMED") {
      const settledAt = clock();
      const updated = await client.variantCapacityReservation.updateMany({
        where: { orderId: order.id, state: { in: ["UNKNOWN", "SUBMITTING"] } },
        data: { state: "COMMITTED", committedAt: settledAt, releasedAt: null },
      });
      return {
        ok: true,
        state: "CONFIRMED",
        pancakeOrderId: order.pancakeOrderId ?? "",
        reservationsCommitted: updated.count,
      };
    }

    if (order.state === "REJECTED") {
      const settledAt = clock();
      const updated = await client.variantCapacityReservation.updateMany({
        where: { orderId: order.id, state: { in: ["UNKNOWN", "SUBMITTING"] } },
        data: { state: "RELEASED", releasedAt: settledAt, committedAt: null },
      });
      return {
        ok: false,
        state: "REJECTED",
        reason: "ORDER_REJECTED",
        reservationsReleased: updated.count,
      };
    }

    if (order.state !== "SYNC_UNKNOWN") {
      return { ok: false, state: order.state, reason: "ORDER_NOT_IN_SYNC_UNKNOWN" };
    }

    if (order.pancakeShopId === null) {
      return {
        ok: false,
        state: "SYNC_UNKNOWN",
        reason: "AMBIGUOUS",
        detail: "Order has no assigned pancakeShopId",
        reservationsUnknown: 0,
      };
    }

    const marker = `[ORDER:${order.publicCode}]`;
    const search = await gateway.searchOrderByMarker(order.pancakeShopId, marker);

    if (search.kind === "FOUND") {
      const committedAt = clock();
      return client.$transaction(async (tx) => {
        const orderClaim = await tx.orderMirror.updateMany({
          where: { id: order.id, state: "SYNC_UNKNOWN" },
          data: {
            state: "CONFIRMED",
            pancakeOrderId: search.orderId,
            syncErrorCode: null,
          },
        });

        if (orderClaim.count !== 1) {
          const fresh = await tx.orderMirror.findUniqueOrThrow({
            where: { id: order.id },
            select: { state: true, pancakeOrderId: true },
          });
          if (fresh.state === "CONFIRMED") {
            const resClaim = await tx.variantCapacityReservation.updateMany({
              where: { orderId: order.id, state: { in: ["UNKNOWN", "SUBMITTING"] } },
              data: { state: "COMMITTED", committedAt, releasedAt: null },
            });
            return {
              ok: true as const,
              state: "CONFIRMED" as const,
              pancakeOrderId: fresh.pancakeOrderId ?? search.orderId,
              reservationsCommitted: resClaim.count,
            };
          }
          if (fresh.state === "REJECTED") {
            const releasedAt = clock();
            const resClaim = await tx.variantCapacityReservation.updateMany({
              where: { orderId: order.id, state: { in: ["UNKNOWN", "SUBMITTING"] } },
              data: { state: "RELEASED", releasedAt, committedAt: null },
            });
            return {
              ok: false as const,
              state: "REJECTED" as const,
              reason: "ORDER_REJECTED" as const,
              reservationsReleased: resClaim.count,
            };
          }
          return {
            ok: false as const,
            state: fresh.state,
            reason: "ORDER_NOT_IN_SYNC_UNKNOWN" as const,
          };
        }

        const resClaim = await tx.variantCapacityReservation.updateMany({
          where: { orderId: order.id, state: { in: ["UNKNOWN", "SUBMITTING"] } },
          data: { state: "COMMITTED", committedAt, releasedAt: null },
        });

        return {
          ok: true as const,
          state: "CONFIRMED" as const,
          pancakeOrderId: search.orderId,
          reservationsCommitted: resClaim.count,
        };
      });
    }

    if (search.kind === "ABSENT") {
      const releasedAt = clock();
      return client.$transaction(async (tx) => {
        const orderClaim = await tx.orderMirror.updateMany({
          where: { id: order.id, state: "SYNC_UNKNOWN" },
          data: {
            state: "REJECTED",
            syncErrorCode: "ORDER_REJECTED",
          },
        });

        if (orderClaim.count !== 1) {
          const fresh = await tx.orderMirror.findUniqueOrThrow({
            where: { id: order.id },
            select: { state: true, pancakeOrderId: true },
          });
          if (fresh.state === "CONFIRMED") {
            const committedAt = clock();
            const resClaim = await tx.variantCapacityReservation.updateMany({
              where: { orderId: order.id, state: { in: ["UNKNOWN", "SUBMITTING"] } },
              data: { state: "COMMITTED", committedAt, releasedAt: null },
            });
            return {
              ok: true as const,
              state: "CONFIRMED" as const,
              pancakeOrderId: fresh.pancakeOrderId ?? "",
              reservationsCommitted: resClaim.count,
            };
          }
          if (fresh.state === "REJECTED") {
            const resClaim = await tx.variantCapacityReservation.updateMany({
              where: { orderId: order.id, state: { in: ["UNKNOWN", "SUBMITTING"] } },
              data: { state: "RELEASED", releasedAt, committedAt: null },
            });
            return {
              ok: false as const,
              state: "REJECTED" as const,
              reason: "ORDER_REJECTED" as const,
              reservationsReleased: resClaim.count,
            };
          }
          return {
            ok: false as const,
            state: fresh.state,
            reason: "ORDER_NOT_IN_SYNC_UNKNOWN" as const,
          };
        }

        const resClaim = await tx.variantCapacityReservation.updateMany({
          where: { orderId: order.id, state: { in: ["UNKNOWN", "SUBMITTING"] } },
          data: { state: "RELEASED", releasedAt, committedAt: null },
        });

        return {
          ok: false as const,
          state: "REJECTED" as const,
          reason: "ORDER_REJECTED" as const,
          reservationsReleased: resClaim.count,
        };
      });
    }

    // search.kind === "AMBIGUOUS"
    // ADR 0014 §9: Move any SUBMITTING hold to UNKNOWN to survive restart / operator review
    await client.variantCapacityReservation.updateMany({
      where: { orderId: order.id, state: "SUBMITTING" },
      data: { state: "UNKNOWN" },
    });

    const unknownCount = await client.variantCapacityReservation.count({
      where: { orderId: order.id, state: "UNKNOWN" },
    });

    return {
      ok: false,
      state: "SYNC_UNKNOWN",
      reason: "AMBIGUOUS",
      detail: search.reason,
      reservationsUnknown: unknownCount,
    };
  }

  async function reconcileAllUnknownOrders(
    options: { limit?: number; shopId?: number } = {},
  ): Promise<BatchReconciliationResult> {
    const limit = options.limit ?? 20;
    const orders = await client.orderMirror.findMany({
      where: {
        state: "SYNC_UNKNOWN",
        ...(options.shopId !== undefined ? { pancakeShopId: options.shopId } : {}),
      },
      select: { publicCode: true },
      orderBy: { createdAt: "asc" },
      take: limit,
    });

    let confirmed = 0;
    let rejected = 0;
    let ambiguous = 0;

    for (const order of orders) {
      const result = await reconcileOrder(order.publicCode);
      if (result.ok && result.state === "CONFIRMED") {
        confirmed += 1;
      } else if (!result.ok && result.state === "REJECTED") {
        rejected += 1;
      } else {
        ambiguous += 1;
      }
    }

    return {
      scanned: orders.length,
      confirmed,
      rejected,
      ambiguous,
    };
  }

  return {
    reconcileOrder,
    reconcileAllUnknownOrders,
  };
}
