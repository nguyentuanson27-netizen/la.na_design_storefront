# Voucher v1 — operations runbook

- **Status:** READY FOR REVIEW (V21, 2026-10-26). It describes the controls that exist in the code on PR #214 and says plainly what an operator still has to prove. It is **not** a go-live approval and nothing here was run against a production system. The launch decision is gate H5; the evidence packet is [the H5 readiness packet](../verification/storefront-voucher-v1-h5-packet.md).
- **Spec / ADRs:** [spec](../specs/storefront-voucher-v1.md), [ADR 0018](../decisions/0018-voucher-v1-accepted-order-architecture.md), [ADR 0019](../decisions/0019-voucher-v1-hold-design.md). Vendor boundary: [Pancake acceptance](../integrations/pancake-voucher-acceptance.md).

## 1. Switches (all server-side, read from `.env.production`; a change needs the `app` container restarted)

| Variable | Meaning |
| --- | --- |
| `LA_VOUCHER_ENABLED` | Exactly `true` turns NEW exposure on: voucher lists, selections, previews, links, holds, and applying holds in checkout. Anything else (unset, empty, `1`, `TRUE`, a `NEXT_PUBLIC_` copy) is OFF. **Default OFF; keep it unset in production until H5.** |
| `LA_PANCAKE_VOUCHER_VERIFIED_SHOP_IDS` | Comma-separated shop ids allowed to receive a NEW hold (ADR 0019 D-6). List a shop only after `pnpm pancake:voucher:accept` passed for it (shop 715077776 passed 2026-10-26). Unset or malformed: no hold is ever granted. |
| `LA_GIFT_QUANTITY_PROMOTIONS_ENABLED` | Voucher checkout rides the benefit checkout, so this gate must be `true` too. **With it off no NEW hold is granted** (a hold checkout could not honour would only take quota for ten minutes). If it is switched off while a shopper already holds a voucher, checkout cannot price it: the hold is set aside and the page says so ("giá bên dưới chưa có ưu đãi"), the old proof cannot place a plain order, nothing is consumed and the hold expires. Keep it `true` for as long as vouchers are on. |
| `LA_PANCAKE_LINE_LEVEL_PRICING_VERIFIED_SHOP_IDS` | The shop must also be line-level-pricing verified (the POS order carries one price per line). Like the gate above, a shop missing from this list gets no NEW hold, and checkout does not offer or block on a voucher it cannot hold. |
| `LA_VOUCHER_TEST_HARNESS` | **Never set in production.** It only matters to a test build; an official build answers 404 for the harness even if it is set by mistake (`pnpm voucher:hold-harness` proves both). |

What OFF means (ADR 0018 D-6, AC-47): it stops **new** exposure. The settle paths never read it, **and neither does checkout for a hold that already exists**. Verified by a database test (`voucher-checkout.test.ts`, AC-47) and what an operator should expect when the flag is switched OFF while shoppers are mid-checkout:

- Voucher lists, the picker, previews, links and **new holds** disappear or are refused at once.
- A shopper who already holds a voucher keeps it until the hold's own 10-minute expiry: the checkout still shows and prices it, the order is accepted, the voucher is consumed and the POS gets the voucher-priced lines. This is deliberate (a shopper is never charged a price they were not shown) and it means **switching the flag off does not instantly stop all voucher orders; allow up to 10 minutes**.
- Holds that expire are not renewed, so after 10 minutes no voucher can reach an order. Expired holds free their cap on the next grant for that campaign.
- Orders already accepted, refunds and reconciliation are unaffected.

To stop vouchers from being *applied* sooner than 10 minutes there is no switch by design (TG-05 A: no force-revoke). The owner can accept this, or decide on an explicit kill switch before H5; that would be new code.

## 2. Staged rollout (each step needs the owner's yes; this runbook enables nothing)

1. Deploy with `LA_VOUCHER_ENABLED` unset. The new migrations are additive and ignored by old behaviour; confirm the app is healthy and an ordinary COD order still works.
2. Set `LA_PANCAKE_VOUCHER_VERIFIED_SHOP_IDS` to the one verified shop, `LA_GIFT_QUANTITY_PROMOTIONS_ENABLED=true` and the line-level list if not already, then `LA_VOUCHER_ENABLED=true`. Create **one** small test voucher in Admin (`/admin/promotions/vouchers`), enable it, and place a real COD order as the owner. Check §3 queries after each step.
3. Only then publish real vouchers. A voucher is created inactive and never activates itself; the Admin presses Bật after checking it.

Stop at any step by §4.

## 3. What to watch

Read-only SQL on the ledger. Run from the `ops` container (`docker compose --profile ops run --rm ops …`) or any read-only connection.

