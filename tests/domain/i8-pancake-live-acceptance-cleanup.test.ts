import assert from "node:assert/strict";
import test from "node:test";

import { recoverOrderIdByMarker } from "../../scripts/i8-pancake-live-acceptance-support.ts";

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
