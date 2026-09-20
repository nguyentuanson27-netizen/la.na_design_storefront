# VPS bootstrap handoff — La.na Design

This runbook is for an operator with shell access to the target VPS. Repository preparation does **not** prove that host provisioning, DNS, TLS, edge routing, backups or monitoring have happened.

## Project identity

Use `project.config.json` as the non-secret identity authority. The current committed values are project slug `la-na-design`, database `la_na_design`, Compose project `la-na-design`, and production hostname `www.lanadesign.vn`.

`deploy/vps/project-identity.sh` exports these values for `deploy.sh`, `rollback.sh` and Compose. Do not reuse inherited LA Clothing repository names, database names, image names, domains or Caddy aliases.

## 1. Inventory and harden the host

Before changing a shared host, record the current OS, Docker/Compose versions, listeners, firewall/SSH posture, existing proxy stack and Docker networks. Do not stop or rebind unrelated production services.

Use key-based administration, supported host packages and an explicit backup/restore plan. Treat Docker-daemon access as root-equivalent.

## 2. Check out the exact approved release

```bash
git clone https://github.com/nguyentuanson27-netizen/la.na_design_storefront.git
cd la.na_design_storefront
git fetch --all --tags --prune
git checkout --detach <APPROVED_FULL_SHA>
git rev-parse HEAD
git status --porcelain
```

The worktree must be clean. Do not deploy a moving branch name.

## 3. Create protected production configuration

```bash
cp deploy/vps/env.example deploy/vps/.env.production
chmod 600 deploy/vps/.env.production
```

Populate the runtime values/secrets required by the template, including exact `RELEASE_SHA`, explicit `DEPLOY_TARGET=production|temporary`, Better Auth secret, database credentials/URL, Pancake credentials, `RESEND_API_KEY`, reviewed server-owned policy values, image references, `EDGE_NETWORK_NAME`, and reviewed `EDGE_TRUSTED_PROXY_CIDR`.

Use `DEPLOY_TARGET=temporary` for the public test deployment at `la.lanadesign.vn`. The script maps that target itself; do not add `APP_DOMAIN` or `BETTER_AUTH_URL` to the env file. Temporary remains noindex by release policy.

`APP_DOMAIN`, `BETTER_AUTH_URL`, `POSTGRES_DB` and `COMPOSE_PROJECT_NAME` are derived from `project.config.json` by the deployment scripts; do not maintain a second manual copy.

Never print the completed environment file into logs, issues, PRs or chat transcripts.

## 4. Prepare the public edge

The checked-in Compose model keeps Caddy off host ports and attaches it to an external edge network. Its stable edge alias is `${COMPOSE_PROJECT_NAME}-caddy`, currently:

```text
la-na-design-caddy
```

If nginx-proxy-manager is the real public edge, verify the actual external Docker network and create/review only the selected La.na Design proxy host. For temporary acceptance use `la.lanadesign.vn`; for final cutover use the production domain from `project.config.json`:


```text
Domain: <selected deploy target hostname>
Forward scheme: http
Forward host/name: la-na-design-caddy
Forward port: 80
TLS/certificate: managed by the public edge
```

Do not assume the inherited LA Clothing proxy host, network or certificate is reusable. `EDGE_NETWORK_NAME` and `EDGE_TRUSTED_PROXY_CIDR` are required with no production fallback; scope the CIDR to the observed proxy hop.

ADR 0010 selects the repository hostname but does not prove external DNS/TLS/edge cutover. Record observed evidence before calling the host live.

## 5. Backup and restore readiness

`deploy.sh` creates a pre-migration custom-format PostgreSQL dump under `/var/backups/$PROJECT_SLUG` by default (currently `/var/backups/la-na-design`). Configure off-site/encrypted retention as appropriate and perform a restore drill before relying on the backup path for production recovery.

On a fresh host, provision the default backup directory once for the non-root deployment operator before the first deploy:

```bash
sudo install -d -m 700 \
  -o "$(id -un)" \
  -g "$(id -gn)" \
  /var/backups/la-na-design
```

If production deliberately overrides `BACKUP_DIR`, provision that path with equivalent ownership and permissions instead.

## 6. Resend contact-delivery acceptance

Verify the sending domain in Resend using the DNS records Resend provides, then create a sending-only/domain-scoped key when available and store it only as `RESEND_API_KEY` in the protected env file. Send one controlled contact-form submission and confirm delivery to the approved support inbox. Never put the key or customer message content in release evidence.

## 7. Controlled Pancake acceptance

A read-only contract probe is not a substitute for any required write-path launch acceptance. For a controlled create test, verify the returned/remote order and clean it up according to the reviewed Pancake capability. If the write outcome is ambiguous, reconcile it as `SYNC_UNKNOWN`; never issue a blind duplicate create.

## 8. Deploy exact SHA

From the clean detached checkout with protected production configuration in place:

```bash
bash deploy/vps/deploy.sh
```

The helper must pass its exact-checkout, Compose, database health, release preflight, backup, migration and application health gates. Diagnose failures instead of bypassing them.

## 9. Public acceptance

After the real edge has valid routing/TLS, verify externally: expected HTTPS hostname, homepage and `/shop`, representative product/cart/checkout/tracking paths, security headers, client-IP/rate-limit behavior, service health/logs, and the explicitly approved search-exposure posture.

## 10. Monitoring and rollback readiness

Before production sign-off, establish checks appropriate to the target host for uptime, certificate/edge health, container restarts, disk/inodes, PostgreSQL, backup freshness and host maintenance.

Keep the previous known-good `${PROJECT_SLUG}:<full-sha>` image locally. Application-only rollback is:

```bash
bash deploy/vps/rollback.sh <PREVIOUS_APPROVED_FULL_SHA>
```

This does not reverse database migrations/data, DNS/TLS/edge changes or Pancake side effects; reconcile those separately when required.
