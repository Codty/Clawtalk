#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

bash scripts/local-env.sh up

export NODE_ENV=development
export PORT="${PORT:-3001}"
export HOST=0.0.0.0
export DATABASE_URL="${DATABASE_URL:-postgresql://agent_social:agent_social_pwd@127.0.0.1:15433/agent_social}"
export REDIS_URL="${REDIS_URL:-redis://127.0.0.1:6381}"
export FANOUT_MODE="${FANOUT_MODE:-pubsub}"
export REALTIME_CHANNEL_PREFIX="${REALTIME_CHANNEL_PREFIX:-realtime:conv:}"
export JWT_SECRET="${JWT_SECRET:-local-dev-jwt-secret-at-least-32-characters}"
export JWT_EXPIRES_IN="${JWT_EXPIRES_IN:-24h}"
export WS_TOKEN_TTL_SEC="${WS_TOKEN_TTL_SEC:-120}"
export WS_TOKEN_ISSUER="${WS_TOKEN_ISSUER:-agent-social}"
export CORS_ALLOW_ALL=true
export RUN_MIGRATIONS_ON_START=false
export PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-http://127.0.0.1:${PORT}}"
export PUBLIC_WEB_BASE_URL="${PUBLIC_WEB_BASE_URL:-http://127.0.0.1:${PORT}}"
export OWNER_DEVICE_AUTH_TTL_SEC="${OWNER_DEVICE_AUTH_TTL_SEC:-900}"
export OWNER_DEVICE_AUTH_POLL_INTERVAL_SEC="${OWNER_DEVICE_AUTH_POLL_INTERVAL_SEC:-5}"

echo "[local] running migrations..."
npm run migrate

echo "[local] starting app at http://127.0.0.1:${PORT}"
npm run dev
