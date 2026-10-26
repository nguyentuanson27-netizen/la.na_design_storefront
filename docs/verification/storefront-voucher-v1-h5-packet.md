# Voucher v1 — H5 readiness packet (V21)

- **What this is:** the evidence assembled for the owner's later go/no-go (gate H5). It **does not** approve, enable or deploy anything, and nothing in it is release permission. A separate `/ship` approval is required to deploy, and PR #214 is not approved for merge.
- **Date / branch:** 2026-10-26, `claude/happy-newton-ts5kut` (PR #214). Operations: [runbook](../operations/storefront-voucher-runbook.md). Per-criterion evidence: [verification](./storefront-voucher-v1.md).
- **Verdict of the author (not a decision):** the code path is built and tested end to end behind `LA_VOUCHER_ENABLED`, which stays unset in production. **Not ready to enable**: §3 lists what only a person can supply, and §4 lists open engineering items.

## 1. What is built

| Area | Tasks | State |
| --- | --- | --- |
| Rules, money, optimizer, scope, shipping, proof | V00–V03, V08, V10 | built, domain + DB tests |
| Schema, Admin, caps | V04–V07 | built; **V07 Admin browser/axe evidence still missing** |
| POS projection and exact-money probe | V09 | built; H1-V live probe 4/4 PASS on shop 715077776 ([evidence](./storefront-voucher-v1-pos-probe.md)) |
| Holds (10 min absolute, reuse, swap, lazy expiry) | V11, V12 | built; H3-V approved ([evidence](./storefront-voucher-v1-h3v.md)) |
| Accepted order, once-only consume | V13 | built (acceptance inside the POS write-boundary transaction) |
| Reject / cancel / refund once, sweep | V14 | built |
| Picker, selection, PDP teaser, marketing link | V15–V17, V19 | built; browser-tested |
| Checkout and cart exposure | V18 | built (server core and UI); browser-tested at 390px |
| QA convergence | V20 | **partly done** (see §4) |
| Runbook and this packet | V21 | this document and the runbook |

## 2. Evidence on the branch

Local runs on 2026-10-26 (PostgreSQL 16, all migrations applied, Node 22). CI is the authority; its run for the last commit is not recorded here because it is read from GitHub, not from this machine.

| Gate | Result |
| --- | --- |
| `prisma validate` | valid |
| `pnpm test` (domain + integrations) | **3630 tests, 3629 pass, 0 fail** (1 not run: skipped/todo, not investigated) |
| Voucher database suites (`tests/database/voucher-*.test.ts`, PostgreSQL) | **137 / 137 pass** |
| `tsc --noEmit` | **1 error, pre-existing on a clean `HEAD`**: `scripts/capacity-handoff-reconcile.ts(7,16)` duplicate function; unrelated to vouchers, but CI should be checked to see whether it reproduces there |
| ESLint on the 117 `.ts/.tsx/.mjs` files this branch changes | 0 errors (`--quiet`). A whole-tree run here reports 898 errors; the tree includes local build output, I did not break the number down, and CI's own lint job is the authority. |
| Browser, production build | `checkout-voucher.spec.ts` 4/4; `voucher-picker.spec.ts`, `checkout.spec.ts`, `checkout-benefit.spec.ts` all pass; `cart-gift-picker.spec.ts` 4 fail on one axe rule (`label-content-name-mismatch`) on an untouched product link, raised by axe-core 4.14.0 locally vs the pinned 4.12.1. H3-V harness 6/6 ([evidence](./storefront-voucher-v1-h3v.md)). |
| CI on earlier commits | 19/19 green on `7902e4f`, green on `8d53099` and `3daf41b`; the commits after `3daf41b` were not checked when this was written |
| Migration rollback / roll-forward dry run | done on a scratch database, empty ledger ([verification](./storefront-voucher-v1.md#migration-rollback-dry-run-v21-partial--2026-10-26)); the two newer migrations (`20261026100000`, `20261026120000`) were applied to the scratch database but their own rollback lists were **not** dry-run separately |

Acceptance criteria, refreshed (the AC table in the verification doc was written before V11–V18 existed; where a row there says "pending V11/V12/V13/V14/V18", this is the current evidence):

| AC | Now | Evidence |
| --- | --- | --- |
| 14–16, 31–34 holds, quota/budget races, expiry, swap | verified (database + browser) | `voucher-hold` (incl. Admin cap-edit races), `voucher-hold-flow`; H3-V harness |
| 17–19 accept once; reject vs unknown; cancel refunds once | verified (database) | `voucher-order-acceptance*.test.ts` (17), `voucher-redemption-refund.test.ts` |
| 22 cart / checkout / commit / Pancake agree | verified (database, fake POS) | `voucher-checkout.test.ts`: rendered proof ↔ DRAFT ↔ acceptance ↔ POS lines agree to the VND; a live POS order is covered only by the H1-V probe fixtures |
| 23 voucher read fails → never a silently dearer total | verified | preview returns `QUOTE_UNAVAILABLE` → plain totals; checkout reprices without a stale hold (`voucherStale`) and refuses the old proof |
| 26 picker open/close keeps COD form | partial | `checkout-voucher.spec.ts`: typed fields survive the hold refresh; the picker lives in the cart, so the open/close-in-checkout half does not exist |
| 27 refund after campaign expiry | verified (database) | `voucher-redemption-refund.test.ts` |
| 35 gift-loss confirmation | verified | consent required (`CONFIRMATION_REQUIRED`), shown and enforced in the browser; the stored gift choice is not edited, checkout shows `GIFT_SELECTION_INVALID` until the buyer removes it |
| 47 flag OFF settles existing holds | **partial** | refund path ignores the flag (tested); acceptance does not read it (by design); a flag flipped while an order is in flight is described in the runbook but **has no dedicated test** |

## 3. What only a person can supply

1. **Owner approval of the two migrations beyond H2:** `20261026100000_voucher_order_snapshot` (new table `OrderVoucherSnapshot`, index on `VoucherHold.orderId`) and `20261026120000_order_quote_step_voucher` (the `VOUCHER` step source). Neither has touched a real database.
2. **A live end-to-end convergence run (V20)** through checkout to a real POS order at the approved shop. The H1-V probe proved the POS stores voucher-derived line prices exactly; nobody has yet placed a voucher order through the website against the real POS. That writes to Pancake, so it needs its own explicit permission — approving the plan or an ADR does not grant it.
3. **A staff-made cancel in the Pancake UI**, observed once, to learn which status code it produces. Only status `7` (the cancel we issue ourselves) refunds today; anything else stays pending by design.
4. **The refund sweep schedule** (runbook §5): nothing in `deploy/vps` runs `voucher:refund:sweep`.
5. **H4 UX review** of the checkout panel, the cart totals wording and the gift-loss consent, ideally on a real phone and a desktop.
6. **Production secrets/env review** for the four gates in runbook §1 and the absence of `LA_VOUCHER_TEST_HARNESS`.
7. **The H5 go/no-go itself**, and a named on-call for the first day.

## 4. Open engineering items (not blockers by themselves, each needs a decision)

- **V07 Admin browser + axe evidence** is missing; Admin behaviour is covered by database tests only.
- **>16 KiB proof UX**: a cart whose voucher proof would exceed the limit gets `PROOF_UNAVAILABLE` and a message; there is no browser evidence for that state.
- **Hold expiry while the checkout page is open**: the panel refreshes at expiry (code path exists), not browser-tested; the desktop viewport of `checkout-voucher.spec.ts` is also only exercised inside the mobile project.
- **`ADMIN_CANCEL` has no caller** (no screen, no script). Decide whether v1 ships without it (manual reconciliation) or gets an operator command.
- **Flag-off in flight** needs a test if the owner wants it proven rather than read from code.
- **Cart-gift-picker axe findings** need a CI check with the pinned axe to confirm they do not reproduce.
- **`capacity-handoff-reconcile.ts` typecheck error** is pre-existing; confirm in CI.

## 5. Security and privacy checks that exist

- PRIVATE vouchers cannot be selected by id alone, in either the write path or the draft preview (two review rounds, mutation-checked); codes are rate-limited with one generic invalid answer.
- A marketing link `?voucher=CODE` is redirected to a clean URL (`no-referrer`, `no-store`); the code never appears in a rendered page or later request URL; with no cart it waits in an HttpOnly cookie (browser test).
- Holds are read from the database on the server; the browser submits only the digest it was shown, and a stale digest is refused. The hold proof and the checkout proof bind different things on purpose (hold: slot count and money; checkout: exact lines).
- The test harness exists only in test builds; an official build answers 404 even with `LA_VOUCHER_TEST_HARNESS=true` (harness runner checks both).
- Settle paths (accept, reconcile, refund) never read the feature flag or the verified-shop list.
- Not done: an independent security review of this feature; `/security-review` has not been run on the branch.

## 6. Rollback

Smallest first: unset `LA_VOUCHER_ENABLED`; remove the shop from the verified list; disable a campaign; revert the deploy; schema rollback only before any accepted order references the tables. Exact steps and the order for an incident are in the [runbook §4](../operations/storefront-voucher-runbook.md#4-stopping-and-rolling-back-smallest-first).

## 7. Decision record (for the owner to fill, not for the author)

| Decision | Owner | Date | Note |
| --- | --- | --- | --- |
| Migrations beyond H2 approved | | | |
| V20 live run authorised (shop, number of orders, cleanup) | | | |
| H4 UX review accepted | | | |
| H5 go / no-go | | | |
| `/ship` approved | | | |
