import type { PrismaClient } from "../generated/prisma/client.ts";
import {
  PANCAKE_ORDER_STATUS_CODES,
  comparePancakeOrderStatusTimestamps,
  isCanonicalPancakeOrderId,
  type PancakeOrderStatus,
} from "../integrations/pancake/order-status.ts";
import { PANCAKE_ORDER_CANCELED_STATUS } from "../integrations/pancake/order-readback.ts";

const MAX_LOCAL_ORDER_ID_LENGTH = 128;
const MAX_CAS_ATTEMPTS = 4;
const STATUS_CODES = new Set<number>(PANCAKE_ORDER_STATUS_CODES);

export type PancakeOrderStatusReconcileResult =
  | { ok: true; outcome: "UPDATED" | "UNCHANGED" | "STALE" }
  | {
      ok: false;
      reason:
        | "ORDER_NOT_FOUND"
        | "ORDER_UNSYNCED"
        | "SHOP_SCOPE_UNVERIFIED"
        | "STATUS_UNAVAILABLE"
        | "STATUS_CONFLICT";
    };

type PancakeOrderStatusGateway = Readonly<{
  fetchOrderStatus(shopId: number, orderId: string): Promise<PancakeOrderStatus>;
}>;

type ReconciliationOptions = Readonly<{
  shopId: number;
  /**
   * V14: called after a successful reconcile whose stored status is now the cancelled code, so the website can refund
   * the order's voucher. It runs again on every later `UNCHANGED` reconcile (the refund is a compare-and-set), so a
   * lost call is retried by the next status read. Best effort: a failure never changes the status result.
   */
  onTrustedCancel?: (input: Readonly<{ orderId: string }>) => Promise<void>;
}>;

const localOrderSelect = {
  id: true,
  pancakeShopId: true,
  pancakeOrderId: true,
  pancakeSystemId: true,
  pancakeStatus: true,
  pancakeStatusUpdatedAt: true,
} as const;

function requirePositiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function requireLocalOrderId(value: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_LOCAL_ORDER_ID_LENGTH ||
    value.trim() !== value
  ) {
    throw new TypeError("Local order id must be a bounded non-empty string");
  }
  return value;
}

function isCanonicalPositiveSafeIntegerString(value: string): boolean {
  if (!/^[1-9][0-9]*$/.test(value)) return false;
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric > 0 && String(numeric) === value;
}

function remoteStatusIsUsable(
  remote: PancakeOrderStatus,
  expected: Readonly<{ shopId: number; orderId: string }>,
): boolean {
  if (
    !remote ||
    typeof remote !== "object" ||
    remote.shopId !== expected.shopId ||
    remote.orderId !== expected.orderId ||
    !isCanonicalPancakeOrderId(remote.orderId) ||
    !Number.isSafeInteger(remote.systemId) ||
    remote.systemId <= 0 ||
    !Number.isSafeInteger(remote.status) ||
    !STATUS_CODES.has(remote.status)
  ) {
    return false;
  }

  try {
    comparePancakeOrderStatusTimestamps(remote.updatedAt, remote.updatedAt);
    return true;
  } catch {
    return false;
  }
}

