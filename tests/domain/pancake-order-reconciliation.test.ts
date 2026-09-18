import assert from "node:assert/strict";
import test from "node:test";

import { createPancakeOrderReconciliationService } from "../../src/commerce/pancake-order-reconciliation.ts";

import type { PrismaClient } from "../../src/generated/prisma/client.ts";

const shopId = 1720000650;
const publicCode = "LA-260918-REC01";
const now = new Date("2026-09-18T06:00:00.000Z");

function buildMockPrisma({
  initialOrderState = "SYNC_UNKNOWN",
  pancakeOrderId = null as string | null,
  initialReservationState = "UNKNOWN",
  reservationsCount = 2,
}: {
  initialOrderState?: "DRAFT" | "VALIDATING" | "POS_SUBMITTING" | "CONFIRMED" | "SYNC_UNKNOWN" | "REJECTED";
  pancakeOrderId?: string | null;
  initialReservationState?: "RESERVED" | "SUBMITTING" | "COMMITTED" | "RELEASED" | "UNKNOWN";
  reservationsCount?: number;
} = {}) {
  let orderState = initialOrderState;
  let currentPancakeOrderId = pancakeOrderId;
  let syncErrorCode: string | null = initialOrderState === "SYNC_UNKNOWN" ? "CREATE_OUTCOME_UNKNOWN" : null;

  const mockOrder = {
    id: "order-rec-01",
    publicCode,
    pancakeShopId: shopId,
    state: orderState,
    syncErrorCode,
    pancakeOrderId: currentPancakeOrderId,
  };

  const reservations = Array.from({ length: reservationsCount }, (_, i) => ({
    id: `res-0${i + 1}`,
    orderId: mockOrder.id,
    variantId: `var-0${i + 1}`,
    quantity: 1,
    state: initialReservationState,
    committedAt: null as Date | null,
    releasedAt: null as Date | null,
  }));

  async function findUnique({ where }: { where: { publicCode?: string; id?: string } }) {
    if (where.publicCode === publicCode || where.id === mockOrder.id) {
      return {
        ...mockOrder,
        state: orderState,
        pancakeOrderId: currentPancakeOrderId,
        syncErrorCode,
      };
    }
    return null;
  }

  const client = {
    orderMirror: {
      findUnique,
      async findUniqueOrThrow({ where }: { where: { publicCode?: string; id?: string } }) {
        const found = await findUnique({ where });
        if (!found) throw new Error("Order not found");
        return found;
      },
      async findMany({ where }: { where: { state?: string } }) {
        if (where.state === orderState) {
          return [{ publicCode: mockOrder.publicCode }];
        }
        return [];
      },
      async updateMany({
        where,
        data,
      }: {
        where: { id?: string; state?: string };
        data: { state?: typeof orderState; syncErrorCode?: string | null; pancakeOrderId?: string };
      }) {
        if (where.id && where.id !== mockOrder.id) return { count: 0 };
        if (where.state && where.state !== orderState) return { count: 0 };

        if (data.state) orderState = data.state;
        if (data.syncErrorCode !== undefined) syncErrorCode = data.syncErrorCode;
        if (data.pancakeOrderId !== undefined) currentPancakeOrderId = data.pancakeOrderId;
        mockOrder.state = orderState;
        mockOrder.syncErrorCode = syncErrorCode;
        mockOrder.pancakeOrderId = currentPancakeOrderId;
        return { count: 1 };
      },
    },
    variantCapacityReservation: {
      async findMany({ where }: { where: { orderId?: string } }) {
        return reservations.filter((r) => !where.orderId || r.orderId === where.orderId);
      },
      async count({ where }: { where: { orderId?: string; state?: string } }) {
        return reservations.filter(
          (r) =>
            (!where.orderId || r.orderId === where.orderId) &&
            (!where.state || r.state === where.state),
        ).length;
      },
      async updateMany({
        where,
        data,
      }: {
        where: { orderId?: string; state?: string };
        data: { state?: typeof initialReservationState; committedAt?: Date | null; releasedAt?: Date | null };
      }) {
        let count = 0;
        for (const r of reservations) {
          if (where.orderId && r.orderId !== where.orderId) continue;
          if (where.state && r.state !== where.state) continue;

          if (data.state) r.state = data.state;
          if (data.committedAt !== undefined) r.committedAt = data.committedAt;
          if (data.releasedAt !== undefined) r.releasedAt = data.releasedAt;
          count += 1;
        }
        return { count };
      },
    },
    async $transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
      return fn(client);
    },
    getState: () => ({
      orderState,
      currentPancakeOrderId,
      syncErrorCode,
      reservations: reservations.map((r) => ({ ...r })),
    }),
  };

  return client as unknown as PrismaClient & { getState: typeof client.getState };
}

