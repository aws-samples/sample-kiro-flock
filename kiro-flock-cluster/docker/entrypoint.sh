#!/bin/sh
# Container entrypoint — the ECS equivalent of the aga-agent systemd unit.
#
# Config arrives as environment variables set by the RunTask container
# overrides (see lambda/ecsManager.ts):
#   AGA_AGENT_CONFIG — full agent config JSON (read by agent/bootstrap.ts)
#   KIRO_API_KEY     — injected by ECS as a secret from SSM /aga/kiro-api-key
#
# There is no config file and no S3 sync: the agent bundle is baked into
# the image and bootstrap.ts prefers AGA_AGENT_CONFIG over /etc/aga/agent.json.
set -eu

: "${AGA_AGENT_CONFIG:?AGA_AGENT_CONFIG is not set — did RunTask pass container overrides?}"

export HOME="${HOME:-/home/agent}"
export AGA_WORKSPACE="${AGA_WORKSPACE:-$HOME/kiro-flock-workspace}"

mkdir -p "$AGA_WORKSPACE" "$HOME/.kiro/sessions/cli"

exec node /opt/aga/agent/bootstrap.js
