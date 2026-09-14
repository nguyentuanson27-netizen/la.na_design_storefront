#!/usr/bin/env bash
# Loads non-secret project identity from the committed project.config.json and exports the
# variables Compose needs. Sourced by deploy.sh and rollback.sh; not executable on its own.
#
# `jq -e` exits non-zero when a key is missing or null, and the assignments run under the caller's
# `set -e`, so a broken config stops the deployment instead of producing empty container, image and
# database names.

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required to read project.config.json" >&2
  exit 1
fi

PROJECT_CONFIG_FILE="${PROJECT_CONFIG_FILE:-project.config.json}"
if [[ ! -f "$PROJECT_CONFIG_FILE" ]]; then
  echo "Missing $PROJECT_CONFIG_FILE" >&2
  exit 1
fi

PROJECT_SLUG="$(jq -er '.projectSlug' "$PROJECT_CONFIG_FILE")"
POSTGRES_DB="$(jq -er '.databaseName' "$PROJECT_CONFIG_FILE")"
COMPOSE_PROJECT_NAME="$(jq -er '.composeProjectName' "$PROJECT_CONFIG_FILE")"
APP_DOMAIN="$(jq -er '.productionDomain' "$PROJECT_CONFIG_FILE")"
# Production always terminates TLS at the edge, so the storefront origin is the domain over HTTPS.
# release:check re-asserts that this matches APP_DOMAIN before anything touches the database.
BETTER_AUTH_URL="https://$APP_DOMAIN"

export PROJECT_SLUG POSTGRES_DB COMPOSE_PROJECT_NAME APP_DOMAIN BETTER_AUTH_URL