test("reconcileOrder returns ORDER_NOT_FOUND when public code is not in mirror", async () => {
  const prismaMock = buildMockPrisma();
  const gateway = {
    async searchOrderByMarker() {
      throw new Error("must not search");
    },
  };
  const service = createPancakeOrderReconciliationService({
    client: prismaMock,
    gateway,
    clock: () => now,
  });

  const result = await service.reconcileOrder("NON_EXISTENT_CODE");
  assert.deepEqual(result, { ok: false, reason: "ORDER_NOT_FOUND" });
});

test("reconcileOrder handles order already in CONFIRMED by converging UNKNOWN reservations", async () => {
  const prismaMock = buildMockPrisma({
    initialOrderState: "CONFIRMED",
    pancakeOrderId: "90001",
    initialReservationState: "UNKNOWN",
  });
  const gateway = {
    async searchOrderByMarker() {
      throw new Error("must not search");
    },
  };
  const service = createPancakeOrderReconciliationService({
    client: prismaMock,
    gateway,
    clock: () => now,
  });

  const result = await service.reconcileOrder(publicCode);
  assert.deepEqual(result, {
    ok: true,
    state: "CONFIRMED",
    pancakeOrderId: "90001",
    reservationsCommitted: 2,
  });

  const finalState = prismaMock.getState();
  assert.equal(finalState.orderState, "CONFIRMED");
  for (const r of finalState.reservations) {
    assert.equal(r.state, "COMMITTED");
    assert.equal(r.committedAt, now);
    assert.equal(r.releasedAt, null);
  }
});

test("reconcileOrder handles order already in REJECTED by converging UNKNOWN reservations to RELEASED", async () => {
  const prismaMock = buildMockPrisma({
    initialOrderState: "REJECTED",
    initialReservationState: "UNKNOWN",
  });
  const gateway = {
    async searchOrderByMarker() {
      throw new Error("must not search");
    },
  };
  const service = createPancakeOrderReconciliationService({
    client: prismaMock,
    gateway,
    clock: () => now,
  });

  const result = await service.reconcileOrder(publicCode);
  assert.deepEqual(result, {
    ok: false,
    state: "REJECTED",
    reason: "ORDER_REJECTED",
    reservationsReleased: 2,
  });

  const finalState = prismaMock.getState();
  assert.equal(finalState.orderState, "REJECTED");
  for (const r of finalState.reservations) {
    assert.equal(r.state, "RELEASED");
    assert.equal(r.releasedAt, now);
    assert.equal(r.committedAt, null);
  }
});

test("reconcileOrder returns ORDER_NOT_IN_SYNC_UNKNOWN for mid-flight orders (e.g. VALIDATING)", async () => {
  const prismaMock = buildMockPrisma({
    initialOrderState: "VALIDATING",
  });
  const gateway = {
    async searchOrderByMarker() {
      throw new Error("must not search");
    },
  };
  const service = createPancakeOrderReconciliationService({
    client: prismaMock,
    gateway,
  });

  const result = await service.reconcileOrder(publicCode);
  assert.deepEqual(result, {
    ok: false,
    state: "VALIDATING",
    reason: "ORDER_NOT_IN_SYNC_UNKNOWN",
  });
});

