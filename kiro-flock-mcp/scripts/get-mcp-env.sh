#!/usr/bin/env bash
# get-mcp-env.sh
#
# Configures kiro-flock-feed-mcp from the deployed kiro-flock CDK stack.
# The MCP server handles authentication itself (browser login + token refresh),
# so this script only needs to write the Cognito and API config into mcp.json.
#
# Usage:
#   ./scripts/get-mcp-env.sh --region eu-central-1
#   ./scripts/get-mcp-env.sh --region eu-central-1 --profile my-profile
#
# Options:
#   --stack    CDK stack name (default: AgaStack)
#   --region   AWS region (default: AWS_DEFAULT_REGION or us-east-1)
#   --profile  AWS CLI profile (optional)

set -euo pipefail

STACK_NAME="AgaStack"
REGION="${AWS_DEFAULT_REGION:-us-east-1}"
PROFILE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --stack)   STACK_NAME="$2"; shift 2 ;;
    --region)  REGION="$2";     shift 2 ;;
    --profile) PROFILE="$2";    shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

AWS="aws"
if [[ -n "$PROFILE" ]]; then
  AWS="aws --profile $PROFILE"
fi

echo "Fetching CloudFormation outputs from stack: $STACK_NAME (region: $REGION)..."

OUTPUTS=$($AWS cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --region "$REGION" \
  --query "Stacks[0].Outputs" \
  --output json)

get_output() {
  echo "$OUTPUTS" | python3 -c \
    "import sys,json; o={x['OutputKey']:x['OutputValue'] for x in json.load(sys.stdin)}; print(o.get('$1',''))"
}

API_URL=$(get_output "ApiUrl")
BUCKET_NAME=$(get_output "BucketName")
USER_POOL_ID=$(get_output "UserPoolId")
CLIENT_ID=$(get_output "UserPoolClientId")
COGNITO_DOMAIN=$(get_output "CognitoDomain")

if [[ -z "$API_URL" || -z "$BUCKET_NAME" ]]; then
  echo "ERROR: Could not find required outputs in stack $STACK_NAME."
  echo "Make sure the stack is deployed and you have the right --stack and --region values."
  exit 1
fi

API_URL="${API_URL%/}"

# ── Ensure admin auth flow is enabled on the Cognito client ──────────────────
# update-user-pool-client is a full replacement: any field not specified is
# reset to its default. We must preserve the OAuth/callback config set by
# install.sh step 5, or the dashboard login will break with redirect_mismatch.

CURRENT_CLIENT=$($AWS cognito-idp describe-user-pool-client \
  --region "$REGION" \
  --user-pool-id "$USER_POOL_ID" \
  --client-id "$CLIENT_ID" \
  --query "UserPoolClient" \
  --output json 2>/dev/null || echo "null")

CURRENT_FLOWS=$(echo "$CURRENT_CLIENT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(json.dumps(d.get('ExplicitAuthFlows') or []))")

