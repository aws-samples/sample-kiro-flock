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
CLI_USERNAME=""
KEEP=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --region)   CLI_REGION="$2";   shift 2 ;;
    --profile)  CLI_PROFILE="$2";  shift 2 ;;
    --username) CLI_USERNAME="$2"; shift 2 ;;
    --keep)     KEEP=true;         shift ;;
    -h|--help)
      echo "Usage: ./setup.sh [--region REGION] [--profile PROFILE] [--username USERNAME] [--keep]"
      echo ""
      echo "Flags override values from install.config. If no flags are given,"
      echo "all values are read from install.config."
      echo ""
      echo "  --keep    Deploy CDK only, skip MCP rebuild and reconfig."
      echo "            Use when you only changed cluster code (Lambda, web, agent)"
      echo "            and don't need to rebuild the local MCP server."
      exit 0
      ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

# ── Load config file (if it exists) ──────────────────────────────────────────
if [[ -f "$CONFIG_FILE" ]]; then
  # shellcheck disable=SC1090  # install.config is written by the operator; its path is only known at run time
  source "$CONFIG_FILE"
fi

# ── Apply CLI overrides ──────────────────────────────────────────────────────
[[ -n "$CLI_REGION" ]]   && REGION="$CLI_REGION"
[[ -n "$CLI_PROFILE" ]]  && PROFILE="$CLI_PROFILE"
[[ -n "$CLI_USERNAME" ]] && USERNAME="$CLI_USERNAME"

# ── Validate required values ─────────────────────────────────────────────────
if [[ -z "${REGION:-}" || -z "${PROFILE:-}" || -z "${USERNAME:-}" ]]; then
  echo "ERROR: REGION, PROFILE, and USERNAME must be set."
  echo ""
  echo "Either create install.config (cp install.config.template install.config)"
  echo "or pass all three as flags: --region, --profile, --username"
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

if [[ "$KEEP" == true ]]; then
  AWS_REGION=$REGION AWS_PROFILE=$PROFILE bash "$CLUSTER_DIR/scripts/install.sh" --keep
else
  AWS_REGION=$REGION AWS_PROFILE=$PROFILE bash "$CLUSTER_DIR/scripts/install.sh"
fi
ok "kiro-flock-cluster deployed"

# ── Step 2: Build the MCP server ─────────────────────────────────────────────
if [[ "$KEEP" == true ]]; then
  ok "Skipping MCP build (--keep)"
else
  step "Step 2: Build kiro-flock-mcp"

  # NOTE (Windows/Git Bash): `npm --prefix "$MCP_DIR"` mangles the path on
  # Windows (prepends a stray drive segment, e.g. C:\c\work\...), producing an
  # ENOENT for package.json. Use a cd subshell instead, which is portable.
  ( cd "$MCP_DIR" && npm install )
  ( cd "$MCP_DIR" && npm run build )
  ok "MCP server built"
fi

# ── Step 3: Configure the MCP server ─────────────────────────────────────────
if [[ "$KEEP" == true ]]; then
  ok "Skipping MCP config (--keep)"
else
  step "Step 3: Configure kiro-flock-mcp"

  bash "$MCP_DIR/scripts/get-mcp-env.sh" \
    --region "$REGION" \
    --profile "$PROFILE"
fi

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo "${B}${C}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${N}"
echo "${B}${G}  Setup complete.${N}"
echo "  Reconnect the kiro-flock-feed MCP server in Kiro to activate it."
echo "${B}${C}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${N}"
echo ""