test("reconcileOrder FOUND: commits order and reservations when remote order is found", async () => {
  const prismaMock = buildMockPrisma({
    initialOrderState: "SYNC_UNKNOWN",
    initialReservationState: "UNKNOWN",
  });

  let searchedShopId = 0;
  let searchedMarker = "";

  const gateway = {
    async searchOrderByMarker(sid: number, marker: string) {
      searchedShopId = sid;
      searchedMarker = marker;
      return { kind: "FOUND" as const, orderId: "777888" };
    },
  };

  const service = createPancakeOrderReconciliationService({
    client: prismaMock,
    gateway,
    clock: () => now,
  });

  const result = await service.reconcileOrder(publicCode);

  assert.equal(searchedShopId, shopId);
  assert.equal(searchedMarker, `[ORDER:${publicCode}]`);
  assert.deepEqual(result, {
    ok: true,
    state: "CONFIRMED",
    pancakeOrderId: "777888",
    reservationsCommitted: 2,
  });

  const state = prismaMock.getState();
  assert.equal(state.orderState, "CONFIRMED");
  assert.equal(state.currentPancakeOrderId, "777888");
  assert.equal(state.syncErrorCode, null);
  for (const r of state.reservations) {
    assert.equal(r.state, "COMMITTED");
    assert.equal(r.committedAt, now);
    assert.equal(r.releasedAt, null);
  }
});

test("reconcileOrder ABSENT: rejects order and releases capacity when order is proven absent", async () => {
  const prismaMock = buildMockPrisma({
    initialOrderState: "SYNC_UNKNOWN",
    initialReservationState: "UNKNOWN",
  });

  const gateway = {
    async searchOrderByMarker(sid: number, marker: string) {
      assert.equal(sid, shopId);
      assert.equal(marker, `[ORDER:${publicCode}]`);
      return { kind: "ABSENT" as const };
    },
  };

  const service = createPancakeOrderReconciliationService({
    client: prismaMock,
    gateway,
    clock: () => now,
  });

  const result = await service.reconcileOrder(publicCode);

  assert.deepEqual(result, {
    ok: false,
    state: "REJECTED",
    reason: "ORDER_REJECTED",
    reservationsReleased: 2,
  });

  const state = prismaMock.getState();
  assert.equal(state.orderState, "REJECTED");
  assert.equal(state.syncErrorCode, "ORDER_REJECTED");
  for (const r of state.reservations) {
    assert.equal(r.state, "RELEASED");
    assert.equal(r.releasedAt, now);
    assert.equal(r.committedAt, null);
  }
});

test("reconcileOrder AMBIGUOUS: preserves SYNC_UNKNOWN and UNKNOWN reservations on incomplete search", async () => {
  const prismaMock = buildMockPrisma({
    initialOrderState: "SYNC_UNKNOWN",
    initialReservationState: "UNKNOWN",
  });

  const gateway = {
    async searchOrderByMarker() {
      return {
        kind: "AMBIGUOUS" as const,
        reason: "bounded order search did not cover all reported pages",
      };
    },
  };

  const service = createPancakeOrderReconciliationService({
    client: prismaMock,
    gateway,
    clock: () => now,
  });

  const result = await service.reconcileOrder(publicCode);

  assert.deepEqual(result, {
    ok: false,
    state: "SYNC_UNKNOWN",
    reason: "AMBIGUOUS",
    detail: "bounded order search did not cover all reported pages",
    reservationsUnknown: 2,
  });

  const state = prismaMock.getState();
  assert.equal(state.orderState, "SYNC_UNKNOWN");
  for (const r of state.reservations) {
    assert.equal(r.state, "UNKNOWN");
    assert.equal(r.committedAt, null);
    assert.equal(r.releasedAt, null);
  }
});

test("reconcileAllUnknownOrders scans and reports correct batch summary", async () => {
  const prismaMock = buildMockPrisma({
    initialOrderState: "SYNC_UNKNOWN",
    initialReservationState: "UNKNOWN",
  });

  const gateway = {
    async searchOrderByMarker() {
      return { kind: "FOUND" as const, orderId: "12345" };
    },
  };

  const service = createPancakeOrderReconciliationService({
    client: prismaMock,
    gateway,
    clock: () => now,
  });

  const batchResult = await service.reconcileAllUnknownOrders({ limit: 10 });
  assert.deepEqual(batchResult, {
    scanned: 1,
    confirmed: 1,
    rejected: 0,
    ambiguous: 0,
  });
});
