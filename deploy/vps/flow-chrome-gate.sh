#!/usr/bin/env bash
# Binds the Flow worker's browser to the version that CI verified and an operator smoke-tested.
#
# Google's apt repository serves only the current stable Chrome, so the worker image built on the VPS
# can differ from the one CI tested. deploy.sh therefore refuses to continue unless the built image
# reports exactly the version recorded as LA_FLOW_WORKER_CHROME_VERSION in the deploy env file.
# Sourced by deploy.sh; no side effects on load.

# A recorded version is four dot-separated numbers, e.g. 155.0.8059.39 (never a range or a major only).
flow_chrome_version_is_valid() {
  [[ "${1:-}" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]
}

# $1 = output of `chrome --version`, $2 = approved version. Exact match on the whole version.
flow_chrome_matches() {
  local reported="${1:-}" approved="${2:-}"
  flow_chrome_version_is_valid "$approved" || return 1
  [[ "$reported" == "Google Chrome $approved" || "$reported" == "Google Chrome $approved "* ]]
}
