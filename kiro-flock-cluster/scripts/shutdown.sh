#!/usr/bin/env bash
# Tear down the AGA control plane and EC2 agents.
#
# Preserves:
#   - IAM Identity Center instance + aga-agent user
#   - Kiro session cache (backed up to ~/.aga-backup/kiro-session/ before destroy)
#
# Removes:
#   - All EC2 agent instances
#   - AgaStack (VPC, Lambda, API, S3 bucket, WAF)
#
# Re-running install.sh after this will:
#   - Recreate AgaStack
#   - Detect the Kiro session in backup and restore it (skipping the kiro-cli login)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

if [[ -t 1 ]]; then
  B=$'\033[1m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; N=$'\033[0m'
else
  B=""; G=""; Y=""; R=""; N=""
fi
info()  { printf "${B}==>${N} %s\n" "$*"; }
ok()    { printf "${G}✓${N} %s\n" "$*"; }
warn()  { printf "${Y}!${N} %s\n" "$*"; }
fail()  { printf "${R}✗${N} %s\n" "$*" >&2; exit 1; }
step()  { printf "\n${B}──── %s ────${N}\n" "$*"; }

# ---------- Preflight --------------------------------------------------------
step "0. Preflight"

command -v aws >/dev/null || fail "aws CLI not found"
command -v npx >/dev/null || fail "npx not found"

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text 2>/dev/null)" \
  || fail "AWS credentials not configured"
REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-$(aws configure get region 2>/dev/null || true)}}"
[[ -n "$REGION" ]] || fail "No AWS region set"

ok "Account : $ACCOUNT_ID"
ok "Region  : $REGION"

if ! aws cloudformation describe-stacks --stack-name AgaStack --region "$REGION" >/dev/null 2>&1; then
  warn "AgaStack is not deployed. Nothing to tear down."
  exit 0
fi

get_output() {
  aws cloudformation describe-stacks --stack-name AgaStack --region "$REGION" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue | [0]" --output text
}
BUCKET="$(get_output BucketName)"
API_URL="$(get_output ApiUrl)"
[[ -n "$BUCKET" && "$BUCKET" != "None" ]] || fail "Could not read BucketName output"

ok "Bucket  : $BUCKET"
ok "API URL : $API_URL"

# ---------- 1. Back up the Kiro session --------------------------------------
step "1. Back up Kiro session"

BACKUP_DIR="${REPO_ROOT}/.aga-backup/kiro-session"
mkdir -p "$BACKUP_DIR"

if aws s3 ls "s3://${BUCKET}/kiro-session/" --region "$REGION" 2>/dev/null | grep -q .; then
  info "Syncing s3://${BUCKET}/kiro-session/ → ${BACKUP_DIR}/"
  aws s3 sync "s3://${BUCKET}/kiro-session/" "$BACKUP_DIR/" --region "$REGION" --delete --only-show-errors
  n="$(find "$BACKUP_DIR" -type f | wc -l | tr -d ' ')"
  [[ "$n" -gt 0 ]] || fail "Backup dir is empty after sync — aborting before we destroy the bucket"
  ok "Backed up $n file(s) to $BACKUP_DIR"
else
  warn "No kiro-session/ prefix in bucket — nothing to back up"
fi

# ---------- 2. Stop the cluster ----------------------------------------------
step "2. Stop the cluster"

info "POST ${API_URL}cluster/stop"
curl -sS -X POST "${API_URL}cluster/stop" -o /dev/null -w "HTTP %{http_code}\n" || true

# Give terminations a few seconds to kick off so RunInstances → describe-instances
# picks them up and the ENIs detach before VPC deletion.
info "Waiting for instances to terminate..."
for i in $(seq 1 30); do
  STATES="$(aws ec2 describe-instances \
    --filters "Name=tag:Project,Values=kiro-flock" \
    --region "$REGION" \
    --query 'Reservations[].Instances[].State.Name' \
    --output text 2>/dev/null | tr '\t' '\n' | sort -u)"
  if [[ -z "$STATES" ]] || [[ "$STATES" == "terminated" ]]; then
    ok "All AGA instances terminated"
    break
  fi
  printf "  [%02d/30] states: %s\n" "$i" "$(echo "$STATES" | tr '\n' ' ')"
  sleep 10
done

# Even if some are still terminating, CloudFormation will wait for ENI release.

# ---------- 3. cdk destroy ---------------------------------------------------
step "3. cdk destroy AgaStack"

npx cdk destroy AgaStack --force

# ---------- 4. Verify --------------------------------------------------------
step "4. Verify"

if aws cloudformation describe-stacks --stack-name AgaStack --region "$REGION" >/dev/null 2>&1; then
  fail "AgaStack still present after destroy"
fi
ok "AgaStack deleted"

REMAINING="$(aws ec2 describe-instances \
  --filters "Name=tag:Project,Values=kiro-flock" "Name=instance-state-name,Values=pending,running,shutting-down,stopping,stopped" \
  --region "$REGION" \
  --query 'Reservations[].Instances[].InstanceId' --output text 2>/dev/null | tr '\t' '\n' | grep -v '^$' || true)"
if [[ -n "$REMAINING" ]]; then
  warn "Non-terminated AGA instances still present:"
  while IFS= read -r line; do echo "  $line"; done <<< "$REMAINING"
  warn "Terminate them manually if they persist."
else
  ok "No AGA EC2 instances left running"
fi

# Quick IDC check — we keep this, just confirm it's still there
IDC_ARN="$(aws sso-admin list-instances --region "$REGION" --no-paginate \
  --query 'Instances[0].InstanceArn' --output text 2>/dev/null | head -n1)"
if [[ -n "$IDC_ARN" && "$IDC_ARN" != "None" ]]; then
  ok "IDC preserved: $IDC_ARN"
else
  warn "No IDC instance found (was expected to be preserved)"
fi

step "Done"
ok "Backup at $BACKUP_DIR (restore on next install)"
ok "To redeploy: ./scripts/install.sh"
