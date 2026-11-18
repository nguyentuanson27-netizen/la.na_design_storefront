#!/usr/bin/env bash
# Runtime check of the apex handling in the real Caddyfile, using the production pair of values.
# Requires Docker. Inputs (from project.config.json via CI, never hardcoded here):
#   APP_DOMAIN             canonical host (e.g. the production domain)
#   APEX_REDIRECT_DOMAIN   its bare apex
# The upstream app is intentionally absent: redirects and the 409 never reach it, and a canonical-host
# request is expected to be proxied (and fail with 5xx), which proves it was NOT redirected.
set -euo pipefail

: "${APP_DOMAIN:?set APP_DOMAIN}"
: "${APEX_REDIRECT_DOMAIN:?set APEX_REDIRECT_DOMAIN}"
CADDYFILE="${CADDYFILE:-deploy/vps/Caddyfile}"
PORT="${PORT:-18080}"
NAME="caddy-apex-smoke-$$"

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker run -d --name "$NAME" -p "127.0.0.1:$PORT:80" \
  -e APP_DOMAIN -e APEX_REDIRECT_DOMAIN -e EDGE_TRUSTED_PROXY_CIDR=127.0.0.1/32 \
  -v "$PWD/$CADDYFILE:/etc/caddy/Caddyfile:ro" caddy:2-alpine >/dev/null

for _ in $(seq 1 30); do
  curl -s -o /dev/null "http://127.0.0.1:$PORT/" -H "Host: $APP_DOMAIN" && break
  sleep 1
done

fail=0
check() { # description, expected, actual
  if [[ "$2" == "$3" ]]; then echo "ok   - $1"; else echo "FAIL - $1: expected '$2', got '$3'"; fail=1; fi
}
req() { curl -s -o /dev/null -D - --max-time 10 "$@"; }
status() { req "$@" | head -1 | awk '{print $2}'; }
location() { req "$@" | awk 'tolower($1)=="location:" {sub(/\r$/,"",$2); print $2}'; }
base="http://127.0.0.1:$PORT"

check "apex GET -> 308" 308 "$(status "$base/shop?x=1" -H "Host: $APEX_REDIRECT_DOMAIN")"
check "apex GET Location keeps path and query" "https://$APP_DOMAIN/shop?x=1" \
  "$(location "$base/shop?x=1" -H "Host: $APEX_REDIRECT_DOMAIN")"
check "apex HEAD -> 308" 308 "$(status -I "$base/shop" -H "Host: $APEX_REDIRECT_DOMAIN")"
check "apex POST fails closed with 409" 409 "$(status -X POST "$base/shop" -H "Host: $APEX_REDIRECT_DOMAIN")"
check "apex POST has no Location" "" "$(location -X POST "$base/shop" -H "Host: $APEX_REDIRECT_DOMAIN")"

canonical="$(status "$base/shop" -H "Host: $APP_DOMAIN")"
check "canonical GET is not redirected" "no" "$([[ "$canonical" == 308 || "$canonical" == 409 ]] && echo yes || echo no)"
check "canonical GET has no Location" "" "$(location "$base/shop" -H "Host: $APP_DOMAIN")"
check "canonical Host + apex X-Forwarded-Host does not loop" "" \
  "$(location "$base/shop" -H "Host: $APP_DOMAIN" -H "X-Forwarded-Host: $APEX_REDIRECT_DOMAIN")"
check "apex Host + canonical X-Forwarded-Host still redirects" 308 \
  "$(status "$base/shop" -H "Host: $APEX_REDIRECT_DOMAIN" -H "X-Forwarded-Host: $APP_DOMAIN")"

exit "$fail"
