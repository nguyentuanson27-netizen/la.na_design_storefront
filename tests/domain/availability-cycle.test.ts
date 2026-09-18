import assert from "node:assert/strict";
import test from "node:test";

import {
  PREORDER_AVAILABILITY_WINDOW_DAYS,
  addVietnamCalendarDays,
  isAvailabilityDateExpired,
  observeAvailabilityCycle,
  vietnamCalendarDate,
  type AvailabilityCycleState,
} from "../../src/commerce/availability-cycle.ts";

/**
 * I9 — the owner-approved preorder availability cycle.
 *
 * The whole point of this module is that the date is a FACT with a birthday, not a rolling
 * function of "now". ADR 0011 rejected `today + 15` precisely because a feed that recomputes the
 * date every run publishes a product fact that never stops moving. So the rules that matter most
 * here are the ones about *not* changing an existing date.
 */

const vn = (iso: string) => new Date(iso);

test("I9 a Vietnam calendar date is the UTC+7 day, not the UTC day", () => {
  // The boundary that actually bites: 17:30 UTC is already tomorrow in Hanoi. A UTC-based date
  // would stamp a cycle a day early for every evening observation.
  assert.equal(vietnamCalendarDate(vn("2026-09-17T17:30:00.000Z")), "2026-09-18");
  assert.equal(vietnamCalendarDate(vn("2026-09-17T16:59:59.999Z")), "2026-09-17");
  // Exactly Vietnam midnight.
  assert.equal(vietnamCalendarDate(vn("2026-09-17T17:00:00.000Z")), "2026-09-18");
  // And the start of a Vietnam day.
  assert.equal(vietnamCalendarDate(vn("2026-09-18T00:00:00.000Z")), "2026-09-18");
});

test("I9 calendar arithmetic crosses month, year and leap boundaries", () => {
  assert.equal(PREORDER_AVAILABILITY_WINDOW_DAYS, 15);
  // Month boundary.
  assert.equal(addVietnamCalendarDays("2026-09-20", 15), "2026-10-05");
  // Year boundary.
  assert.equal(addVietnamCalendarDays("2026-12-25", 15), "2027-01-09");
  // Leap day — 2028 is a leap year, so +15 from Feb 20 lands on Mar 6, not Mar 7.
  assert.equal(addVietnamCalendarDays("2028-02-20", 15), "2028-03-06");
  // Non-leap control.
  assert.equal(addVietnamCalendarDays("2027-02-20", 15), "2027-03-07");
});

test("I9 a malformed date is refused rather than coerced", () => {
  // These feed a published product fact, so a silent `Invalid Date` would become a fabricated one.
  assert.equal(vietnamCalendarDate(new Date(Number.NaN)), null);
  assert.equal(addVietnamCalendarDays("not-a-date", 15), null);
  assert.equal(addVietnamCalendarDays("2026-13-01", 15), null);
  assert.equal(addVietnamCalendarDays("2026-02-30", 15), null);
});

const observedAt = vn("2026-09-18T03:00:00.000Z"); // 2026-09-18 in Vietnam
const laterSameDay = vn("2026-09-18T09:00:00.000Z");
const nextWeek = vn("2026-09-25T03:00:00.000Z");

test("I9 stock falling to zero under preorder opens exactly one cycle", () => {
  const before: AvailabilityCycleState = {
    cycleStartDate: null,
    availabilityDate: null,
    lastStockNonPositive: false,
    lastPreorder: true,
  };

  const opened = observeAvailabilityCycle(before, {
    stockNonPositive: true,
    isPreorder: true,
    observedAt,
  });

  assert.equal(opened.cycleStartDate, "2026-09-18");
  assert.equal(opened.availabilityDate, "2026-10-03");
});

test("I9 re-observing the same state never moves the date", () => {
  // The rule ADR 0011 exists for. A sync that reruns with identical state — which is what a healthy
  // catalog does all day — must be a no-op on the published fact.
  let state = observeAvailabilityCycle(null, {
    stockNonPositive: true,
    isPreorder: true,
    observedAt,
  });
  const first = state.availabilityDate;

  for (const at of [laterSameDay, nextWeek, vn("2026-10-20T03:00:00.000Z")]) {
    state = observeAvailabilityCycle(state, { stockNonPositive: true, isPreorder: true, observedAt: at });
    assert.equal(state.availabilityDate, first, "a repeated observation must preserve the date");
    assert.equal(state.cycleStartDate, "2026-09-18");
  }
});

