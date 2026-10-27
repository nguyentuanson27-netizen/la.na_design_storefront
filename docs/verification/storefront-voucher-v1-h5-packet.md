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
| 35 gift-loss confirmation | verified (database), **after the 86af0a8 review** | The consent is required (`CONFIRMATION_REQUIRED`) and, once given, the hold transaction itself removes or reduces (newest first) the stored choices the voucher made unearned, then issues the proof; a refusal anywhere rolls the voucher and the gift change back together; without consent nothing is touched. Tests: `voucher-checkout` (consent repairs and the order can then be placed with no manual step; fewer slots than chosen reduces; atomic rollback), mutations fail them. **Earlier versions of this row said the stored choice was left alone and the buyer had to remove it by hand: that contradicted spec 4.1.4 / 7.3 / AC-35 and was wrong.** |
| 47 flag OFF settles existing holds | verified (database) | `voucher-checkout.test.ts` AC-47: flag off mid-checkout → the held voucher is still priced, accepted, consumed and sent to the POS; a new hold and the preview are refused. Consequence: switching off takes up to 10 minutes to stop vouchers reaching orders (runbook §1) |

## 2b. V20 live convergence run (2026-10-26, shop 715077776)

`pnpm voucher:convergence:live` (`scripts/voucher-convergence-live.ts`). The production composition (hold → rendered benefit quote and proof → DRAFT → POS re-derivation → acceptance at the write boundary → **real** Pancake create and read-back) against the live shop, with a scratch local database. Authorised by the owner (up to 10 orders; this run created **2**, POS orders 9 and 10, same test variation `9e7a1103-…`, SKU `SQ069S`, live list price 849.000đ). Orders carry the marker `TEST AUTOMATION VOUCHER V20` and were cancelled by the script on every path.

| Case | Website | POS read-back | Refund |
| --- | --- | --- | --- |
| C1: 2 units, merchandise voucher 10.000đ + free-shipping voucher | goods 1.688.000đ, fee waived to 0 | order 9: 2 × 844.000đ, total 1.688.000đ (list 849.000đ − 5.000đ per unit) | after the POS cancel the real status reconciliation read status 7 and refunded both vouchers once; counters back to 0/0; a second reconciliation changed nothing |
| C2: 3 units, 10.000đ voucher that does not divide, no free-shipping voucher | goods 2.537.000đ, fee 30.000đ kept, total 2.567.000đ | order 10: 2 × 845.667đ + 1 × 845.666đ, total 2.537.000đ | same: refunded once, counters returned, second pass a no-op |

Both orders read back **status 7** after the run (read-only check), and a first attempt that failed on a fixture rule before any create left no order. Not covered by this run: a gift line (covered by the H1-V probe fixture F3), a staff-made cancel in the Pancake UI, and `SYNC_UNKNOWN`.

## 3. What only a person can supply

1. **Owner approval of the two migrations beyond H2:** `20261026100000_voucher_order_snapshot` (new table `OrderVoucherSnapshot`, index on `VoucherHold.orderId`) and `20261026120000_order_quote_step_voucher` (the `VOUCHER` step source). Neither has touched a real database.
2. ~~A live end-to-end convergence run (V20)~~ — **done 2026-10-26** with the owner's explicit permission ("chạy v20 đi", "10 đơn"): see §2b. Any further live run needs its own permission.
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
- **No instant kill switch**: with the flag off, held vouchers still settle for up to 10 minutes (tested, deliberate). Decide whether that is acceptable or an explicit kill switch is wanted before H5.
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

## 8. Re-review of PR #214 at `f3eed3a` (owner account, 2026-10-26) and what was done

| Finding | Verified against the code | Change |
| --- | --- | --- |
| P1 hold granted but checkout cannot honour it when the gift/quantity gate is OFF | yes: the hold flow checked only the voucher gate and the verified shop; `resolveBenefitCheckoutQuote` returns `LEGACY` before reading holds | New holds also need `canCheckoutHonorVouchers` (gift/quantity gate + line-level-verified shop); checkout shows no offer (and does not block the order) where no hold can be granted; a live hold met with the gate OFF is set aside **and reported** (`voucherStale`), never silently plain. Tests: `voucher-hold-flow` (each dependency off on its own), `voucher-checkout` (gate off inside the 10 minutes), domain gate and view tests; two mutations each fail a test |
| P1 status 7 stored but the refund hook lost is never swept | yes: the sweep only read `REJECTED` orders | `sweepCancelledOrders` (and `sweep()`, now what `pnpm voucher:refund:sweep` runs): candidates are orders with stored status 7 and an unrefunded redemption; `refundOrder` still re-checks the complete, shop-verified record under the order lock. Test: lost hook → sweep → once, with provenance; other codes, half records and `SYNC_UNKNOWN` untouched; a mutation fails it |
| P2 a code applied in the picker leaves the cart's "Dự kiến sau ưu đãi" stale | yes: the apply-code action deliberately does not refresh | The picker refreshes the page when the dialog closes after a code was applied; browser test at 390 and 1280 px |

