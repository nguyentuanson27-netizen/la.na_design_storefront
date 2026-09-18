import assert from "node:assert/strict";
import test from "node:test";

import { canTransition, type ReservationState } from "../../src/commerce/capacity-policy.ts";
import { createGuestCheckoutSubmitService } from "../../src/commerce/guest-checkout-submit.ts";

const checkoutInput = {
  name: "Nguyễn Văn A",
  phone: "0901234567",
  provinceRef: "province-01",
  districtRef: "district-001",
  communeRef: "commune-0001",
  detail: "12 Đường A",
  note: null,
};
const now = new Date("2026-08-12T05:30:00.000Z");
const cartId = "11111111-1111-4111-8111-111111111111";
const shopId = 920_007;

function snapshotOrder(
  publicCode: string,
  state: "DRAFT" | "VALIDATING" | "POS_SUBMITTING" | "CONFIRMED" | "SYNC_UNKNOWN" = "DRAFT",
) {
  return {
    ok: true as const,
    order: {
      // I6b — the order is the reservation's idempotency key (§3) and its lines are what gets held,
      // so the double carries both. Without `capacity` wired the service takes no hold at all, which
      // is what keeps every pre-I6b assertion in this file describing the same behaviour.
      id: `order-${publicCode}`,
      publicCode,
      state,
      merchandiseSubtotalVnd: BigInt(500_000),
      shippingFeeVnd: BigInt(30_000),
      totalVnd: BigInt(530_000),
      lines: [{ variantId: "variant-1", quantity: 1 }],
    },
  };
}

test("snapshot failure stops before Pancake submission and exposes only a stable browser reason", async () => {
  let submitCalls = 0;
  const service = createGuestCheckoutSubmitService({
    snapshot: {
      async create() {
        return { ok: false as const, reason: "CART_LINE_UNAVAILABLE" as const };
      },
    },
    orderSubmission: {
      async submit() {
        submitCalls += 1;
        throw new Error("must not submit");
      },
    },
    generatePublicCode: () => "LA-proposed",
  });

  assert.deepEqual(await service.submit({ cartId, shopId, checkoutInput, now }), {
    ok: false,
    status: "RETRYABLE",
    reason: "CART_UNAVAILABLE",
  });
  assert.equal(submitCalls, 0);
});

test("reused active snapshot submits by the persisted order code rather than a newly proposed code", async () => {
  let submittedPublicCode = "";
  let submittedShopId = 0;
  const service = createGuestCheckoutSubmitService({
    snapshot: {
      async create(input) {
        assert.equal(input.publicCode, "LA-proposed");
        return snapshotOrder("LA-existing");
      },
    },
    orderSubmission: {
      async submit(input) {
        submittedPublicCode = input.publicCode;
        submittedShopId = input.shopId;
        return { ok: true as const, state: "CONFIRMED" as const, pancakeOrderId: "700001" };
      },
    },
    generatePublicCode: () => "LA-proposed",
  });

  assert.deepEqual(await service.submit({ cartId, shopId, checkoutInput, now }), {
    ok: true,
    status: "CONFIRMED",
    orderCode: "LA-existing",
  });
  assert.equal(submittedPublicCode, "LA-existing");
  assert.equal(submittedShopId, shopId);
});

test("ambiguous and in-flight outcomes never become browser retry instructions", async () => {
  const cases = [
    {
      submission: {
        ok: false as const,
        state: "SYNC_UNKNOWN" as const,
        reason: "CREATE_OUTCOME_UNKNOWN" as const,
      },
      expected: { ok: false, status: "SYNC_UNKNOWN", orderCode: "LA-existing" },
    },
    {
      submission: {
        ok: false as const,
        state: "POS_SUBMITTING" as const,
        reason: "SUBMISSION_ALREADY_CLAIMED" as const,
      },
      expected: { ok: false, status: "PROCESSING", orderCode: "LA-existing" },
    },
    {
      submission: {
        ok: false as const,
        state: "VALIDATING" as const,
        reason: "SUBMISSION_ALREADY_CLAIMED" as const,
      },
      expected: { ok: false, status: "PROCESSING", orderCode: "LA-existing" },
    },
  ];

  for (const entry of cases) {
    const service = createGuestCheckoutSubmitService({
      snapshot: { async create() { return snapshotOrder("LA-existing"); } },
      orderSubmission: { async submit() { return entry.submission; } },
      generatePublicCode: () => "LA-unused",
    });

    assert.deepEqual(
      await service.submit({ cartId, shopId, checkoutInput, now }),
      entry.expected,
    );
  }
});

