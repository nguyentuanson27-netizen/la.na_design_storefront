#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"
ENV_FILE="deploy/vps/.env.production"
if [[ ! -f "$ENV_FILE" ]]; then echo "Missing deployment environment file" >&2; exit 1; fi
DEPLOY_TARGET="$(grep -E '^DEPLOY_TARGET=' "$ENV_FILE" | tail -n 1 | cut -d= -f2- || true)"
export DEPLOY_TARGET
# Never source the environment file. Load only the existing trusted identity resolver.
source "deploy/vps/project-identity.sh"
command="${1:-}"
shift || true
case "$command" in
  audit)
    [[ "$#" -eq 0 ]] || exit 1
    script="scripts/list-price-audit.ts"
    docker compose --env-file "$ENV_FILE" -f deploy/vps/compose.yml run --rm -T --no-deps --pull=never ops node --experimental-strip-types "$script"
    ;;
  config)
    service="${1:-app}"
    [[ "$#" -le 1 && ( "$service" == "app" || "$service" == "catalog-sync" ) ]] || exit 1
    # Read the running container, not a fresh ops process. Output only named non-secret flags.
    docker compose --env-file "$ENV_FILE" -f deploy/vps/compose.yml exec -T "$service" node -e 'console.log(JSON.stringify({RELEASE_SHA:process.env.RELEASE_SHA??null,LIST_PRICE_DISPLAY:process.env.LIST_PRICE_DISPLAY==="true",LIST_PRICE_CAMPAIGN_BASIS:process.env.LIST_PRICE_CAMPAIGN_BASIS==="true",LIST_PRICE_ORDER_HISTORY:process.env.LIST_PRICE_ORDER_HISTORY==="true",LA_PROMOTION_ACTIVATION_ENABLED:process.env.LA_PROMOTION_ACTIVATION_ENABLED==="true"}))'
    docker compose --env-file "$ENV_FILE" -f deploy/vps/compose.yml images --format json "$service"
    ;;
  *) echo "Usage: list-price-ops.sh audit | config [app|catalog-sync]" >&2; exit 1 ;;
esac
