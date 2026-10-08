#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

ENV_FILE="deploy/vps/.env.production"
COMPOSE_FILE="deploy/vps/compose.yml"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE" >&2
  exit 1
fi

# Load only non-secret deployment controls before identity resolution. Never source the whole file.
DEPLOY_TARGET="$(grep -E '^DEPLOY_TARGET=' "$ENV_FILE" | tail -n 1 | cut -d= -f2- || true)"
export DEPLOY_TARGET

# shellcheck source=deploy/vps/project-identity.sh
source "deploy/vps/project-identity.sh"

BACKUP_DIR="${BACKUP_DIR:-/var/backups/$PROJECT_SLUG}"

# Load only RELEASE_SHA for the exact-checkout invariant. Do not echo env contents.
RELEASE_SHA="$(grep -E '^RELEASE_SHA=' "$ENV_FILE" | tail -n 1 | cut -d= -f2-)"
TRY_ON_ENABLED="$(grep -E '^LA_TRY_ON_ENABLED=' "$ENV_FILE" | tail -n 1 | cut -d= -f2- || true)"
TRY_ON_PROVIDER="$(grep -E '^LA_TRY_ON_PROVIDER=' "$ENV_FILE" | tail -n 1 | cut -d= -f2- || true)"
TRY_ON_FLOW_URL="$(grep -E '^LA_TRY_ON_FLOW_URL=' "$ENV_FILE" | tail -n 1 | cut -d= -f2- || true)"
TRY_ON_PROVIDER="${TRY_ON_PROVIDER:-vertex}"
if [[ -z "$RELEASE_SHA" || "$RELEASE_SHA" == "replace-with-approved-git-sha" ]]; then
  echo "RELEASE_SHA must be set in $ENV_FILE" >&2
  exit 1
fi

ACTUAL_SHA="$(git rev-parse HEAD)"
if [[ "$ACTUAL_SHA" != "$RELEASE_SHA" ]]; then
  echo "Refusing deploy: checkout $ACTUAL_SHA does not match RELEASE_SHA $RELEASE_SHA" >&2
  exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Refusing deploy: git working tree is not clean" >&2
  exit 1
fi

