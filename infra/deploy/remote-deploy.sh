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

deployment_succeeded=false
cleanup_failed_deployment() {
  if [ "${deployment_succeeded}" = "true" ]; then
    return
  fi

  echo "Deployment did not complete; reclaiming images that are not referenced by containers."
  docker image prune --all --force || true
}
trap cleanup_failed_deployment EXIT

cleanup_completed_workspaces() {
  local runtime_container runtime_image completed_task_ids
  runtime_container="$("${compose[@]}" ps -q worker)"
  if [ -z "${runtime_container}" ]; then
    runtime_container="$("${compose[@]}" ps -q api)"
  fi
  if [ -z "${runtime_container}" ]; then
    echo "No existing runtime container is available; skipping completed workspace cleanup."
    return
  fi

  runtime_image="$(docker inspect --format='{{.Config.Image}}' "${runtime_container}")"
  completed_task_ids="$(
    "${compose[@]}" exec -T postgres sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At' <<'SQL'
SELECT id
FROM tasks
WHERE status = 'completed'
  AND finished_at < CURRENT_TIMESTAMP - INTERVAL '1 hour'
ORDER BY finished_at;
SQL
  )"
  if [ -z "${completed_task_ids}" ]; then
    echo "No completed task workspaces are old enough to remove."
    return
  fi

  printf '%s\n' "${completed_task_ids}" \
    | docker run --rm -i --entrypoint sh \
        -v forgemind_worker_workspaces:/workspaces \
        "${runtime_image}" -lc '
          set -eu
          removed_count=0
          removed_kilobytes=0
          while IFS= read -r task_id; do
            [ -n "$task_id" ] || continue
            if ! printf "%s" "$task_id" | grep -Eq "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"; then
              echo "Refusing invalid workspace task id: $task_id" >&2
              exit 1
            fi
            target="/workspaces/$task_id"
            resolved="$(realpath -m "$target")"
            if [ "$resolved" != "$target" ]; then
              echo "Refusing unexpected workspace path: $resolved" >&2
              exit 1
            fi
            if [ -d "$resolved" ]; then
              size_kilobytes="$(du -sk "$resolved" | cut -f1)"
              rm -rf -- "$resolved"
              removed_count=$((removed_count + 1))
              removed_kilobytes=$((removed_kilobytes + size_kilobytes))
            fi
          done
          printf "Removed %s completed workspaces (%s KiB).\n" "$removed_count" "$removed_kilobytes"
        '
}

assert_deploy_free_space() {
  local available_kilobytes minimum_megabytes minimum_kilobytes
  minimum_megabytes="${FORGEMIND_DEPLOY_MIN_FREE_MB:-6144}"
  available_kilobytes="$(df -Pk "${APP_ROOT}" | awk 'NR == 2 { print $4 }')"
  minimum_kilobytes="$((minimum_megabytes * 1024))"
  if [ "${available_kilobytes}" -lt "${minimum_kilobytes}" ]; then
    echo "Deployment requires at least ${minimum_megabytes} MB free before pulling release images; only $((available_kilobytes / 1024)) MB is available." >&2
    exit 1
  fi
}

docker network inspect shared-edge >/dev/null 2>&1 || docker network create shared-edge >/dev/null

echo "Docker storage before deployment:"
docker system df

echo "Reclaiming unused Docker build cache and images before starting the deployment."
docker builder prune --all --force
docker image prune --all --force

"${compose[@]}" up -d --wait postgres
cleanup_completed_workspaces

echo "Docker storage after pre-deployment cleanup:"
docker system df
assert_deploy_free_space

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
    echo "Reclaiming release images that became unused after container replacement."
    docker image prune --all --force || true
    echo "Docker storage after deployment:"
    docker system df
    deployment_succeeded=true
    exit 0
  fi

  sleep 2
done

echo "Studio API or Codex OAuth relay did not become ready in time." >&2
"${compose[@]}" logs --tail=200 api codex-oauth-relay worker
exit 1