export function createPancakeOrderStatusReconciliationService(
  client: PrismaClient,
  gateway: PancakeOrderStatusGateway,
  options: ReconciliationOptions,
) {
  const configuredShopId = requirePositiveSafeInteger(options?.shopId, "Configured Pancake shop id");

  async function readLocalOrder(orderId: string) {
    return client.orderMirror.findUnique({
      where: { id: orderId },
      select: localOrderSelect,
    });
  }

  function validateLocalIdentity(
    local: Awaited<ReturnType<typeof readLocalOrder>>,
  ):
    | { ok: true; pancakeOrderId: string }
    | { ok: false; reason: "ORDER_NOT_FOUND" | "ORDER_UNSYNCED" | "SHOP_SCOPE_UNVERIFIED" } {
    if (!local) return { ok: false, reason: "ORDER_NOT_FOUND" };
    if (
      local.pancakeShopId === null ||
      local.pancakeOrderId === null ||
      !isCanonicalPancakeOrderId(local.pancakeOrderId)
    ) {
      return { ok: false, reason: "ORDER_UNSYNCED" };
    }
    if (local.pancakeShopId !== configuredShopId) {
      return { ok: false, reason: "SHOP_SCOPE_UNVERIFIED" };
    }
    return { ok: true, pancakeOrderId: local.pancakeOrderId };
  }

  async function reconcile(input: { orderId: string }): Promise<PancakeOrderStatusReconcileResult> {
    const result = await reconcileStatus(input);
    if (result.ok && result.outcome !== "STALE" && options.onTrustedCancel) {
      try {
        // The stored record is the authority, not the remote answer: only a complete, shop-verified mirror at the
        // cancelled code is a signal, and the refund re-checks it under the order lock.
        const stored = await client.orderMirror.findUnique({ where: { id: input.orderId }, select: { pancakeStatus: true } });
        if (stored?.pancakeStatus === PANCAKE_ORDER_CANCELED_STATUS) await options.onTrustedCancel({ orderId: input.orderId });
      } catch {
        // Retried by the next status read; never a reason to fail the reconcile.
      }
    }
    return result;
  }

  async function reconcileStatus({ orderId: rawOrderId }: { orderId: string }): Promise<PancakeOrderStatusReconcileResult> {
    const orderId = requireLocalOrderId(rawOrderId);
    let current = await readLocalOrder(orderId);
    const initialIdentity = validateLocalIdentity(current);
    if (!initialIdentity.ok) return initialIdentity;

    let remote: PancakeOrderStatus;
    try {
      remote = await gateway.fetchOrderStatus(configuredShopId, initialIdentity.pancakeOrderId);
    } catch {
      return { ok: false, reason: "STATUS_UNAVAILABLE" };
    }

    if (
      !remoteStatusIsUsable(remote, {
        shopId: configuredShopId,
        orderId: initialIdentity.pancakeOrderId,
      })
    ) {
      return { ok: false, reason: "STATUS_UNAVAILABLE" };
    }

    const remoteSystemId = String(remote.systemId);

    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const identity = validateLocalIdentity(current);
      if (!identity.ok) return identity;
      if (identity.pancakeOrderId !== remote.orderId) {
        return { ok: false, reason: "STATUS_CONFLICT" };
      }

      const hasSystemId = current!.pancakeSystemId !== null;
      const hasStatus = current!.pancakeStatus !== null;
      const hasRevision = current!.pancakeStatusUpdatedAt !== null;
      const hasAnyStatusData = hasSystemId || hasStatus || hasRevision;
      const hasCompleteStatusData = hasSystemId && hasStatus && hasRevision;

      if (hasAnyStatusData && !hasCompleteStatusData) {
        return { ok: false, reason: "STATUS_CONFLICT" };
      }

      if (!hasCompleteStatusData) {
        const updated = await client.$executeRaw`
          UPDATE "OrderMirror"
          SET "pancakeSystemId" = ${remoteSystemId},
              "pancakeStatus" = ${remote.status},
              "pancakeStatusUpdatedAt" = ${remote.updatedAt}
          WHERE "id" = ${orderId}
            AND "pancakeShopId" = ${configuredShopId}
            AND "pancakeOrderId" = ${remote.orderId}
            AND "pancakeSystemId" IS NULL
            AND "pancakeStatus" IS NULL
            AND "pancakeStatusUpdatedAt" IS NULL
        `;
        if (updated === 1) return { ok: true, outcome: "UPDATED" };
        current = await readLocalOrder(orderId);
        continue;
      }

      const currentSystemId = current!.pancakeSystemId!;
      const currentStatus = current!.pancakeStatus!;
      const currentRevision = current!.pancakeStatusUpdatedAt!;
      if (
        !isCanonicalPositiveSafeIntegerString(currentSystemId) ||
        !Number.isSafeInteger(currentStatus) ||
        !STATUS_CODES.has(currentStatus)
      ) {
        return { ok: false, reason: "STATUS_CONFLICT" };
      }

      let revisionComparison: -1 | 0 | 1;
      try {
        revisionComparison = comparePancakeOrderStatusTimestamps(remote.updatedAt, currentRevision);
      } catch {
        return { ok: false, reason: "STATUS_CONFLICT" };
      }

      if (revisionComparison < 0) {
        return { ok: true, outcome: "STALE" };
      }
      if (revisionComparison === 0) {
        if (currentSystemId === remoteSystemId && currentStatus === remote.status) {
          return { ok: true, outcome: "UNCHANGED" };
        }
        return { ok: false, reason: "STATUS_CONFLICT" };
      }

      const updated = await client.$executeRaw`
        UPDATE "OrderMirror"
        SET "pancakeSystemId" = ${remoteSystemId},
            "pancakeStatus" = ${remote.status},
            "pancakeStatusUpdatedAt" = ${remote.updatedAt}
        WHERE "id" = ${orderId}
          AND "pancakeShopId" = ${configuredShopId}
          AND "pancakeOrderId" = ${remote.orderId}
          AND "pancakeSystemId" = ${currentSystemId}
          AND "pancakeStatus" = ${currentStatus}
          AND "pancakeStatusUpdatedAt" = ${currentRevision}
      `;
      if (updated === 1) return { ok: true, outcome: "UPDATED" };
      current = await readLocalOrder(orderId);
    }

    return { ok: false, reason: "STATUS_CONFLICT" };
  }

  return { reconcile };
}
