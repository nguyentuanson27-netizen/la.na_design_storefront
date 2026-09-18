import assert from "node:assert/strict";
import test from "node:test";

import {
  PREORDER_PREPARATION_DAYS,
  buildPreorderOrderSnapshot,
  type PreorderSnapshotLineInput,
} from "../../src/commerce/preorder-order-snapshot.ts";

const line = (
  variantId: string,
  quantity: number,
  isPreorderSale: boolean,
): PreorderSnapshotLineInput => ({ variantId, quantity, isPreorderSale });

test("I7 adds 15 calendar days across the end of a month", () => {
  const confirmedAt = new Date("2026-01-25T10:15:00.000Z");

  const snapshot = buildPreorderOrderSnapshot({
    confirmedAt,
    lines: [line("v-preorder", 1, true)],
  });

  assert.equal(PREORDER_PREPARATION_DAYS, 15);
  assert.equal(snapshot.preorderReadyAt?.toISOString(), "2026-02-09T10:15:00.000Z");
  assert.equal(snapshot.lines[0]?.preorderReadyAt?.toISOString(), "2026-02-09T10:15:00.000Z");
});

test("I7 adds 15 calendar days across the end of a year", () => {
  const snapshot = buildPreorderOrderSnapshot({
    confirmedAt: new Date("2026-12-20T10:15:00.000Z"),
    lines: [line("v-preorder", 1, true)],
  });

  assert.equal(snapshot.preorderReadyAt?.toISOString(), "2027-01-04T10:15:00.000Z");
});

test("I7 handles a leap-year calendar boundary deterministically", () => {
  const snapshot = buildPreorderOrderSnapshot({
    confirmedAt: new Date("2028-02-15T10:15:00.000Z"),
    lines: [line("v-preorder", 1, true)],
  });

  assert.equal(snapshot.preorderReadyAt?.toISOString(), "2028-03-01T10:15:00.000Z");
});

test("I7 mixed ready + preorder order ships after the preorder readiness", () => {
  const snapshot = buildPreorderOrderSnapshot({
    confirmedAt: new Date("2026-01-25T10:15:00.000Z"),
    lines: [
      line("v-ready", 1, false),
      line("v-preorder", 1, true),
    ],
  });

  assert.equal(snapshot.lines[0]?.state, "READY");
  assert.equal(snapshot.lines[0]?.preorderReadyAt, null);
  assert.equal(snapshot.lines[1]?.state, "PREORDER");
  assert.equal(snapshot.preorderReadyAt?.toISOString(), "2026-02-09T10:15:00.000Z");
});

test("I7 snapshots multiple preorder lines at the same confirmation-based readiness", () => {
  const snapshot = buildPreorderOrderSnapshot({
    confirmedAt: new Date("2026-09-18T10:15:00.000Z"),
    lines: [
      line("v-preorder-a", 1, true),
      line("v-preorder-b", 2, true),
    ],
  });

  assert.deepEqual(
    snapshot.lines.map((entry) => entry.preorderReadyAt?.toISOString()),
    ["2026-10-03T10:15:00.000Z", "2026-10-03T10:15:00.000Z"],
  );
  assert.equal(snapshot.preorderReadyAt?.toISOString(), "2026-10-03T10:15:00.000Z");
});

test("I7 has no order preorder ETA when every line is ready", () => {
  const snapshot = buildPreorderOrderSnapshot({
    confirmedAt: new Date("2026-01-25T10:15:00.000Z"),
    lines: [line("v-ready-a", 1, false), line("v-ready-b", 2, false)],
  });

  assert.equal(snapshot.preorderReadyAt, null);
  assert.deepEqual(
    snapshot.lines.map((entry) => ({ state: entry.state, preorderReadyAt: entry.preorderReadyAt })),
    [
      { state: "READY", preorderReadyAt: null },
      { state: "READY", preorderReadyAt: null },
    ],
  );
});