compose=(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE")
flow_services=()
if [[ "$TRY_ON_ENABLED" == "true" && "$TRY_ON_PROVIDER" == "flow" ]]; then
  if [[ "$TRY_ON_FLOW_URL" != "http://flow-worker:8787" ]]; then
    echo "Flow try-on requires LA_TRY_ON_FLOW_URL=http://flow-worker:8787 on VPS" >&2
    exit 1
  fi
  compose+=(--profile flow-try-on)
  flow_services+=(flow-worker)
elif [[ "$TRY_ON_ENABLED" == "true" && "$TRY_ON_PROVIDER" != "vertex" ]]; then
  echo "LA_TRY_ON_PROVIDER must be vertex or flow when try-on is enabled" >&2
  exit 1
fi

"${compose[@]}" config --quiet
"${compose[@]}" build app ops "${flow_services[@]}"

# A warm flow-worker keeps Chrome open on the Google profile, and `gflow auth status` opens a second
# Chrome on that same profile. Ask a running worker to release it first (POST /v1/cool). A worker that
# is not running, or has the warm browser off, needs nothing; a generation in progress answers 409 and
# is retried for up to a minute.
cool_flow_worker() {
  "${compose[@]}" exec -T flow-worker python -c '
import os, sys, time, urllib.error, urllib.request
for _ in range(20):
    request = urllib.request.Request(
        "http://127.0.0.1:8787/v1/cool",
        method="POST",
        headers={"authorization": "Bearer " + os.environ["FLOW_WORKER_TOKEN"]},
    )
    try:
        urllib.request.urlopen(request, timeout=20).read()
        sys.exit(0)
    except urllib.error.HTTPError as error:
        if error.code != 409:
            sys.exit(1)
    time.sleep(3)
sys.exit(1)
' >/dev/null 2>&1 || true
}

# Fail before any database change or app cutover when Flow was explicitly enabled but its server
# secret/session is unusable. Output is discarded because auth status can include the Google email.
if [[ "${#flow_services[@]}" -gt 0 ]]; then
  cool_flow_worker
  if ! "${compose[@]}" run --rm --no-deps flow-worker sh -ec '
    test "${#FLOW_WORKER_TOKEN}" -ge 32
    test "$FLOW_WORKER_TOKEN" = "$(printf %s "$FLOW_WORKER_TOKEN" | tr -d "[:space:]")"
    env -u FLOW_WORKER_TOKEN gflow auth status --profile "$GFLOW_CLI_PROFILE" >/dev/null 2>&1
  '; then
    echo "Flow try-on preflight failed: check worker token and refresh the Google session before deploy" >&2
    exit 1
  fi
  echo "Flow try-on preflight verified the saved Google session"
fi

"${compose[@]}" up -d postgres

for _ in {1..30}; do
  postgres_id="$("${compose[@]}" ps -q postgres)"
  postgres_health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$postgres_id" 2>/dev/null || true)"
  if [[ "$postgres_health" == "healthy" ]]; then
    break
  fi
  if [[ "$postgres_health" == "unhealthy" ]]; then
    "${compose[@]}" logs --tail=200 postgres
    echo "PostgreSQL health check failed" >&2
    exit 1
  fi
  sleep 2
done

postgres_id="$("${compose[@]}" ps -q postgres)"
postgres_health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$postgres_id" 2>/dev/null || true)"
if [[ "$postgres_health" != "healthy" ]]; then
  "${compose[@]}" logs --tail=200 postgres
  echo "Timed out waiting for PostgreSQL health" >&2
  exit 1
fi

# Validate real production configuration before any database-changing command.
"${compose[@]}" run --rm ops pnpm release:check

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
BACKUP_FILE="$BACKUP_DIR/$PROJECT_SLUG-predeploy-${RELEASE_SHA:0:12}-$(date -u +%Y%m%dT%H%M%SZ).dump"

# This is the pre-migration logical recovery artifact. Off-site replication and
# restore drills remain mandatory host operations before declaring production ready.
"${compose[@]}" exec -T postgres sh -ec \
  'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom' > "$BACKUP_FILE"
chmod 600 "$BACKUP_FILE"
echo "Created pre-migration database dump: $BACKUP_FILE"

# Quiesce every database writer of the current release before any migration: the app and the
# catalog sync. Capacity-resource migrations backfill reservations that already exist, and a later
# migration may establish another write invariant; if an old writer kept running between that
# migration and the new release starting, it could create old-shape rows the new code never sees
# (for example a reservation without its CapacityReservationResource rows). One always-safe sequence
# rather than a per-migration mode. The cost is real: the storefront is unavailable (Caddy answers
# 502) for as long as the migration runs, so schedule releases with migrations accordingly.
WRITERS=(app catalog-sync)
stopped_writers=()
for writer in "${WRITERS[@]}"; do
  if [[ -n "$("${compose[@]}" ps -q "$writer")" ]]; then
    "${compose[@]}" stop "$writer"
    stopped_writers+=("$writer")
  fi
done

if ! "${compose[@]}" run --rm ops pnpm prisma:migrate:deploy; then
  # `docker compose stop` keeps the stopped containers, so this resumes the exact pre-release writers
  # instead of recreating them from the newly built images. What was not running before is not
  # started: nothing is invented.
  for writer in ${stopped_writers[@]+"${stopped_writers[@]}"}; do
    "${compose[@]}" start "$writer"
  done
  echo "Migration failed; the pre-release writers that were running were restored" >&2
  exit 1
fi

# Record every capacity mirror handoff the mirror already proves before any new writer serves (ADR
# 0014 §4.3). A migration's backfill runs once, but the supported rollback keeps the migrated schema,
# and an older release retires holds by its per-read rule without recording them; on roll-forward the
# new code would count those units again until its first catalog sync. Idempotent, and a no-op when
# nothing is pending. On failure the pre-release writers resume exactly as after a failed migration:
# their release reads the migrated schema, which is what rollback relies on too.
if ! "${compose[@]}" run --rm ops pnpm capacity:handoff:reconcile; then
  for writer in ${stopped_writers[@]+"${stopped_writers[@]}"}; do
    "${compose[@]}" start "$writer"
  done
  echo "Capacity handoff reconciliation failed; the pre-release writers that were running were restored" >&2
  exit 1
fi

# wait_healthy SERVICE ATTEMPTS DELAY: succeeds once Docker reports SERVICE healthy.
wait_healthy() {
  local service="$1" attempts="$2" delay="$3" container health
  for ((attempt = 0; attempt < attempts; attempt += 1)); do
    container="$("${compose[@]}" ps -q "$service")"
    health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container" 2>/dev/null || true)"
    if [[ "$health" == "healthy" ]]; then
      return 0
    fi
    if [[ "$health" == "unhealthy" ]]; then
      return 1
    fi
    sleep "$delay"
  done
  return 1
}

# Bring the private Flow dependency up and prove it before the app can expose a Flow-backed entry
# point. The preflight above proved the saved session; this proves the actual long-lived worker.
if [[ "${#flow_services[@]}" -gt 0 ]]; then
  "${compose[@]}" up -d --no-build flow-worker
  if ! wait_healthy flow-worker 20 3; then
    "${compose[@]}" logs --tail=100 flow-worker
    echo "Flow try-on worker did not become healthy; app cutover was not started" >&2
    exit 1
  fi
  cool_flow_worker
  if ! "${compose[@]}" exec -T flow-worker sh -ec 'env -u FLOW_WORKER_TOKEN gflow auth status --profile "$GFLOW_CLI_PROFILE" >/dev/null 2>&1'; then
    echo "Flow try-on Google session became unavailable before app cutover" >&2
    exit 1
  fi
  echo "Flow try-on worker and Google session are healthy at release $RELEASE_SHA"
fi

"${compose[@]}" up -d --no-build app caddy catalog-sync

if ! wait_healthy app 40 3; then
  "${compose[@]}" logs --tail=200 app
  echo "Application did not become healthy at release $RELEASE_SHA" >&2
  exit 1
fi
echo "Application container is healthy at release $RELEASE_SHA"

# The release is not done until the catalog sync has actually succeeded once: a running loop whose
# every sync fails would otherwise leave COMMITTED capacity holds uncleared and restocks unsellable
# while the deploy reports success. Its health check turns healthy on the first successful sync.
if ! wait_healthy catalog-sync 80 5; then
  "${compose[@]}" logs --tail=200 catalog-sync
  echo "Application is serving release $RELEASE_SHA, but the catalog sync has not succeeded; fix it before relying on stock" >&2
  exit 1
fi
echo "Catalog sync is healthy at release $RELEASE_SHA"
