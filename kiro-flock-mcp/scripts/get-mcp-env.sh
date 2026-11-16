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

# to_native_path — emit a path in the OS-native form the *consumer* expects.
#
# The mcp.json this script writes is read by the native Windows toolchain:
# the Windows `node` that launches the MCP server, and (for the config file
# itself) the Windows python that writes it. Under Git Bash/MSYS, shell paths
# look like `/c/Users/...`, which those native programs misresolve. `cygpath -w`
# converts to `C:\Users\...`. On Linux/macOS there is no cygpath and paths are
# already native, so this is a transparent pass-through. Use it for any path
# that will be handed to a native (non-MSYS) program.
to_native_path() {
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -w "$1"
  else
    printf '%s' "$1"
  fi
}

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
# ECS compute backend (empty on stacks that predate it). Used by the MCP's
# stream_acp / list_acp_sessions to reach Fargate agents via ECS Exec.
ECS_CLUSTER_ARN=$(get_output "EcsClusterArn")

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

if ! echo "$CURRENT_FLOWS" | grep -q "ALLOW_ADMIN_USER_PASSWORD_AUTH" \
   || ! echo "$CURRENT_FLOWS" | grep -q "ALLOW_USER_PASSWORD_AUTH"; then
  echo "Enabling ADMIN_USER_PASSWORD_AUTH and USER_PASSWORD_AUTH on Cognito client..."

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
    --explicit-auth-flows ALLOW_USER_SRP_AUTH ALLOW_USER_PASSWORD_AUTH ALLOW_REFRESH_TOKEN_AUTH ALLOW_ADMIN_USER_PASSWORD_AUTH
    --id-token-validity 24
    --access-token-validity 24
    --refresh-token-validity 7
    --token-validity-units '{"IdToken":"hours","AccessToken":"hours","RefreshToken":"days"}'
  )
  # Each list is space-separated (none of these values may contain spaces);
  # split into array elements rather than relying on unquoted expansion.
  append_list() { local flag="$1" list="$2" items; [[ -n "$list" ]] || return 0; read -r -a items <<< "$list"; ARGS+=("$flag" "${items[@]}"); }
  append_list --callback-urls "$CALLBACK_URLS"
  append_list --logout-urls "$LOGOUT_URLS"
  append_list --allowed-o-auth-flows "$OAUTH_FLOWS"
  append_list --allowed-o-auth-scopes "$OAUTH_SCOPES"
  append_list --supported-identity-providers "$IDPS"
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

# MCP_CONFIG is only ever handed to the Windows python that writes the file, so
# convert it to native form (a no-op on Linux/macOS). Leaving it as an MSYS path
# (/c/Users/...) makes python resolve it against its own root and write to the
# wrong file.
MCP_CONFIG="$(to_native_path "$MCP_CONFIG")"

# SCRIPT_DIR is used two ways with conflicting needs, so keep it in MSYS form and
# derive a separate native value only where a native tool consumes it:
#   - native: passed to python to build the dist/index.js arg for `node` (below)
#   - MSYS:   used in bash `[[ -f ]]` / `cp` for the skill copy further down —
#             a `C:\...` path there would be mangled by bash backslash-escaping
#             and the copy would silently fail on Windows.
SCRIPT_DIR_NATIVE="$(to_native_path "$SCRIPT_DIR")"

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
  python3 - "$MCP_CONFIG" "$API_URL" "$BUCKET_NAME" "$SCRIPT_DIR_NATIVE" "$REGION" "$aws_profile" "$COGNITO_DOMAIN" "$CLIENT_ID" "$USER_POOL_ID" "$ECS_CLUSTER_ARN" <<'PYEOF'
import sys, json, os

config_path, api_url, bucket, script_dir, region, aws_profile, cognito_domain, client_id, user_pool_id, ecs_cluster_arn = sys.argv[1:]
dist_path = os.path.join(script_dir, "dist", "index.js")

if os.path.exists(config_path):
  with open(config_path) as f:
    config = json.load(f)
else:
  config = {}

env = {
  "FLOCK_API_URL": api_url,
  "FLOCK_S3_BUCKET": bucket,
  "FLOCK_S3_REGION": region,
  "FLOCK_COGNITO_DOMAIN": cognito_domain,
  "FLOCK_COGNITO_CLIENT_ID": client_id,
  "FLOCK_COGNITO_USER_POOL_ID": user_pool_id,
  "AWS_PROFILE": aws_profile,
  "AWS_DEFAULT_REGION": region,
}
if ecs_cluster_arn:
  # ECS compute backend: stream_acp / list_acp_sessions reach Fargate
  # agents via ECS Exec on this cluster.
  env["FLOCK_ECS_CLUSTER_ARN"] = ecs_cluster_arn

config.setdefault("mcpServers", {})
config["mcpServers"]["kiro-flock-feed"] = {
  "command": "node",
  "args": [dist_path],
  "env": env,
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

# ── Install the kiro-flock-compact skill ─────────────────────────────────────

# Remove deprecated skills replaced by kiro-flock-compact
rm -rf "$HOME/.kiro/skills/kiro-flock" "$HOME/.kiro/skills/weltenbuilder" "$HOME/.kiro/skills/everforge"

COMPACT_SKILL_SRC="$SCRIPT_DIR/skills/kiro-flock-compact/SKILL.md"
COMPACT_SKILL_DEST_DIR="$HOME/.kiro/skills/kiro-flock-compact"
COMPACT_SKILL_DEST="$COMPACT_SKILL_DEST_DIR/SKILL.md"

if [[ -f "$COMPACT_SKILL_SRC" ]]; then
  mkdir -p "$COMPACT_SKILL_DEST_DIR"
  cp "$COMPACT_SKILL_SRC" "$COMPACT_SKILL_DEST"
  echo "Installed kiro-flock-compact skill to $COMPACT_SKILL_DEST"
fi

# ── Update WAF IP allowlist ───────────────────────────────────────────────────

WAF_ID=$(get_output "WafIpSetId")
if [[ -n "$WAF_ID" ]]; then
  echo ""
  echo "Updating WAF IP allowlist to your current public IP..."
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