test("only pre-write validation unavailability is presented as a safe retry for an existing order", async () => {
  const service = createGuestCheckoutSubmitService({
    snapshot: { async create() { return snapshotOrder("LA-existing"); } },
    orderSubmission: {
      async submit() {
        return {
          ok: false as const,
          state: "DRAFT" as const,
          reason: "VALIDATION_UNAVAILABLE" as const,
        };
      },
    },
    generatePublicCode: () => "LA-unused",
  });

  assert.deepEqual(await service.submit({ cartId, shopId, checkoutInput, now }), {
    ok: false,
    status: "RETRYABLE",
    reason: "SERVICE_UNAVAILABLE",
    orderCode: "LA-existing",
  });
});

test("live price or stock rejection becomes a cart-changed result while internal/config failures stay generic", async () => {
  const cases = [
    { reason: "PRICE_CHANGED" as const, expectedReason: "CART_CHANGED" },
    { reason: "STOCK_UNAVAILABLE" as const, expectedReason: "CART_CHANGED" },
    { reason: "SHOP_SCOPE_UNVERIFIED" as const, expectedReason: "CHECKOUT_UNAVAILABLE" },
    { reason: "LOCAL_ORDER_INVALID" as const, expectedReason: "CHECKOUT_UNAVAILABLE" },
  ];

  for (const entry of cases) {
    const service = createGuestCheckoutSubmitService({
      snapshot: { async create() { return snapshotOrder("LA-existing"); } },
      orderSubmission: {
        async submit() {
          return { ok: false as const, state: "REJECTED" as const, reason: entry.reason };
        },
      },
      generatePublicCode: () => "LA-unused",
    });

    assert.deepEqual(await service.submit({ cartId, shopId, checkoutInput, now }), {
      ok: false,
      status: "RETRYABLE",
      reason: entry.expectedReason,
      orderCode: "LA-existing",
    });
  }
});

test("P9a an unproven quote returns refreshed money and nothing that could authorize the next submit", async () => {
  let submitCalls = 0;
  const service = createGuestCheckoutSubmitService({
    snapshot: {
      async create() {
        return {
          ok: false as const,
          reason: "QUOTE_UNPROVEN" as const,
          quoteReason: "PRICE_CHANGED" as const,
          refreshedQuote: {
            items: [{ variantExternalId: "var-a", quantity: 3, unitPriceVnd: 500_000 }],
            merchandiseSubtotalVnd: 1_500_000,
            shippingFeeVnd: 30_000,
            totalVnd: 1_530_000,
            totalQuantity: 3,
          },
        };
      },
    },
    orderSubmission: {
      async submit() {
        submitCalls += 1;
        throw new Error("must not submit an unproven quote");
      },
    },
    generatePublicCode: () => "LA-unused",
  });

  const result = await service.submit({ cartId, shopId, checkoutInput, now });

  assert.deepEqual(result, {
    ok: false,
    status: "PRICE_CHANGED",
    priceChange: {
      merchandiseSubtotalVnd: 1_500_000,
      shippingFeeVnd: 30_000,
      totalVnd: 1_530_000,
    },
  });
  assert.equal(submitCalls, 0, "an unproven quote must never reach Pancake");

  // The load-bearing assertion. Returning a fresh proof here would let the browser authorize its
  // next submission before the refreshed quote had actually been rendered, and this refusal was
  // driven by a *quantity* change the warning's total alone does not show. The refreshed render is
  // the only thing that issues a proof, so there is nothing here to authorize an early re-submit.
  assert.equal(result.ok, false);
  if (result.ok || result.status !== "PRICE_CHANGED") return;
  assert.deepEqual(
    Object.keys(result.priceChange).sort(),
    ["merchandiseSubtotalVnd", "shippingFeeVnd", "totalVnd"],
    "the price-change payload must carry display money only, never a proof",
  );
});

