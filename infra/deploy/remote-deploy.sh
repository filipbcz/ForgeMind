#!/usr/bin/env bash
set -euo pipefail

APP_ROOT="${APP_ROOT:-/opt/forgemind}"
APP_DIR="${APP_ROOT}/app"
ENV_FILE="${APP_ROOT}/shared/server.env"
COMPOSE_FILE="${APP_DIR}/infra/docker-compose.prod.yml"
COMPOSE_OVERRIDE="${FORGEMIND_COMPOSE_OVERRIDE:-}"

: "${FORGEMIND_RUNTIME_IMAGE:?FORGEMIND_RUNTIME_IMAGE is required}"
: "${FORGEMIND_RUNTIME_BASE_IMAGE:?FORGEMIND_RUNTIME_BASE_IMAGE is required}"
: "${FORGEMIND_WEB_IMAGE:?FORGEMIND_WEB_IMAGE is required}"

if [ ! -s "${ENV_FILE}" ]; then
  echo "Missing or empty environment file: ${ENV_FILE}" >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is not installed on the target host." >&2
  exit 1
fi

cd "${APP_DIR}"

export FORGEMIND_ENV_FILE="${ENV_FILE}"
compose_files=(-f "${COMPOSE_FILE}")
if [ -n "${COMPOSE_OVERRIDE}" ]; then
  if [ ! -f "${COMPOSE_OVERRIDE}" ]; then
    echo "Missing Compose override: ${COMPOSE_OVERRIDE}" >&2
    exit 1
  fi
  compose_files+=(-f "${COMPOSE_OVERRIDE}")
fi
compose=(docker compose --env-file "${ENV_FILE}" "${compose_files[@]}")

docker network inspect shared-edge >/dev/null 2>&1 || docker network create shared-edge >/dev/null

"${compose[@]}" up -d postgres

echo "Docker storage before deployment:"
docker system df

echo "Reclaiming unused Docker build cache and images older than 24 hours before pulling the release."
docker builder prune --all --force
docker image prune --all --force --filter "until=24h"

echo "Docker storage after pre-deployment cleanup:"
docker system df

if docker image inspect "${FORGEMIND_RUNTIME_BASE_IMAGE}" >/dev/null 2>&1; then
  echo "Runtime base cache hit: ${FORGEMIND_RUNTIME_BASE_IMAGE}"
else
  echo "Runtime base cache miss; downloading ${FORGEMIND_RUNTIME_BASE_IMAGE}"
  docker pull "${FORGEMIND_RUNTIME_BASE_IMAGE}"
fi

docker pull "${FORGEMIND_RUNTIME_IMAGE}"
docker pull "${FORGEMIND_WEB_IMAGE}"

WORKER_CONTAINER="$("${compose[@]}" ps -q worker)"
if [ -n "${WORKER_CONTAINER}" ]; then
  WORKER_DRAIN_TIMEOUT_SECONDS="${FORGEMIND_WORKER_DRAIN_TIMEOUT_SECONDS:-5400}"
  echo "Draining worker before migrations and replacement (timeout: ${WORKER_DRAIN_TIMEOUT_SECONDS}s)."
  "${compose[@]}" stop --timeout "${WORKER_DRAIN_TIMEOUT_SECONDS}" worker
fi

MIGRATION_STATE_FILE="${APP_ROOT}/shared/migrations.sha256"
MIGRATIONS_DIR="${APP_DIR}/packages/db/prisma/migrations"
MIGRATIONS_CHECKSUM="$(
  find "${MIGRATIONS_DIR}" -type f -print0 \
    | LC_ALL=C sort -z \
    | xargs -0 -r sha256sum \
    | sha256sum \
    | cut -d ' ' -f 1
)"
APPLIED_MIGRATIONS_CHECKSUM="$(cat "${MIGRATION_STATE_FILE}" 2>/dev/null || true)"
EXPECTED_MIGRATIONS="$(
  find "${MIGRATIONS_DIR}" -mindepth 2 -maxdepth 2 -type f -name migration.sql \
    -printf '%h\n' \
    | sed 's#.*/##' \
    | LC_ALL=C sort
)"
DATABASE_MIGRATIONS="$(
  "${compose[@]}" exec -T postgres sh -c \
    'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "SELECT migration_name FROM \"_prisma_migrations\" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name"' \
    2>/dev/null || true
)"

if [ "${MIGRATIONS_CHECKSUM}" != "${APPLIED_MIGRATIONS_CHECKSUM}" ] \
  || [ "${DATABASE_MIGRATIONS}" != "${EXPECTED_MIGRATIONS}" ]; then
  echo "Migration files or database migration state changed; applying database migrations."
  "${compose[@]}" run --rm migrate
  printf '%s\n' "${MIGRATIONS_CHECKSUM}" > "${MIGRATION_STATE_FILE}"
else
  echo "Migration checksum unchanged; skipping database migrations."
fi

"${compose[@]}" up -d --remove-orphans api codex-oauth-relay worker web

API_CONTAINER="$("${compose[@]}" ps -q api)"
OAUTH_RELAY_CONTAINER="$("${compose[@]}" ps -q codex-oauth-relay)"

if [ -z "${API_CONTAINER}" ]; then
  echo "Studio API container was not created." >&2
  exit 1
fi

if [ -z "${OAUTH_RELAY_CONTAINER}" ]; then
  echo "Codex OAuth relay container was not created." >&2
  exit 1
fi

for attempt in $(seq 1 60); do
  STATUS="$(docker inspect --format='{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "${API_CONTAINER}")"
  OAUTH_RELAY_STATUS="$(docker inspect --format='{{.State.Status}}' "${OAUTH_RELAY_CONTAINER}")"
  if [ "${STATUS}" = "healthy" ] && [ "${OAUTH_RELAY_STATUS}" = "running" ]; then
    echo "Deployment finished successfully."
    "${compose[@]}" ps
    echo "Docker storage after deployment:"
    docker system df
    exit 0
  fi

  sleep 2
done

echo "Studio API or Codex OAuth relay did not become ready in time." >&2
"${compose[@]}" logs --tail=200 api codex-oauth-relay worker
exit 1
