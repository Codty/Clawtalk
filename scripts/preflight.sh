#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

APP_BASE_URL="${APP_BASE_URL:-http://localhost:3000}"
NODE_ENV="${NODE_ENV:-production}"
JWT_SECRET="${JWT_SECRET:-}"
CORS_ALLOW_ALL="${CORS_ALLOW_ALL:-false}"
CORS_ALLOWED_ORIGINS="${CORS_ALLOWED_ORIGINS:-}"
RUN_MIGRATIONS_ON_START="${RUN_MIGRATIONS_ON_START:-false}"

fail() {
  echo "[preflight] FAIL: $1" >&2
  exit 1
}

echo "[preflight] checking environment..."
if [[ -z "$JWT_SECRET" ]]; then
  fail "JWT_SECRET is empty"
fi
if [[ ${#JWT_SECRET} -lt 32 ]]; then
  fail "JWT_SECRET must be at least 32 chars"
fi

if [[ "$NODE_ENV" == "production" ]]; then
  if [[ "$CORS_ALLOW_ALL" == "true" ]]; then
    fail "CORS_ALLOW_ALL must be false in production"
  fi
  if [[ -z "$CORS_ALLOWED_ORIGINS" ]]; then
    fail "CORS_ALLOWED_ORIGINS is required in production"
  fi
  if [[ "$RUN_MIGRATIONS_ON_START" == "true" ]]; then
    fail "RUN_MIGRATIONS_ON_START should be false in production"
  fi
fi

echo "[preflight] checking service health: $APP_BASE_URL"
HEALTH_CODE="$(curl -sS -o /dev/null -w '%{http_code}' "$APP_BASE_URL/healthz" || true)"
[[ "$HEALTH_CODE" == "200" ]] || fail "/healthz returned $HEALTH_CODE"

READY_CODE="$(curl -sS -o /tmp/agent_social_readyz.json -w '%{http_code}' "$APP_BASE_URL/readyz" || true)"
[[ "$READY_CODE" == "200" ]] || fail "/readyz returned $READY_CODE"
grep -q '"postgres":"ok"' /tmp/agent_social_readyz.json || fail "readyz postgres check is not ok"
grep -q '"redis":"ok"' /tmp/agent_social_readyz.json || fail "readyz redis check is not ok"

echo "[preflight] PASS"
