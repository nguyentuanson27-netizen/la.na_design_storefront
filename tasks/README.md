# Task planning policy

Task plans in this directory define dependencies, ownership, acceptance criteria and verification for their workstreams.

## Current execution authority

For active La.na Design work, use these sources in this order:

1. [`docs/specs/la-na-design-master-spec.md`](../docs/specs/la-na-design-master-spec.md) — current implementation contract and precedence rules.
2. [`docs/specs/la-na-design-owner-approved-facts-and-decisions.md`](../docs/specs/la-na-design-owner-approved-facts-and-decisions.md) — field-level owner-approved brand truth.
3. [`docs/specs/la-na-design-policy-authority.md`](../docs/specs/la-na-design-policy-authority.md) — approved policy wording.
4. [`tasks/plan.md`](./plan.md) — dependency-ordered implementation plan.
5. [`tasks/todo.md`](./todo.md) — current execution checklist and completion state.

If an older plan, audit or task note conflicts with these current authorities, the current La.na Design source wins for brand truth and current execution state.

## Feature plan awaiting approval — gift picker / checkout reminder

The original [gift-picker specification](../docs/specs/storefront-gift-picker-checkout-reminder.md) was merged in PR #173 at `6c75d5e9d8bbb582bcd5438e04f02c0bbfff9646` at the owner's request. PR #174 updates that spec with UX follow-up acceptance before implementation:

- [Implementation plan](./storefront-gift-picker-checkout-reminder-plan.md) — dependencies, checkout safety boundaries, UX-01..UX-04 review dispositions, early C2 UX checks and known CI baseline failures.
- [Task checklist](./storefront-gift-picker-checkout-reminder-todo.md) — the same T00..T13 tasks, acceptance criteria and AC-01..AC-28 traceability; AC-25..AC-28 cover the UX follow-up and implementation tasks are not completed.

This workstream awaits approval of both the plan and the UX spec additions before implementation. T13 records verified results; it is not permission to defer UX decisions until after coding. The workstream does not replace the master plan/checklist, change unrelated policy authority, or claim that the feature has shipped.

## Legacy plans and audits

This repository preserves Core Kit / Brand #1 history. Older files such as the growth-commerce, marketing, storefront-refinement and other completed workstream plans may mention LA Clothing, previous domains, previous databases or old owner gates.

Treat those files as **historical technical context**, not as current La.na Design brand truth and not as the current execution checklist. Do not revive an old `BLOCKED`, `OPEN`, owner-fact value or launch decision without checking the current master spec and `tasks/todo.md` first.

The old LA Clothing source-of-truth document paths are intentionally reduced to tombstones so historical links remain understandable without competing with current La.na Design authorities. Their original contents remain available through Git history.

## Pull request sizing

Current PR sizing is governed by [ADR 0005](../docs/decisions/0005-pr-scope-reviewability.md).

- There is **no hard file-count limit**.
- File count is a signal, not a merge/split gate.
- Use effective changed lines (`additions + deletions`), atomicity, subsystem ownership, risk, verification and revertability to judge scope.
- `≤300` changed lines is the preferred small-review target; `301–500` is normally acceptable for one coherent concern; `501–800` requires an explicit cohesion/reviewability justification; `>800` defaults to split; `>1000` has a strong presumption to split except for justified mechanical/generated/migration/fixture bulk or an inseparable atomic change.
- Do not split production behavior from directly affected tests/assertions merely to meet a size target.
- Independent concerns should still split even when the diff is small.

Older `≤5`, `>5`, `~5 files` or equivalent wording in historical plans is non-authoritative where it conflicts with ADR 0005.
