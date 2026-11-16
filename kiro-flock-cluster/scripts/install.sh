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

# ---------- Flags ------------------------------------------------------------
KEEP=false
while [[ $# -gt 0 ]]; do
  case "$1" in
    --keep) KEEP=true; shift ;;
    *) shift ;;
  esac
done

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

# Container builder — the agent image (ECS compute backend) is built at
# CDK synth/deploy time. CDK uses docker by default; point it at finch
# via CDK_DOCKER when docker isn't available (our local setup uses finch).
if [[ -n "${CDK_DOCKER:-}" ]]; then
  ok "Container builder: \$CDK_DOCKER=$CDK_DOCKER (preset)"
elif command -v docker >/dev/null 2>&1; then
  ok "Container builder: docker"
elif command -v finch >/dev/null 2>&1; then
  export CDK_DOCKER=finch
  # finch needs its VM running before it can build.
  if ! finch info >/dev/null 2>&1; then
    info "Starting finch VM"
    if ! finch vm start 2>&1 | tail -3; then
      # vm init builds a NEW VM and discards existing VM state. It used to run
      # here with both streams suppressed, which made a destructive fallback
      # invisible. Announce it and keep the output.
      info "finch vm start failed — initialising a new VM (discards existing VM state)"
      finch vm init 2>&1 | tail -5 \
        || fail "finch is installed but its VM could not be initialised"
    fi
    finch info >/dev/null 2>&1 || fail "finch VM did not become ready"
  fi
  ok "Container builder: finch (CDK_DOCKER=finch)"
else
  fail "No container builder found — install finch (brew install finch) or docker; needed to build the agent image"
fi

aws sts get-caller-identity --output json >/dev/null 2>&1 \
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

if [[ ! -d node_modules ]]; then
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
  npx cdk bootstrap "aws://${ACCOUNT_ID}/${REGION}"
fi

# ---------- 2b. Container registry credentials -------------------------------
# The agent image is pushed to the CDK assets ECR repo during deploy. That push
# speaks the Docker Registry v2 protocol, which uses HTTP Basic auth and knows
# nothing about AWS credentials. Being logged into the AWS CLI is necessary but
# not sufficient: the AWS credentials only mint a 12-hour registry token via
# ecr:GetAuthorizationToken, which then has to reach the builder.
#
# We do NOT use `<builder> login` for this. `login` honours the credsStore /
# credHelpers settings in the user's own config.json, and on macOS that is
# commonly "osxkeychain", which stores the secret in the host Keychain and
# leaves only an empty stub in the auths map. finch then runs the actual push
# inside its Lima VM, where the host's docker-credential-osxkeychain binary
# does not exist, so the lookup yields nothing and the push fails with
# "no basic auth credentials" — a message that reads like a permissions problem
# and is not one. `login` reports success in that case, which makes it worse.
#
# Instead, write a throwaway config containing the token inline and point the
# builder at it via DOCKER_CONFIG for the duration of the deploy. Inline auth
# needs no helper binary, so it resolves inside the VM. The user's own
# ~/.docker and ~/.finch configs are left untouched.
step "2b. Container registry credentials"

ECR_REGISTRY="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"
BUILDER="${CDK_DOCKER:-docker}"

# dist/ is gitignored. 0700 + 0600 because this file holds a live token.
REGISTRY_CONFIG_DIR="${PWD}/dist/registry-config"
rm -rf "$REGISTRY_CONFIG_DIR"
mkdir -p "$REGISTRY_CONFIG_DIR"
chmod 700 "$REGISTRY_CONFIG_DIR"

ECR_PASSWORD="$(aws ecr get-login-password --region "$REGION" 2>/dev/null || true)"
[[ -n "$ECR_PASSWORD" ]] \
  || fail "Could not obtain an ECR token (aws ecr get-login-password failed).
     Check that your AWS credentials are current for $REGION."

