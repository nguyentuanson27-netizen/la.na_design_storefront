import assert from "node:assert/strict";
import test from "node:test";

import { recoverOrderIdByMarker, requireAuthorizedFixture } from "../../scripts/i8-pancake-live-acceptance-support.ts";

test("I8 cleanup marker recovery retries bounded propagation until the created order appears", async () => {
  let calls = 0;
  let sleeps = 0;
  const orderId = await recoverOrderIdByMarker({
    gateway: {
      async searchOrderByMarker() {
        calls += 1;
        return calls < 3
          ? { kind: "ABSENT" as const }
          : { kind: "FOUND" as const, orderId: "987654" };
      },
    },
    shopId: 1720000650,
    marker: "[I8-LIVE-ACCEPTANCE-test]",
    attempts: 5,
    delayMs: 1,
    sleep: async () => {
      sleeps += 1;
    },
  });

  assert.equal(orderId, "987654");
  assert.equal(calls, 3);
  assert.equal(sleeps, 2);
});

test("I8 cleanup marker recovery stays bounded when no unique order can be recovered", async () => {
  let calls = 0;
  const orderId = await recoverOrderIdByMarker({
    gateway: {
      async searchOrderByMarker() {
        calls += 1;
        return { kind: "AMBIGUOUS" as const, reason: "propagation or pagination inconclusive" };
      },
    },
    shopId: 1720000650,
    marker: "[I8-LIVE-ACCEPTANCE-missing]",
    attempts: 3,
    delayMs: 1,
    sleep: async () => {},
  });

  assert.equal(orderId, null);
  assert.equal(calls, 3);
});


test("I8 live fixture selection matches only exact V8014-S identity", () => {
  const authorized = { id: "variation-2", displayId: "V8014-S", barcode: "OTHER" };
  const selected = requireAuthorizedFixture(
    [
      { id: "variation-1", displayId: "V8014-M", barcode: "V8014-M" },
      authorized,
      { id: "variation-3", displayId: "V8014-S-OLD", barcode: "V8014-S-OLD" },
    ],
    "V8014-S",
  );

  assert.equal(selected, authorized);
});

test("I8 live fixture selection fails closed when exact V8014-S is missing or duplicated", () => {
  assert.throws(
    () =>
      requireAuthorizedFixture(
        [{ id: "variation-1", displayId: "V8014-M", barcode: "V8014-M" }],
        "V8014-S",
      ),
    /exactly one authorized fixture/i,
  );

  assert.throws(
    () =>
      requireAuthorizedFixture(
        [
          { id: "variation-1", displayId: "V8014-S", barcode: "A" },
          { id: "variation-2", displayId: "B", barcode: "V8014-S" },
        ],
        "V8014-S",
      ),
    /exactly one authorized fixture/i,
  );
});
