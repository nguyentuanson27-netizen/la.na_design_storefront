import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_NEGATIVE_STOCK_LIMIT,
  RESERVATION_STATES,
  RESERVATION_TRANSITIONS,
  SELLING_MODES,
  canTransition,
  capacityFloorForMode,
  evaluateMultiLineReservation,
  evaluateVariantCapacity,
  isTerminalReservationState,
  reservationHoldsCapacity,
  type ReservationState,
  type SellingMode,
  type VariantCapacityInput,
} from "../../src/commerce/capacity-policy.ts";

function variant(overrides: Partial<VariantCapacityInput> = {}): VariantCapacityInput {
  return {
    mirroredStock: 0,
    activeReservedQuantity: 0,
    sellingMode: "STANDARD",
    negativeStockLimit: DEFAULT_NEGATIVE_STOCK_LIMIT,
    isComposite: false,
    ...overrides,
  };
}

test("G5 the approved selling modes and default limit are exactly the spec's", () => {
  assert.deepEqual(SELLING_MODES, ["STANDARD", "OVERSELL", "PREORDER"]);
  assert.equal(DEFAULT_NEGATIVE_STOCK_LIMIT, -20);

  // STANDARD ignores the limit; its floor is always 0 (master spec §28).
  assert.equal(capacityFloorForMode("STANDARD", -20), 0);
  assert.equal(capacityFloorForMode("OVERSELL", -20), -20);
  assert.equal(capacityFloorForMode("PREORDER", -20), -20);
});

test("G5 STANDARD sells the last unit and refuses the one after it", () => {
  const stock1 = variant({ mirroredStock: 1 });

  assert.equal(evaluateVariantCapacity(stock1, 1).allowed, true);
  assert.equal(evaluateVariantCapacity(stock1, 1).projectedCapacity, 0);

  const refused = evaluateVariantCapacity(stock1, 2);
  assert.equal(refused.allowed, false);
  assert.equal(refused.reason, "standard-would-go-negative");

  // At zero stock nothing more is sellable, whatever the negative limit says.
  assert.equal(evaluateVariantCapacity(variant({ mirroredStock: 0 }), 1).allowed, false);
});

test("G5 STANDARD last-unit concurrency: the second checkout sees the first one's hold", () => {
  // Both checkouts read mirroredStock = 1. The difference is that the second one runs after the
  // first has taken its hold inside the same locked transaction, so it cannot also sell that unit.
  const first = evaluateVariantCapacity(variant({ mirroredStock: 1, activeReservedQuantity: 0 }), 1);
  const second = evaluateVariantCapacity(variant({ mirroredStock: 1, activeReservedQuantity: 1 }), 1);

  assert.equal(first.allowed, true);
  assert.equal(second.allowed, false);
  assert.equal(second.reason, "standard-would-go-negative");
});

test("G5 OVERSELL and PREORDER stop exactly at the negative limit", () => {
  for (const mode of ["OVERSELL", "PREORDER"] as const) {
    // The owner's worked example: limit -20, stock -19, one more unit is the last allowed.
    const atMinus19 = variant({ mirroredStock: -19, sellingMode: mode });
    const lastAllowed = evaluateVariantCapacity(atMinus19, 1);
    assert.equal(lastAllowed.allowed, true, `${mode} must reach the limit`);
    assert.equal(lastAllowed.projectedCapacity, -20);

    // limit + 1 unit is refused.
    const overshoot = evaluateVariantCapacity(atMinus19, 2);
    assert.equal(overshoot.allowed, false, `${mode} must not cross the limit`);
    assert.equal(overshoot.reason, "negative-limit-reached");

    // Already at the limit: nothing more.
    assert.equal(
      evaluateVariantCapacity(variant({ mirroredStock: -20, sellingMode: mode }), 1).allowed,
      false,
    );
  }
});

test("G5 two concurrent reservations cannot jointly cross the limit", () => {
  // Stock -19, limit -20: exactly one unit remains. Two checkouts each want it.
  const mode: SellingMode = "PREORDER";
  const winner = evaluateVariantCapacity(
    variant({ mirroredStock: -19, sellingMode: mode, activeReservedQuantity: 0 }),
    1,
  );
  const loser = evaluateVariantCapacity(
    variant({ mirroredStock: -19, sellingMode: mode, activeReservedQuantity: 1 }),
    1,
  );

  assert.equal(winner.allowed, true);
  assert.equal(winner.projectedCapacity, -20);
  assert.equal(loser.allowed, false, "a stale read must not let both through");
  assert.equal(loser.reason, "negative-limit-reached");
});

