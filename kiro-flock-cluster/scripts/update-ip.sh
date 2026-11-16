#!/usr/bin/env bash
# Add this machine's public IPv4 address to the dashboard's WAF allowlist.
#
# The API Gateway stage sits behind a WAF web ACL whose default action is
# block; only addresses in the AgaStack allowlist IP set reach the dashboard,
# the sign-in page and the API the factory talks to. install.sh runs this once
# at the end of setup. Run it again whenever your public IP changes (new
# network, new day on a residential connection) and the dashboard stops
# answering with 403.
#
# Usage:
#   ./scripts/update-ip.sh                 # add the current public IP, keep the rest
#   ./scripts/update-ip.sh --replace       # make the current public IP the only entry
#   ./scripts/update-ip.sh 203.0.113.7     # add a specific address instead
#   AWS_REGION=eu-west-1 ./scripts/update-ip.sh
#
# IPv4 only: the set in the stack is IPV4. An operator on IPv6-only
# connectivity needs a second set and rule in cdk/lib/aga-stack.ts.
set -euo pipefail

REGION="${AWS_REGION:-$(aws configure get region 2>/dev/null || true)}"
if [[ -z "${REGION}" ]]; then
  echo "update-ip: set AWS_REGION or configure a default region" >&2
  exit 1
fi
STACK="${STACK_NAME:-AgaStack}"

REPLACE=0
WANTED=""
for arg in "$@"; do
  case "$arg" in
    --replace) REPLACE=1 ;;
    -h|--help) sed -n '2,19p' "$0"; exit 0 ;;
    *) WANTED="$arg" ;;
  esac
done

if [[ -z "$WANTED" ]]; then
  # api.ipify.org answers over IPv4 only, which is what the set accepts.
  WANTED="$(curl --proto '=https' --tlsv1.2 -sSf --max-time 10 https://api.ipify.org)"
fi
if ! [[ "$WANTED" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]]; then
  echo "update-ip: '$WANTED' is not an IPv4 address" >&2
  exit 1
fi
CIDR="${WANTED}/32"

output() {
  aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}
IPSET_ID="$(output AllowListIpSetId)"
IPSET_NAME="$(output AllowListIpSetName)"
if [[ -z "$IPSET_ID" || "$IPSET_ID" == "None" ]]; then
  echo "update-ip: stack $STACK in $REGION has no AllowListIpSetId output; deploy the current stack first" >&2
  exit 1
fi

# WAF updates are optimistic: read the lock token with the current addresses,
# write them back with ours added. A concurrent change makes the update fail
# with WAFOptimisticLockException; run again.
CURRENT_JSON="$(aws wafv2 get-ip-set --region "$REGION" --scope REGIONAL --id "$IPSET_ID" --name "$IPSET_NAME")"
LOCK_TOKEN="$(printf '%s' "$CURRENT_JSON" | python3 -c 'import sys,json; print(json.load(sys.stdin)["LockToken"])')"
if [[ "$REPLACE" == 1 ]]; then
  ADDRESSES="$CIDR"
else
  ADDRESSES="$(printf '%s' "$CURRENT_JSON" | python3 -c '
import sys, json
have = json.load(sys.stdin)["IPSet"]["Addresses"]
want = sys.argv[1]
if want not in have:
    have.append(want)
print(" ".join(have))' "$CIDR")"
fi

# shellcheck disable=SC2086  # ADDRESSES is a space-separated list on purpose
aws wafv2 update-ip-set --region "$REGION" --scope REGIONAL \
  --id "$IPSET_ID" --name "$IPSET_NAME" --lock-token "$LOCK_TOKEN" \
  --addresses $ADDRESSES > /dev/null

echo "update-ip: $CIDR is allowed on the $STACK dashboard in $REGION"
if [[ "$REPLACE" == 1 ]]; then
  echo "update-ip: it is now the only allowed address"
else
  echo "update-ip: allowed addresses: $ADDRESSES"
fi