test("P9b a DRAFT repriced against a fresher Pancake base asks the buyer to reconfirm", async () => {
  const service = createGuestCheckoutSubmitService({
    snapshot: {
      async create() {
        return snapshotOrder("LA-repriced");
      },
    },
    orderSubmission: {
      async submit() {
        return {
          ok: false as const,
          state: "DRAFT" as const,
          reason: "PRICE_CHANGED" as const,
          repricedQuote: {
            merchandiseSubtotalVnd: 600_000,
            shippingFeeVnd: 30_000,
            totalVnd: 630_000,
          },
        };
      },
    },
    generatePublicCode: () => "LA-repriced",
  });

  // The load-bearing assertion. Falling through to PROCESSING would tell the buyer the order is
  // being handled and to stop resubmitting, which would make P9b's explicit reconfirmation
  // unreachable from the browser and strand the order at the repriced DRAFT forever.
  assert.deepEqual(await service.submit({ cartId, shopId, checkoutInput, now }), {
    ok: false,
    status: "PRICE_CHANGED",
    priceChange: {
      merchandiseSubtotalVnd: 600_000,
      shippingFeeVnd: 30_000,
      totalVnd: 630_000,
    },
  });
});

test("P9b a DRAFT returned for any other reason still reads as processing", async () => {
  const service = createGuestCheckoutSubmitService({
    snapshot: {
      async create() {
        return snapshotOrder("LA-busy");
      },
    },
    orderSubmission: {
      async submit() {
        return { ok: false as const, state: "DRAFT" as const, reason: "SUBMISSION_BUSY" as const };
      },
    },
    generatePublicCode: () => "LA-busy",
  });

  assert.deepEqual(await service.submit({ cartId, shopId, checkoutInput, now }), {
    ok: false,
    status: "PROCESSING",
    orderCode: "LA-busy",
  });
});

/**
 * I6b — the ADR 0014 §6.2 reservation boundary at the checkout commit point.
 *
 * What these pin is the *order of operations* and the outcome mapping, because those are the whole
 * safety argument: a hold taken after the external write would be decoration, and a hold released
 * on an ambiguous write is the oversell G2 showed Pancake will not prevent.
 */
type FakeReservation = { id: string; variantId: string; quantity: number; state: string };

function createFakeCapacity(
  options: Readonly<{ refuse?: boolean; initialState?: string }> = {},
) {
  const rows: FakeReservation[] = [];
  const events: string[] = [];

  const capacity = {
    async reserveOrderCapacity({
      orderId,
      lines,
    }: {
      orderId: string;
      lines: readonly { variantId: string; quantity: number }[];
    }) {
      events.push("reserve");
      if (lines.length === 0) {
        return { ok: false as const, reason: "empty-basket" as const, refusedVariantId: null };
      }
      if (options.refuse) {
        return {
          ok: false as const,
          reason: "standard-would-go-negative" as const,
          refusedVariantId: lines[0]?.variantId ?? null,
        };
      }
      rows.length = 0;
      rows.push(
        ...lines.map((line, index) => ({
          id: `${orderId}-r${index}`,
          variantId: line.variantId,
          quantity: line.quantity,
          state: options.initialState ?? "RESERVED",
        })),
      );
      return {
        ok: true as const,
        alreadyHeld: false,
        reservations: rows.map((row) => ({ ...row })),
      } as never;
    },
    async transitionReservation({ id, from, to }: { id: string; from: string; to: string }) {
      // The real repository refuses an edge the state machine does not have, loudly, rather than
      // no-opping — otherwise `RESERVED -> COMMITTED` would look like a lost race instead of the
      // bug it is. `canTransition` is imported rather than restated so this double cannot drift
      // away from the table it is standing in for.
      if (!canTransition(from as ReservationState, to as ReservationState)) {
        throw new Error(`illegal reservation transition ${from} -> ${to}`);
      }
      const row = rows.find((candidate) => candidate.id === id);
      if (!row || row.state !== from) return false;
      row.state = to;
      events.push(`${from}->${to}`);
      return true;
    },
  };

  return { capacity: capacity as never, rows, events };
}

/**
 * A submission double that honours the write boundary.
 *
 * Fidelity here is load-bearing rather than incidental. The real service claims the hold through
 * `beforeExternalWrite`, so a double that ignored the hook would leave every reservation RESERVED
 * and quietly assert that the gate does nothing; a double that called it on entry would restore the
 * very bug the boundary exists to prevent. This mirrors `createPancakeOrderSubmissionService`: a
 * pre-write phase that can end the submission with nothing sent, then the hook, then the write, and
 * on refusal the same pre-write DRAFT it returns for any other bailout.
 */
