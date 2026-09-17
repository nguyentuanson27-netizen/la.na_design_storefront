import assert from "node:assert/strict";
import test from "node:test";

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
      const row = rows.find((candidate) => candidate.id === id);
      if (!row || row.state !== from) return false;
      row.state = to;
      events.push(`${from}->${to}`);
      return true;
    },
  };

  return { capacity: capacity as never, rows, events };
}

test("I6b holds capacity before the external write and commits it on success", async () => {
  const { capacity, rows, events } = createFakeCapacity();
  const service = createGuestCheckoutSubmitService({
    snapshot: { async create() { return snapshotOrder("LA-ok", "CONFIRMED"); } },
    orderSubmission: {
      async submit() {
        events.push("submit");
        return { ok: true as const } as never;
      },
    },
    generatePublicCode: () => "LA-ok",
    capacity,
  });

  assert.deepEqual(await service.submit({ cartId, shopId, checkoutInput, now }), {
    ok: true,
    status: "CONFIRMED",
    orderCode: "LA-ok",
  });

  // The ordering IS the contract: reserve, then move to SUBMITTING, and only then talk to Pancake.
  // A hold taken after the write would prove nothing about capacity at the moment it was spent.
  assert.deepEqual(events, ["reserve", "RESERVED->SUBMITTING", "submit", "SUBMITTING->COMMITTED"]);
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

test("I6b an ambiguous write keeps holding and a rejection releases", async () => {
  // §8/§10, the asymmetry that matters: SYNC_UNKNOWN must never free capacity on anything but
  // evidence, while REJECTED is evidence that nothing landed.
  for (const [submission, expected] of [
    [{ ok: false, state: "SYNC_UNKNOWN", reason: "TRANSPORT" }, "UNKNOWN"],
    [{ ok: false, state: "REJECTED", reason: "STOCK_UNAVAILABLE" }, "RELEASED"],
  ] as const) {
    const { capacity, rows } = createFakeCapacity();
    const service = createGuestCheckoutSubmitService({
      snapshot: { async create() { return snapshotOrder("LA-amb"); } },
      orderSubmission: { async submit() { return submission as never; } },
      generatePublicCode: () => "LA-amb",
      capacity,
    });

    await service.submit({ cartId, shopId, checkoutInput, now });
    assert.equal(rows[0]?.state, expected, `${submission.state} must settle to ${expected}`);
  }
});

test("I6b an in-flight outcome leaves the hold SUBMITTING rather than guessing", async () => {
  // VALIDATING, POS_SUBMITTING and a repriced DRAFT are not outcomes. Releasing on any of them
  // would free units the buyer is mid-way through buying — the P9b reprice is the clearest case,
  // since the next thing that happens is the buyer reconfirming the very same basket.
  for (const submission of [
    { ok: false, state: "VALIDATING", reason: "PENDING" },
    { ok: false, state: "POS_SUBMITTING", reason: "PENDING" },
    { ok: false, state: "DRAFT", reason: "VALIDATION_UNAVAILABLE" },
  ] as const) {
    const { capacity, rows } = createFakeCapacity();
    const service = createGuestCheckoutSubmitService({
      snapshot: { async create() { return snapshotOrder("LA-flight"); } },
      orderSubmission: { async submit() { return submission as never; } },
      generatePublicCode: () => "LA-flight",
      capacity,
    });

    await service.submit({ cartId, shopId, checkoutInput, now });
    assert.equal(rows[0]?.state, "SUBMITTING", `${submission.state} is not an outcome yet`);
  }
});

test("I6b a hold already decided elsewhere stops the submission closed", async () => {
  // A COMMITTED, RELEASED or UNKNOWN hold means this order's capacity was already settled — by an
  // earlier submission or by §10 reconciliation. Submitting again would either double-send or write
  // over an ambiguous outcome on no evidence.
  for (const state of ["COMMITTED", "RELEASED", "UNKNOWN"] as const) {
    const { capacity } = createFakeCapacity({ initialState: state });
    let submitCalls = 0;
    const service = createGuestCheckoutSubmitService({
      snapshot: { async create() { return snapshotOrder("LA-decided"); } },
      orderSubmission: {
        async submit() {
          submitCalls += 1;
          return { ok: true as const } as never;
        },
      },
      generatePublicCode: () => "LA-decided",
      capacity,
    });

    assert.deepEqual(await service.submit({ cartId, shopId, checkoutInput, now }), {
      ok: false,
      status: "RETRYABLE",
      reason: "CHECKOUT_UNAVAILABLE",
      orderCode: "LA-decided",
    });
    assert.equal(submitCalls, 0, `a ${state} hold must not be resubmitted against`);
  }

  // A hold already SUBMITTING is the in-flight retry, and it proceeds: the guarded CAS would refuse
  // to move it again, so treating it as a blocker would strand every legitimate retry.
  const { capacity, rows } = createFakeCapacity({ initialState: "SUBMITTING" });
  const service = createGuestCheckoutSubmitService({
    snapshot: { async create() { return snapshotOrder("LA-retry", "CONFIRMED"); } },
    orderSubmission: { async submit() { return { ok: true as const } as never; } },
    generatePublicCode: () => "LA-retry",
    capacity,
  });
  assert.equal((await service.submit({ cartId, shopId, checkoutInput, now })).ok, true);
  assert.equal(rows[0]?.state, "COMMITTED");
});
