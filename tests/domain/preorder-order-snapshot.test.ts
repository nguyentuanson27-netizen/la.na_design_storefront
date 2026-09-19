import assert from "node:assert/strict";
import test from "node:test";

import { buildPreorderOrderSnapshot } from "../../src/commerce/preorder-order-snapshot.ts";

test("I7 adds 15 calendar days across month, year and leap-year boundaries", () => {
  for (const [confirmedAt, expectedReadyAt] of [
    ["2026-01-20T03:30:00.000Z", "2026-02-04T03:30:00.000Z"],
    ["2026-12-25T03:30:00.000Z", "2027-01-09T03:30:00.000Z"],
    ["2028-02-20T03:30:00.000Z", "2028-03-06T03:30:00.000Z"],
  ] as const) {
    const snapshot = buildPreorderOrderSnapshot({
      confirmedAt: new Date(confirmedAt),
      lines: [{ variantId: "preorder", quantity: 1, isPreorderSale: true }],
    });

    assert.equal(snapshot.preorderReadyAt?.toISOString(), expectedReadyAt);
    assert.equal(snapshot.lines[0]?.preorderReadyAt?.toISOString(), expectedReadyAt);
  }
});

test("I7 mixed READY and PREORDER lines ship against the preorder order readiness", () => {
  const confirmedAt = new Date("2026-09-18T04:00:00.000Z");
  const snapshot = buildPreorderOrderSnapshot({
    confirmedAt,
    lines: [
      { variantId: "ready", quantity: 1, isPreorderSale: false },
      { variantId: "preorder-a", quantity: 1, isPreorderSale: true },
      { variantId: "preorder-b", quantity: 2, isPreorderSale: true },
    ],
  });

  assert.equal(snapshot.preorderReadyAt?.toISOString(), "2026-10-03T04:00:00.000Z");
  assert.deepEqual(
    snapshot.lines.map(({ variantId, state, preorderReadyAt }) => ({
      variantId,
      state,
      preorderReadyAt: preorderReadyAt?.toISOString() ?? null,
    })),
    [
      { variantId: "ready", state: "READY", preorderReadyAt: null },
      {
        variantId: "preorder-a",
        state: "PREORDER",
        preorderReadyAt: "2026-10-03T04:00:00.000Z",
      },
      {
        variantId: "preorder-b",
        state: "PREORDER",
        preorderReadyAt: "2026-10-03T04:00:00.000Z",
      },
    ],
  );
});


test("F8c I7 copies factual shipping windows only when the confirmed order contains preorder", () => {
  const confirmedAt = new Date("2026-09-18T04:00:00.000Z");
  const shippingEstimate = {
    innerCity: { minimum: 8, maximum: 12 },
    otherProvince: { minimum: 13, maximum: 21 },
  } as const;

  const preorder = buildPreorderOrderSnapshot({
    confirmedAt,
    lines: [{ variantId: "preorder", quantity: 1, isPreorderSale: true }],
    shippingEstimate,
  });
  assert.deepEqual(
    {
      innerMin: preorder.shippingInnerCityMinDays,
      innerMax: preorder.shippingInnerCityMaxDays,
      otherMin: preorder.shippingOtherProvinceMinDays,
      otherMax: preorder.shippingOtherProvinceMaxDays,
    },
    { innerMin: 8, innerMax: 12, otherMin: 13, otherMax: 21 },
  );

  const ready = buildPreorderOrderSnapshot({
    confirmedAt,
    lines: [{ variantId: "ready", quantity: 1, isPreorderSale: false }],
    shippingEstimate,
  });
  assert.deepEqual(
    {
      innerMin: ready.shippingInnerCityMinDays,
      innerMax: ready.shippingInnerCityMaxDays,
      otherMin: ready.shippingOtherProvinceMinDays,
      otherMax: ready.shippingOtherProvinceMaxDays,
    },
    { innerMin: null, innerMax: null, otherMin: null, otherMax: null },
  );
});