Design note for the owner: where the gift/quantity gate goes OFF **while** a shopper holds a voucher, the hold is **not** honoured (it cannot be priced without the benefit pipeline); the shopper is told and nothing is charged or consumed. Honouring it would mean pricing voucher orders without that pipeline, which is new design, not a fix. The runbook says to keep the gate on for as long as vouchers are on.

## 9. Re-review of PR #214 at `86af0a8` (owner account, 2026-10-26): AC-35

Verified against the spec (§4.1.4, §7.3, AC-35: "confirm updates the choice and revalidates / reproofs atomically") and against my own test, which had to delete the saved gift by hand to get past checkout. Confirmed and fixed: `holds.hold` gained an `afterGrant` hook that runs inside the transaction, under the cart lock and after the holds exist; for an acknowledged hold that costs selected gift slots it calls `repairGiftSelectionsAfterVoucherConsent` (`voucher-gift-repair.ts`), which reads the very post-hold derivation checkout runs and removes or reduces only the choices that exceed the entitlement left after the voucher. Anything else wrong with a choice (stock, a changed campaign) is left to the existing contract. The picker and checkout consent text now says the chosen gift is removed from the cart if the buyer continues.

## 10. Re-review of PR #214 at `1bb0d61`: AC-35 at the picker

Confirmed: the picker said "if you continue the chosen gift is removed from the cart", but its "Áp dụng" saved only the voucher intent, so the gift stayed until the second confirmation at checkout. The spec asks for both in one consistent step. Fixed with option A of the review: `commitVoucherDraft` verifies the consent against the server's own quote **inside the selection transaction under the cart lock** (no gift lost -> as before; gifts lost without consent -> `CONFIRMATION_REQUIRED`; consent for a stale digest -> `QUOTE_CHANGED`; consent for the current quote -> voucher intent and gift change written together, by the same rule the hold path uses). The picker sends the digest of the quote it showed and a yes, never a price or a list of gifts. Tests: database (`voucher-checkout.test.ts`, three mutations fail them), domain parser, and browser (`checkout-voucher.spec.ts`: the first press asks again and changes nothing, the second removes the gift and saves the voucher). `pnpm test` 3654/0, voucher database suites 145/0, browser 14/14 on a production build.

The hold step keeps its own consent (a shopper who never opened the picker, or whose cart changed since, is asked again at checkout), so the gift is never removed without an explicit yes at the step that removes it.

## 11. Re-review of PR #214 at `5a62d20` (owner account, 2026-10-26)

| Finding | Verified against the code | Change |
| --- | --- | --- |
| P1 a typed code skips the consent the picker's commit enforces | yes: `applyStorefrontVoucherCode` saved a verified code straight to the selection | Picker commit, the single-group action and the typed code now all pass one gate (`consentGate`, `voucher-draft-commit.ts`) inside the selection transaction, under the cart lock, before anything is written: stale digest -> `QUOTE_CHANGED`; a choice that costs a chosen gift or raises the total without consent -> `CONFIRMATION_REQUIRED`, nothing written, the verified code is not saved; consent for the current quote saves the voucher and repairs the gift together. The code is still verified and rate-counted first. A refusal names the verified campaign so the picker previews it for that request only (`verifiedPrivateIds`, set by the server, never browser input). The picker keeps the typed code and asks again; the second press sends the digest and a yes |
| P2 own live holds read before the cart lock | yes: a snapshot array was passed in | The gate takes `attemptSecret` and reads the shopper's own holds inside the transaction after the lock (same as the hold flow). The earlier window is removed structurally; there is no barrier test for it |
| P2 cart / PDP offer where no hold can be honoured | yes: offers checked only the voucher gate | Picker and teaser offer only where `canGrantHonourableVoucherHolds` (voucher gates, verified shop, gift/quantity gate, line-level pricing). A browser regression per gate was **not** written; the gate itself has domain tests per dependency |
| P2 cancelled-order sweep batch can starve | yes: half records filled the bounded batch | Candidate query requires the complete record and orders by id. Test: 60 half records + 1 valid, limit 50 |
| CI `admin-a11y-runtime (4)` on `5a62d20` | one run failed at `storefront-commerce.spec.ts:450` (PDP contrast); the re-run of that job was cancelled by the newer push, so it proved nothing | Re-checked on the new head; see the PR |

