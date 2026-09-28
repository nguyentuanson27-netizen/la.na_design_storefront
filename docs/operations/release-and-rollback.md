# La.na Design release and rollback runbook

This runbook follows the checked-in deployment assets under `deploy/vps/`. Repository configuration is not proof that a real VPS, DNS record, TLS certificate or public edge has already been configured.

Non-secret project identity has one source: `project.config.json`. `deploy/vps/project-identity.sh` loads the project slug, database, Compose project, application domain and Better Auth URL from it. Do not substitute inherited LA Clothing project names or domains.

## Release model

Every release uses one reviewed, CI-green, full 40-character Git SHA. `deploy/vps/.env.production` carries the release SHA, an explicit `DEPLOY_TARGET`, and runtime secrets/configuration; `deploy.sh` refuses a dirty or mismatched checkout.

`DEPLOY_TARGET=production` resolves the application origin from `project.config.json`. `DEPLOY_TARGET=temporary` resolves only to the already-approved `la.lanadesign.vn` temporary host. No arbitrary hostname is accepted, and the temporary host remains fail-closed for indexing.

The current Compose topology expects PostgreSQL, app, ops, catalog-sync and Caddy plus an external edge Docker network named by `EDGE_NETWORK_NAME`. Caddy's edge alias is `${COMPOSE_PROJECT_NAME}-caddy`, currently `la-na-design-caddy`. The real trusted proxy range must be supplied through `EDGE_TRUSTED_PROXY_CIDR`; the documentation fallback is not a production value.

If nginx-proxy-manager is the real public edge, verify its actual network, proxy host and certificate before promotion. Never assume the old LA Clothing proxy-host state still exists or is correct for this project.

## Release gate

A candidate is releasable only when all applicable items are true:

1. human review/approval exists for the exact SHA;
2. exact-head CI and required runtime checks are green;
3. target host/DNS/TLS/edge state has been observed;
4. protected `deploy/vps/.env.production` contains real runtime values and no placeholders, including `DEPLOY_TARGET` and `RESEND_API_KEY`;
5. the external edge network exists and both `EDGE_NETWORK_NAME` and `EDGE_TRUSTED_PROXY_CIDR` are explicitly configured and narrowly reviewed;
6. database migration/recovery impact has been reviewed;
7. backup/restore readiness matches the migration risk;
8. the previous known-good application SHA/image is retained;
9. any required controlled Pancake write acceptance is completed separately from generic smoke testing.

Do not treat repository docs as evidence that host-only work has happened.

## Preflight and release

From the clean detached checkout:

```bash
pnpm release:check
bash deploy/vps/deploy.sh
```

`deploy.sh` loads current project identity, validates Compose, builds exact-SHA images, waits for PostgreSQL, runs the production preflight, creates a pre-migration custom-format dump, stops every running database writer (`app` and `catalog-sync`), deploys Prisma migrations, records any capacity mirror handoffs the mirror already proves (`pnpm capacity:handoff:reconcile`, which covers rows an older release wrote after a rollback), starts app/Caddy/catalog-sync, waits for `/shop` health and then waits for the catalog sync's first successful run.

If the migration or the handoff reconciliation fails, only the writers that were running before the release are resumed from their stopped pre-release containers; nothing from the new images starts. A release whose app is healthy but whose catalog sync never succeeds exits non-zero: capacity holds for committed orders only clear, and Pancake restocks only reach the storefront, through a successful sync.

## Scheduled catalog sync

`catalog-sync` runs `pnpm pancake:catalog:sync --loop` from the release-tagged ops image (`$PROJECT_SLUG-ops:$RELEASE_SHA`), with two loops in one process, restarting with the stack and logging fixed text only:

