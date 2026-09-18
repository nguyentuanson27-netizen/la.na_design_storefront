import assert from "node:assert/strict";
import test from "node:test";

import { createGuestCheckoutSubmitRuntime } from "../../src/commerce/guest-checkout-submit-runtime.ts";

const now = new Date("2026-08-12T06:00:00.000Z");
const cartId = "44444444-4444-4444-8444-444444444444";
const checkoutInput = {
  name: "Nguyễn Văn A",
  phone: "0901234567",
  provinceRef: "province-01",
  districtRef: "district-001",
  communeRef: "commune-0001",
  detail: "12 Đường A",
  note: null,
};

test("fresh guest checkout validates geo before creating a snapshot", async () => {
  let configReads = 0;
  let recoveryInput: unknown;
  let geoInput: unknown;
  let snapshotFactoryInput: { checkoutInputValidated?: boolean; verifyRenderedQuote?: unknown } | undefined;
  let snapshotInput: unknown;
  let submissionInput: unknown;
  let orderFactoryConfig: unknown;
  const calls: string[] = [];

  const runtime = createGuestCheckoutSubmitRuntime({
    recoverStranded: async (input) => {
      calls.push("recover");
      recoveryInput = input;
    },
    readConfig: () => {
      calls.push("config");
      configReads += 1;
      return { apiKey: "server-secret", shopId: 920_007 };
    },
    requiresFreshSnapshot: async (input) => {
      calls.push("fresh-check");
      assert.equal(input, cartId);
      return true;
    },
    validateGeo: async (_config: unknown, input: unknown) => {
      calls.push("geo");
      geoInput = input;
      return { ok: true as const, checkoutInput };
    },
    createSnapshot: (input) => {
      snapshotFactoryInput = input;
      return {
        async create(snapshot) {
          calls.push("snapshot");
          snapshotInput = snapshot;
          return {
            ok: true as const,
            order: {
              publicCode: "LA-server-owned",
              id: "order-LA-server-owned",
              state: "DRAFT" as const,
              merchandiseSubtotalVnd: BigInt(500_000),
              shippingFeeVnd: BigInt(30_000),
              totalVnd: BigInt(530_000),
              lines: [{ variantId: "variant-1", quantity: 1 }],
            },
          };
        },
      };
    },
    createOrderSubmission: (config) => {
      orderFactoryConfig = config;
      return {
        async submit(input) {
          calls.push("submit");
          submissionInput = input;
          return {
            ok: true as const,
            state: "CONFIRMED" as const,
            pancakeOrderId: "700001",
          };
        },
      };
    },
    // I6b — a capacity double, so this file keeps testing the runtime's ORDERING (recover, config,
    // fresh-check, geo, snapshot, submit) without a database. The reservation state machine itself
    // is pinned in guest-checkout-submit.test.ts.
    createCapacity: () => ({
      async reserveOrderCapacity({ lines }) {
        return {
          ok: true as const,
          alreadyHeld: false,
          reservations: lines.map((line, index) => ({
            id: `runtime-hold-${index}`,
            variantId: line.variantId,
            quantity: line.quantity,
            state: "RESERVED" as const,
          })),
        };
      },
      async transitionReservation() {
        return true;
      },
    }),
    generatePublicCode: () => "LA-server-owned",
    readQuoteProofSecret: () => "runtime-test-secret-at-least-32-characters",
    clock: () => now,
  });

  assert.deepEqual(await runtime.submit({ cartId, checkoutInput, quoteProof: null }), {
    ok: true,
    status: "CONFIRMED",
    orderCode: "LA-server-owned",
  });
  assert.deepEqual(calls, ["recover", "config", "fresh-check", "geo", "snapshot", "submit"]);
  assert.deepEqual(recoveryInput, { cartId, now });
  assert.equal(configReads, 1);
  assert.deepEqual(geoInput, checkoutInput);
  assert.equal(snapshotFactoryInput?.checkoutInputValidated, true);
  // The runtime must hand the snapshot a real verifier on every path, whatever it decided about
  // geo authority: a snapshot service built without one would create submit-capable DRAFTs at
  // prices no buyer has acknowledged.
  assert.equal(typeof snapshotFactoryInput?.verifyRenderedQuote, "function");
  assert.deepEqual(orderFactoryConfig, { apiKey: "server-secret", shopId: 920_007 });
  assert.deepEqual(snapshotInput, {
    cartId,
    shopId: 920_007,
    publicCode: "LA-server-owned",
    checkoutInput,
    now,
  });
  const submission = submissionInput as {
    publicCode: string;
    shopId: number;
    beforeExternalWrite?: unknown;
  };
  assert.equal(submission.publicCode, "LA-server-owned");
  assert.equal(submission.shopId, 920_007);
  // I6b — the runtime must hand the submission service a real write-boundary hook whenever it holds
  // capacity. Without one the service writes to Pancake with the hold still RESERVED, which is the
  // bypass the boundary exists to prevent; the hook's behaviour itself is pinned in
  // guest-checkout-submit.test.ts.
  assert.equal(typeof submission.beforeExternalWrite, "function");
});

