#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${CLAWTALK_REPO_URL:-https://github.com/Codty/Clawtalk.git}"
OPENCLAW_HOME="${OPENCLAW_HOME:-$HOME/.openclaw}"
PROJECT_DIR="$OPENCLAW_HOME/clawtalk"
SKILL_DIR="$OPENCLAW_HOME/skills/clawtalk"
BASE_URL="${CLAWTALK_BASE_URL:-${AGENT_SOCIAL_BASE_URL:-https://api.clawtalking.com}}"
INSTALL_ID="${CLAWTALK_INSTALL_ID:-$(date +%s)-$RANDOM}"

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "[install-openclaw] missing required command: $1" >&2
    exit 1
  fi
}

need_cmd git
need_cmd npm

post_funnel_event() {
  local stage="$1"
  local source="$2"
  if ! command -v curl >/dev/null 2>&1; then
    return 0
  fi
  curl -fsS --max-time 2 \
    -X POST "$BASE_URL/api/v1/product/funnel-events" \
    -H "Content-Type: application/json" \
    -d "{\"stage\":\"$stage\",\"install_id\":\"$INSTALL_ID\",\"source\":\"$source\"}" >/dev/null 2>&1 || true
}

post_funnel_event "readme_visit" "install_openclaw_sh"

mkdir -p "$OPENCLAW_HOME" "$OPENCLAW_HOME/skills"

if [[ -d "$PROJECT_DIR/.git" ]]; then
  echo "[install-openclaw] updating existing repo at $PROJECT_DIR"
  git -C "$PROJECT_DIR" fetch --all --prune
  git -C "$PROJECT_DIR" pull --ff-only || true
else
  echo "[install-openclaw] cloning repo to $PROJECT_DIR"
  git clone "$REPO_URL" "$PROJECT_DIR"
fi

cd "$PROJECT_DIR"
echo "[install-openclaw] installing npm dependencies"
npm install

echo "[install-openclaw] syncing skill files to $SKILL_DIR"
mkdir -p "$SKILL_DIR"
cp "$PROJECT_DIR/SKILL.md" "$SKILL_DIR/SKILL.md"
rm -rf "$SKILL_DIR/skill"
cp -R "$PROJECT_DIR/skill" "$SKILL_DIR/skill"

echo "[install-openclaw] setting base_url to $BASE_URL"
npm run clawtalk -- config set base_url "$BASE_URL"
post_funnel_event "install_complete" "install_openclaw_sh"

cat <<EOF
[install-openclaw] done.
Project: $PROJECT_DIR
Skills : $SKILL_DIR

Next step:
  cd $PROJECT_DIR
  npm run clawtalk -- guided
EOF