if ! echo "$CURRENT_FLOWS" | grep -q "ALLOW_ADMIN_USER_PASSWORD_AUTH"; then
  echo "Enabling ADMIN_USER_PASSWORD_AUTH on Cognito client..."

  CALLBACK_URLS=$(echo "$CURRENT_CLIENT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(' '.join(d.get('CallbackURLs') or []))")
  LOGOUT_URLS=$(echo "$CURRENT_CLIENT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(' '.join(d.get('LogoutURLs') or []))")
  OAUTH_FLOWS=$(echo "$CURRENT_CLIENT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(' '.join(d.get('AllowedOAuthFlows') or []))")
  OAUTH_SCOPES=$(echo "$CURRENT_CLIENT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(' '.join(d.get('AllowedOAuthScopes') or []))")
  IDPS=$(echo "$CURRENT_CLIENT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(' '.join(d.get('SupportedIdentityProviders') or []))")
  OAUTH_UPC=$(echo "$CURRENT_CLIENT" | python3 -c "import sys,json; d=json.load(sys.stdin); print('true' if d.get('AllowedOAuthFlowsUserPoolClient') else 'false')")

  ARGS=(
    --region "$REGION"
    --user-pool-id "$USER_POOL_ID"
    --client-id "$CLIENT_ID"
    --explicit-auth-flows ALLOW_USER_SRP_AUTH ALLOW_REFRESH_TOKEN_AUTH ALLOW_ADMIN_USER_PASSWORD_AUTH
    --id-token-validity 24
    --access-token-validity 24
    --refresh-token-validity 7
    --token-validity-units '{"IdToken":"hours","AccessToken":"hours","RefreshToken":"days"}'
  )
  [[ -n "$CALLBACK_URLS" ]] && ARGS+=(--callback-urls $CALLBACK_URLS)
  [[ -n "$LOGOUT_URLS" ]]   && ARGS+=(--logout-urls $LOGOUT_URLS)
  [[ -n "$OAUTH_FLOWS" ]]   && ARGS+=(--allowed-o-auth-flows $OAUTH_FLOWS)
  [[ -n "$OAUTH_SCOPES" ]]  && ARGS+=(--allowed-o-auth-scopes $OAUTH_SCOPES)
  [[ -n "$IDPS" ]]          && ARGS+=(--supported-identity-providers $IDPS)
  if [[ "$OAUTH_UPC" == "true" ]]; then
    ARGS+=(--allowed-o-auth-flows-user-pool-client)
  else
    ARGS+=(--no-allowed-o-auth-flows-user-pool-client)
  fi

  $AWS cognito-idp update-user-pool-client "${ARGS[@]}" > /dev/null
  echo "Done."
fi

# ── Output ───────────────────────────────────────────────────────────────────

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  kiro-flock-feed-mcp config"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  API URL    : $API_URL"
echo "  S3 Bucket  : $BUCKET_NAME ($REGION)"
echo "  AWS Profile: ${PROFILE:-default}"
echo "  Auth       : browser login (token managed by MCP server)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# ── Auto-update MCP config ───────────────────────────────────────────────────

MCP_CONFIG="$HOME/.kiro/settings/mcp.json"
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

update_mcp_config() {
  local aws_profile="${PROFILE:-default}"
  if [[ -z "$PROFILE" ]]; then
    CURRENT_ACCOUNT=$($AWS sts get-caller-identity --query Account --output text 2>/dev/null || echo "")
    if [[ -n "$CURRENT_ACCOUNT" ]]; then
      DETECTED=$(aws configure list-profiles 2>/dev/null | while read -r p; do
        ACCT=$(aws sts get-caller-identity --profile "$p" --query Account --output text 2>/dev/null || echo "")
        if [[ "$ACCT" == "$CURRENT_ACCOUNT" && "$p" != "default" ]]; then
          echo "$p"
          break
        fi
      done)
      if [[ -n "$DETECTED" ]]; then
        aws_profile="$DETECTED"
      fi
    fi
  fi
  python3 - "$MCP_CONFIG" "$API_URL" "$BUCKET_NAME" "$SCRIPT_DIR" "$REGION" "$aws_profile" "$COGNITO_DOMAIN" "$CLIENT_ID" "$USER_POOL_ID" <<'PYEOF'
import sys, json, os

config_path, api_url, bucket, script_dir, region, aws_profile, cognito_domain, client_id, user_pool_id = sys.argv[1:]
dist_path = os.path.join(script_dir, "dist", "index.js")

if os.path.exists(config_path):
  with open(config_path) as f:
    config = json.load(f)
else:
  config = {}

config.setdefault("mcpServers", {})
config["mcpServers"]["kiro-flock-feed"] = {
  "command": "node",
  "args": [dist_path],
  "env": {
    "FLOCK_API_URL": api_url,
    "FLOCK_S3_BUCKET": bucket,
    "FLOCK_S3_REGION": region,
    "FLOCK_COGNITO_DOMAIN": cognito_domain,
    "FLOCK_COGNITO_CLIENT_ID": client_id,
    "FLOCK_COGNITO_USER_POOL_ID": user_pool_id,
    "AWS_PROFILE": aws_profile,
    "AWS_DEFAULT_REGION": region,
  },
}

os.makedirs(os.path.dirname(config_path), exist_ok=True)
with open(config_path, "w") as f:
  json.dump(config, f, indent=2)
  f.write("\n")
PYEOF
}