test("G5 composite products may not oversell or preorder in v1", () => {
  // G2 exercised a single 1:1 fixture. That is not evidence about arbitrary multipliers, a child
  // starting negative, or multi-component atomicity, so the unproven cases are refused.
  for (const mode of ["OVERSELL", "PREORDER"] as const) {
    const decision = evaluateVariantCapacity(
      variant({ mirroredStock: 5, sellingMode: mode, isComposite: true }),
      1,
    );
    assert.equal(decision.allowed, false, `composite ${mode} must be refused in v1`);
    assert.equal(decision.reason, "composite-oversell-unproven");
  }

  // A composite in STANDARD mode is unaffected: it never goes below zero, so no component
  // accounting is required.
  assert.equal(
    evaluateVariantCapacity(variant({ mirroredStock: 5, isComposite: true }), 1).allowed,
    true,
  );
});

test("G5 malformed capacity input fails closed rather than being coerced", () => {
  const cases: ReadonlyArray<readonly [Partial<VariantCapacityInput>, number, string]> = [
    [{}, 0, "invalid-quantity"],
    [{}, -1, "invalid-quantity"],
    [{}, 1.5, "invalid-quantity"],
    [{}, Number.NaN, "invalid-quantity"],
    [{}, Number.POSITIVE_INFINITY, "invalid-quantity"],
    // A positive "negative limit" would invert the rule into an allowance to sell stock that does
    // not exist, so it is refused rather than clamped.
    [{ sellingMode: "OVERSELL", negativeStockLimit: 5 }, 1, "invalid-limit"],
    [{ sellingMode: "OVERSELL", negativeStockLimit: -1.5 }, 1, "invalid-limit"],
    // A fault in the mirror is reported as `invalid-stock`, not `invalid-quantity`: the request was
    // fine and an operator needs to be sent to the stock data, not to the shopper's input.
    [{ mirroredStock: Number.NaN }, 1, "invalid-stock"],
    // `WarehouseStock.quantity` is `Float`, so a fractional sum is reachable. Capacity is a count,
    // so it fails closed rather than being floored into a number nobody approved.
    [{ mirroredStock: 5.5 }, 1, "invalid-stock"],
    [{ mirroredStock: Number.POSITIVE_INFINITY }, 1, "invalid-stock"],
    [{ activeReservedQuantity: -1 }, 1, "invalid-stock"],
    [{ activeReservedQuantity: 1.5 }, 1, "invalid-stock"],
  ];

  for (const [overrides, quantity, reason] of cases) {
    const decision = evaluateVariantCapacity(variant(overrides), quantity);
    assert.equal(decision.allowed, false, `${JSON.stringify(overrides)} q=${quantity}`);
    assert.equal(decision.reason, reason, `${JSON.stringify(overrides)} q=${quantity}`);
  }

  // A limit of exactly 0 is legitimate: oversell enabled, no negative allowance.
  assert.equal(
    evaluateVariantCapacity(
      variant({ mirroredStock: 1, sellingMode: "OVERSELL", negativeStockLimit: 0 }),
      1,
    ).allowed,
    true,
  );
});

test("G5 a multi-line order fails as a unit when any single line lacks capacity", () => {
  const decision = evaluateMultiLineReservation([
    { line: "ok-a", input: variant({ mirroredStock: 10 }), quantity: 2 },
    { line: "short", input: variant({ mirroredStock: 1 }), quantity: 3 },
    { line: "ok-b", input: variant({ mirroredStock: 4 }), quantity: 1 },
  ]);

  assert.equal(decision.allowed, false, "a partially reservable basket is a refusal");
  assert.equal(decision.refusedLine, "short");
  // Every line is still reported, so one call explains the whole order.
  assert.deepEqual(decision.decisions.map((entry) => entry.decision.allowed), [true, false, true]);
});

test("G5 a multi-line order succeeds only when every line fits, and an empty order is not a reservation", () => {
  const ok = evaluateMultiLineReservation([
    { line: "a", input: variant({ mirroredStock: 10 }), quantity: 2 },
    { line: "b", input: variant({ mirroredStock: -19, sellingMode: "OVERSELL" }), quantity: 1 },
  ]);
  assert.equal(ok.allowed, true);
  assert.equal(ok.refusedLine, null);

  assert.equal(evaluateMultiLineReservation([]).allowed, false, "nothing to reserve is not success");
});