Tests: database (`voucher-checkout.test.ts`: code refused without consent / stale / saved with the current one, for gift loss and EX-06; unknown code still `INVALID_CODE`), `voucher-redemption-refund.test.ts` (starvation), mutations fail them; browser (`checkout-voucher.spec.ts`: a typed code that costs a gift asks first, changes nothing, then saves with consent).

## 12. Re-review of PR #214 at `8bdb2f0` (owner account, 2026-10-26)

| Finding | Verified against the code | Change |
| --- | --- | --- |
| P1 the consent gate is fail-open when no quote can be derived | yes: `consentGate` returned "no refusal" for any preview that was not `ok`, before the digest and the gift / total checks, and the choice was then saved (a quote that is unavailable, for example an unreadable shipping policy, was treated as "costs nothing") | No quote, no commit: a choice that could change money or gifts is refused with `QUOTE_UNAVAILABLE` and nothing is written, for the picker commit, the one-group action and a typed code (the code is still verified and rate-counted; nothing is pending because there is nothing to show). A consent digest does not open the gate, because it cannot be checked against a quote that does not exist. A read that throws counts as no quote. What stays allowed without a quote is only a choice that cannot add cost: every group "no voucher" or exactly what is already saved, so the shopper can always drop a code. After the authority recovers the same consent is judged normally (tested). Tests: real PostgreSQL, forced `QUOTE_UNAVAILABLE` by an unreadable shipping fee; draft, digest, code and one-group action all refused with the gift and the selection untouched; retry succeeds; dropping works, swapping does not; a mutation that restores the fail-open fails it |
| P1 (UI part) a Server Action can answer `ok` with no picker after the DB saved, and the picker showed an error for a choice that did change | yes: `respond()` returns `picker: null` when the quote cannot be re-read right after the save (and a drop of a voucher is saved without a quote by design) | The picker treats `ok` without a model as saved: it closes (or, for a typed code, says the code is applied and that the expected price updates when the dialog closes) and refreshes the page behind it, never an error. Browser test: a DB trigger empties the cart the moment the selection is written, so the post-save read is unavailable while the save stands; the shopper sees "Đã áp dụng mã ưu đãi" and no alert; a mutation that removes the branch shows the false error and fails it. Not covered in a browser: the same branch for the "Áp dụng" button (same code shape, reasoned not run) |
| P2 the one-group action overwrites the other group from a stale snapshot | yes: it read the saved selection outside the cart lock and wrote both groups | A group passed as `null` is kept as saved and is read inside the same transaction, under the cart lock, by `applyBoth`; only that read decides what the kept group is, and a kept group is not re-validated (it is not being chosen). The consent gate receives the resolved groups. Test: a second transaction holds the cart lock and saves SHIPPING = "no voucher" while the action waits; after release the action's change is saved and the other tab's choice survives; the test also proves the action was blocked on the lock; a mutation that reads before the lock fails it |
| Optional: editing the code box keeps the old code waiting for the yes | yes: `pendingCode` stayed set and the confirm button sent it | Editing the box to a different text abandons the waiting code (confirmation, message and preview go back to what is saved). Browser test: confirm button gone after the edit, a wrong second code gives the one generic error, nothing saved |

Not done: the owner/ship gates in §3-4 are unchanged and still need people.

## 13. Re-review of PR #214 at `beca608` (owner account, 2026-10-26)