function fakeSubmission(
  result: unknown,
  options: Readonly<{ endsBeforeWrite?: boolean; events?: string[] }> = {},
) {
  return {
    async submit({
      beforeExternalWrite,
    }: {
      beforeExternalWrite?: () => Promise<boolean>;
    }) {
      options.events?.push("pre-write");
      if (options.endsBeforeWrite) return result as never;
      if (beforeExternalWrite && !(await beforeExternalWrite())) {
        return { ok: false, state: "DRAFT", reason: "VALIDATION_UNAVAILABLE" } as never;
      }
      options.events?.push("write");
      return result as never;
    },
  };
}

test("I6b holds capacity at the external write boundary and commits it on success", async () => {
  const { capacity, rows, events } = createFakeCapacity();
  const service = createGuestCheckoutSubmitService({
    snapshot: { async create() { return snapshotOrder("LA-ok"); } },
    orderSubmission: fakeSubmission({ ok: true }, { events }),
    generatePublicCode: () => "LA-ok",
    capacity,
  });

  assert.deepEqual(await service.submit({ cartId, shopId, checkoutInput, now }), {
    ok: true,
    status: "CONFIRMED",
    orderCode: "LA-ok",
  });

  // The ordering IS the contract, and `pre-write` sitting before `RESERVED->SUBMITTING` is the part
  // that matters: the hold is taken at the write, not around the whole call. A hold claimed before
  // the pre-write phase would be non-expiring for the whole of it; a hold taken after the write
  // would prove nothing about capacity at the moment it was spent.
  assert.deepEqual(events, [
    "reserve",
    "pre-write",
    "RESERVED->SUBMITTING",
    "write",
    "SUBMITTING->COMMITTED",
  ]);
  assert.equal(rows[0]?.state, "COMMITTED");
});

test("I6b a refused reservation sends nothing to Pancake", async () => {
  const { capacity, events } = createFakeCapacity({ refuse: true });
  let submitCalls = 0;
  const service = createGuestCheckoutSubmitService({
    snapshot: { async create() { return snapshotOrder("LA-refused"); } },
    orderSubmission: {
      async submit() {
        submitCalls += 1;
        throw new Error("must not submit without a hold");
      },
    },
    generatePublicCode: () => "LA-refused",
    capacity,
  });

  assert.deepEqual(await service.submit({ cartId, shopId, checkoutInput, now }), {
    ok: false,
    status: "RETRYABLE",
    reason: "CART_CHANGED",
    orderCode: "LA-refused",
  });
  assert.equal(submitCalls, 0, "an unheld basket must never reach the vendor");
  assert.deepEqual(events, ["reserve"]);
});

test("I6b a pre-write outcome never leaves a non-expiring hold", async () => {
  // The defect this pins: `submit()` has a substantial pre-write phase — live catalog fetch,
  // repricing, validation — that can end with nothing sent to Pancake. Claiming SUBMITTING around
  // the whole call turned every such ending into a permanent hold, because §8 forbids releasing
  // SUBMITTING on a timer. The buyer abandons checkout, no order was ever sent, and the SKU keeps
  // losing capacity until someone reconciles it by hand.
  //
  // RESERVED is the state that may expire, so it has to survive the pre-write phase.
  for (const submission of [
    { ok: false, state: "DRAFT", reason: "VALIDATION_UNAVAILABLE" },
    { ok: false, state: "DRAFT", reason: "PRICE_CHANGED", repricedQuote: { merchandiseSubtotalVnd: 520_000, shippingFeeVnd: 30_000, totalVnd: 550_000 } },
    { ok: false, state: "VALIDATING", reason: "SUBMISSION_ALREADY_CLAIMED" },
    { ok: false, state: "POS_SUBMITTING", reason: "SUBMISSION_ALREADY_CLAIMED" },
  ] as const) {
    const { capacity, rows, events } = createFakeCapacity();
    const service = createGuestCheckoutSubmitService({
      snapshot: { async create() { return snapshotOrder("LA-prewrite"); } },
      orderSubmission: fakeSubmission(submission, { endsBeforeWrite: true, events }),
      generatePublicCode: () => "LA-prewrite",
      capacity,
    });

    await service.submit({ cartId, shopId, checkoutInput, now });
    assert.equal(
      rows[0]?.state,
      "RESERVED",
      `${submission.state}/${submission.reason} sent nothing, so the hold must stay expirable`,
    );
    assert.ok(
      !events.includes("RESERVED->SUBMITTING"),
      `${submission.state}/${submission.reason} must never claim the write`,
    );
  }

  // The other direction, so "keep it RESERVED" cannot widen into "never claim SUBMITTING at all":
  // once the write boundary is crossed, an in-flight outcome DOES leave the hold SUBMITTING, which
  // is exactly right — a write may be in flight and §10 is what resolves those.
  const { capacity, rows } = createFakeCapacity();
  const service = createGuestCheckoutSubmitService({
    snapshot: { async create() { return snapshotOrder("LA-inflight"); } },
    orderSubmission: fakeSubmission({
      ok: false,
      state: "POS_SUBMITTING",
      reason: "SUBMISSION_ALREADY_CLAIMED",
    }),
    generatePublicCode: () => "LA-inflight",
    capacity,
  });
  await service.submit({ cartId, shopId, checkoutInput, now });
  assert.equal(rows[0]?.state, "SUBMITTING", "past the write, an in-flight outcome is not an outcome");
});

