#!/usr/bin/env bash
# End-to-end install for the AGA control plane.
#
# Idempotent: safe to re-run. Each step skips if already complete.
# Requires a Kiro API key (ksk_...) generated at https://app.kiro.dev.
#
# Usage:
#   ./scripts/install.sh                     # uses current AWS creds + region
#   AWS_REGION=eu-west-1 ./scripts/install.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# ---------- Colours ----------------------------------------------------------
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


# ---------- 0. Preflight -----------------------------------------------------
step "0. Preflight"

for cmd in aws node npx unzip curl; do
  command -v "$cmd" >/dev/null || fail "$cmd not found in PATH"
done
if ! command -v kiro-cli >/dev/null 2>&1; then
  fail "kiro-cli is not installed. See https://kiro.dev/docs/cli/installation/"
fi

IDENTITY_JSON="$(aws sts get-caller-identity --output json 2>/dev/null)" \
  || fail "AWS credentials not configured"

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
CALLER_ARN="$(aws sts get-caller-identity --query Arn --output text)"

REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-$(aws configure get region 2>/dev/null || true)}}"
[[ -n "$REGION" ]] || fail "No AWS region set (use AWS_REGION=... or aws configure set region)"

ok "Account : $ACCOUNT_ID"
ok "Caller  : $CALLER_ARN"
ok "Region  : $REGION"

# ---------- 1. npm dependencies ----------------------------------------------
step "1. npm install"

if [[ ! -d node_modules/.bin ]]; then
  npm install
else
  ok "node_modules already present"
fi

# ---------- 2. CDK bootstrap -------------------------------------------------
step "2. CDK bootstrap"

if aws cloudformation describe-stacks \
     --region "$REGION" --stack-name CDKToolkit >/dev/null 2>&1; then
  ok "CDKToolkit stack already present in $REGION"
else
  info "Bootstrapping CDK in $REGION"
  ./node_modules/.bin/cdk bootstrap "aws://${ACCOUNT_ID}/${REGION}"
fi

# ---------- 3. Deploy AgaStack -----------------------------------------------
step "3. Deploy AgaStack"

info "Running cdk deploy (no-op if nothing has changed)"
./node_modules/.bin/cdk deploy AgaStack --require-approval never

get_output() {
  aws cloudformation describe-stacks \
    --stack-name AgaStack --region "$REGION" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue | [0]" \
    --output text
}

BUCKET="$(get_output BucketName | tr -d '[:space:]')"
API_URL="$(get_output ApiUrl | tr -d '[:space:]')"
WELTEN_URL="$(get_output WeltenUrl | tr -d '[:space:]')"

[[ -n "$BUCKET" && "$BUCKET" != "None" ]] || fail "Could not read BucketName output"

ok "Bucket     : $BUCKET"
ok "API URL    : $API_URL"
ok "Welten URL : $WELTEN_URL"

# ---------- 4. Kiro API key --------------------------------------------------
step "4. Kiro API key"

SSM_PARAM_NAME="/aga/kiro-api-key"

EXISTING_KEY="$(aws ssm get-parameter \
  --name "$SSM_PARAM_NAME" \
  --with-decryption \
  --region "$REGION" \
  --query 'Parameter.Value' --output text 2>/dev/null || true)"
[[ "$EXISTING_KEY" == "None" ]] && EXISTING_KEY=""

if [[ -n "$EXISTING_KEY" && "$EXISTING_KEY" == ksk_* ]]; then
  masked="ksk_$(printf '%0.s*' $(seq 1 $((${#EXISTING_KEY} - 4))))"
  ok "Kiro API key already stored in SSM ($SSM_PARAM_NAME): $masked"
  printf "Replace existing key? ${B}[r to replace / Enter to keep]${N} "
  read -r keep_reply
  if [[ "$keep_reply" == "r" || "$keep_reply" == "R" ]]; then
    EXISTING_KEY=""
  else
    ok "Keeping existing API key"
  fi
fi

if [[ -z "$EXISTING_KEY" ]]; then
  cat <<EOF

Generate an API key at ${B}https://app.kiro.dev${N} → API Keys.
The key starts with ksk_.

