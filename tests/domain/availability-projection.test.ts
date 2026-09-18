import assert from "node:assert/strict";
import test from "node:test";

import {
  projectExternalAvailability,
  type ExternalAvailabilityInput,
} from "../../src/commerce/availability-projection.ts";

/**
 * I9 — the ONE external availability decision, per ADR 0011.
 *
 * ADR 0011 requires Merchant output and product JSON-LD to consume the same projection rather than
 * each translating internal selling-mode names. This module is that projection, so these tests are
 * where the ADR's table is actually pinned: every row, plus the two fail-closed rows the owner
 * added when approving the cycle date.
 */

const base: ExternalAvailabilityInput = {
  purchasable: true,
  isPreorderSale: false,
  unavailableReason: null,
  capacityReason: "capacity-available",
  availabilityDate: null,
  today: "2026-09-18",
};

const input = (overrides: Partial<ExternalAvailabilityInput>): ExternalAvailabilityInput => ({
  ...base,
  ...overrides,
});

test("I9 a purchasable variant with ready stock is in stock in both vocabularies", () => {
  // Covers three ADR 0011 rows at once — standard above zero, oversell with capacity left, and
  // preorder that still has ready stock. None of them carries a date, and none is labelled with an
  // external preorder term, because the product is already released.
  const projected = projectExternalAvailability(base);

  assert.equal(projected.published, true);
  if (!projected.published) return;
  assert.equal(projected.merchant, "in_stock");
  assert.equal(projected.schema, "InStock");
  assert.equal(projected.availabilityDate, null);
});

test("I9 a sold-out variant and a variant at its hard limit are both out of stock", () => {
  for (const capacityReason of ["standard-would-go-negative", "negative-limit-reached"] as const) {
    const projected = projectExternalAvailability(
      input({ purchasable: false, unavailableReason: "OUT_OF_STOCK", capacityReason }),
    );

    assert.equal(projected.published, true, `${capacityReason} is a publishable state`);
    if (!projected.published) return;
    assert.equal(projected.merchant, "out_of_stock");
    assert.equal(projected.schema, "OutOfStock");
    assert.equal(projected.availabilityDate, null);
  }
});

test("I9 internal preorder without ready stock publishes backorder with the persisted date", () => {
  // The row ADR 0011 blocked. Google reserves `preorder` for unreleased products, so a released
  // La.na product still accepting orders is `backorder` — and `backorder` is exactly the value that
  // requires an availability_date, which is why the row waited for the owner's authority.
  const projected = projectExternalAvailability(
    input({ isPreorderSale: true, availabilityDate: "2026-10-03" }),
  );

  assert.equal(projected.published, true);
  if (!projected.published) return;
  assert.equal(projected.merchant, "backorder");
  assert.equal(projected.schema, "BackOrder");
  assert.equal(projected.availabilityDate, "2026-10-03");
});

test("I9 a backorder is never published without a valid, current date", () => {
  // The fail-closed rule, and the reason this projection exists rather than two mappers. Whatever
  // is wrong with the date, the answer is to withhold the offer — never to fabricate one, and never
  // to relabel the variant `out_of_stock` while checkout is still accepting orders for it.
  const cases: ReadonlyArray<readonly [string, Partial<ExternalAvailabilityInput>]> = [
    ["no cycle has ever opened", { availabilityDate: null }],
    ["the date has passed", { availabilityDate: "2026-09-17" }],
    ["the date is malformed", { availabilityDate: "not-a-date" }],
    ["today is unknown", { availabilityDate: "2026-10-03", today: null }],
  ];

  for (const [label, overrides] of cases) {
    const projected = projectExternalAvailability(input({ isPreorderSale: true, ...overrides }));
    assert.equal(projected.published, false, `${label} must withhold the offer`);
    if (projected.published) return;
    assert.equal(projected.reason, "BACKORDER_DATE_UNAVAILABLE");
  }
});

test("I9 a backorder is still published on its availability date itself", () => {
  // The boundary the expiry rule turns on: the promised day is the promise being kept.
  const projected = projectExternalAvailability(
    input({ isPreorderSale: true, availabilityDate: "2026-09-18", today: "2026-09-18" }),
  );
  assert.equal(projected.published, true);
});

test("I9 a catalog that cannot state availability withholds rather than guessing", () => {
  // Mapping and pricing failures were already withheld before I9. The capacity reasons matter just
  // as much: an unreadable stock number or a malformed stored limit is not evidence of being sold
  // out, and publishing `out_of_stock` on that basis would be a fact the catalog cannot support.
  for (const unavailableReason of ["MAPPING_REQUIRED", "AMBIGUOUS_OPTION", "PRICE_UNRESOLVED"] as const) {
    const projected = projectExternalAvailability(input({ purchasable: false, unavailableReason }));
    assert.equal(projected.published, false, `${unavailableReason} must withhold`);
    if (projected.published) return;
    assert.equal(projected.reason, "AVAILABILITY_UNRESOLVED");
  }

  for (const capacityReason of ["invalid-stock", "invalid-limit", "composite-oversell-unproven"] as const) {
    const projected = projectExternalAvailability(
      input({ purchasable: false, unavailableReason: "OUT_OF_STOCK", capacityReason }),
    );
    assert.equal(projected.published, false, `${capacityReason} must withhold, not read as sold out`);
    if (projected.published) return;
    assert.equal(projected.reason, "AVAILABILITY_UNRESOLVED");
  }
});

test("I9 a date is never attached to a state that does not take one", () => {
  // Google only accepts availability_date alongside preorder/backorder. A stale cycle date left on
  // a restocked variant would be both meaningless and a policy violation.
  const restocked = projectExternalAvailability(input({ availabilityDate: "2026-10-03" }));
  assert.equal(restocked.published, true);
  if (!restocked.published) return;
  assert.equal(restocked.merchant, "in_stock");
  assert.equal(restocked.availabilityDate, null, "an in-stock offer carries no availability date");
});
