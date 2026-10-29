# Catalog list-price audit

The display phase uses derived prices without a markup cap. Deploy this additive
migration and worker before enabling `LIST_PRICE_DISPLAY` (all flags default OFF).

From the release repository with the normal `deploy/vps/.env.production`:

```sh
bash deploy/vps/list-price-ops.sh audit
bash deploy/vps/list-price-ops.sh config app
bash deploy/vps/list-price-ops.sh config catalog-sync
```

The wrapper loads project identity, passes the Compose env file without sourcing
secrets, and uses the deployed ops image without pulling/building or starting
unrelated services. Exit 2 reports invalid POS, unavailable list or ratio >1.5;
stop rollout and review the reported variant IDs. A POS of 10,000 yields 49,000,
reports an outlier and remains unchanged.

After each completed catalog sync and from the recurring inventory loop, the audit
compares the persisted sync marker and last successful audit date. It also runs
daily and retries failures after 60 seconds. A failed audit/notification emits
`list_price.catalog_audit_failed`, persists retry state and never rolls back the
catalog/inventory commit. Successful `list_price.catalog_audit` events include
counts, minimum POS, maximum ratio and up to 50 external variant IDs; they contain
no credentials, customer data or media URLs.

Configure operator log alerts for nonzero `invalidPos`, `unavailableList`, `outliers`
and every failure event. The durable `CatalogSyncState` summary remains available
for diagnostics. Verify log routing before rollout; do not interpret absent audit
output as a healthy catalog. Phase 2 adds the separate campaign-basis preflight and
DB freeze protocol; this audit does not authorize activation of that basis.