test("reusable active checkout skips geo reads while snapshot transaction retains race authority", async () => {
  const calls: string[] = [];
  let snapshotFactoryInput: { checkoutInputValidated?: boolean; verifyRenderedQuote?: unknown } | undefined;
  const runtime = createGuestCheckoutSubmitRuntime({
    readQuoteProofSecret: () => "runtime-test-secret-at-least-32-characters",
    recoverStranded: async () => {
      calls.push("recover");
    },
    readConfig: () => {
      calls.push("config");
      return { apiKey: "server-secret", shopId: 920_007 };
    },
    requiresFreshSnapshot: async () => {
      calls.push("fresh-check");
      return false;
    },
    validateGeo: async () => {
      calls.push("geo");
      throw new Error("reusable checkout must not re-read Pancake geo");
    },
    createSnapshot: (input) => {
      snapshotFactoryInput = input;
      return {
        async create() {
          calls.push("snapshot");
          return {
            ok: true as const,
            order: {
              publicCode: "LA-confirmed",
              id: "order-LA-confirmed",
              state: "CONFIRMED" as const,
              merchandiseSubtotalVnd: BigInt(500_000),
              shippingFeeVnd: BigInt(30_000),
              totalVnd: BigInt(530_000),
              lines: [{ variantId: "variant-1", quantity: 1 }],
            },
          };
        },
      };
    },
    createOrderSubmission: () => ({
      async submit() {
        calls.push("submit");
        return {
          ok: true as const,
          state: "CONFIRMED" as const,
          pancakeOrderId: "700001",
        };
      },
    }),
    // I6b — same capacity double as above: this file pins the runtime's ordering, not the
    // reservation state machine.
    createCapacity: () => ({
      async reserveOrderCapacity({ lines }) {
        return {
          ok: true as const,
          alreadyHeld: false,
          reservations: lines.map((line, index) => ({
            id: `runtime-hold-${index}`,
            variantId: line.variantId,
            quantity: line.quantity,
            state: "RESERVED" as const,
          })),
        };
      },
      async transitionReservation() {
        return true;
      },
    }),
    clock: () => now,
  });

  assert.deepEqual(await runtime.submit({ cartId, checkoutInput, quoteProof: null }), {
    ok: true,
    status: "CONFIRMED",
    orderCode: "LA-confirmed",
  });
  assert.deepEqual(calls, ["recover", "config", "fresh-check", "snapshot", "submit"]);
  assert.equal(snapshotFactoryInput?.checkoutInputValidated, false);
  // The runtime must hand the snapshot a real verifier on every path, whatever it decided about
  // geo authority: a snapshot service built without one would create submit-capable DRAFTs at
  // prices no buyer has acknowledged.
  assert.equal(typeof snapshotFactoryInput?.verifyRenderedQuote, "function");
});

test("fresh guest checkout rejects an invalid geo hierarchy before snapshot or order submission", async () => {
  const calls: string[] = [];
  const runtime = createGuestCheckoutSubmitRuntime({
    readQuoteProofSecret: () => "runtime-test-secret-at-least-32-characters",
    recoverStranded: async () => {
      calls.push("recover");
    },
    readConfig: () => {
      calls.push("config");
      return { apiKey: "server-secret", shopId: 920_007 };
    },
    requiresFreshSnapshot: async () => {
      calls.push("fresh-check");
      return true;
    },
    validateGeo: async () => {
      calls.push("geo");
      return { ok: false as const, reason: "INVALID_INPUT" as const };
    },
    createSnapshot: () => {
      calls.push("snapshot-factory");
      throw new Error("snapshot must not be created");
    },
    createOrderSubmission: () => {
      calls.push("order-factory");
      throw new Error("order submission must not be created");
    },
    clock: () => now,
  });

  assert.deepEqual(await runtime.submit({ cartId, checkoutInput, quoteProof: null }), {
    ok: false,
    status: "RETRYABLE",
    reason: "INVALID_INPUT",
  });
  assert.deepEqual(calls, ["recover", "config", "fresh-check", "geo"]);
});
