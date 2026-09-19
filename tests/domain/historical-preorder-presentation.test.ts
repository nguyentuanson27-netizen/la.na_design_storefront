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
  const hasPreorder = lines.some((line) => line.state === "PREORDER");
  return {
    preorderReadyAt: hasPreorder ? READY_AT : null,
    shippingInnerCityMinDays: hasPreorder ? 1 : null,
    shippingInnerCityMaxDays: hasPreorder ? 3 : null,
    shippingOtherProvinceMinDays: hasPreorder ? 3 : null,
    shippingOtherProvinceMaxDays: hasPreorder ? 10 : null,
    lines,
    ...overrides,
  };
}

test("F8c ready-only history produces no preorder presentation", () => {
  assert.equal(
    buildHistoricalPreorderPresentation(
      snapshot([{ quantity: 1, state: "READY", preorderReadyAt: null }]),
    ),
    null,
  );
});

test("F8c preorder history renders persisted readiness and persisted shipping windows", () => {
  const presentation = buildHistoricalPreorderPresentation(
    snapshot(
      [{ quantity: 1, state: "PREORDER", preorderReadyAt: READY_AT }],
      {
        shippingInnerCityMinDays: 8,
        shippingInnerCityMaxDays: 12,
        shippingOtherProvinceMinDays: 13,
        shippingOtherProvinceMaxDays: 21,
      },
    ),
  );

  assert.ok(presentation);
  assert.equal(presentation.preorderLabel, "Đặt trước");
  assert.equal(presentation.preorderReadyAt, READY_AT.toISOString());
  assert.deepEqual(
    presentation.shippingWindows?.map(({ minimumDays, maximumDays }) => ({
      minimumDays,
      maximumDays,
    })),
    [
      { minimumDays: 8, maximumDays: 12 },
      { minimumDays: 13, maximumDays: 21 },
    ],
  );
});

test("F8c mixed immutable history is one shipment", () => {
  const presentation = buildHistoricalPreorderPresentation(
    snapshot([
      { quantity: 1, state: "READY", preorderReadyAt: null },
      { quantity: 2, state: "PREORDER", preorderReadyAt: READY_AT },
    ]),
  );

  assert.ok(presentation);
  assert.equal(presentation.isMixedReadyAndPreorder, true);
});

test("F8c multiple preorder lines use the snapshotted order readiness instead of recomputing", () => {
  const presentation = buildHistoricalPreorderPresentation(
    snapshot([
      { quantity: 1, state: "PREORDER", preorderReadyAt: READY_AT },
      { quantity: 4, state: "PREORDER", preorderReadyAt: READY_AT },
    ]),
  );

  assert.ok(presentation);
  assert.equal(presentation.preorderReadyAt, READY_AT.toISOString());
  assert.equal(presentation.isMixedReadyAndPreorder, false);
});

test("F8c legacy I7 history without snapshotted shipping facts never fabricates shipping ETA", () => {
  const presentation = buildHistoricalPreorderPresentation(
    snapshot(
      [{ quantity: 1, state: "PREORDER", preorderReadyAt: READY_AT }],
      {
        shippingInnerCityMinDays: null,
        shippingInnerCityMaxDays: null,
        shippingOtherProvinceMinDays: null,
        shippingOtherProvinceMaxDays: null,
      },
    ),
  );

  assert.ok(presentation);
  assert.equal(presentation.shippingWindows, null);
  assert.equal(presentation.preorderReadyAt, READY_AT.toISOString());
});

test("F8c invalid or partial persisted history fails closed instead of consulting live facts", () => {
  assert.equal(
    buildHistoricalPreorderPresentation(
      snapshot(
        [{ quantity: 1, state: "PREORDER", preorderReadyAt: READY_AT }],
        { shippingOtherProvinceMaxDays: null },
      ),
    ),
    null,
  );

  assert.equal(
    buildHistoricalPreorderPresentation(
      snapshot([
        {
          variantId: "pre",
          quantity: 1,
          state: "PREORDER",
          preorderReadyAt: new Date("2026-10-04T04:30:00.000Z"),
        },
      ]),
    ),
    null,
  );
});

test("F8c READY history cannot become preorder and PREORDER history cannot become ready from live facts", () => {
  assert.equal(
    buildHistoricalPreorderPresentation(
      snapshot([{ quantity: 1, state: "READY", preorderReadyAt: null }]),
    ),
    null,
  );

  const preorderHistory = buildHistoricalPreorderPresentation(
    snapshot([{ quantity: 1, state: "PREORDER", preorderReadyAt: READY_AT }]),
  );
  assert.equal(preorderHistory?.preorderLabel, "Đặt trước");
});
