#!/usr/bin/env bash
# setup.sh — full setup for kiro-flock (cluster + MCP)
#
# Usage:
#   ./setup.sh                                  # reads from install.config
#   ./setup.sh --region eu-central-1 --profile my-profile --username my-user

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG_FILE="$SCRIPT_DIR/install.config"
CLUSTER_DIR="$SCRIPT_DIR/kiro-flock-cluster"
MCP_DIR="$SCRIPT_DIR/kiro-flock-mcp"

# ── Parse CLI flags (override config file) ────────────────────────────────────
CLI_REGION=""
CLI_PROFILE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --region)   CLI_REGION="$2";   shift 2 ;;
    --profile)  CLI_PROFILE="$2";  shift 2 ;;
    -h|--help)
      echo "Usage: ./setup.sh [--region REGION] [--profile PROFILE]"
      echo ""
      echo "Flags override values from install.config. If no flags are given,"
      echo "all values are read from install.config."
      exit 0
      ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

# ── Load config file (if it exists) ──────────────────────────────────────────
if [[ -f "$CONFIG_FILE" ]]; then
  source "$CONFIG_FILE"
fi

# ── Apply CLI overrides ──────────────────────────────────────────────────────
[[ -n "$CLI_REGION" ]]   && REGION="$CLI_REGION"
[[ -n "$CLI_PROFILE" ]]  && PROFILE="$CLI_PROFILE"

# ── Validate required values ─────────────────────────────────────────────────
if [[ -z "${REGION:-}" || -z "${PROFILE:-}" ]]; then
  echo "ERROR: REGION and PROFILE must be set."
  echo ""
  echo "Either create install.config (cp install.config.template install.config)"
  echo "or pass both as flags: --region, --profile"
  exit 1
fi

# ── Colours ───────────────────────────────────────────────────────────────────
B=$'\033[1m'
G=$'\033[32m'
C=$'\033[36m'
N=$'\033[0m'

step() { echo ""; echo "${B}${C}━━━━  $*  ━━━━${N}"; echo ""; }
ok()   { echo "${G}✓${N} $*"; }

# ── Header ────────────────────────────────────────────────────────────────────
echo ""
echo "${B}${C}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${N}"
echo "${B}  kiro-flock full setup${N}"
echo "  Region : $REGION"
echo "  Profile: $PROFILE"
echo "${B}${C}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${N}"

# ── Step 1: Deploy kiro-flock-cluster ─────────────────────────────────────────
step "Step 1: Deploy kiro-flock CDK stack"

AWS_REGION=$REGION AWS_PROFILE=$PROFILE bash "$CLUSTER_DIR/scripts/install.sh"
ok "kiro-flock-cluster deployed"

# ── Step 2: Build the MCP server ─────────────────────────────────────────────
step "Step 2: Build kiro-flock-mcp"

npm install --prefix "$MCP_DIR" --silent
npm run build --prefix "$MCP_DIR"
ok "MCP server built"

# ── Step 3: Configure the MCP server ─────────────────────────────────────────
step "Step 3: Configure kiro-flock-mcp"

bash "$MCP_DIR/scripts/get-mcp-env.sh" \
  --region "$REGION" \
  --profile "$PROFILE"

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo "${B}${C}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${N}"
echo "${B}${G}  Setup complete.${N}"
echo "  Reconnect the kiro-flock-feed MCP server in Kiro to activate it."
echo "${B}${C}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${N}"
echo ""