EOF
  api_key=""
  while :; do
    printf "Paste the KIRO_API_KEY here (input hidden): "
    read -rs api_key
    printf "\n"
    if [[ "$api_key" == ksk_* ]]; then
      # Show masked confirmation: ksk_ + asterisks for the rest
      masked="ksk_$(printf '%0.s*' $(seq 1 $((${#api_key} - 4))))"
      ok "Received: $masked"
      break
    fi
    warn "Key should start with ksk_, try again."
  done

  info "Storing API key in SSM Parameter Store ($SSM_PARAM_NAME)"
  aws ssm put-parameter \
    --name "$SSM_PARAM_NAME" \
    --type SecureString \
    --value "$api_key" \
    --overwrite \
    --region "$REGION" >/dev/null
  ok "API key stored"
fi

# ---------- 5. Cognito dashboard user -----------------------------------------
step "5. Cognito dashboard user"

USER_POOL_ID="$(get_output UserPoolId | tr -d '[:space:]')"
CLIENT_ID="$(get_output UserPoolClientId | tr -d '[:space:]')"
COGNITO_DOMAIN="$(get_output CognitoDomain | tr -d '[:space:]')"

ok "User Pool  : $USER_POOL_ID"
ok "Client ID  : $CLIENT_ID"
ok "Auth domain: $COGNITO_DOMAIN"

# Update the Cognito app client callback URL to point to the actual API Gateway URL.
# We read the current client config first and preserve all existing settings —
# only overriding the callback/logout URLs. This prevents cdk deploy from
# resetting token validity and auth flows on every redeploy.
info "Setting Cognito callback URL to $API_URL"

CURRENT_CLIENT="$(aws cognito-idp describe-user-pool-client \
  --user-pool-id "$USER_POOL_ID" \
  --client-id "$CLIENT_ID" \
  --region "$REGION" \
  --query 'UserPoolClient' --output json)"

# Token validity — use fixed values matching the CDK stack definition.
# Reading these from the existing client is fragile because Cognito may
# return values without explicit units, or CDK may store them in different
# unit scales depending on version. The CDK stack always sets:
#   accessTokenValidity: 24 hours
#   idTokenValidity:     24 hours
#   refreshTokenValidity: 7 days
ACCESS_TOKEN_VALIDITY=24
ID_TOKEN_VALIDITY=24
REFRESH_TOKEN_VALIDITY=7

aws cognito-idp update-user-pool-client \
  --user-pool-id "$USER_POOL_ID" \
  --client-id "$CLIENT_ID" \
  --supported-identity-providers COGNITO \
  --callback-urls "${API_URL}" "${WELTEN_URL}" "${WELTEN_URL}/" "http://localhost:19836/callback" \
  --logout-urls "${API_URL}" "${WELTEN_URL}" "${WELTEN_URL}/" \
  --allowed-o-auth-flows implicit \
  --allowed-o-auth-scopes openid \
  --allowed-o-auth-flows-user-pool-client \
  --explicit-auth-flows ALLOW_USER_SRP_AUTH ALLOW_REFRESH_TOKEN_AUTH ALLOW_ADMIN_USER_PASSWORD_AUTH \
  --access-token-validity "$ACCESS_TOKEN_VALIDITY" \
  --id-token-validity "$ID_TOKEN_VALIDITY" \
  --refresh-token-validity "$REFRESH_TOKEN_VALIDITY" \
  --token-validity-units "AccessToken=hours,IdToken=hours,RefreshToken=days" \
  --region "$REGION" > /dev/null

# Verify Cognito actually has the right callback URLs registered
REGISTERED_CALLBACKS="$(aws cognito-idp describe-user-pool-client \
  --user-pool-id "$USER_POOL_ID" \
  --client-id "$CLIENT_ID" \
  --region "$REGION" \
  --query 'UserPoolClient.CallbackURLs' --output json)"

if ! echo "$REGISTERED_CALLBACKS" | grep -q "$API_URL"; then
  fail "Cognito callback URL mismatch! Registered: $REGISTERED_CALLBACKS, expected to contain: '$API_URL'"
fi
if [[ -n "$WELTEN_URL" ]] && ! echo "$REGISTERED_CALLBACKS" | grep -q "$WELTEN_URL"; then
  fail "Cognito callback URL mismatch! Registered: $REGISTERED_CALLBACKS, expected to contain: '$WELTEN_URL'"
