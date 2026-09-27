/**
 * I6a — the atomic capacity primitive (ADR 0014 §6.2, §6.4, §7).
 *
 * This is the module I1 deliberately did not ship. Reading a policy is safe outside a transaction;
 * *holding* capacity is not, and a naive write would have looked like the gate while enforcing
 * nothing.
 *
 * The one thing to understand before changing anything here is **why the lock target is
 * `VariantMirror` and not the ledger** (§6.1). `SELECT … FOR UPDATE` locks the rows it returns. A
 * variant nobody has reserved yet has no ledger rows, so locking the ledger returns zero rows and
 * locks nothing: two first-ever checkouts both succeed vacuously, both read
 * `activeReservedQuantity = 0`, and both insert. The lock is useless in exactly the state every
 * variant is in before its first sale. `VariantMirror` rows always exist for anything reservable —
 * `VariantCapacityReservation.variantId` references them with `onDelete: Restrict` — so locking the
 * variant row serializes the second caller even when the ledger is empty.
 *
 * `READ COMMITTED` is deliberate and sufficient. Correctness comes from the explicit lock, not the
 * isolation level, and at this level the blocked transaction's post-lock read takes a fresh snapshot
 * and therefore observes the winner's inserted holds. A higher level would take its snapshot before
 * blocking and abort with a serialization error instead — safe, but it would need a retry loop to be
 * usable, which is a cost with no benefit here.
 */

import { Prisma, type PrismaClient } from "../generated/prisma/client.ts";
import {
  canTransition,
  evaluateVariantCapacity,
  resourceHoldsCapacity,
  resolveSellingPolicy,
  type CapacityDecisionReason,
  type ReservationState,
  type VariantCapacityInput,
  resolveAcceptedPreorderState,
} from "./capacity-policy.ts";

export type ReservationLineRequest = Readonly<{
  variantId: string;
  quantity: number;
  /**
   * The fulfillment state the buyer was shown and acknowledged for this line, when the caller has
   * one to declare.
   *
   * The signed quote proof catches a state that moved where the *projection* can see it, but the
   * projection deliberately does not subtract competing live reservations — it passes
   * `activeReservedQuantity: 0`, because ADR 0014 §2 puts the authoritative read here. So the state
   * can still flip under this lock: PREORDER stock 2, quantity 2, and another order holding 1 unit
   * makes an acknowledged READY line into a PREORDER one. Declaring the expectation lets that be
   * refused before any row is written and before any external call.
   *
   * Optional because only a caller that actually showed a buyer something can promise it. Absent
   * means no promise was made on this attempt and nothing is compared — it never means "accept
   * whatever comes out".
   */
  expectedFulfillmentState?: "READY" | "PREORDER";
}>;

export type HeldReservation = Readonly<{
  id: string;
  variantId: string;
  quantity: number;
  state: ReservationState;
}>;

export type ReservationRefusalReason =
  | "empty-basket"
  | "invalid-quantity"
  | "variant-missing"
  /**
   * This order already has ledger rows, but they are not the basket being asked for: a different
   * quantity, a different set of variants, or a row that no longer holds capacity. Fail-closed on
   * purpose — see `reserveOrderCapacity`.
   */
  | "reservation-conflict"
  /**
   * The line may be held, but not as the buyer was told it would be: capacity moved between the
   * quote they acknowledged and this lock, and an accepted READY line would have become PREORDER
   * (or the reverse). Fail-closed, and surfaced through the same re-confirm path as any other
   * cart change.
   */
  | "fulfillment-state-changed"
  | CapacityDecisionReason;

export type ReservationOutcome =
  | Readonly<{
      ok: true;
      reservations: readonly HeldReservation[];
      /** True when this order already held these lines and nothing new was inserted (§3). */
      alreadyHeld: boolean;
    }>
  | Readonly<{
      ok: false;
      reason: ReservationRefusalReason;
      /** The variant whose line was refused, when one line is responsible. */
      refusedVariantId: string | null;
    }>;

/**
 * ADR §7's precondition, applied rather than assumed.
 *
 * Two lines for the same variant would each see the other excluded from `activeReservedQuantity` and
 * could jointly overshoot. Merging is also what keeps the `(orderId, variantId)` unique key from
 * rejecting a legitimate basket, so it happens here and not in a caller that might forget.
 */