- **Webhook-driven inventory batch, every 30 seconds.** Pancake's `variations_warehouses` webhook posts to `/api/pancake/inventory-webhook` (custom header `x-pancake-webhook-secret` = `PANCAKE_WEBHOOK_SECRET`). The endpoint only records a `(variation, warehouse)` marker; duplicates and out-of-order deliveries collapse into one row. Each batch reads the flagged variations' authoritative stock from Pancake (`GET /products/variations` with `variation_ids[]`) and applies it through the same guarded write as the full reconciliation (variant locks, availability cycles, durable capacity handoff). A batch with work logs `inventory batch: N webhook events (D deduplicated), … applied, … superseded, … unknown, … failed reads (… retried, … dropped), … capacity holds handed to the mirror`; an idle batch logs nothing. A failed read keeps its marker for up to 5 batches; a delivery that arrives meanwhile is a new marker version with a fresh budget, so a failing claim never drops or charges it.
- **Full reconciliation, immediately and then every `CATALOG_SYNC_INTERVAL_SECONDS`** (60-86400, default 3600). It is the safety net: after lost webhooks or downtime, the next reconciliation brings the mirror back to Pancake's state. Its `catalog sync ok` line and the heartbeat file record the last successful reconciliation.

### Rollout: webhook-driven inventory release

`deploy/vps/.env.production` persists across releases and its values override code defaults, so this release does not change production behavior until the file is updated. Before (or with) deploying it, edit `.env.production` on the VPS:

1. set `CATALOG_SYNC_INTERVAL_SECONDS=3600`, replacing any existing value (an older file may still carry `300`, which would keep the full catalog sync running every 5 minutes);
2. set `PANCAKE_WEBHOOK_SECRET` to a long random value;
3. in Pancake shop settings, set `webhook_url` to `https://<APP_DOMAIN>/api/pancake/inventory-webhook`, add `variations_warehouses` to `webhook_types`, and add the header `x-pancake-webhook-secret: <PANCAKE_WEBHOOK_SECRET>` to `webhook_headers`.

After `deploy.sh`, confirm with `grep '^CATALOG_SYNC_INTERVAL_SECONDS=' deploy/vps/.env.production` (expect `3600`) and that consecutive `catalog sync ok` lines in the `catalog-sync` logs are about an hour apart.

A read never overwrites stock that a later-started read already wrote, whichever path wrote it, so an hourly reconciliation that commits after a newer webhook batch cannot restore pre-order stock under a recorded capacity handoff.

The health check is healthy only when a full reconciliation succeeded within two intervals plus two minutes; a running loop whose every reconciliation fails is reported unhealthy. A one-off reconciliation is `docker compose ... run --rm ops pnpm pancake:catalog:sync`.

The default local backup directory is `/var/backups/$PROJECT_SLUG`, currently `/var/backups/la-na-design`. It is not a substitute for off-site backup.

After promotion, verify through the real public edge: HTTPS/hostname, buyer-critical flows, security headers, client-IP/rate-limit behavior, service health/logs, contact-form delivery, and the explicitly approved search-exposure posture. For the temporary target, verify robots/noindex behavior remains blocked. Do not create a live Pancake order merely as a generic release smoke test.

Before accepting the contact form, verify `lanadesign.vn` for sending in Resend, create a server-only sending key, store it as `RESEND_API_KEY`, and confirm a controlled message from `website@lanadesign.vn` reaches the approved support inbox.

## Application rollback

When the previous application remains schema/data compatible and its exact image exists locally:

```bash
bash deploy/vps/rollback.sh <PREVIOUS_APPROVED_FULL_SHA>
```

The helper first stops the current `catalog-sync`, so the older app never runs beside newer sync code, then restores the prior application image and waits for app health, then starts that release's own catalog sync from `$PROJECT_SLUG-ops:<SHA>` and waits for a successful sync. A release from before the catalog-sync service has no such image: the helper warns and leaves the sync stopped until the next release, which means committed-order capacity holds stop clearing and restocks stop reaching the storefront. It does **not** roll back database migrations/data, edge configuration, DNS/TLS or Pancake side effects.

After rollback, verify public routing and buyer-critical flows. For ambiguous `SYNC_UNKNOWN` POS outcomes, reconcile the remote state; never issue a blind duplicate create.

## Database/data recovery

Application rollback is not database recovery. For destructive/incompatible migrations or damaged data, use a release-specific recovery plan and validate the restore point before deliberately switching production data.

## Promotion rollback

Promotion-specific containment remains documented in [`promotion-rollback-runbook.md`](./promotion-rollback-runbook.md). The historical `LA_` environment-variable prefix is a technical namespace, not a LA Clothing brand authority.

## Evidence to record

Record non-secret evidence appropriate to the release: exact SHA, CI run, runtime image, migration set, backup reference, public health, domain/TLS/edge state, client-IP sanity, telemetry review, and rollback SHA if used.