test("I9 an expired cycle is never silently extended", () => {
  // Owner rule 8, stated as its own test because "just add another 15 days" is the tempting bug:
  // the date lapses, publication stops, and the cycle does NOT roll forward on its own.
  const state = observeAvailabilityCycle(null, {
    stockNonPositive: true,
    isPreorder: true,
    observedAt,
  });
  const longAfterExpiry = observeAvailabilityCycle(state, {
    stockNonPositive: true,
    isPreorder: true,
    observedAt: vn("2027-03-01T03:00:00.000Z"),
  });

  assert.equal(longAfterExpiry.availabilityDate, "2026-10-03");
  assert.equal(isAvailabilityDateExpired("2026-10-03", "2027-03-01"), true);
  // Expiry is "the date has passed", so the date itself is still publishable on its own day.
  assert.equal(isAvailabilityDateExpired("2026-10-03", "2026-10-03"), false);
  assert.equal(isAvailabilityDateExpired("2026-10-03", "2026-10-04"), true);
});

test("I9 stock returning closes the cycle, and the next drop opens a different one", () => {
  const open = observeAvailabilityCycle(null, {
    stockNonPositive: true,
    isPreorder: true,
    observedAt,
  });
  assert.equal(open.availabilityDate, "2026-10-03");

  const restocked = observeAvailabilityCycle(open, {
    stockNonPositive: false,
    isPreorder: true,
    observedAt: nextWeek,
  });
  assert.equal(restocked.cycleStartDate, null, "stock above zero ends the cycle");
  assert.equal(restocked.availabilityDate, null);

  const reopened = observeAvailabilityCycle(restocked, {
    stockNonPositive: true,
    isPreorder: true,
    observedAt: vn("2026-10-01T03:00:00.000Z"),
  });
  assert.equal(reopened.cycleStartDate, "2026-10-01", "a later drop is a new cycle, not the old one");
  assert.equal(reopened.availabilityDate, "2026-10-16");
});

test("I9 turning preorder off and on again while sold out is a new cycle", () => {
  // Owner rule 3, third bullet. The operator's toggle is itself a cycle boundary, even though the
  // stock never moved — so this cannot be driven by stock transitions alone.
  const open = observeAvailabilityCycle(null, {
    stockNonPositive: true,
    isPreorder: true,
    observedAt,
  });

  const off = observeAvailabilityCycle(open, {
    stockNonPositive: true,
    isPreorder: false,
    observedAt: vn("2026-09-19T03:00:00.000Z"),
  });
  assert.equal(off.cycleStartDate, null, "leaving preorder ends the cycle");

  const backOn = observeAvailabilityCycle(off, {
    stockNonPositive: true,
    isPreorder: true,
    observedAt: vn("2026-09-20T03:00:00.000Z"),
  });
  assert.equal(backOn.cycleStartDate, "2026-09-20");
  assert.equal(backOn.availabilityDate, "2026-10-05");
});

test("I9 a first observation that is already sold out establishes the initial cycle", () => {
  // Owner rule 3, second bullet: the feature starting to watch is itself the observation. It uses
  // the first day the website SAW the state — never a guess at when the stock actually ran out,
  // which is the backfill the owner ruled out.
  const first = observeAvailabilityCycle(null, {
    stockNonPositive: true,
    isPreorder: true,
    observedAt,
  });

  assert.equal(first.cycleStartDate, "2026-09-18");
  assert.equal(first.availabilityDate, "2026-10-03");
});

test("I9 a variant that is not on preorder never carries a cycle", () => {
  for (const stockNonPositive of [true, false]) {
    const state = observeAvailabilityCycle(null, {
      stockNonPositive,
      isPreorder: false,
      observedAt,
    });
    assert.equal(state.cycleStartDate, null);
    assert.equal(state.availabilityDate, null);
  }
});

test("I9 an unusable observation instant opens no cycle rather than a fabricated one", () => {
  const state = observeAvailabilityCycle(null, {
    stockNonPositive: true,
    isPreorder: true,
    observedAt: new Date(Number.NaN),
  });
  assert.equal(state.cycleStartDate, null, "no trustworthy day means no cycle, not today's guess");
  assert.equal(state.availabilityDate, null);
});
