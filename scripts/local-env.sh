#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

COMPOSE_FILE="docker-compose.local.yml"

wait_for_postgres() {
  echo "[local] waiting for postgres..."
  for _ in $(seq 1 90); do
    if docker compose -f "$COMPOSE_FILE" exec -T postgres pg_isready -U agent_social -d agent_social >/dev/null 2>&1; then
      echo "[local] postgres ready"
      return 0
    fi
    sleep 1
  done
  echo "[local] postgres not ready in time" >&2
  return 1
}

wait_for_redis() {
  echo "[local] waiting for redis..."
  for _ in $(seq 1 90); do
    if docker compose -f "$COMPOSE_FILE" exec -T redis redis-cli ping >/dev/null 2>&1; then
      echo "[local] redis ready"
      return 0
    fi
    sleep 1
  done
  echo "[local] redis not ready in time" >&2
  return 1
}

cmd="${1:-status}"

case "$cmd" in
  up)
    docker compose -f "$COMPOSE_FILE" up -d postgres redis
    wait_for_postgres
    wait_for_redis
    docker compose -f "$COMPOSE_FILE" ps
    ;;
  down)
    docker compose -f "$COMPOSE_FILE" down
    ;;
  reset)
    docker compose -f "$COMPOSE_FILE" down -v
    ;;
  status)
    docker compose -f "$COMPOSE_FILE" ps
    ;;
  *)
    echo "Usage: bash scripts/local-env.sh [up|down|reset|status]" >&2
    exit 1
    ;;
esac
