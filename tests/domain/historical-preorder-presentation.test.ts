import assert from "node:assert/strict";
import test from "node:test";

import {
  buildHistoricalPreorderPresentation,
  type HistoricalPreorderSnapshotFacts,
} from "../../src/commerce/historical-preorder-presentation.ts";

const READY_AT = new Date("2026-10-03T04:30:00.000Z");

function snapshot(
  lines: HistoricalPreorderSnapshotFacts["lines"],
  overrides: Partial<HistoricalPreorderSnapshotFacts> = {},
): HistoricalPreorderSnapshotFacts {
  return {
    confirmedAt: new Date("2026-09-18T04:30:00.000Z"),
    preorderReadyAt: lines.some((line) => line.state === "PREORDER") ? READY_AT : null,
    shippingScope: lines.some((line) => line.state === "PREORDER") ? "HANOI" : null,
    shippingEstimateMinDays: lines.some((line) => line.state === "PREORDER") ? 1 : null,
    shippingEstimateMaxDays: lines.some((line) => line.state === "PREORDER") ? 3 : null,
    lines,
    ...overrides,
  };
}

test("F8c ready-only history produces no preorder presentation", () => {
  assert.equal(
    buildHistoricalPreorderPresentation(
      snapshot([{ variantId: "ready", quantity: 1, state: "READY", preorderReadyAt: null }]),
    ),
    null,
  );
});

test("F8c preorder history renders the persisted ready date and persisted shipping facts", () => {
  const presentation = buildHistoricalPreorderPresentation(
    snapshot(
      [{ variantId: "pre", quantity: 1, state: "PREORDER", preorderReadyAt: READY_AT }],
      {
        shippingScope: "OTHER_PROVINCE",
        shippingEstimateMinDays: 8,
        shippingEstimateMaxDays: 12,
      },
    ),
  );

  assert.ok(presentation);
  assert.equal(presentation.preorderLabel, "Đặt trước");
  assert.equal(presentation.preorderReadyAt, READY_AT.toISOString());
  assert.deepEqual(presentation.shippingEstimate, {
    scope: "OTHER_PROVINCE",
    minimumDays: 8,
    maximumDays: 12,
  });
});

test("F8c mixed immutable history is one shipment and keeps per-line READY/PREORDER state", () => {
  const presentation = buildHistoricalPreorderPresentation(
    snapshot([
      { variantId: "ready", quantity: 1, state: "READY", preorderReadyAt: null },
      { variantId: "pre", quantity: 2, state: "PREORDER", preorderReadyAt: READY_AT },
    ]),
  );

  assert.ok(presentation);
  assert.equal(presentation.isMixedReadyAndPreorder, true);
  assert.deepEqual(
    presentation.lines.map(({ variantId, state }) => ({ variantId, state })),
    [
      { variantId: "ready", state: "READY" },
      { variantId: "pre", state: "PREORDER" },
    ],
  );
});

test("F8c multiple preorder lines use the snapshotted order readiness instead of recomputing per line", () => {
  const presentation = buildHistoricalPreorderPresentation(
    snapshot([
      { variantId: "a", quantity: 1, state: "PREORDER", preorderReadyAt: READY_AT },
      { variantId: "b", quantity: 4, state: "PREORDER", preorderReadyAt: READY_AT },
    ]),
  );

  assert.ok(presentation);
  assert.equal(presentation.preorderReadyAt, READY_AT.toISOString());
  assert.equal(presentation.lines[0]?.preorderReadyAt, READY_AT.toISOString());
  assert.equal(presentation.lines[1]?.preorderReadyAt, READY_AT.toISOString());
});

test("F8c legacy I7 history without snapshotted shipping facts never fabricates a shipping ETA", () => {
  const presentation = buildHistoricalPreorderPresentation(
    snapshot(
      [{ variantId: "pre", quantity: 1, state: "PREORDER", preorderReadyAt: READY_AT }],
      {
        shippingScope: null,
        shippingEstimateMinDays: null,
        shippingEstimateMaxDays: null,
      },
    ),
  );

  assert.ok(presentation);
  assert.equal(presentation.shippingEstimate, null);
  assert.equal(presentation.preorderReadyAt, READY_AT.toISOString());
});

test("F8c READY history cannot become preorder and PREORDER history cannot become ready from live facts", () => {
  const readyHistory = buildHistoricalPreorderPresentation(
    snapshot([{ variantId: "v", quantity: 1, state: "READY", preorderReadyAt: null }]),
  );
  assert.equal(readyHistory, null);

  const preorderHistory = buildHistoricalPreorderPresentation(
    snapshot([{ variantId: "v", quantity: 1, state: "PREORDER", preorderReadyAt: READY_AT }]),
  );
  assert.equal(preorderHistory?.lines[0]?.state, "PREORDER");
});
