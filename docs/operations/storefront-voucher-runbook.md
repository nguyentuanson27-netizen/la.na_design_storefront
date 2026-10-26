# Voucher v1 — operations runbook (DRAFT)

- **Status:** DRAFT. The checkout path (V11–V14, V18) is not built, so this describes the controls that exist today and marks what is still missing. It is not a go-live approval; the launch decision is gate H5.
- **Spec / ADRs:** [spec](../specs/storefront-voucher-v1.md), [ADR 0018](../decisions/0018-voucher-v1-accepted-order-architecture.md), [ADR 0019](../decisions/0019-voucher-v1-hold-design.md).

## 1. The switch

| Control | Meaning |
| --- | --- |
| `LA_VOUCHER_ENABLED` unset, empty, or anything but exactly `true` | **OFF** (default). No voucher is listed, selected, previewed, linked or held. The cart, PDP and checkout are byte-for-byte what they were. |
| `LA_VOUCHER_ENABLED=true` | Vouchers appear in the cart and PDP as **previews**. **Do not set this in production yet**: checkout does not apply vouchers (V18 is not built), so a shopper would see a saving that checkout does not honour. |

`LA_PANCAKE_VOUCHER_VERIFIED_SHOP_IDS` (comma-separated shop ids, default empty) is the second gate for a NEW hold (ADR 0019 D-6): list a shop only after `pnpm pancake:voucher:accept` passed for it (shop 715077776 passed on 2026-10-26, see the verification folder). Unset or malformed means no hold is ever granted. It is not read on the settle path.

Turning the flag OFF stops **new** exposure only. Existing holds and redemptions keep settling (consume, expire, refund); the settle path does not read the flag (ADR 0018 D-6, AC-47). There is nothing to "drain" before switching off.

## 2. Admin

`/admin/promotions/vouchers`. A voucher is created **inactive** and never activates itself; an Admin presses Bật after checking it.

- **Disable** stops new grants and leaves live holds and the ledger exactly as they are (TG-05 A). There is deliberately no force-revoke.
- A campaign that has run and was switched off, or has ended, is read-only; **Sao chép** makes a new draft.
- Caps cannot be set under *redeemed-not-refunded + live holds*. The screen shows the committed budget; the database refuses a lower cap even if a script tries.

## 3. What to watch (once holds exist)

Queries are read-only and use the ledger columns on `VoucherCampaign`:

```sql
-- committed vs caps, per campaign
SELECT id, name, "redeemedUses", "reservedUses", "maxUses", "redeemedVnd", "reservedVnd", "maxBudgetVnd"
FROM "VoucherCampaign" WHERE "pancakeShopId" = :shop ORDER BY "updatedAt" DESC;

-- holds that outlived their TTL without being swept (expected to be near zero once the sweeper runs)
SELECT count(*) FROM "VoucherHold" WHERE state = 'HELD' AND "expiresAt" < now();

-- ledger drift: reserved must equal the live HELD holds (alert if any row returns)
SELECT c.id FROM "VoucherCampaign" c
LEFT JOIN (SELECT "campaignId", count(*) n, coalesce(sum("heldDiscountVnd"),0) v FROM "VoucherHold" WHERE state = 'HELD' GROUP BY 1) h ON h."campaignId" = c.id
WHERE c."reservedUses" <> coalesce(h.n,0) OR c."reservedVnd" <> coalesce(h.v,0);

-- redemptions waiting on POS (not refunded; order not CONFIRMED)
SELECT r.id, o."publicCode", o.state FROM "VoucherRedemption" r JOIN "OrderMirror" o ON o.id = r."orderId"
WHERE r."refundedAt" IS NULL AND o.state IN ('POS_SUBMITTING','SYNC_UNKNOWN');
```

Alert on: any drift row; `SYNC_UNKNOWN` redemptions older than the reconciliation window; a rising rate of `RATE_LIMITED` on voucher codes (guessing).

## 4. Rollback

| Layer | How | Effect |
| --- | --- | --- |
| Feature | unset `LA_VOUCHER_ENABLED` | New exposure stops; settlement continues. No data change. |
| Campaign | disable in Admin | New grants stop for that campaign; live holds honoured. |
| Code | revert the deploy | The tables are additive and ignored by old code; accepted-order guards only affect orders that have an `OrderAcceptance` row (none exist until V13). |
| Schema | the `DROP` list at the top of `20261025100000_voucher_v1_additive/migration.sql` | Safe only while no accepted order references the tables. **Never** drop after launch; disable instead. |

## 5. Not yet covered (blocks H5)

Refund/reconciliation runbook for `SYNC_UNKNOWN` and cancelled orders (V14, needs the Pancake status mapping, TG-04); hold sweeper and its alert (V11); checkout screens and the gift-loss confirmation (V18); the operator-run sandbox probe (H1-V); a migration rollback dry run on staging.
