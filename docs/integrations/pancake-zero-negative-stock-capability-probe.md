# Pancake zero/negative-stock & composite capability probe (G2)

Status: **Historical controlled-write evidence complete; credential revocation/rotation owner-confirmed on 2026-09-16.**

> [!NOTE]
> A Pancake credential was exposed during early PR #9 development. The repository owner confirmed on **2026-09-16** that the exposed credential was revoked/rotated. The credential value is not recorded here. Repository review cannot independently verify provider-side state, so this document records the owner attestation rather than claiming direct provider verification. The probe script continues to require `PANCAKE_PROBE_CREDENTIAL_ROTATED=true` as an explicit runtime attestation before Pancake network execution; this flag does not itself rotate a credential.

## Authorized scope

The owner authorized controlled writes against test shop `1720000650` only, using these fixtures:

- ordinary product code `V8014` (historically resolved to `V8014-S`)
- composite parent `SV1683-S`
- composite children `SV1683-AO-S` and `SV1683-VAY-S`

The current harness resolves these codes read-only at runtime and fails closed unless the parent references the exact two authorized child variation IDs with 1:1 multipliers and all four variations share one deterministic warehouse.

## Historical live evidence

The controlled live run occurred on `2026-09-16T08:54:25.352Z`, run id `3v3pbs`. It used the earlier probe implementation. No additional live Pancake writes were performed for the later review-hardening changes.

Historical baseline:

| Variation | Baseline |
|---|---:|
| `V8014-S` | 10 |
| `SV1683-S` | 0 |
| `SV1683-AO-S` | 0 |
| `SV1683-VAY-S` | 0 |

Observed outcomes:

| Scenario | Observed result | Scope of conclusion |
|---|---|---|
| Positive ordinary stock | One order accepted; stock `10 -> 9` | This fixture accepted a normal positive-stock order. |
| Ordinary stock exactly `0` | One order accepted; stock `0 -> -1` | This test shop/configuration accepted an order at zero stock. |
| Ordinary stock already `-1` | One order accepted; stock `-1 -> -2` | This test shop/configuration accepted an order that started negative. |
| Two concurrent requests at `0` | Both accepted; final stock `-2` | A bounded two-request test showed no zero-stock rejection for those requests. This does not prove general concurrency safety. |
| Composite positive, 1:1 fixture | Parent order accepted; both children `1 -> 0` | For this exact two-child 1:1 fixture, ordering the parent decremented both observed components by one. |
| One composite child at `0` | Parent order accepted; child `0 -> -1`, other child `1 -> 0` | For this exact fixture, zero component stock did not block the parent order. |
| Composite child already negative | **NOT PROBED** | Direct negative component setup could not be established safely in the historical run. |

Historical run accounting: 25 mutating API calls; seven created test orders were recorded as cancelled with terminal status `7`; the recorded final stock baseline matched the pre-run baseline.

## What the historical run did not prove

The live evidence does **not** establish:

- behavior for non-1:1 composite multipliers;
- atomicity of multi-component decrements under partial failure or contention;
- nested/general BOM behavior;
- composite-parent behavior when a component starts negative;
- unlimited overselling safety;
- a safe storefront concurrency model.

G5 must therefore treat Pancake as an upstream system that does not enforce La.na's planned storefront capacity invariant. Composite `oversell` / `preorder` remains disallowed in v1 unless G5 later approves component-aware atomic capacity handling.

## Post-review harness hardening

The current PR code was hardened after the live run. These controls are verified by unit tests/dry-run logic, **not by a second live Pancake execution**:

- exact runtime SKU/variation/component relationship validation;
- one-shop / one-warehouse fail-closed mutation allowlist;
- generic secret sanitization;
- hard mutation budget and concurrency cap;
- dry-run reports `NOT PROBED` only and performs zero writes;
- uncertain order POST outcomes remain ambiguous unless a unique marker order is found;
- bounded marker pagination refuses to claim absence when its declared search window is incomplete;
- stock mutation errors are reconciled by independent stock readback;
- cancellation always performs an independent GET readback after PUT;
- the scenario runner executes cleanup in a `finally`-equivalent path and performs final stock/order reconciliation;
- live execution is refused until credential rotation is explicitly attested through the environment.

These safeguards are implementation controls for any future authorized rerun. They are not retroactive evidence that the historical live run executed those exact code paths.

## G5 factual handoff

G5 may rely on the following bounded observations:

1. In the authorized test shop, ordinary orders were accepted at positive, zero, and already-negative stock.
2. Two simultaneous ordinary submissions at stock `0` were both accepted in the bounded two-request test.
3. In the observed 1:1 composite fixture, a parent order decremented both child components; one child starting at `0` became `-1` and the order was still accepted.
4. Pancake upstream behavior alone is insufficient to enforce La.na's `negativeStockLimit` or last-unit concurrency invariant.
5. Composite negative-start behavior, arbitrary multipliers, and component-update atomicity remain unproven.

## Credential follow-up status

The repository owner confirmed on **2026-09-16** that the credential exposed during PR #9 development was revoked/rotated. Provider-side state was not independently queried from this repository workflow.

For any future authorized live Pancake execution:

- provision only the replacement credential through the existing server-side secret mechanism;
- set `PANCAKE_PROBE_CREDENTIAL_ROTATED=true` only as an attestation that the revoked/rotated credential incident has been resolved and the replacement is being used;
- never reuse the exposed credential.

Do not put any replacement credential in repository files, PR text, tests, logs, or documentation.