ECR_AUTH="$(printf 'AWS:%s' "$ECR_PASSWORD" | base64 | tr -d '\n')"
umask 077
printf '{"auths":{"%s":{"auth":"%s"}}}' "$ECR_REGISTRY" "$ECR_AUTH" \
  > "$REGISTRY_CONFIG_DIR/config.json"
chmod 600 "$REGISTRY_CONFIG_DIR/config.json"
unset ECR_AUTH

# cdk shells out to the builder, which inherits this.
export DOCKER_CONFIG="$REGISTRY_CONFIG_DIR"

# finch does not see the host's DOCKER_CONFIG. The push runs inside its Lima
# VM, and the finch binary sets DOCKER_CONFIG there to its own ~/.finch, so the
# inline file above is never read and the push fails with "no basic auth
# credentials" for any registry finch has not been logged into. `finch login`
# stores the token where the VM looks (the keychain through finch's own
# credential forwarding, or inline in ~/.finch/config.json), so it is the one
# path that reaches the push. Done per registry, so switching REGION in
# install.config logs into the new one rather than reusing a stale login.
#
# With DOCKER_CONFIG unset for this one command: finch honours the variable on
# the host side of `login`, so left set it would write the token into the
# throwaway file above, which is the one place the VM does not look.
if [[ "$BUILDER" == "finch" ]]; then
  printf '%s' "$ECR_PASSWORD" \
    | env -u DOCKER_CONFIG finch login --username AWS --password-stdin "$ECR_REGISTRY" >/dev/null 2>&1 \
    || fail "finch login to $ECR_REGISTRY failed. Try it by hand:
     aws ecr get-login-password --region $REGION | finch login --username AWS --password-stdin $ECR_REGISTRY"
  ok "Registry: $ECR_REGISTRY (finch login; token valid 12 h)"
else
  ok "Registry: $ECR_REGISTRY ($BUILDER, inline auth via DOCKER_CONFIG)"
fi
unset ECR_PASSWORD

# ---------- 3. Deploy AgaStack -----------------------------------------------
step "3. Deploy AgaStack"

info "Running cdk deploy (no-op if nothing has changed)"
npx cdk deploy AgaStack --require-approval never

get_output() {
  aws cloudformation describe-stacks \
    --stack-name AgaStack --region "$REGION" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue | [0]" \
    --output text
}

BUCKET="$(get_output BucketName | tr -d '[:space:]')"
API_URL="$(get_output ApiUrl | tr -d '[:space:]')"

[[ -n "$BUCKET" && "$BUCKET" != "None" ]] || fail "Could not read BucketName output"

ok "Bucket     : $BUCKET"
ok "API URL    : $API_URL"
# ---------- 3b. Agent deploy bootstrap ---------------------------------------
# Deployer clusters do not use the account's default CDK bootstrap (its deploy
# role may change any stack and its execution role is an administrator). They
# use a second bootstrap, qualifier "kflock", built from
# cdk/bootstrap/agent-bootstrap.template.yaml: the deploy role only touches
# stacks tagged KiroFlockManaged=true, and the execution role runs under a
# scoped policy and a permissions boundary that every role an agent stack
# creates must carry. The flock's bucket and user pool are passed in so the
# template can deny them explicitly. Runs after the AgaStack deploy because it
# needs those two values; the stack itself only names the kflock roles.
step "3b. Agent deploy bootstrap (qualifier kflock)"
USER_POOL_ARN="$(aws cognito-idp describe-user-pool \
  --user-pool-id "$(get_output UserPoolId | tr -d '[:space:]')" \
  --region "$REGION" --query 'UserPool.Arn' --output text)"
# `cdk bootstrap` cannot pass template parameters of its own, so the stack is
# deployed with the CloudFormation CLI. The template is the CDK bootstrap
# template with the changes listed in scripts/make-agent-bootstrap.mjs; its
# BootstrapVersion SSM parameter is part of the template, which is all the
# CDK CLI reads at deploy time.
info "Deploying CDKToolkit-kflock in $REGION (no-op if nothing has changed)"
aws cloudformation deploy \
  --region "$REGION" \
  --stack-name CDKToolkit-kflock \
  --template-file cdk/bootstrap/agent-bootstrap.template.yaml \
  --capabilities CAPABILITY_NAMED_IAM \
  --no-fail-on-empty-changeset \
  --parameter-overrides \
    "Qualifier=kflock" \
    "FlockBucketName=${BUCKET}" \
    "FlockUserPoolArn=${USER_POOL_ARN}" \
  --tags Project=kiro-flock