```sql
-- committed vs caps, per campaign
SELECT id, name, "redeemedUses", "reservedUses", "maxUses", "redeemedVnd", "reservedVnd", "maxBudgetVnd"
FROM "VoucherCampaign" WHERE "pancakeShopId" = :shop ORDER BY "updatedAt" DESC;

-- ledger drift: reserved must equal the HELD holds (alert if any row returns).
-- Expired-but-unswept HELD holds still count on both sides, so they are not drift.
SELECT c.id FROM "VoucherCampaign" c
LEFT JOIN (SELECT "campaignId", count(*) n, coalesce(sum("heldDiscountVnd"),0) v FROM "VoucherHold" WHERE state = 'HELD' GROUP BY 1) h ON h."campaignId" = c.id
WHERE c."reservedUses" <> coalesce(h.n,0) OR c."reservedVnd" <> coalesce(h.v,0);

-- redeemed counters must equal the unrefunded redemptions
SELECT c.id FROM "VoucherCampaign" c
LEFT JOIN (SELECT "campaignId", count(*) n, coalesce(sum("amountVnd"),0) v FROM "VoucherRedemption" WHERE "refundedAt" IS NULL GROUP BY 1) r ON r."campaignId" = c.id
WHERE c."redeemedUses" <> coalesce(r.n,0) OR c."redeemedVnd" <> coalesce(r.v,0);

-- redemptions whose order is not settled (pending POS truth): these are NOT refunded and must be reconciled
SELECT r.id, o."publicCode", o.state, o."pancakeStatus", r."createdAt"
FROM "VoucherRedemption" r JOIN "OrderMirror" o ON o.id = r."orderId"
WHERE r."refundedAt" IS NULL AND o.state IN ('POS_SUBMITTING','SYNC_UNKNOWN') ORDER BY r."createdAt";

-- rejected orders that still hold an unrefunded redemption (the refund sweep should leave none)
SELECT r.id, r."orderId" FROM "VoucherRedemption" r JOIN "OrderMirror" o ON o.id = r."orderId"
WHERE r."refundedAt" IS NULL AND o.state = 'REJECTED';

-- HELD holds past their TTL (harmless: grants expire them lazily; a large count only means the table is untidy)
SELECT count(*) FROM "VoucherHold" WHERE state = 'HELD' AND "expiresAt" < now();
```

Alert on: any row from the two drift queries; any row from the last-but-one query (should be empty); a `SYNC_UNKNOWN` redemption older than the reconciliation window; a rising rate of `RATE_LIMITED` answers on voucher codes (guessing).

## 4. Stopping and rolling back, smallest first

| Layer | How | Effect |
| --- | --- | --- |
| Feature | unset `LA_VOUCHER_ENABLED`, restart `app` | New exposure and new holds stop; existing holds are honoured until they expire (≤ 10 minutes), settlement continues. No data change. |
| One shop | remove it from `LA_PANCAKE_VOUCHER_VERIFIED_SHOP_IDS`, restart `app` | No new holds for that shop; existing holds honoured until they expire. |
| One campaign | disable in Admin | New grants stop for it; live holds and the ledger are untouched (TG-05 A). There is deliberately no force-revoke. |
| Code | revert the deploy (`release-and-rollback.md`) | The tables are additive and ignored by old code. Orders that carry an `OrderAcceptance` row keep their frozen money; an old release would not apply the voucher to a NEW order, which is why the flag is switched off first. |
| Schema | the commented rollback list at the top of each voucher migration | **Only while no accepted order references the tables.** Dry run on an empty scratch ledger done 2026-10-26. After real redemptions a schema rollback needs a data decision by the owner; never drop after launch, disable instead. |

Order for an incident: unset the flag → restart → run §5 → decide on code rollback. Do not roll the code back first with live redemptions.

## 5. Reconciling and refunding

A redemption is refunded **once** and **only from a trusted signal** (ADR 0018 D-4); everything else is pending and alerts, never a guess. The refund path is a compare-and-set under the order row lock, so the sweep, the status reconciliation and the submit hook can all run at once.

| Situation | What happens | Operator action |
| --- | --- | --- |
| Pancake rejects the create (4xx), or confirmed absence after `SYNC_UNKNOWN` | Order closed `REJECTED`; the hook refunds the redemptions and returns the counters | none |
| A hook was lost (crash between the state change and the refund), for a `REJECTED` order **or** an order with a stored cancelled status (6 or 7) | The redemption stays unrefunded | `pnpm voucher:refund:sweep` (idempotent; prints `N rejected orders checked, M redemptions refunded`). Run it from the `ops` container. |
| Order cancelled in Pancake with status `7` (the cancel the website issues itself) or `6` "Đã hủy" (a cancel by staff in the Pancake UI, observed 2026-10-26) on a complete shop-verified status record | The status reconciliation refunds once. If staff later move the order out of 6 after the refund, the order runs with its voucher already returned (one use over the cap): accepted by the owner | none |
| `SYNC_UNKNOWN`, timeout, network error, **any other status code**, a half-written status record | **Pending.** No refund. | Reconcile against Pancake, never create a duplicate order. A cancel by staff in the Pancake UI reads **6** and is settled automatically (row above); a return or any other code is not a cancel and stays pending until a person decides. |
| A person cancelled the order by hand (Pancake UI, phone) and no trusted signal arrived | The redemption stays unrefunded; it is the voucher's use and budget that is held, **not money** (orders are cash on delivery, nothing is paid back) | `pnpm voucher:refund:admin-cancel -- --order <public code or id> --evidence "<who cancelled it, where, why>"` shows what would be returned (dry run); add `--apply` to return it. **Check the order in Pancake yourself first (shop, order code, that it is really cancelled): the command does not.** It is a manual override and cannot be undone; run it with the restricted ops credential only, and put who did it and the ticket in `--evidence`. Once-only, safe to repeat, the evidence is stored with the refund. Run from the `ops` container like the sweep. |
| Campaign expired or disabled after acceptance | Counters return; the campaign's `isEnabled`, window and revision are not touched | none |

