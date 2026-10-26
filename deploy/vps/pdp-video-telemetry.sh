#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"
ENV_FILE="deploy/vps/.env.production"
SINCE="${1:-1h}"
if [[ "$#" -gt 1 || ! "$SINCE" =~ ^[1-9][0-9]*(s|m|h)$ ]]; then
  echo "Usage: bash deploy/vps/pdp-video-telemetry.sh [positive duration, e.g. 1h]" >&2
  exit 1
fi
if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing deployment environment file" >&2
  exit 1
fi

# Match deploy.sh: read only the non-secret target; never source/evaluate the full env file.
DEPLOY_TARGET="$(grep -E '^DEPLOY_TARGET=' "$ENV_FILE" | tail -n 1 | cut -d= -f2- || true)"
export DEPLOY_TARGET
# shellcheck source=deploy/vps/project-identity.sh
source "deploy/vps/project-identity.sh"

# Spool privately so a failed Compose command cannot be mistaken for a valid NO_DATA report.
VIDEO_LOG_FILE="$(mktemp "${TMPDIR:-/tmp}/pdp-video-logs.XXXXXX")"
trap 'rm -f "$VIDEO_LOG_FILE"' EXIT
if ! docker compose --env-file "$ENV_FILE" -f deploy/vps/compose.yml \
  logs --no-color --no-log-prefix --since="$SINCE" app > "$VIDEO_LOG_FILE"; then
  echo "Unable to collect app logs; no telemetry summary was produced" >&2
  exit 1
fi
# The release-tagged ops image supplies Node and this release's source; no host Node install.
# --no-deps keeps application/database services untouched; --pull=never uses the deployed image.
docker compose --env-file "$ENV_FILE" -f deploy/vps/compose.yml \
  run --rm -T --no-deps --pull=never ops \
  node --experimental-strip-types scripts/pdp-video-playback-summary.ts < "$VIDEO_LOG_FILE"
