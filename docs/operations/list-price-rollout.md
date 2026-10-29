# List-price rollout and rollback

Implementation authority: [spec PR225 v6](../specs/list-price-display-v1.md),
[ADR 0021](../decisions/0021-list-price-display-and-campaign-basis.md).
This runbook does not activate any production feature. All flags default OFF.

## Before rollout

Deploy migrations and the reviewed application/ops release while every list flag
is OFF. Nullable history columns remain on rollback; never backfill legacy orders.
Drain/terminate all older app/worker instances before permitting mutations with the
new basis. Inventory every host and replica; a fresh ops process alone does not
prove the running instances read the same flags.

From the deployed repository, with its release-tagged ops image and complete
`deploy/vps/.env.production`, run:

```sh
bash deploy/vps/list-price-ops.sh audit
bash deploy/vps/list-price-ops.sh config app
bash deploy/vps/list-price-ops.sh config catalog-sync
```

The wrapper resolves project identity, passes the deployment env file, never sources
secrets, never pulls/builds an image and starts no dependency. Audit exit 2 means
outliers/invalid money: stop rollout for owner review. A POS 10,000 -> list 49,000
must alert, not receive a silent cap. Check the persisted CatalogSyncState audit
summary and `list_price.catalog_audit` / `list_price.catalog_audit_failed` logs.
Configure operator log alerts for nonzero outliers/invalidPos/unavailableList and
for every audit failure; the inventory loop retries after 60 seconds, daily after
success, and whenever the catalog sync marker changes. Alert delivery failures
must be retried, not dismissed as a healthy audit.

Compare card/PDP/variant/cart/drawer/checkout on staging, money and analytics with
display ON/OFF, long prices and phone layouts. Review factual pricing-policy copy.
Enable only display first; monitor conversion, returns and complaints.

Before basis ON, enumerate **all** enabled product `PERCENTAGE` campaigns, including
future schedules (not gift/quantity/order-value ladders). Resolve or disable them
through the admin service before changing basis. Verify partial threshold warnings,
unsafe-price refusal and representative parity. Set display ON first, then basis ON
in deployment configuration, recreate **every** web and catalog-sync instance with
this same release/config and verify named flags on each host/replica. Enable order
history separately; legacy null references never acquire invented savings.

```sh
bash deploy/vps/list-price-ops.sh campaigns
```

This read-only check exits 2 while any current/future percentage campaign remains;
the report counts all matches and bounds the displayed IDs to 50. It makes no writes.

Merchant is **NO-GO** in this implementation. Leave LIST_PRICE_MERCHANT=false.
No new g:sale_price or StrikethroughPrice is emitted. Optional phase 4 needs owner
GO, evidence of historically applied prices, parity/diagnostics, rendered-HTML
Rich Results validation and a separate implementation. Existing real campaign money
continues through the existing Merchant/JSON-LD paths.

## Basis rollback: freeze first, never just flip the flag

Example: POS 590,000, list 749,000, 25% is 562,000 with basis ON. Flipping OFF while
it remains enabled would charge 442,500: 119,500 less per unit. Preflight must refuse.

1. Set the non-secret `LIST_PRICE_ROLLBACK_ACTOR` operator identifier in the ops env
   file. Choose a bounded rollback id. Keep basis ON and execute:

   ```sh
   bash deploy/vps/list-price-ops.sh freeze rollback_20261030
   ```

   The DB revision lock waits for earlier publishes, persists freeze ownership and
   advances pricing revision. All new create/edit/copy/publish writes fail closed.
   Disable/end-early still work. No browser-only button fence is used.
2. Set LA_PROMOTION_ACTIVATION_ENABLED=false and recreate **all** web/worker instances
   (using the normal deployment procedure). Verify the reviewed guard release and
   the flag on 100% of hosts/replicas. If inventory/config cannot be verified, stop.
   Disable every enabled current/future product percentage campaign via its service;
   do not bulk-rewrite campaign rows. Stop on any refusal. Fixed-price campaigns do
   not change basis and must not be disabled indiscriminately.
3. With the DB freeze still ON and every instance verified, run:

   ```sh
   bash deploy/vps/list-price-ops.sh preflight rollback_20261030 --all-instances-verified
   ```

   Preflight locks revision, checks owned freeze and queries the enabled campaigns
   again. It exits 2 until none remain, then stores revision/time. The CLI switch is
   an operator attestation after inspection, not an automated discovery of replicas.
4. Only after successful preflight, set LIST_PRICE_CAMPAIGN_BASIS=false everywhere,
   keeping display ON and activation disabled. Recreate every traffic-serving app
   and worker. Verify flags, image release and fresh cache identity/revision on each
   instance. Check PDP/cart/checkout/sale listings, POS mapping and Merchant parity.
   Old quotes must re-quote; do not replay a proof as new money. Keep DB freeze ON
   throughout. Missing/mixed instances are a stop condition.
5. Re-run preflight if revision changed since the earlier successful check. Once all
   instances are verified OFF and activation remains disabled, run:

   ```sh
   bash deploy/vps/list-price-ops.sh release rollback_20261030 --all-instances-verified
   ```

   Release rechecks owned/fresh preflight and zero enabled percentage campaigns in
   the revision transaction, then advances revision. Re-enable activation only if
   the owner wants new campaigns on the old basis, after every instance agrees.
   Display may be disabled only after basis is OFF. Order history can remain ON,
   reading frozen references regardless of current catalog/basis flags.

Never remove list columns or rewrite accepted snapshot rows during rollback.