`pnpm voucher:refund:sweep` settles both kinds of lost hook: `REJECTED` orders, and orders whose cancelled status (6 or 7) was stored on a complete, shop-verified record but whose refund never ran (`CONFIRMED` orders that Pancake cancelled). It prints `N rejected orders checked, M redemptions refunded; N cancelled orders checked, M redemptions refunded`.

Decisions recorded for v1 (owner, 2026-10-26, "theo khuyến nghị"): (1) while pricing cannot be derived a shopper may still **drop** a voucher (and nothing else): the picker says the price is not known and that the final price is shown before the order; (2) if the gift/quantity gate is switched OFF while a shopper holds a voucher, that hold is set aside and the shopper is told (it is not honoured), so keep the gate ON for as long as vouchers are on; (3) there is **no instant kill switch**: switching the feature OFF stops new holds at once and lets existing holds finish within 10 minutes; (4) a person-cancelled order is returned with the command above, not through a screen.

**Scheduling gap (blocks H5):** nothing in `deploy/vps` runs `voucher:refund:sweep` on a schedule (`catalog-sync` is the only loop in the `ops` profile). The sweep is safe on any schedule; the owner has to decide where it runs (a cron or systemd timer on the VPS calling `docker compose --profile ops run --rm ops pnpm voucher:refund:sweep`, every 5–15 minutes) and add it to the release checklist. Holds need no scheduled job: expiry is lazy under the campaign lock, and `sweepExpired` is a tidy-up with no caller.

## 6. Admin rules to remember

- A campaign that has run and was switched off, or has ended, is read-only; **Sao chép** makes a new draft.
- Caps cannot be set below *redeemed-not-refunded + live holds*. The screen shows the committed budget; the database refuses a lower cap even if a script tries.
- A PRIVATE voucher is reachable only through its code (rate-limited); a link `?voucher=CODE` is only **offered**: the parameter is stripped by redirect, the code waits in an HttpOnly cookie and **stays on the server** (the cart page is told only that a code is waiting: the code is in no HTML, RSC payload or DOM, so scripts on the page such as GTM never see it), and **nothing is saved by the link** (a GET is a navigation, not a confirmation); the shopper presses "Dùng mã từ liên kết", a Server Action that reads the cookie itself and verifies, rate-counts, quotes and asks for consent before saving, then clears the cookie. The code never reaches a rendered page or a later request URL (AC-40).

## 7. Release checklist for the person flipping the switch

- [x] Owner approved the two migrations beyond H2 (`20261026100000_voucher_order_snapshot`, `20261026120000_order_quote_step_voucher`) on 2026-10-27 ([comment](https://github.com/nguyentuanson27-netizen/la.na_design_storefront/pull/214#issuecomment-6433999206)). That is approval of the SQL only, not of running it on production.
- [ ] Before applying them to the real database: backup taken; earlier migrations in the expected state; table sizes and a maintenance window agreed (`CREATE INDEX` on `VoucherHold` can block writes while it builds; the `CHECK` change on `OrderQuoteDiscountStep` locks the table and scans it); both rollback lists dry-run on a scratch/staging database with representative data.
- [ ] CI green on the exact release SHA, including the database and browser jobs.
- [ ] `pnpm pancake:voucher:accept` passed for the shop within the agreed window; a staff-made cancel was observed on 2026-10-26 (status 6, order `11`; the owner accepted it as a cancel).
- [ ] The refund sweep is scheduled (§5) and a first run printed `0 … 0` or its real numbers.
- [ ] The §3 queries return no drift on the target database.
- [ ] `LA_VOUCHER_TEST_HARNESS` is absent from `.env.production`.
- [ ] **H4 UX acceptance** by the owner (checkout panel, cart totals wording, picker, gift-loss consent, the Admin screens), on a real phone and a desktop. Evidence link: ______ · signed by: ______ · date: ______
- [ ] **Independent security review** of this feature (not the author; `/security-review` has not been run on the branch). Report link: ______ · reviewer: ______ · date: ______ · every P1/P2 closed or accepted in writing
- [ ] **Production env and secrets review** of the four gates in §1, the absence of `LA_VOUCHER_TEST_HARNESS`, and that the auth secret used for the opaque offer handle is the production one. Record link: ______ · reviewed by: ______ · date: ______
- [ ] A named person is on call for the first day and knows §4.
- [ ] H5 go/no-go recorded by the owner. It does **not** replace the evidence for each box above; every one needs its own link and signature. **A separate `/ship` approval is required to deploy.**
