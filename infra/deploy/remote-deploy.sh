#!/usr/bin/env bash
set -euo pipefail

APP_ROOT="${APP_ROOT:-/opt/forgemind}"
APP_DIR="${APP_ROOT}/app"
ENV_FILE="${APP_ROOT}/shared/server.env"
COMPOSE_FILE="${APP_DIR}/infra/docker-compose.prod.yml"

: "${FORGEMIND_RUNTIME_IMAGE:?FORGEMIND_RUNTIME_IMAGE is required}"
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

compose=(docker compose --env-file "${ENV_FILE}" -f "${COMPOSE_FILE}")

docker network inspect shared-edge >/dev/null 2>&1 || docker network create shared-edge >/dev/null

"${compose[@]}" up -d postgres
docker pull "${FORGEMIND_RUNTIME_IMAGE}"
docker pull "${FORGEMIND_WEB_IMAGE}"
"${compose[@]}" run --rm migrate
"${compose[@]}" up -d --remove-orphans api worker web

API_CONTAINER="$("${compose[@]}" ps -q api)"

if [ -z "${API_CONTAINER}" ]; then
  echo "Studio API container was not created." >&2
  exit 1
fi

for attempt in $(seq 1 60); do
  STATUS="$(docker inspect --format='{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "${API_CONTAINER}")"
  if [ "${STATUS}" = "healthy" ]; then
    echo "Deployment finished successfully."
    "${compose[@]}" ps
    exit 0
  fi

  sleep 2
done

echo "Studio API did not become healthy in time." >&2
"${compose[@]}" logs --tail=200 api worker
exit 1