| Finding | Verified against the code | Change |
| --- | --- | --- |
| P2 the picker's full draft can overwrite a choice another tab saved | yes: the picker sends both groups explicitly; `applyBoth` read the saved choice under the lock but never compared it with the one the picker was built on, so a stale half (for example SHIPPING = AUTO) was written over a newer choice (SHIPPING = none) even with no gift or price warning | The server hands the picker a **version of the SAVED choice** (`selectionVersionOf`: a digest of both groups' mode and voucher id, not a price or a timestamp, so two vouchers with the same saving differ) with every model. "Áp dụng" must send the version it last saw (`selection`, required by `parseVoucherCommitInput`; a commit without it is refused whole). Under the cart lock, before any quote is derived, the server compares it with the saved choice: a mismatch is `SELECTION_CHANGED`, nothing is written, and the answer carries the model of what is saved now. The picker takes that model, tells the shopper another page changed the offers, and lets them choose again. The picker only adopts a version from a commit, an applied code or a refusal, never from a preview of a draft (that would hide the staleness). The one-group action and a typed code keep the other group as saved under the lock and need no version. Tests: parser (domain); real PostgreSQL (tab B saves SHIPPING = none, tab A's stale draft is refused with B's choice untouched, tab A retries from the new version and saves, the used version cannot be replayed, two vouchers with the same saving have different versions); browser, two pages (the page opened earlier is refused with the explanation, shows what is saved, and applying from there works). A mutation that removes the version check fails the database test; the browser test has no mutation check of its own |
| P2/UX clear / "no voucher" while no quote exists | yes: allowed by `cannotCostAnything`, and dropping a free-shipping voucher can make a later total higher; with no fee authority "cannot cost anything" is not provable | **Owner decision needed**: keep the exception (the shopper can always drop a code while pricing is down) or refuse every change while pricing is down. Until decided the exception stays, and the UI no longer implies the price is settled: the picker says the choice was saved, that the price cannot be derived now and that the final price will be shown before the order is placed (the dialog stays open with that text and the page behind refreshes when it closes; the action does not refresh the page behind when it has no model to return, so the message is not lost). Browser test: pricing disappears before "Áp dụng"; the drop is saved and the notice shows, no error. The notice says "will be shown before the order"; checkout does show the voucher state and total before the order, which is the existing contract, not a new promise |

Gates in §3-5 are unchanged and still need people.

## 14. Re-review of PR #214 at `26f6d3a` (owner account, 2026-10-26)

| Finding | Verified against the code | Change |
| --- | --- | --- |
| P2 the version the picker carries can belong to a newer choice than the quote it shows | yes: the preview read the saved choice inside its repeatable-read snapshot but returned only the intent used for the quote; `respond()` and `loadCurrentVoucherPicker()` then read the saved choice AGAIN after the snapshot to compute the version, so another tab saving in between gave a quote of S0 with the version of S1, and the stale draft passed the check | The preview returns `savedSelectionVersion`, computed from the saved choice read in its own snapshot; both callers use it and no longer read again. Test (real PostgreSQL): tab B saves right after the preview's snapshot is read (the client wrapper commits B's choice as the preview transaction returns); the preview's version is S0's, not S1's, and the picker built from it is refused with `SELECTION_CHANGED` and B's choice untouched; a mutation that re-reads the version after the snapshot fails it. The two server callers are not exercised as a pair in a browser: they are one-line uses of the preview's field |

## 15. Owner decisions taken "theo khuyến nghị" (2026-10-26) and what was built for them

| Decision | Taken | Built |
| --- | --- | --- |
| Drop a voucher while pricing is unreadable | Keep the exception (drop only, with the "price not known" notice) | already in `cabe82e`/`26f6d3a`; runbook §5 |
| Gift/quantity gate OFF mid-hold | Hold set aside and reported, not honoured; keep the gate ON while vouchers are ON | already in place; runbook §1 and §5 |
| Instant kill switch | Not for v1 (feature OFF stops new holds at once; existing holds finish within 10 minutes) | nothing; runbook §1 |
| Return the vouchers of a person-cancelled order | An operator command, not a screen. Note: this is the voucher's use and budget, **not money** (COD); an earlier wording that said "via accounting" was wrong and is removed | `pnpm voucher:refund:admin-cancel` (`voucher-admin-cancel.ts`): dry run unless `--apply`, evidence required (10-400 chars), once-only; domain and real-database tests |
| Admin form emptied after a refused save | Fix | the form is submitted by hand so React no longer resets it; browser test asserts the typed values survive |
| Saving text in the picker | "-amount" in red (was "Dự kiến giảm ...") | `-70.000đ` in red with a screen-reader prefix "Dự kiến giảm"; Axe clean |

