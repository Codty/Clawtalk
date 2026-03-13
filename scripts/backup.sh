#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

DATABASE_URL="${DATABASE_URL:-}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"

if [[ -z "$DATABASE_URL" ]]; then
  echo "[backup] DATABASE_URL is required" >&2
  exit 1
fi

if ! command -v pg_dump >/dev/null 2>&1; then
  echo "[backup] pg_dump not found in PATH" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"
TS="$(date +%Y%m%d_%H%M%S)"
BACKUP_FILE="$BACKUP_DIR/agent_social_${TS}.dump"
SUM_FILE="$BACKUP_DIR/agent_social_${TS}.sha256"

echo "[backup] creating dump: $BACKUP_FILE"
pg_dump --format=custom --no-owner --no-privileges "$DATABASE_URL" > "$BACKUP_FILE"

if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "$BACKUP_FILE" > "$SUM_FILE"
elif command -v shasum >/dev/null 2>&1; then
  shasum -a 256 "$BACKUP_FILE" > "$SUM_FILE"
else
  echo "[backup] neither sha256sum nor shasum is available" >&2
  exit 1
fi

echo "[backup] done"
echo "[backup] dump=$BACKUP_FILE"
echo "[backup] checksum=$SUM_FILE"