fi
ok "Callback URLs verified: $REGISTERED_CALLBACKS"

# Check if any users exist
EXISTING_USERS="$(aws cognito-idp list-users \
  --user-pool-id "$USER_POOL_ID" \
  --region "$REGION" \
  --query 'Users[].Username' --output text 2>/dev/null || true)"
[[ "$EXISTING_USERS" == "None" ]] && EXISTING_USERS=""

if [[ -n "$EXISTING_USERS" ]]; then
  ok "Dashboard user(s): $EXISTING_USERS"
  printf "${B}[Enter]${N} keep / ${B}[c]${N} create new / ${B}[r]${N} delete and recreate: "
  read -r user_action

  if [[ "$user_action" == "r" || "$user_action" == "R" ]]; then
    for u in $EXISTING_USERS; do
      aws cognito-idp admin-delete-user \
        --user-pool-id "$USER_POOL_ID" \
        --username "$u" \
        --region "$REGION" 2>/dev/null && ok "Deleted user: $u"
    done
    EXISTING_USERS=""
  elif [[ "$user_action" == "c" || "$user_action" == "C" ]]; then
    EXISTING_USERS=""
  else
    EXISTING_USERS="skip"
  fi
fi

if [[ "$EXISTING_USERS" != "skip" && -z "$EXISTING_USERS" ]] || [[ "$user_action" == "c" || "$user_action" == "C" ]]; then
  printf "Dashboard username: "
  read -r dash_user
  [[ -z "$dash_user" ]] && fail "Username cannot be empty"

  printf "Dashboard password (min 8 chars, upper + digit): "
  read -rs dash_pass
  printf "\n"
  [[ ${#dash_pass} -lt 8 ]] && fail "Password must be at least 8 characters"

  info "Creating Cognito user: $dash_user"
  aws cognito-idp admin-create-user \
    --user-pool-id "$USER_POOL_ID" \
    --username "$dash_user" \
    --temporary-password "$dash_pass" \
    --message-action SUPPRESS \
    --region "$REGION" >/dev/null

  # Set permanent password so the user doesn't have to change it on first login
  aws cognito-idp admin-set-user-password \
    --user-pool-id "$USER_POOL_ID" \
    --username "$dash_user" \
    --password "$dash_pass" \
    --permanent \
    --region "$REGION" >/dev/null
  ok "User $dash_user created with permanent password"
fi

# Write auth config to S3 so both dashboards can pick it up.
# WeltenBuilder and the kiro-flock dashboard share the Cognito pool and
# API Gateway, but each app.js fetches its auth-config.json relative to
# its own page path, so we mirror the same file under both prefixes.
info "Writing auth config to S3"
AUTH_CONFIG="{\"userPoolId\":\"${USER_POOL_ID}\",\"clientId\":\"${CLIENT_ID}\",\"cognitoDomain\":\"${COGNITO_DOMAIN}\",\"apiUrl\":\"${API_URL}\"}"
aws s3 cp - "s3://${BUCKET}/web/auth-config.json" --content-type application/json --region "$REGION" <<< "$AUTH_CONFIG"
ok "Auth config written to s3://${BUCKET}/web/auth-config.json"

# WeltenBuilder's copy points apiUrl at its own URL so the hosted-UI
# redirect lands back on /welten/ rather than the dashboard root.
WELTEN_AUTH_CONFIG="{\"userPoolId\":\"${USER_POOL_ID}\",\"clientId\":\"${CLIENT_ID}\",\"cognitoDomain\":\"${COGNITO_DOMAIN}\",\"apiUrl\":\"${WELTEN_URL}/\"}"
aws s3 cp - "s3://${BUCKET}/welten-web/auth-config.json" --content-type application/json --region "$REGION" <<< "$WELTEN_AUTH_CONFIG"
ok "Auth config written to s3://${BUCKET}/welten-web/auth-config.json"

# ---------- Done -------------------------------------------------------------
step "Done"
ok "Dashboard   : $API_URL"
ok "WeltenBuilder: $WELTEN_URL"
ok "Bucket      : s3://$BUCKET"
ok "Next        : open a dashboard and create or start a cluster"