export function mergeReservationLines(
  lines: readonly ReservationLineRequest[],
): ReservationLineRequest[] {
  const byVariantId = new Map<string, number>();
  const expectedByVariantId = new Map<string, "READY" | "PREORDER">();
  for (const line of lines) {
    byVariantId.set(line.variantId, (byVariantId.get(line.variantId) ?? 0) + line.quantity);
    if (line.expectedFulfillmentState === undefined) continue;
    // §30 gives the order one readiness basis, so a merged quantity waits if any part of it was
    // presented as waiting. A cart carries one line per variant, so this only arbitrates a
    // defensive case — but the rule it applies is the spec's, not a convenience.
    if (line.expectedFulfillmentState === "PREORDER" || !expectedByVariantId.has(line.variantId)) {
      expectedByVariantId.set(line.variantId, line.expectedFulfillmentState);
    }
  }
  return [...byVariantId].map(([variantId, quantity]) => {
    const expected = expectedByVariantId.get(variantId);
    return expected === undefined
      ? { variantId, quantity }
      : { variantId, quantity, expectedFulfillmentState: expected };
  });
}

export function createCapacityReservationRepository(client: PrismaClient) {
  const MAX_POSTGRES_INTEGER = 2_147_483_647;

  function sumMirroredStock(stocks: readonly { quantity: number }[]): number {
    let total = 0;
    for (const stock of stocks) {
      if (!Number.isFinite(stock.quantity)) return Number.NaN;
      total += stock.quantity;
      if (!Number.isFinite(total)) return Number.NaN;
    }
    return total;
  }

  function multiplyResourceQuantity(lineQuantity: number, requiredQuantity: number): number | null {
    if (
      !Number.isSafeInteger(lineQuantity) ||
      lineQuantity <= 0 ||
      lineQuantity > MAX_POSTGRES_INTEGER ||
      !Number.isSafeInteger(requiredQuantity) ||
      requiredQuantity <= 0 ||
      requiredQuantity > MAX_POSTGRES_INTEGER
    ) {
      return null;
    }
    const total = lineQuantity * requiredQuantity;
    return Number.isSafeInteger(total) && total > 0 && total <= MAX_POSTGRES_INTEGER ? total : null;
  }

  /**
   * Reserve capacity for one order, all lines or none (§31, §7).
   *
   * The ledger remains line-oriented for idempotency/history, while CapacityReservationResource
   * snapshots the actual stock identities consumed by each line. A standalone line consumes itself;
   * a composite parent consumes its component variants. All requested line variants and component
   * resources are locked in one ordered statement, so different FULL SET variants that share one
   * child serialize on the same always-present VariantMirror row.
   */
  async function reserveOrderCapacity({
    orderId,
    lines,
  }: {
    orderId: string;
    lines: readonly ReservationLineRequest[];
  }): Promise<ReservationOutcome> {
    const merged = mergeReservationLines(lines);
    if (merged.length === 0) return { ok: false, reason: "empty-basket", refusedVariantId: null };
    for (const line of merged) {
      if (
        !Number.isSafeInteger(line.quantity) ||
        line.quantity <= 0 ||
        line.quantity > MAX_POSTGRES_INTEGER
      ) {
        return { ok: false, reason: "invalid-quantity", refusedVariantId: line.variantId };
      }
    }

    const variantIds = merged.map((line) => line.variantId).sort();

    return client.$transaction(
      async (tx) => {
        const locked = await tx.$queryRaw<{ id: string }[]>(
          Prisma.sql`
            SELECT "id"
            FROM "VariantMirror"
            WHERE "id" IN (${Prisma.join(variantIds)})
               OR "id" IN (
                 SELECT "componentVariantId"
                 FROM "CompositeComponentMirror"
                 WHERE "parentVariantId" IN (${Prisma.join(variantIds)})
               )
               OR "id" IN (
                 SELECT resource."variantId"
                 FROM "CapacityReservationResource" resource
                 JOIN "VariantCapacityReservation" reservation
                   ON reservation."id" = resource."reservationId"
                 WHERE reservation."orderId" = ${orderId}
               )
            ORDER BY "id"
            FOR UPDATE
          `,
        );
        const lockedIds = locked.map(({ id }) => id);
        const lockedIdSet = new Set(lockedIds);

        const missing = variantIds.find((id) => !lockedIdSet.has(id)) ?? null;
        if (missing !== null) {
          return { ok: false, reason: "variant-missing", refusedVariantId: missing } as const;
        }

        const variants = await tx.variantMirror.findMany({
          where: { id: { in: variantIds } },
          select: {
            id: true,
            product: {
              select: {
                pancakeShopId: true,
                sellingPolicy: { select: { sellingMode: true, negativeStockLimit: true } },
              },
            },
            compositeComponents: {
              orderBy: [{ componentVariantId: "asc" }],
              select: {
                quantity: true,
                componentVariant: {
                  select: {
                    id: true,
                    isPresent: true,
                    product: {
                      select: {
                        pancakeShopId: true,
                        isPresent: true,
                      },
                    },
                  },
                },
              },
            },
          },
        });
        const variantById = new Map(variants.map((variant) => [variant.id, variant]));
        const absentRequested = variantIds.find((id) => !variantById.has(id)) ?? null;
        if (absentRequested !== null) {
          return { ok: false, reason: "variant-missing", refusedVariantId: absentRequested } as const;
        }

        const lockedFacts = await tx.variantMirror.findMany({
          where: { id: { in: lockedIds } },
          select: {
            id: true,
            warehouseStocks: { select: { quantity: true } },
          },
        });
        const stockByResourceId = new Map(
          lockedFacts.map((variant) => [variant.id, sumMirroredStock(variant.warehouseStocks)]),
        );

        type LinePlan = Readonly<{
          line: ReservationLineRequest;
          isComposite: boolean;
          sellingMode: ReturnType<typeof resolveSellingPolicy>["sellingMode"];
          negativeStockLimit: number;
          resources: readonly Readonly<{ variantId: string; quantity: number }>[];
          invalidResource: boolean;
        }>;

        const linePlans: LinePlan[] = [];
        for (const line of merged) {
          const variant = variantById.get(line.variantId)!;
          const policy = resolveSellingPolicy(variant.product.sellingPolicy);
          if (variant.compositeComponents.length === 0) {
            linePlans.push({
              line,
              isComposite: false,
              sellingMode: policy.sellingMode,
              negativeStockLimit: policy.negativeStockLimit,
              resources: [{ variantId: line.variantId, quantity: line.quantity }],
              invalidResource: false,
            });
            continue;
          }

          let invalidResource = false;
          const resources: { variantId: string; quantity: number }[] = [];
          for (const edge of variant.compositeComponents) {
            const component = edge.componentVariant;
            const quantity = multiplyResourceQuantity(line.quantity, edge.quantity);
            if (
              quantity === null ||
              component.product.pancakeShopId !== variant.product.pancakeShopId ||
              !component.product.isPresent ||
              !component.isPresent ||
              !lockedIdSet.has(component.id)
            ) {
              invalidResource = true;
              continue;
            }
            resources.push({ variantId: component.id, quantity });
          }
          linePlans.push({
            line,
            isComposite: true,
            sellingMode: policy.sellingMode,
            negativeStockLimit: policy.negativeStockLimit,
            resources,
            invalidResource: invalidResource || resources.length === 0,
          });
        }

        const own = await tx.variantCapacityReservation.findMany({
          where: { orderId },
          select: {
            id: true,
            variantId: true,
            quantity: true,
            state: true,
            acceptedPreorderState: true,
            resources: { select: { mirroredAt: true } },
          },
        });
        if (own.length > 0) {
          const requestedByVariantId = new Map(merged.map((line) => [line.variantId, line.quantity]));
          const expectedByVariantId = new Map(
            merged
              .filter((line) => line.expectedFulfillmentState !== undefined)
              .map((line) => [line.variantId, line.expectedFulfillmentState!]),
          );
          // A line still holds while any resource it consumed has not been handed to the mirror. A
          // line with no resource rows has had nothing handed off, so it holds.
          const stillHolds = (row: (typeof own)[number]) => {
            const resources = row.resources.length > 0 ? row.resources : [{ mirroredAt: null }];
            return resources.some((resource) =>
              resourceHoldsCapacity({ state: row.state, mirroredAt: resource.mirroredAt }),
            );
          };
          const mismatch = own.find(
            (row) =>
              row.quantity !== requestedByVariantId.get(row.variantId) ||
              (expectedByVariantId.has(row.variantId) &&
                row.acceptedPreorderState !== expectedByVariantId.get(row.variantId)) ||
              !stillHolds(row),
          );
          if (own.length !== variantIds.length || mismatch !== undefined) {
            return {
              ok: false,
              reason: "reservation-conflict",
              refusedVariantId: mismatch?.variantId ?? null,
            } as const;
          }
          return {
            ok: true,
            alreadyHeld: true,
            reservations: own.map(({ id, variantId, quantity, state }) =>
              Object.freeze({ id, variantId, quantity, state }),
            ),
          } as const;
        }

        const resourceVariantIds = [
          ...new Set(linePlans.flatMap((plan) => plan.resources.map((resource) => resource.variantId))),
        ];
        const heldByResourceId = new Map<string, number>();
        if (resourceVariantIds.length > 0) {
          // Read under the variant locks taken above. The catalog sync records a mirror handoff in
          // the same transaction that writes the stock it relies on, and that transaction locks
          // these same VariantMirror rows, so this read and the stock read above see one side of a
          // sync or the other, never new handoffs against old stock. The filter only narrows the
          // rows; `resourceHoldsCapacity()` decides.
          const heldResources = await tx.capacityReservationResource.findMany({
            where: {
              variantId: { in: resourceVariantIds },
              reservation: { orderId: { not: orderId } },
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
          for (const resource of heldResources) {
            const holds = resourceHoldsCapacity({
              state: resource.reservation.state,
              mirroredAt: resource.mirroredAt,
            });
            if (!holds) continue;
            heldByResourceId.set(
              resource.variantId,
              (heldByResourceId.get(resource.variantId) ?? 0) + resource.quantity,
            );
          }
        }

        const pendingByResourceId = new Map<string, number>();
        const acceptedStateByVariantId = new Map<string, "READY" | "PREORDER">();

        const orderedPlans = [...linePlans].sort((left, right) => {
          const leftFlexible = !left.isComposite && left.sellingMode !== "STANDARD";
          const rightFlexible = !right.isComposite && right.sellingMode !== "STANDARD";
          if (leftFlexible !== rightFlexible) return leftFlexible ? 1 : -1;
          return left.line.variantId.localeCompare(right.line.variantId);
        });

        for (const plan of orderedPlans) {
          if (plan.invalidResource) {
            return {
              ok: false,
              reason: "invalid-stock",
              refusedVariantId: plan.line.variantId,
            } as const;
          }

          let standaloneInput: VariantCapacityInput | null = null;
          for (const resource of plan.resources) {
            const input: VariantCapacityInput = {
              mirroredStock: stockByResourceId.get(resource.variantId) ?? Number.NaN,
              activeReservedQuantity:
                (heldByResourceId.get(resource.variantId) ?? 0) +
                (pendingByResourceId.get(resource.variantId) ?? 0),
              sellingMode: plan.sellingMode,
              negativeStockLimit: plan.negativeStockLimit,
              isComposite: plan.isComposite,
            };
            const decision = evaluateVariantCapacity(input, resource.quantity);
            if (!decision.allowed) {
              return {
                ok: false,
                reason: decision.reason,
                refusedVariantId: plan.line.variantId,
              } as const;
            }
            if (!plan.isComposite) standaloneInput = input;
          }

          for (const resource of plan.resources) {
            pendingByResourceId.set(
              resource.variantId,
              (pendingByResourceId.get(resource.variantId) ?? 0) + resource.quantity,
            );
          }

          acceptedStateByVariantId.set(
            plan.line.variantId,
            plan.isComposite
              ? "READY"
              : resolveAcceptedPreorderState(standaloneInput!, plan.line.quantity),
          );
        }

        const stateMismatch = merged.find((line) => {
          if (line.expectedFulfillmentState === undefined) return false;
          return acceptedStateByVariantId.get(line.variantId) !== line.expectedFulfillmentState;
        });
        if (stateMismatch !== undefined) {
          return {
            ok: false,
            reason: "fulfillment-state-changed",
            refusedVariantId: stateMismatch.variantId,
          } as const;
        }

        await tx.variantCapacityReservation.createMany({
          data: merged.map((line) => ({
            orderId,
            variantId: line.variantId,
            quantity: line.quantity,
            acceptedPreorderState: acceptedStateByVariantId.get(line.variantId) ?? "READY",
          })),
        });
        const inserted = await tx.variantCapacityReservation.findMany({
          where: { orderId, variantId: { in: variantIds } },
          select: { id: true, variantId: true, quantity: true, state: true },
        });
        const planByVariantId = new Map(linePlans.map((plan) => [plan.line.variantId, plan]));
        const resourceRows = inserted.flatMap((reservation) => {
          const plan = planByVariantId.get(reservation.variantId);
          return (plan?.resources ?? []).map((resource) => ({
            reservationId: reservation.id,
            variantId: resource.variantId,
            quantity: resource.quantity,
          }));
        });
        if (resourceRows.length > 0) {
          await tx.capacityReservationResource.createMany({ data: resourceRows });
        }

        return {
          ok: true,
          alreadyHeld: false,
          reservations: inserted.map((row) => Object.freeze({ ...row })),
        } as const;
      },
      { timeout: 30_000, maxWait: 30_000 },
    );
  }

  /**
   * §6.4 — move one reservation, as a compare-and-set.
   *
   * The enum constrains a column's value and the §13 CHECKs are all intra-row, so nothing in SQL
   * stops an UPDATE moving a row COMMITTED → RESERVED. The state machine is only real if every
   * write carries its expected current state and asserts it moved exactly one row.
   */
  async function transitionReservation({
    id,
    from,
    to,
    at = new Date(),
  }: {
    id: string;
    from: ReservationState;
    to: ReservationState;
    at?: Date;
  }): Promise<boolean> {
    if (!canTransition(from, to)) {
      throw new Error(`Illegal reservation transition ${from} -> ${to}`);
    }

    const timestamps =
      to === "COMMITTED"
        ? { committedAt: at, releasedAt: null }
        : to === "RELEASED"
          ? { committedAt: null, releasedAt: at }
          : { committedAt: null, releasedAt: null };

    const moved = await client.variantCapacityReservation.updateMany({
      where: { id, state: from },
      data: { state: to, ...timestamps },
    });
    return moved.count === 1;
  }

  return { reserveOrderCapacity, transitionReservation };
}