ok "Agent deploys use the kflock bootstrap roles"

# ---------- 4. Kiro API key --------------------------------------------------
step "4. Kiro API key"

if [[ "$KEEP" == true ]]; then
  ok "Skipping API key prompt (--keep)"
else

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
  printf 'Replace existing key? %s[r to replace / Enter to keep]%s ' "$B" "$N"
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

fi # end --keep guard for step 4

# ---------- 5. Cognito dashboard user -----------------------------------------
step "5. Cognito dashboard user"

USER_POOL_ID="$(get_output UserPoolId | tr -d '[:space:]')"
CLIENT_ID="$(get_output UserPoolClientId | tr -d '[:space:]')"
COGNITO_DOMAIN="$(get_output CognitoDomain | tr -d '[:space:]')"

ok "User Pool  : $USER_POOL_ID"
ok "Client ID  : $CLIENT_ID"
ok "Auth domain: $COGNITO_DOMAIN"

# Update the Cognito app client callback URL to point to the actual API Gateway
# URL, re-asserting the full client config (update-user-pool-client is a full
# replacement; unspecified fields reset to defaults).
info "Setting Cognito callback URL to $API_URL"

# Token validity: use fixed values matching the CDK stack definition.
# Reading these from the existing client is fragile: CDK stores durations
# in minutes (1440), so re-labelling the raw number as hours below would
# send "1440 hours" and exceed Cognito's 24h max. The CDK stack always sets:
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
  --callback-urls "${API_URL}" "http://localhost:19836/callback" \
  --logout-urls "${API_URL}" \
  --allowed-o-auth-flows implicit \
  --allowed-o-auth-scopes openid \
  --allowed-o-auth-flows-user-pool-client \
  --explicit-auth-flows ALLOW_USER_SRP_AUTH ALLOW_USER_PASSWORD_AUTH ALLOW_REFRESH_TOKEN_AUTH ALLOW_ADMIN_USER_PASSWORD_AUTH \
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
ok "Callback URLs verified: $REGISTERED_CALLBACKS"

# Check if any users exist
if [[ "$KEEP" == true ]]; then
  ok "Skipping user management (--keep)"
else
EXISTING_USERS="$(aws cognito-idp list-users \
  --user-pool-id "$USER_POOL_ID" \
  --region "$REGION" \
  --query 'Users[].Username' --output text 2>/dev/null || true)"
[[ "$EXISTING_USERS" == "None" ]] && EXISTING_USERS=""

if [[ -n "$EXISTING_USERS" ]]; then
  ok "Dashboard user(s): $EXISTING_USERS"
  printf '%s[Enter]%s keep / %s[c]%s create new / %s[r]%s delete and recreate: ' "$B" "$N" "$B" "$N" "$B" "$N"
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
  info "The user pool requires TOTP MFA: the first dashboard sign-in enrolls an authenticator app."
fi
fi # end --keep guard for user management

# Write auth config to S3. The unified shell at the stage root is the
# only page now — one auth-config.json, one Cognito callback URL.
info "Writing auth config to S3"
AUTH_CONFIG="{\"userPoolId\":\"${USER_POOL_ID}\",\"clientId\":\"${CLIENT_ID}\",\"cognitoDomain\":\"${COGNITO_DOMAIN}\",\"apiUrl\":\"${API_URL}\"}"
aws s3 cp - "s3://${BUCKET}/web/auth-config.json" --content-type application/json --region "$REGION" <<< "$AUTH_CONFIG"
ok "Auth config written to s3://${BUCKET}/web/auth-config.json"

