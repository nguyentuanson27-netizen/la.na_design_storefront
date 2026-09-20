# La.na Design release and rollback runbook

This runbook follows the checked-in deployment assets under `deploy/vps/`. Repository configuration is not proof that a real VPS, DNS record, TLS certificate or public edge has already been configured.

Non-secret project identity has one source: `project.config.json`. `deploy/vps/project-identity.sh` loads the project slug, database, Compose project, application domain and Better Auth URL from it. Do not substitute inherited LA Clothing project names or domains.

## Release model

Every release uses one reviewed, CI-green, full 40-character Git SHA. `deploy/vps/.env.production` carries the release SHA, an explicit `DEPLOY_TARGET`, and runtime secrets/configuration; `deploy.sh` refuses a dirty or mismatched checkout.

`DEPLOY_TARGET=production` resolves the application origin from `project.config.json`. `DEPLOY_TARGET=temporary` resolves only to the already-approved `la.lanadesign.vn` temporary host. No arbitrary hostname is accepted, and the temporary host remains fail-closed for indexing.

The current Compose topology expects PostgreSQL, app, ops and Caddy plus an external edge Docker network named by `EDGE_NETWORK_NAME`. Caddy's edge alias is `${COMPOSE_PROJECT_NAME}-caddy`, currently `la-na-design-caddy`. The real trusted proxy range must be supplied through `EDGE_TRUSTED_PROXY_CIDR`; the documentation fallback is not a production value.

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

`deploy.sh` loads current project identity, validates Compose, builds exact-SHA images, waits for PostgreSQL, runs the production preflight, creates a pre-migration custom-format dump, deploys Prisma migrations, starts app/Caddy and waits for `/shop` health.

The default local backup directory is `/var/backups/$PROJECT_SLUG`, currently `/var/backups/la-na-design`. It is not a substitute for off-site backup.

After promotion, verify through the real public edge: HTTPS/hostname, buyer-critical flows, security headers, client-IP/rate-limit behavior, service health/logs, contact-form delivery, and the explicitly approved search-exposure posture. For the temporary target, verify robots/noindex behavior remains blocked. Do not create a live Pancake order merely as a generic release smoke test.

Before accepting the contact form, verify `lanadesign.vn` for sending in Resend, create a server-only sending key, store it as `RESEND_API_KEY`, and confirm a controlled message from `website@lanadesign.vn` reaches the approved support inbox.

## Application rollback

When the previous application remains schema/data compatible and its exact image exists locally:

```bash
bash deploy/vps/rollback.sh <PREVIOUS_APPROVED_FULL_SHA>
```

The helper restores the prior application image and waits for app health. It does **not** roll back database migrations/data, edge configuration, DNS/TLS or Pancake side effects.

After rollback, verify public routing and buyer-critical flows. For ambiguous `SYNC_UNKNOWN` POS outcomes, reconcile the remote state; never issue a blind duplicate create.

## Database/data recovery

Application rollback is not database recovery. For destructive/incompatible migrations or damaged data, use a release-specific recovery plan and validate the restore point before deliberately switching production data.

## Promotion rollback

Promotion-specific containment remains documented in [`promotion-rollback-runbook.md`](./promotion-rollback-runbook.md). The historical `LA_` environment-variable prefix is a technical namespace, not a LA Clothing brand authority.

## Evidence to record

Record non-secret evidence appropriate to the release: exact SHA, CI run, runtime image, migration set, backup reference, public health, domain/TLS/edge state, client-IP sanity, telemetry review, and rollback SHA if used.