test("G5 the reservation state machine makes commit and release at-most-once", () => {
  // Terminal states accept nothing further, so a duplicate release or a double commit is not a
  // race to be detected — it is a transition that does not exist.
  assert.equal(isTerminalReservationState("COMMITTED"), true);
  assert.equal(isTerminalReservationState("RELEASED"), true);
  assert.equal(canTransition("RELEASED", "RELEASED"), false);
  assert.equal(canTransition("RELEASED", "COMMITTED"), false);
  assert.equal(canTransition("COMMITTED", "RELEASED"), false);
  assert.equal(canTransition("COMMITTED", "COMMITTED"), false);

  assert.deepEqual([...RESERVATION_STATES].sort(), [
    "COMMITTED",
    "RELEASED",
    "RESERVED",
    "SUBMITTING",
    "UNKNOWN",
  ]);
});

test("G5 an ambiguous Pancake write goes to UNKNOWN and has no path that releases on a timer", () => {
  assert.equal(canTransition("SUBMITTING", "UNKNOWN"), true);

  // UNKNOWN leaves only by reconciliation proving the order exists or proving it does not.
  assert.deepEqual([...RESERVATION_TRANSITIONS.UNKNOWN].sort(), ["COMMITTED", "RELEASED"]);

  // There is no self-loop and no way back to an in-flight state, so nothing can quietly retry it
  // into releasing the hold.
  assert.equal(canTransition("UNKNOWN", "UNKNOWN"), false);
  assert.equal(canTransition("UNKNOWN", "SUBMITTING"), false);
  assert.equal(canTransition("UNKNOWN", "RESERVED"), false);

  // RESERVED may never jump straight to UNKNOWN: ambiguity only exists once a write was attempted.
  assert.equal(canTransition("RESERVED", "UNKNOWN"), false);
});

test("G5 an UNKNOWN reservation keeps holding capacity; a released one never does", () => {
  assert.equal(reservationHoldsCapacity({ state: "UNKNOWN" }), true);
  assert.equal(reservationHoldsCapacity({ state: "RESERVED" }), true);
  assert.equal(reservationHoldsCapacity({ state: "SUBMITTING" }), true);
  assert.equal(reservationHoldsCapacity({ state: "RELEASED" }), false);
});

test("G5 a committed reservation holds until the mirror observably includes the decrement", () => {
  const committedAt = new Date("2026-09-17T00:00:00Z");

  // Mirror predates the commit: Pancake's decrement is not in it yet, so the hold must stay or the
  // units are counted by neither side.
  assert.equal(
    reservationHoldsCapacity({
      state: "COMMITTED",
      committedAt,
      stockSyncedAt: new Date("2026-09-16T23:59:59Z"),
    }),
    true,
  );

  // Mirror is strictly newer: it necessarily read Pancake after the order landed, so continuing to
  // hold would subtract the same units twice.
  assert.equal(
    reservationHoldsCapacity({
      state: "COMMITTED",
      committedAt,
      stockSyncedAt: new Date("2026-09-17T00:00:01Z"),
    }),
    false,
  );

  // Ties and missing/invalid timestamps resolve to keep holding. The failure modes are not
  // symmetric: over-holding refuses a sale, under-holding breaches the owner's hard limit.
  assert.equal(
    reservationHoldsCapacity({ state: "COMMITTED", committedAt, stockSyncedAt: committedAt }),
    true,
  );
  assert.equal(reservationHoldsCapacity({ state: "COMMITTED", committedAt }), true);
  assert.equal(
    reservationHoldsCapacity({ state: "COMMITTED", committedAt, stockSyncedAt: null }),
    true,
  );
  assert.equal(
    reservationHoldsCapacity({
      state: "COMMITTED",
      committedAt,
      stockSyncedAt: new Date(Number.NaN),
    }),
    true,
  );
});

test("G5 every state's transitions are declared, and no undeclared edge is allowed", () => {
  // Guards against a state being added with no transition entry, which `canTransition` would
  // otherwise read as "no edges" rather than failing visibly.
  for (const state of RESERVATION_STATES) {
    assert.ok(
      Array.isArray(RESERVATION_TRANSITIONS[state]),
      `${state} has no declared transitions`,
    );
  }

  const declared = new Set<string>();
  for (const from of RESERVATION_STATES) {
    for (const to of RESERVATION_TRANSITIONS[from]) declared.add(`${from}->${to}`);
  }

  for (const from of RESERVATION_STATES) {
    for (const to of RESERVATION_STATES) {
      assert.equal(
        canTransition(from, to),
        declared.has(`${from}->${to}`),
        `${from}->${to} disagreed with the declared table`,
      );
    }
  }

  // An unknown state name must not resolve to a transition.
  assert.equal(canTransition("NOT_A_STATE" as ReservationState, "COMMITTED"), false);
});