echo ""
read -rp "Auto-update $MCP_CONFIG? [Y/n] " CONFIRM
if [[ "$CONFIRM" =~ ^[Nn] ]]; then
  echo "Skipped. Paste the config above manually."
else
  update_mcp_config
  echo "Updated $MCP_CONFIG."
fi

# ── Install the kiro-flock skill ─────────────────────────────────────────────

SKILL_SRC="$SCRIPT_DIR/skills/kiro-flock/SKILL.md"
SKILL_DEST_DIR="$HOME/.kiro/skills/kiro-flock"
SKILL_DEST="$SKILL_DEST_DIR/SKILL.md"

if [[ -f "$SKILL_SRC" ]]; then
  mkdir -p "$SKILL_DEST_DIR"
  cp "$SKILL_SRC" "$SKILL_DEST"
  echo "Installed kiro-flock skill to $SKILL_DEST"
fi

# ── Install the weltenbuilder skill ──────────────────────────────────────────

WB_SKILL_SRC="$SCRIPT_DIR/skills/weltenbuilder/SKILL.md"
WB_SKILL_DEST_DIR="$HOME/.kiro/skills/weltenbuilder"
WB_SKILL_DEST="$WB_SKILL_DEST_DIR/SKILL.md"

if [[ -f "$WB_SKILL_SRC" ]]; then
  mkdir -p "$WB_SKILL_DEST_DIR"
  cp "$WB_SKILL_SRC" "$WB_SKILL_DEST"
  echo "Installed weltenbuilder skill to $WB_SKILL_DEST"
fi

# ── Update WAF IP allowlist (if deployed) ─────────────────────────────────────
# The CDK stack does not deploy a WAF by default. If you add one manually or
# via an extension stack and export a WafIpSetId output, this block updates it.