test("I6b an ambiguous write keeps holding and a rejection releases", async () => {
  // §8/§10, the asymmetry that matters: SYNC_UNKNOWN must never free capacity on anything but
  // evidence, while REJECTED is evidence that nothing landed.
  //
  // The two arrive on different sides of the write boundary, which is why the released case also
  // proves RESERVED -> RELEASED works: a live stock or price rejection is decided during
  // validation, before anything is sent, so that hold never became SUBMITTING. Leaving it to
  // expire instead would keep units out of stock for the whole reservation window on an outcome
  // the server already knows is final.
  for (const [submission, endsBeforeWrite, expected] of [
    [{ ok: false, state: "SYNC_UNKNOWN", reason: "CREATE_OUTCOME_UNKNOWN" }, false, "UNKNOWN"],
    [{ ok: false, state: "REJECTED", reason: "STOCK_UNAVAILABLE" }, true, "RELEASED"],
  ] as const) {
    const { capacity, rows } = createFakeCapacity();
    const service = createGuestCheckoutSubmitService({
      snapshot: { async create() { return snapshotOrder("LA-amb"); } },
      orderSubmission: fakeSubmission(submission, { endsBeforeWrite }),
      generatePublicCode: () => "LA-amb",
      capacity,
    });

    await service.submit({ cartId, shopId, checkoutInput, now });
    assert.equal(rows[0]?.state, expected, `${submission.state} must settle to ${expected}`);
  }
});

test("I6b a hold already decided elsewhere never reaches the external write", async () => {
  // A COMMITTED, RELEASED or UNKNOWN hold means this order's capacity was already settled — by an
  // earlier submission or by §10 reconciliation. Writing again would either double-send or write
  // over an ambiguous outcome on no evidence.
  //
  // The refusal now lands at the write boundary rather than before `submit()`, so `submit()` is
  // entered and its pre-write phase runs. What must not happen is the write, and the buyer is told
  // to retry — the retry re-reserves and gets the truthful capacity answer from the ledger.
  for (const state of ["COMMITTED", "RELEASED", "UNKNOWN"] as const) {
    const { capacity, events } = createFakeCapacity({ initialState: state });
    const service = createGuestCheckoutSubmitService({
      snapshot: { async create() { return snapshotOrder("LA-decided"); } },
      orderSubmission: fakeSubmission({ ok: true }, { events }),
      generatePublicCode: () => "LA-decided",
      capacity,
    });

    assert.deepEqual(await service.submit({ cartId, shopId, checkoutInput, now }), {
      ok: false,
      status: "RETRYABLE",
      reason: "SERVICE_UNAVAILABLE",
      orderCode: "LA-decided",
    });
    assert.ok(!events.includes("write"), `a ${state} hold must not be written against`);
  }

  // A hold already SUBMITTING is the in-flight retry, and it proceeds: the guarded CAS would refuse
  // to move it again, so treating it as a blocker would strand every legitimate retry.
  const { capacity, rows, events } = createFakeCapacity({ initialState: "SUBMITTING" });
  const service = createGuestCheckoutSubmitService({
    snapshot: { async create() { return snapshotOrder("LA-retry"); } },
    orderSubmission: fakeSubmission({ ok: true }, { events }),
    generatePublicCode: () => "LA-retry",
    capacity,
  });
  assert.equal((await service.submit({ cartId, shopId, checkoutInput, now })).ok, true);
  assert.ok(events.includes("write"), "an in-flight retry must still reach the vendor");
  assert.equal(rows[0]?.state, "COMMITTED");
});