## 16. Staff cancel in the Pancake UI, observed (2026-10-26, shop 715077776, order `11`)

One live test order (2 x SQ069S at 844.000đ, voucher-priced, marked "TEST AUTOMATION VOUCHER V20") was created with the owner's explicit request ("tạo 1 đơn đi để t hủy") and left open; the owner cancelled it by hand in the Pancake UI. Observation run (`V20_OBSERVE_ORDER=11`: no create, no cancel):

| What | Result |
| --- | --- |
| Status Pancake reports after the staff cancel | **6** (the order we cancel ourselves through the API reports **7**, observed in V20) |
| Website mirror after the real status reconciliation | `CONFIRMED`, status 6 stored on a complete shop-verified record |
| Voucher redemptions of the order | 2, **0 refunded**, before and after: status 6 is not a mapped signal, so nothing was returned (the designed safe behaviour: ADR 0018 D-4, unmapped codes never refund) |

Consequence for v1 as built: a voucher on an order that staff cancel in the Pancake UI stays "in use" until someone runs `pnpm voucher:refund:admin-cancel` for it. Proposal (owner decision needed): treat status **6 ("Đã hủy")** as a trusted cancel in the same way as 7, so the status reconciliation and the sweep return the vouchers once. Caveat to accept: staff can in principle move an order out of 6 again; if they do after the refund, the order is live with its voucher already returned (one voucher use over the cap). Not implemented: it widens the set of signals that move the ledger and was not decided. Tested order mapping would be: `POS_CANCELLED` for 6 and 7, nothing for the other codes; one database test per code.

## 17. Status 6 treated as a cancel (owner decision, 2026-10-26)

The owner accepted the §16 proposal ("coi trạng thái 6 (\"Đã hủy\") là tín hiệu hủy đáng tin"). Built: `PANCAKE_ORDER_CANCELLED_STATUSES = [6, 7]` and `isPancakeOrderCancelledStatus` (`order-readback.ts`), used by `refundOrder` (POS_CANCELLED), `sweepCancelledOrders` and the status reconciliation's refund hook; the evidence stored with a refund names the status (`status=6`). Every other code still refunds nothing. Tests (real PostgreSQL): the code matrix now refuses 0-5, 8, 9, 11-13, 15-17, 20; 6 refunds once under five parallel signals with `status=6` evidence; a half record at 6 refuses; a lost hook after a staff cancel is settled by the sweep; the real services (reconciliation at 6, then again) refund once; two mutations (6 not mapped; 3, 5 also mapped) each fail tests. **Real evidence:** the live staff-cancelled order `11` was settled by the sweep, once (`POS_CANCELLED`, `status=6`), and a later reconciliation refunded nothing more. Accepted caveat: if staff move an order out of 6 after the refund it runs with its voucher already returned (one use over the cap). The scratch rows of the live run were then removed. Not changed: the order read-back check that treats 7 as "the POS order is canceled" at creation time.

## 18. Re-review of PR #214 at `54cb476` (owner account, 2026-10-26)

| Finding | Verified against the code | Change |
| --- | --- | --- |
| P1 the marketing-link GET with an existing cart saves the code without the consent gate | yes: `voucher-link/route.ts` called `applyCode({ cartId, rawCode })` directly; the gate is an optional hook, so a code that costs a chosen gift or raises the total (EX-06) was saved as a manual choice with no quote and no consent. It was the only call site that skipped the gate | The link **never saves**: with or without a cart it remembers the code in the HttpOnly cookie and redirects to the clean URL; the cart page offers it (pre-filled) and the shopper applies it with "Áp dụng mã", which is the gated path (verify, rate-count, quote, consent, save under the cart lock). Tests: browser, a shopper with a cart and a chosen gift follows a link to a code that costs the gift: the GET saves nothing, the picker offers the code, applying it asks for consent and shows the loss, declining keeps selection and gift as they were; the AC-40 link test now asserts the link saved nothing and that applying from the picker works. Structural guard (domain test): no file under `src/` outside the selection service and `voucher-draft-commit.ts` may call `applyCode`/`applyBoth`/`setGroup`; putting the direct call back into the route fails it. The offered-code details were then superseded by §19 |

## 19. Re-review of PR #214 at `231202c` (owner account, 2026-10-26): the offered code stays on the server