WAF_ID=$(get_output "WafIpSetId")
if [[ -n "$WAF_ID" ]]; then
  echo ""
  echo "WAF IP set detected. Updating allowlist to your current public IP..."
  MY_IP=$(curl -sf https://checkip.amazonaws.com || echo "")
  if [[ -n "$MY_IP" ]]; then
    LOCK=$($AWS wafv2 get-ip-set --scope REGIONAL --region "$REGION" \
      --id "$WAF_ID" --name aga-allowed-ips --query LockToken --output text 2>/dev/null || echo "")
    if [[ -n "$LOCK" ]]; then
      $AWS wafv2 update-ip-set --scope REGIONAL --region "$REGION" \
        --id "$WAF_ID" --name aga-allowed-ips \
        --addresses "${MY_IP}/32" \
        --lock-token "$LOCK" > /dev/null 2>&1 && echo "  WAF updated: ${MY_IP}/32" || echo "  WAF update failed (check IAM permissions)"
    fi
  else
    echo "  Could not determine public IP — skipping WAF update"
  fi
fi

# ── Check and grant S3 upload access (environment/ + knowledge-base/) ───────

echo ""
echo "Checking local AWS identity has s3:PutObject on environment/ and knowledge-base/..."

IDENTITY=$($AWS sts get-caller-identity --output json 2>&1) || true
if echo "$IDENTITY" | grep -qi "error\|Exception"; then
  echo "Could not determine AWS identity — skipping S3 access check."
else
  ACCOUNT=$(echo "$IDENTITY" | python3 -c "import sys,json; print(json.load(sys.stdin)['Account'])")
  ARN=$(echo "$IDENTITY" | python3 -c "import sys,json; print(json.load(sys.stdin)['Arn'])")
  IDENTITY_TYPE=$(echo "$ARN" | python3 -c "import sys; a=sys.stdin.read().strip(); print('user' if ':user/' in a else 'role' if ':assumed-role/' in a else 'other')")
  IDENTITY_NAME=$(echo "$ARN" | python3 -c "import sys; a=sys.stdin.read().strip(); parts=a.split('/'); print(parts[1] if len(parts)>1 else a)")

  echo "  Identity: $ARN"

  # Test both prefixes. The MCP exposes env_upload_* (writes to environment/)
  # and kb_upload_* (writes to knowledge-base/). Both need PutObject.
  ENV_RESULT=$($AWS s3api put-object \
    --bucket "$BUCKET_NAME" \
    --key "environment/.access-check" \
    --body /dev/null \
    --region "$REGION" 2>&1) || true
  KB_RESULT=$($AWS s3api put-object \
    --bucket "$BUCKET_NAME" \
    --key "knowledge-base/.access-check" \
    --body /dev/null \
    --region "$REGION" 2>&1) || true

  ENV_DENIED=$(echo "$ENV_RESULT" | grep -qi "AccessDenied\|Access Denied\|403" && echo yes || echo no)
  KB_DENIED=$(echo "$KB_RESULT"  | grep -qi "AccessDenied\|Access Denied\|403" && echo yes || echo no)

  if [[ "$ENV_DENIED" == "yes" || "$KB_DENIED" == "yes" ]]; then
    if [[ "$ENV_DENIED" == "yes" && "$KB_DENIED" == "yes" ]]; then
      echo "  Access denied on both environment/ and knowledge-base/."
    elif [[ "$ENV_DENIED" == "yes" ]]; then
      echo "  Access denied on environment/ (needed for env_upload_file / env_upload_folder)."
    else
      echo "  Access denied on knowledge-base/ (needed for kb_upload_file / kb_upload_folder)."
    fi
    echo ""
    read -rp "  Attach an inline policy to grant access to both prefixes? [Y/n] " GRANT
    if [[ ! "$GRANT" =~ ^[Nn] ]]; then
      POLICY=$(python3 -c "
import json
print(json.dumps({
  'Version': '2012-10-17',
  'Statement': [{
    'Effect': 'Allow',
    'Action': ['s3:PutObject', 's3:GetObject', 's3:ListBucket'],
    'Resource': [
      'arn:aws:s3:::$BUCKET_NAME/environment/*',
      'arn:aws:s3:::$BUCKET_NAME/knowledge-base/*',
      'arn:aws:s3:::$BUCKET_NAME'
    ]
  }]
}))
")
      if [[ "$IDENTITY_TYPE" == "user" ]]; then
        $AWS iam put-user-policy \
          --user-name "$IDENTITY_NAME" \
          --policy-name "kiro-flock-upload-access" \
          --policy-document "$POLICY" 2>&1
        echo "  Policy attached to IAM user: $IDENTITY_NAME"
      elif [[ "$IDENTITY_TYPE" == "role" ]]; then
        ROLE_NAME=$(echo "$ARN" | python3 -c "import sys; a=sys.stdin.read().strip(); print(a.split('/')[1])")
        $AWS iam put-role-policy \
          --role-name "$ROLE_NAME" \
          --policy-name "kiro-flock-upload-access" \
          --policy-document "$POLICY" 2>&1
        echo "  Policy attached to IAM role: $ROLE_NAME"
      else
        echo "  Cannot attach policy to identity type: $IDENTITY_TYPE"
        echo "  Manually grant s3:PutObject on:"
        echo "    arn:aws:s3:::$BUCKET_NAME/environment/*"
        echo "    arn:aws:s3:::$BUCKET_NAME/knowledge-base/*"
      fi
    else
      echo "  Skipped. env_upload_* and/or kb_upload_* will fail with Access Denied."
    fi
  else
    $AWS s3api delete-object --bucket "$BUCKET_NAME" --key "environment/.access-check" --region "$REGION" 2>/dev/null || true
    $AWS s3api delete-object --bucket "$BUCKET_NAME" --key "knowledge-base/.access-check" --region "$REGION" 2>/dev/null || true
    echo "  Access OK for environment/ and knowledge-base/."
  fi
fi
