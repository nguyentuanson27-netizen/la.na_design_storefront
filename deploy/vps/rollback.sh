#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <previous-approved-sha>" >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

ENV_FILE="deploy/vps/.env.production"
COMPOSE_FILE="deploy/vps/compose.yml"
PREVIOUS_SHA="$1"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE" >&2
  exit 1
fi

DEPLOY_TARGET="$(grep -E '^DEPLOY_TARGET=' "$ENV_FILE" | tail -n 1 | cut -d= -f2- || true)"
export DEPLOY_TARGET

# shellcheck source=deploy/vps/project-identity.sh
source "deploy/vps/project-identity.sh"

if ! [[ "$PREVIOUS_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "Rollback SHA must be a full 40-character lowercase Git SHA" >&2
  exit 1
fi

if ! docker image inspect "$PROJECT_SLUG:$PREVIOUS_SHA" >/dev/null 2>&1; then
  echo "Required rollback image $PROJECT_SLUG:$PREVIOUS_SHA is not available locally" >&2
  exit 1
fi

compose=(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE")

# A previous storefront release may not know how to use the Flow worker. Stop the current worker
# first so a rollback never leaves a signed-in Google session process running orphaned on the VPS.
"${compose[@]}" --profile flow-try-on stop flow-worker >/dev/null 2>&1 || true

# App and catalog-sync are both database writers and must belong to the same release. Quiesce the
# current sync *before* the previous app starts, so there is no window where the older app serves
# while newer sync code is still writing; `stop` waits out an in-flight sync (90s grace).
"${compose[@]}" stop catalog-sync

# The release being left may have added a second Pancake shop's stock to the mirror (WarehouseStock
# rows keyed `secondary:*`). The release being restored adds up EVERY warehouse row it finds and does
# not know that key, so until its own sync removed them those units would count as primary stock on
# the storefront and in capacity reservations, while its checkout reads the primary POS alone. So
# they are removed -- and the availability they affected observed again -- while the writers are
# quiet and before the previous app takes traffic. It runs from the release being left (the one in
# the env file), the only one that knows the rows; a release without the script predates the feature
# and has nothing to remove. Idempotent.
CURRENT_SHA="$(grep -E '^RELEASE_SHA=' "$ENV_FILE" | tail -n 1 | cut -d= -f2- || true)"
if [[ -n "$CURRENT_SHA" ]] && docker image inspect "$PROJECT_SLUG-ops:$CURRENT_SHA" >/dev/null 2>&1 \
  && "${compose[@]}" run --rm --no-deps ops node -e "process.exit(require('node:fs').existsSync('scripts/pancake-secondary-teardown.ts') ? 0 : 1)" >/dev/null 2>&1; then
  if ! "${compose[@]}" run --rm ops pnpm pancake:secondary:teardown; then
    # Nothing was started: put the current writer back exactly as it was, and stop here.
    "${compose[@]}" start catalog-sync >/dev/null 2>&1 || true
    echo "Could not remove the secondary shop's stock from the mirror; $PREVIOUS_SHA was NOT started. Fix the database access and retry the rollback." >&2
    exit 1
  fi
else
  echo "Note: the release being left has no secondary-stock teardown, so there is no secondary stock to remove."
fi

RELEASE_SHA="$PREVIOUS_SHA" "${compose[@]}" up -d --no-build app caddy

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

if ! wait_healthy app 40 3; then
  "${compose[@]}" logs --tail=200 app
  echo "Rollback image failed to become healthy" >&2
  exit 1
fi
echo "Application rolled back to $PREVIOUS_SHA"
echo "Database migrations/data and Pancake side effects were NOT rolled back; reconcile them separately if required."

# Start the previous release's own sync only if that release shipped one. Releases from before the
# catalog-sync service have no tagged ops image: sync stays stopped, which means COMMITTED capacity
# holds stop clearing and restocks stop reaching the storefront until the next release, so say so
# loudly.
if docker image inspect "$PROJECT_SLUG-ops:$PREVIOUS_SHA" >/dev/null 2>&1; then
  RELEASE_SHA="$PREVIOUS_SHA" "${compose[@]}" up -d --no-build catalog-sync
  if ! wait_healthy catalog-sync 80 5; then
    "${compose[@]}" logs --tail=200 catalog-sync
    echo "Rolled-back catalog sync has not succeeded; capacity holds will not clear until it does" >&2
    exit 1
  fi
  echo "Catalog sync rolled back to $PREVIOUS_SHA and healthy"
else
  echo "WARNING: $PREVIOUS_SHA has no catalog-sync image; the scheduled catalog sync stays stopped until the next release" >&2
fi