| Finding | Verified against the code | Change |
| --- | --- | --- |
| P2 an HttpOnly cookie does not keep the code out of the page: `/cart` passed the raw code to the picker as `prefillCode`, so it was in the HTML, the RSC payload and the input's value, on a page that loads GTM / Meta | yes: `readPendingVoucherCode()` returned the code to a Server Component which handed it to a Client Component; the AC-40 test only checked the landing page, and my own new test asserted the code was in the cart's input | Option A of the review. The cart page is told only a boolean (`voucherLinkOffered`); the picker shows "Có mã ưu đãi từ liên kết" and a button **"Dùng mã từ liên kết"**; a Server Action (`applyStorefrontLinkedVoucherCode`) reads the cookie itself and runs the same verify / rate-count / quote / consent / save as a typed code, and clears the cookie once the code is used. The browser sends at most a yes and the quote digest (parser: a code, a price or a gift list in that request is refused whole). Tests: browser, on the server with tracking on (GTM): the cart's HTML (fetched), its DOM and the open dialog contain no trace of the code before, during and after the consent step, the code box is empty, the button applies it through the gate, a code that costs a gift is shown and not saved until consent and declining keeps everything; the AC-40 test asserts the same on the product-link flow; domain test for the new parser. Not tested with a real GTM container (no network capture of the tag): the property is that the page contains nothing to capture. The cookie itself still holds the code for up to 24 hours (HttpOnly, never sent to a script) |

Also from this review, for H4/release: the PR title and body still describe the older V13/V14/V18 state and should be refreshed before release; the offered-code cookie now clears when the code is used.

## 20. Re-review of PR #214 at `04dea8b` (owner account, 2026-10-26): the linked code's cookie

| Finding | Verified | Change |
| --- | --- | --- |
| P2 clearing the cookie inside the Server Action re-renders the page and can remount the picker, closing the dialog the shopper is reading the result in | yes, reproduced: with the delete put back in the action, the browser test that checks the dialog after "Dùng mã từ liên kết" fails (the dialog is gone / the cookie state is wrong at the wrong time). It was a regression of my previous change; the typed-code path never had it | The action no longer touches the cookie. When the shopper closes the dialog, the picker calls a separate action (`dismissStorefrontLinkedVoucherOffer`) that clears it, then refreshes the page: nothing is lost because the dialog is already closed. Inside the dialog the offer disappears at once after use. Tests (browser, mobile): without consent, after the click the dialog stays open with "Đã áp dụng mã ưu đãi", the 70K voucher checked, the offer gone and the cookie still present, then Escape closes it and the cookie is cleared; with a chosen gift, the code is first declined (cookie kept, still offered), then accepted with the consent (gift removed, voucher saved, cookie cleared); with pricing unreadable after the save (DB trigger) the shopper gets the success message with no alert and the dialog open. Not tested: a desktop viewport for this flow (the dialog is the same component; the earlier picker tests cover 1280px) |

## 21. Re-review of PR #214 at `e0166b2` (owner account, 2026-10-26): the offer cookie is shared by every tab

| Finding | Verified | Change |
| --- | --- | --- |
| P2 the dismissal deleted the cookie unconditionally, so closing tab A's dialog could remove the newer link (KOL80) tab B had just opened | yes, reproduced with two pages of one browser context: tab A used the KOL70 offer, tab B opened a KOL80 link (the shared cookie became KOL80), tab A closed its dialog and the cookie was gone | Compare-and-clear. The linked-code action returns an opaque token for the offer it used (an HMAC of the code under the server's secret, truncated; never the code); the picker hands it back when it closes; the server clears the cookie only if it still holds THAT offer, otherwise leaves the newer one alone. The page gets no code, only the token. Tests: browser, two pages of one context (KOL70 used in A, KOL80 opened in B, A closes: the cookie is still KOL80 and B's cart still offers "Dùng mã từ liên kết"); with the comparison removed the test fails (cookie null); domain test: the dismissal request carries only a 32-hex token (a code, upper case, extra keys are refused). The earlier single-tab tests still pass (the offer is cleared when the same tab closes) |

## 22. Re-review of PR #214 at `846d645` (owner account, 2026-10-26/27): the click applies the offer that was shown

| Finding | Verified | Change |
| --- | --- | --- |
| P2 "Dùng mã từ liên kết" applied whatever the cookie held at click time: A views the KOL70 offer, B opens a KOL80 link, A clicks and A's cart saves KOL80 (a code A never saw offered). The page was told only a boolean | yes, by reading the code: `applyStorefrontLinkedVoucherCode` read the cookie at POST time and compared it with nothing the page had rendered; the earlier two-tab test only covered "A applies, B links, A closes" | The offer is bound when the cart renders. The page receives an opaque handle of the offer (`voucherOfferToken`: HMAC of the code under the server's secret, truncated to 32 hex; never the code) instead of a boolean. The apply request must carry it (parser: refused whole without it, with a code, or with a malformed one); the server compares it (constant time) with the handle of the cookie's current code **before verifying or saving anything** and, on a mismatch, saves nothing and answers `OFFER_CHANGED`. The picker says the code was replaced by another page and re-renders, so the shopper sees what is on offer now and a second, deliberate click applies that one. The handle returned after a successful apply is the one the shopper used, so the earlier compare-and-clear (§21) is unchanged. Tests: browser, two pages of one context (A views KOL70, B opens KOL80, A clicks: nothing saved, the message is shown, the cookie is still KOL80; A's second click applies KOL80); domain parser test (handle required, nothing else accepted); with the comparison neutralised the browser test fails (KOL80 is saved from A's first click, the 80.000đ choice appears in A's dialog). Not decided here: whether last-link-wins would be acceptable UX; failing closed is the conservative option and costs one extra click |