test("I6b a terminal outcome from another worker's write is not settled twice", async () => {
  // The race the settle branch exists for: the snapshot hands back a DRAFT, but by the time the
  // submission service looks, another worker has already claimed and confirmed the order. It
  // reports that order's real outcome without this call ever reaching the write boundary, so these
  // holds — the same rows, since reservations are keyed by order (§3) — are still RESERVED here and
  // are that worker's to settle.
  //
  // Settling them from here would mean asserting RESERVED -> COMMITTED, an edge the state machine
  // does not have precisely because capacity cannot be spent by a write this call never made.
  for (const [submission, expected] of [
    [{ ok: true, state: "CONFIRMED", pancakeOrderId: "700900" }, "COMMITTED"],
    [{ ok: false, state: "SYNC_UNKNOWN", reason: "CREATE_OUTCOME_UNKNOWN" }, "UNKNOWN"],
  ] as const) {
    const { capacity, rows } = createFakeCapacity();
    const service = createGuestCheckoutSubmitService({
      snapshot: { async create() { return snapshotOrder("LA-raced"); } },
      orderSubmission: fakeSubmission(submission, { endsBeforeWrite: true }),
      generatePublicCode: () => "LA-raced",
      capacity,
    });

    // The buyer still gets the real answer; only the bookkeeping is left to its owner.
    await service.submit({ cartId, shopId, checkoutInput, now });
    assert.equal(
      rows[0]?.state,
      "RESERVED",
      `a ${expected} outcome we did not write must not be settled from here`,
    );
  }
});

test("I6b an order already past submission is not re-reserved", async () => {
  // The hole the guest-checkout HTTP smoke caught, which no unit test here had: the snapshot can
  // hand back an order that is ALREADY confirmed — the recovery path finds an active checkout
  // rather than creating one, and a buyer resubmitting a confirmed order lands there too.
  //
  // Reserving for it is wrong twice over. Its capacity was decided when it was first submitted, so
  // a fresh hold double-counts it; and for an order created before this boundary existed there are
  // no lines to hold, so the reservation refused `empty-basket` and turned a confirmed checkout
  // into CART_CHANGED — which is how CI found it.
  for (const state of ["CONFIRMED", "SYNC_UNKNOWN"] as const) {
    const { capacity, events } = createFakeCapacity();
    const service = createGuestCheckoutSubmitService({
      snapshot: {
        async create() {
          return {
            ok: true as const,
            order: {
              id: "order-settled",
              publicCode: "LA-settled",
              state,
              merchandiseSubtotalVnd: BigInt(500_000),
              shippingFeeVnd: BigInt(30_000),
              totalVnd: BigInt(530_000),
              // No lines, exactly like the recovered order the smoke reuses.
              lines: [],
            },
          };
        },
      },
      orderSubmission: {
        async submit() {
          events.push("submit");
          return { ok: true as const } as never;
        },
      },
      generatePublicCode: () => "LA-settled",
      capacity,
    });

    assert.deepEqual(await service.submit({ cartId, shopId, checkoutInput, now }), {
      ok: true,
      status: "CONFIRMED",
      orderCode: "LA-settled",
    });
    assert.deepEqual(events, ["submit"], `${state} must reach submission without a fresh hold`);
  }

  // A DRAFT with no lines is a different thing entirely — nothing has been submitted, so an empty
  // basket is a real refusal and must not reach Pancake. Both directions, so the skip above cannot
  // widen into "an empty basket is always fine".
  const { capacity, events } = createFakeCapacity();
  const service = createGuestCheckoutSubmitService({
    snapshot: {
      async create() {
        return {
          ok: true as const,
          order: {
            id: "order-empty-draft",
            publicCode: "LA-empty",
            state: "DRAFT" as const,
            merchandiseSubtotalVnd: BigInt(500_000),
            shippingFeeVnd: BigInt(30_000),
            totalVnd: BigInt(530_000),
            lines: [],
          },
        };
      },
    },
    orderSubmission: {
      async submit() {
        events.push("submit");
        return { ok: true as const } as never;
      },
    },
    generatePublicCode: () => "LA-empty",
    capacity,
  });

  const outcome = await service.submit({ cartId, shopId, checkoutInput, now });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.ok === false && outcome.status, "RETRYABLE");
  assert.ok(!events.includes("submit"), "an unheld DRAFT must not reach the vendor");
});
