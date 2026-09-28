import assert from "node:assert/strict";
import test from "node:test";

import type { PendingInventorySignal } from "../../src/commerce/pancake-inventory-signals.ts";
import {
  INVENTORY_BATCH_INTERVAL_MS,
  processInventorySignals,
  runInventoryBatchLoop,
  type InventoryBatchDependencies,
} from "../../src/operations/inventory-batch.ts";

function signal(variationId: string, receivedCount = 1, warehouseId = "w-1"): PendingInventorySignal {
  return {
    pancakeVariationId: variationId,
    pancakeWarehouseId: warehouseId,
    receivedCount,
    lastReceivedAt: new Date("2026-09-28T09:00:00.000Z"),
    attempts: 0,
  };
}

/** A recording fake of every dependency, in the order the batch touches them. */
function fakes(overrides: Partial<InventoryBatchDependencies> = {}) {
  const trace: string[] = [];
  let tick = 0;
  const clock = () => {
    tick += 1;
    trace.push(`clock#${tick}`);
    return new Date(Date.UTC(2026, 8, 28, 9, 0, tick));
  };
  const resolved: PendingInventorySignal[] = [];
  const failed: PendingInventorySignal[] = [];
  const applied: Parameters<InventoryBatchDependencies["applyVariationStocks"]>[0][] = [];
  const deps: InventoryBatchDependencies = {
    shopId: 47,
    clock,
    signals: {
      listPending: async () => {
        trace.push("claim");
        return [signal("v-1", 3), signal("v-2"), signal("v-unknown")];
      },
      productIdsFor: async () => new Map([["v-1", "p-1"], ["v-2", "p-1"]]),
      resolve: async (signals) => {
        resolved.push(...signals);
        return signals.length;
      },
      recordFailure: async (signals) => {
        failed.push(...signals);
        return { retried: signals.length, dropped: 0 };
      },
    },
    readProduct: async (productId) => {
      trace.push(`read:${productId}`);
      return new Map([
        ["v-1", [{ warehouseId: "w-1", remainQuantity: 4 }]],
        ["v-2", [{ warehouseId: "w-1", remainQuantity: 0 }]],
      ]);
    },
    applyVariationStocks: async (input) => {
      trace.push("apply");
      applied.push(input);
      return { applied: input.observations.length, unknown: 0, superseded: 0, capacityHandedOff: 1 };
    },
    ...overrides,
  };
  return { deps, trace, resolved, failed, applied };
}

test("a batch claims, samples the read-start clock, reads each product once, then applies", async () => {
  const { deps, trace, resolved, applied } = fakes();
  const result = await processInventorySignals(deps);

  // claim time, then the read-start marker, both before the first Pancake request (ADR 0014 §4.2).
  assert.deepEqual(trace, ["clock#1", "claim", "clock#2", "read:p-1", "clock#3", "apply"]);
  assert.deepEqual(applied[0]!.syncedAt, new Date(Date.UTC(2026, 8, 28, 9, 0, 2)));
  assert.deepEqual(
    applied[0]!.observations.map(({ variationId }) => variationId),
    ["v-1", "v-2"],
  );
  assert.equal(resolved.length, 3, "written and unknown markers are covered");
  assert.deepEqual(result, {
    events: 5,
    deduplicated: 2,
    signals: 3,
    variations: 3,
    applied: 2,
    superseded: 0,
    unknown: 1,
    failedReads: 0,
    retried: 0,
    dropped: 0,
    capacityHandedOff: 1,
  });
});

test("a failed Pancake read keeps its markers for retry and still clears the rest", async () => {
  const { deps, resolved, failed, applied } = fakes({
    readProduct: async () => {
      throw new Error("pancake 502 with api_key=SECRET");
    },
  });
  const result = await processInventorySignals(deps);
  assert.equal(applied.length, 0, "nothing is written from a read that did not happen");
  assert.deepEqual(failed.map((s) => s.pancakeVariationId), ["v-1", "v-2"]);
  assert.deepEqual(resolved.map((s) => s.pancakeVariationId), ["v-unknown"]);
  assert.equal(result.failedReads, 1);
});

test("a failed write keeps every marker of the batch", async () => {
  const { deps, resolved, failed } = fakes({
    applyVariationStocks: async () => {
      throw new Error("serialization failure");
    },
  });
  const result = await processInventorySignals(deps);
  assert.equal(resolved.length, 0);
  assert.equal(failed.length, 3);
  assert.equal(result.failedReads, 1);
});

test("an empty queue does no Pancake read at all", async () => {
  const { deps, trace } = fakes({ signals: { ...fakes().deps.signals, listPending: async () => [] } });
  const result = await processInventorySignals(deps);
  assert.equal(result.signals, 0);
  assert.equal(trace.some((step) => step.startsWith("read:")), false);
});

test("the batch loop runs every 30 seconds, stays quiet when idle, and survives a failing batch", async () => {
  const controller = new AbortController();
  const sleeps: number[] = [];
  const lines: string[] = [];
  let calls = 0;
  const result = await runInventoryBatchLoop({
    process: async () => {
      calls += 1;
      if (calls === 1) return { ...(await processInventorySignals(fakes({ signals: { ...fakes().deps.signals, listPending: async () => [] } }).deps)) };
      if (calls === 2) throw new Error("pancake down: token=SECRET");
      if (calls === 3) {
        controller.abort();
        return processInventorySignals(fakes().deps);
      }
      throw new Error("unreachable");
    },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    signal: controller.signal,
    log: (line) => lines.push(line),
    now: () => new Date("2026-09-28T09:00:00.000Z"),
  });

  assert.equal(INVENTORY_BATCH_INTERVAL_MS, 30_000);
  assert.deepEqual(sleeps, [30_000, 30_000, 30_000], "each batch waits out one 30-second window first");
  assert.deepEqual(result, { batches: 3, failures: 1 });
  assert.equal(lines.length, 2, "an idle batch logs nothing");
  assert.match(lines[0]!, /inventory batch failed; markers kept/);
  assert.equal(lines.some((line) => line.includes("SECRET")), false);
  assert.match(lines[1]!, /inventory batch: 5 webhook events \(2 deduplicated\), 3 variations, 2 applied/);
});
