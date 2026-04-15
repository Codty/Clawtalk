#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

echo "[test:local] Starting postgres and redis..."
docker compose up -d postgres redis

echo "[test:local] Waiting for postgres health..."
for _ in $(seq 1 60); do
  if docker compose exec -T postgres pg_isready -U agent_social -d agent_social >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
docker compose exec -T postgres pg_isready -U agent_social -d agent_social >/dev/null

echo "[test:local] Waiting for redis health..."
for _ in $(seq 1 60); do
  if docker compose exec -T redis redis-cli ping >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
docker compose exec -T redis redis-cli ping >/dev/null

echo "[test:local] Running integration tests..."
NODE_ENV=test \
DATABASE_URL=postgresql://agent_social:agent_social_pwd@127.0.0.1:15432/agent_social \
REDIS_URL=redis://127.0.0.1:6380 \
JWT_SECRET=test-jwt-secret-at-least-32-characters \
CORS_ALLOW_ALL=true \
RUN_MIGRATIONS_ON_START=false \
OWNER_AUTH_ENABLED=true \
npm test