## 23. Re-review of PR #214 at `b948f0e` (owner account, 2026-10-26/27): the consent step must notice a replaced offer too

| Finding | Verified | Change |
| --- | --- | --- |
| P2 (UI recovery) `OFFER_CHANGED` was handled only by the first click of "Dùng mã từ liên kết"; when that click had answered `CONFIRMATION_REQUIRED` (the code costs a chosen gift) and another tab then replaced the offer, "Tiếp tục với voucher này" got `OFFER_CHANGED` from the server (correctly, nothing saved) but fell into the generic error and left the old offer's pending state and quote in place | yes, reproduced by mutation: with the new branch disabled, the new browser test fails with exactly the generic message "Chưa cập nhật được ưu đãi..." | One shared handler (`offerGone`) for both entry points: it drops the pending linked step and the confirmation, puts the dialog back on what is SAVED (model and draft), says why, and re-renders the page so the current offer is shown. The consent apply routes `OFFER_CHANGED` there, and also `INVALID_CODE` (the offer was used or cleared elsewhere) while a linked step is pending. The server side is unchanged (it already failed closed). Test: browser, two pages of one context: A clicks the link (KOL73 costs the gift, A is asked to confirm), B opens KOL74, A confirms: nothing saved, the gift is kept, the message is shown, the dialog shows the saved choice again and no confirm button for the old code, the offer is shown again; A's deliberate click then confirms KOL74 (which asks again) and only that confirmation saves it and removes the gift. Local: lint, typecheck, `pnpm test` 3695/3695, production build, Playwright 32/32 |

## 24. Re-review of PR #214 at `735ff62` (owner account, 2026-10-27): one code source at a time waits for the shopper's yes

| Finding | Verified | Change |
| --- | --- | --- |
| P2 a typed code waiting for consent (`pendingCode`, `confirming`) was not dropped when the shopper then used the linked offer: the dialog showed the linked code's result while the footer still carried the typed code's "Tiếp tục với voucher này", and pressing it re-sent the typed code; `offerGone` cleared `pendingLink` but not `pendingCode` | yes, reproduced: with the previous picker both new browser tests fail (the typed code's confirm button is still there after the linked code applied; after a replaced offer the dialog cannot be closed with the footer without acting on the typed code) | Each source takes over from the other. The linked code's outcomes (saved, saved-but-price-unreadable, waiting for its own yes) clear `pendingCode` and, when saved, `confirming`; the typed code's outcomes (saved, waiting for its own yes) clear `pendingLink`; `offerGone` clears `pendingCode` too. The footer therefore only ever confirms the source and quote on display. Tests (browser, mobile, cart with a chosen gift): typed KOL73 (costs the gift) waits for its yes, the linked KOL10 (costs nothing) is applied: KOL10 saved, shown, no confirm button for KOL73, the footer commits KOL10, the gift stays; typed KOL73 waiting, the offer replaced by another tab, the linked click: nothing saved, the message is shown, no confirm button, and using the footer afterwards never saves KOL73. Local: lint, typecheck, `pnpm test` 3695/3695, production build, Playwright 34/34 |
