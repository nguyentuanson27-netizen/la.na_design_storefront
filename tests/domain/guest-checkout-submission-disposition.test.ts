import assert from "node:assert/strict";
import test from "node:test";

import { submitGuestCheckoutPublicAction } from "../../src/commerce/guest-checkout-public-actions.ts";
import { createGuestCheckoutSubmitService } from "../../src/commerce/guest-checkout-submit.ts";
import { submissionDisposition } from "../../src/commerce/submission-disposition.ts";

/**
 * A local order row carries an `orderCode` whether or not anything reached Pancake, so the code says
 * nothing about whether a parcel exists. These tests drive each outcome through the real submit
 * service and pin what the per-phone limit may conclude from it.
 */

const checkoutInput = {
  name: "Nguyễn Văn A",
  phone: "0901234567",
  provinceRef: "province-01",
  communeRef: "commune-0001",
  detail: "12 Đường A",
  note: null,
};
const now = new Date("2026-11-03T03:00:00.000Z");
const cartId = "11111111-1111-4111-8111-111111111111";
const shopId = 920_007;

const order = {
  id: "order-LA-local",
  publicCode: "LA-local",
  state: "DRAFT" as const,
  merchandiseSubtotalVnd: BigInt(500_000),
  shippingFeeVnd: BigInt(30_000),
  totalVnd: BigInt(530_000),
  lines: [{ variantId: "variant-1", quantity: 1 }],
};
const snapshotCreatesOrder = {
  async create() {
    return { ok: true as const, order, verifiedFulfillmentStateByVariantId: new Map<string, "READY" | "PREORDER">() };
  },
};
const capacityRefuses = {
  async reserveOrderCapacity() {
    return { ok: false as const, reason: "standard-would-go-negative" as const, refusedVariantId: "variant-1" };
  },
  async transitionReservation() {
    return true;
  },
} as never;

type Submission = Awaited<ReturnType<Parameters<typeof createGuestCheckoutSubmitService>[0]["orderSubmission"]["submit"]>>;

function serviceFor(submission: Submission | "unreachable", options: { refuseCapacity?: boolean } = {}) {
  let sent = 0;
  const service = createGuestCheckoutSubmitService({
    snapshot: snapshotCreatesOrder as never,
    orderSubmission: {
      async submit() {
        sent += 1;
        if (submission === "unreachable") throw new Error("must not be sent");
        return submission;
      },
    } as never,
    generatePublicCode: () => "LA-proposed",
    ...(options.refuseCapacity ? { capacity: capacityRefuses } : {}),
  });
  return { service, sent: () => sent };
}

const submit = (service: ReturnType<typeof serviceFor>["service"]) => service.submit({ cartId, shopId, checkoutInput, now });

test("a capacity refusal before the write boundary carries an order code and is NOT_SENT", async () => {
  const { service, sent } = serviceFor("unreachable", { refuseCapacity: true });
  const result = await submit(service);
  assert.deepEqual(result, { ok: false, status: "RETRYABLE", reason: "CART_CHANGED", orderCode: "LA-local" });
  assert.equal(sent(), 0, "nothing reaches Pancake");
  assert.equal(submissionDisposition(result), "NOT_SENT");
});

test("an order Pancake refuses outright (HTTP 4xx, closed REJECTED) carries an order code and is NOT_SENT", async () => {
  const { service } = serviceFor({ ok: false, state: "REJECTED", reason: "ORDER_REJECTED" });
  const result = await submit(service);
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.status, "RETRYABLE");
  assert.equal(result.ok === false && result.status === "RETRYABLE" ? result.orderCode : undefined, "LA-local");
  assert.equal(submissionDisposition(result), "NOT_SENT");
});

test("a validation that could not run is NOT_SENT, whether the order was closed or left a draft", async () => {
  for (const submission of [
    { ok: false, state: "REJECTED", reason: "VALIDATION_UNAVAILABLE" },
    { ok: false, state: "DRAFT", reason: "VALIDATION_UNAVAILABLE" },
  ] as const) {
    const result = await submit(serviceFor(submission as unknown as Submission).service);
    assert.equal(result.ok === false && result.status, "RETRYABLE", submission.state);
    assert.equal(submissionDisposition(result), "NOT_SENT", submission.state);
  }
});

