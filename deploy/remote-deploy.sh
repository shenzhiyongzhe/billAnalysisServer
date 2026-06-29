#!/usr/bin/env bash
# 在部署机 DEPLOY_PATH 下执行：pull → prisma migrate deploy → compose up
# 用法：export DOCKER_IMAGE=ghcr.io/.../bill-analysis-server:<sha>
#       bash deploy/remote-deploy.sh
#
# 可选环境变量：
#   DOCKER_NETWORK  PostgreSQL 所在的 Docker 网络名（如 uniapp-network）
#                   PostgreSQL 在宿主机时留空，脚本自动用 --network host
#                   PostgreSQL 在 Docker 容器时设置此变量，避免 compose run 网络问题
set -exo pipefail

COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.prod.yml}"
COMPOSE_UP_FILE="${COMPOSE_UP_FILE:-docker-compose.prod.yml}"

: "${DOCKER_IMAGE:?Set DOCKER_IMAGE to ghcr.io/.../bill-analysis-server:tag}"
: "${PYTHON_DOCKER_IMAGE:?Set PYTHON_DOCKER_IMAGE to ghcr.io/.../pdf-parser:tag}"

# ── 诊断：打印关键环境变量 ──────────────────────────────────────────────
echo "=== [DIAG] ENV CHECK ===" >&2
echo "  DOCKER_IMAGE=${DOCKER_IMAGE}" >&2
echo "  PYTHON_DOCKER_IMAGE=${PYTHON_DOCKER_IMAGE}" >&2
echo "  COMPOSE_FILE=${COMPOSE_FILE}" >&2
echo "  DOCKER_NETWORK=[${DOCKER_NETWORK:-}]  (empty=宿主机PG或未传入)" >&2
echo "  DOCKER_NETWORK length=$(printf '%s' "${DOCKER_NETWORK:-}" | wc -c)" >&2
echo "  PWD=$(pwd)" >&2
echo "  USER=$(whoami)" >&2
# ──────────────────────────────────────────────────────────────────────────

echo "=== [1/4] pull ===" >&2
docker compose -f "${COMPOSE_FILE}" pull

echo "=== [2/4] prisma migrate deploy ===" >&2
DATABASE_URL_VAL="$(
  grep -E '^DATABASE_URL=' .env | head -1 | cut -d= -f2- | tr -d '\r' \
    | sed -e 's/^["'\'']//' -e 's/["'\'']$//'
)"

# ── 诊断：DATABASE_URL 主机部分（隐藏密码）──────────────────────────────
DB_HOST_PART="$(printf '%s' "$DATABASE_URL_VAL" | sed 's|.*@||' | cut -d/ -f1)"
echo "  DATABASE_URL host:port=[${DB_HOST_PART}]" >&2
# ──────────────────────────────────────────────────────────────────────────

run_prisma_migrate() {
  local db_url="$1"
  echo "  → branch: --network host (宿主机 PostgreSQL)" >&2
  docker run --rm --network host \
    -e "DATABASE_URL=${db_url}" \
    "${DOCKER_IMAGE}" \
    npx prisma migrate deploy
}

run_prisma_migrate_docker_network() {
  local db_url="$1"
  local network="$2"
  echo "  → branch: --network ${network} (Docker 容器 PostgreSQL)" >&2
  docker run --rm --network "${network}" \
    -e "DATABASE_URL=${db_url}" \
    "${DOCKER_IMAGE}" \
    npx prisma migrate deploy
}

normalize_host_pg_url() {
  printf '%s' "$1" \
    | sed -e 's/@localhost:/@127.0.0.1:/' -e 's/@host\.docker\.internal:/@127.0.0.1:/'
}

uses_host_postgresql() {
  printf '%s' "$1" | grep -qE '@(localhost|127\.0\.0\.1|host\.docker\.internal):'
}

# ── 诊断：判断分支 ────────────────────────────────────────────────────────
echo "  uses_host_postgresql check..." >&2
if uses_host_postgresql "$DATABASE_URL_VAL"; then
  echo "  [DIAG] → matched host PG pattern (localhost/127.0.0.1/host.docker.internal)" >&2
  MIGRATE_DATABASE_URL="$(normalize_host_pg_url "$DATABASE_URL_VAL")"
  echo "migrate: docker run --network host (DATABASE_URL → 127.0.0.1 on deploy host)" >&2
  run_prisma_migrate "${MIGRATE_DATABASE_URL}"
elif [ -n "${DOCKER_NETWORK:-}" ]; then
  echo "  [DIAG] → DOCKER_NETWORK is set: [${DOCKER_NETWORK}], using docker network" >&2
  run_prisma_migrate_docker_network "${DATABASE_URL_VAL}" "${DOCKER_NETWORK}"
else
  echo "  [DIAG] → DOCKER_NETWORK is EMPTY and not host PG → fallback: docker compose run" >&2
  echo "  [DIAG]   若 PostgreSQL 在 Docker 容器，请设置 DOCKER_NETWORK 环境变量再重跑" >&2
  docker compose -f "${COMPOSE_FILE}" run -T --rm app npx prisma migrate deploy
fi
# ──────────────────────────────────────────────────────────────────────────

if printf '%s' "$DATABASE_URL_VAL" | grep -q '@localhost:' \
  && [ "${COMPOSE_UP_FILE}" = "docker-compose.prod.yml" ]; then
  echo "WARN: .env uses localhost; running API in bridge mode cannot reach host PostgreSQL." >&2
  echo "      Use host.docker.internal in DATABASE_URL, or COMPOSE_UP_FILE=docker-compose.prod.hostnetwork.yml" >&2
fi

echo "=== [3/4] compose up -d ===" >&2
docker compose -f "${COMPOSE_UP_FILE}" up -d --remove-orphans

echo "=== [4/4] cleanup old images ===" >&2
docker image prune -f || true

IMAGE_REPO="${DOCKER_IMAGE%:*}"
if [ -n "$IMAGE_REPO" ]; then
  OLD_IMAGES=$(docker images --format '{{.Repository}}:{{.Tag}}' | grep -E "^${IMAGE_REPO}:" | grep -vFx "${DOCKER_IMAGE}" || true)
  if [ -n "$OLD_IMAGES" ]; then
    echo "Removing old images:" >&2
    echo "$OLD_IMAGES" >&2
    docker rmi $OLD_IMAGES || true
  else
    echo "No old tags to remove." >&2
  fi
fi

echo "=== deploy OK ===" >&2
