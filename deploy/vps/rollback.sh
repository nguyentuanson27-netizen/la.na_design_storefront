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
RELEASE_SHA="$PREVIOUS_SHA" "${compose[@]}" up -d --no-build app caddy

for _ in {1..40}; do
  app_id="$("${compose[@]}" ps -q app)"
  health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$app_id" 2>/dev/null || true)"
  if [[ "$health" == "healthy" ]]; then
    echo "Application rolled back to $PREVIOUS_SHA"
    echo "Database migrations/data and Pancake side effects were NOT rolled back; reconcile them separately if required."
    exit 0
  fi
  if [[ "$health" == "unhealthy" ]]; then
    "${compose[@]}" logs --tail=200 app
    echo "Rollback image failed health check" >&2
    exit 1
  fi
  sleep 3
done

"${compose[@]}" logs --tail=200 app
echo "Timed out waiting for rollback health" >&2
exit 1