# ---------- Model catalog ----------------------------------------------------
# Bake the list of models the local kiro-cli knows about into S3. This is the
# single source of truth for the dashboard's model picker and the backend's
# model validation — neither the browser nor the Lambda can run kiro-cli, so
# the catalog has to be captured here (where kiro-cli is guaranteed present by
# the preflight check) and uploaded. Re-running install.sh refreshes it, so a
# newly-released model shows up after the next setup.
#
# The `--model` flag on `kiro-cli acp` consumes exactly these `model_id`
# values, so we store the CLI output verbatim (no filtering, no rewriting).
# Runs outside the --keep guards, same as the auth-config writes above, so a
# code-only redeploy still refreshes the catalog.
step "Model catalog"

# NOTE: `kiro-cli chat --list-models` can exit non-zero even when it prints a
# perfectly good catalog to stdout, so we must NOT gate on its exit code (an
# earlier version did, via `... && [[ -n ... ]]`, and silently skipped the
# upload every time). Instead we capture the output unconditionally and gate
# on whether it parses as JSON with a non-empty `models` array.
MODELS_JSON="$(kiro-cli chat --list-models --format json 2>/dev/null || true)"
MODEL_COUNT="$(printf '%s' "$MODELS_JSON" \
  | python3 -c "import sys,json; m=json.load(sys.stdin).get('models'); print(len(m) if isinstance(m,list) else 0)" 2>/dev/null || echo 0)"

if [[ "${MODEL_COUNT:-0}" -gt 0 ]]; then
  printf '%s' "$MODELS_JSON" \
    | aws s3 cp - "s3://${BUCKET}/config/models.json" --content-type application/json --region "$REGION"
  ok "Model catalog written to s3://${BUCKET}/config/models.json ($MODEL_COUNT models)"
else
  warn "kiro-cli --list-models produced no usable catalog — skipping."
  warn "The dashboard model picker will be empty and model validation falls back"
  warn "to a permissive check until the next successful install."
fi

# ---------- Pricing catalog ---------------------------------------------------
# Fetch on-demand pricing for our supported EC2 Graviton types and Fargate ARM
# from the AWS Price List API. Stored as config/pricing.json in S3, read by the
# snapshot builder to calculate infra cost. Re-running install.sh refreshes it.
step "Pricing catalog"

PRICING_JSON="$(node scripts/fetch-pricing.js --region "$REGION" 2>/dev/null || true)"
PRICING_KEYS="$(printf '%s' "$PRICING_JSON" \
  | python3 -c "import sys,json; d=json.load(sys.stdin).get('ec2',{}); print(len(d))" 2>/dev/null || echo 0)"

if [[ "${PRICING_KEYS:-0}" -gt 0 ]]; then
  printf '%s' "$PRICING_JSON" \
    | aws s3 cp - "s3://${BUCKET}/config/pricing.json" --content-type application/json --region "$REGION"
  ok "Pricing catalog written to s3://${BUCKET}/config/pricing.json ($PRICING_KEYS instance types)"
else
  warn "Could not fetch pricing data — the dashboard will show AI costs only."
  warn "This is non-fatal; infra cost tracking requires the Pricing API (us-east-1 endpoint)."
fi

# ---------- 6. WAF allowlist ----------------------------------------------------
# The stage answers only to addresses in the allowlist IP set, and the set is
# deployed empty. Without this step the dashboard is a 403 for everyone,
# the operator included.
step "6. WAF allowlist"
if AWS_REGION="$REGION" bash "$(dirname "$0")/update-ip.sh"; then
  ok "Your current public IP is on the dashboard allowlist"
else
  warn "Could not add your IP to the WAF allowlist. The dashboard will answer 403 until you run:"
  warn "  AWS_REGION=$REGION ./scripts/update-ip.sh"
fi

# ---------- Done -------------------------------------------------------------
step "Done"
ok "Dashboard   : $API_URL"
ok "IP changed? : AWS_REGION=$REGION ./scripts/update-ip.sh"
ok "Bucket      : s3://$BUCKET"
ok "Next        : open the dashboard and create or start a cluster"