test("a snapshot refusal creates nothing and is NOT_SENT", async () => {
  const service = createGuestCheckoutSubmitService({
    snapshot: { async create() { return { ok: false as const, reason: "CART_LINE_UNAVAILABLE" as const }; } } as never,
    orderSubmission: { async submit() { throw new Error("must not be sent"); } } as never,
    generatePublicCode: () => "LA-proposed",
  });
  assert.equal(submissionDisposition(await submit(service)), "NOT_SENT");
});

test("an outcome that cannot be told from success keeps MAY_EXIST, with or without a code", async () => {
  const unknown = await submit(serviceFor({ ok: false, state: "SYNC_UNKNOWN", reason: "CREATE_OUTCOME_UNKNOWN" }).service);
  assert.equal(unknown.ok === false && unknown.status, "SYNC_UNKNOWN");
  assert.equal(submissionDisposition(unknown), "MAY_EXIST");

  for (const state of ["POS_SUBMITTING", "VALIDATING"] as const) {
    const inFlight = await submit(serviceFor({ ok: false, state, reason: "SUBMISSION_ALREADY_CLAIMED" } as unknown as Submission).service);
    assert.equal(inFlight.ok === false && inFlight.status, "PROCESSING", state);
    assert.equal(submissionDisposition(inFlight), "MAY_EXIST", state);
  }
});

test("a confirmed order is CONFIRMED and a reprice of a never-submitted draft is NOT_SENT", async () => {
  const confirmed = await submit(serviceFor({ ok: true, state: "CONFIRMED", pancakeOrderId: "700001" }).service);
  assert.equal(submissionDisposition(confirmed), "CONFIRMED");
  assert.equal(
    submissionDisposition({ ok: false, status: "PRICE_CHANGED", priceChange: {} as never }),
    "NOT_SENT",
  );
});

// --- through the public action, with the real service behind it -----------------------------------

type Calls = string[];
const form = () => {
  const data = new FormData();
  for (const [key, value] of Object.entries({ name: checkoutInput.name, phone: checkoutInput.phone, provinceRef: checkoutInput.provinceRef, communeRef: checkoutInput.communeRef, detail: checkoutInput.detail })) data.set(key, value);
  return data;
};
const runThroughAction = (service: ReturnType<typeof serviceFor>["service"], calls: Calls) =>
  submitGuestCheckoutPublicAction(
    {
      cartSession: { read: () => cartId, clear: () => undefined },
      consumeAttempt: async () => true,
      submitCheckout: (input) => service.submit({ cartId: input.cartId, shopId, checkoutInput: { ...checkoutInput, ...(input.checkoutInput as object) } as never, now }),
      phoneOrderLimit: {
        admit: async () => { calls.push("admit"); return "ADMITTED"; },
        release: async () => { calls.push("release"); },
      },
    },
    form(),
  );

test("through the action: a capacity refusal and a hard Pancake rejection give the slot back; an unknown outcome keeps it", async () => {
  const cases: Array<[string, ReturnType<typeof serviceFor>, string[]]> = [
    ["capacity refusal", serviceFor("unreachable", { refuseCapacity: true }), ["admit", "release"]],
    ["hard Pancake rejection", serviceFor({ ok: false, state: "REJECTED", reason: "ORDER_REJECTED" }), ["admit", "release"]],
    ["unknown outcome", serviceFor({ ok: false, state: "SYNC_UNKNOWN", reason: "CREATE_OUTCOME_UNKNOWN" }), ["admit"]],
    ["confirmed", serviceFor({ ok: true, state: "CONFIRMED", pancakeOrderId: "700001" }), ["admit"]],
  ];
  for (const [label, { service }, expected] of cases) {
    const calls: Calls = [];
    await runThroughAction(service, calls);
    assert.deepEqual(calls, expected, label);
  }
});
