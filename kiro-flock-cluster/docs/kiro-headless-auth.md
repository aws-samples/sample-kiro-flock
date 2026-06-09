# Kiro CLI headless authentication on EC2

Findings from the kiro-flock project, April 2026. This documents what works, what doesn't, and the path forward for running `kiro-cli acp` on headless EC2 instances.

## What we tried: SSO token copy

The original approach was to run `kiro-cli login` locally as the `aga-agent` IDC user, then copy the resulting SSO cache files to S3 and restore them on EC2 instances at boot.

Files copied:
- `~/.aws/sso/cache/kiro-auth-token.json` (access + refresh tokens)
- `~/.aws/sso/cache/<clientIdHash>.json` (OIDC client registration)

### Why it failed

`kiro-cli` does not consider itself "logged in" just because the SSO cache files exist. Running `kiro-cli acp` on the instance returned:

```
error: You are not logged in, please log in with kiro-cli login
```

Even though:
- The token file was present at the correct path (`~/.aws/sso/cache/kiro-auth-token.json`)
- The token had not expired (`expiresAt` was still in the future)
- The client registration file was also present
- `kiro-cli` was the same version (2.0.1) on both local and remote

`kiro-cli` tracks login state beyond the SSO cache files. The exact mechanism is internal, but the cache files alone are not sufficient. There is no `kiro-cli auth status` command to inspect this.

### Observed behavior on EC2

When the bootstrap process spawned `kiro-cli acp` with the copied tokens:
1. ACP connection initialized successfully
2. A new session was created
3. The connection immediately closed with `Error: ACP connection closed`
4. systemd restarted the service, creating a crash loop (restart counter reached 138+)

The `kiro-cli acp` stderr output confirmed: `error: You are not logged in, please log in with kiro-cli login`

## What works: API key authentication (headless mode)

Kiro CLI supports headless authentication via API keys. This is the intended path for CI/CD and automation.

### How it works

1. Set `KIRO_API_KEY` environment variable (key format: `ksk_xxxxxxxx`)
2. `kiro-cli` picks it up automatically, no `kiro-cli login` needed
3. Works with `kiro-cli chat --no-interactive` and `kiro-cli acp`

### Authentication precedence

1. Active browser session (from `kiro-cli login`)
2. `KIRO_API_KEY` environment variable
3. No credentials, CLI prompts to sign in

### Generating an API key

- Requires Kiro Pro, Pro+, or Power subscription
- Admin must enable "Enable users to generate API keys" in the Kiro console (Settings > Kiro settings)
- User logs into https://app.kiro.dev, navigates to API Keys, creates a key
- The full key value is only shown at creation time

### IDC region constraint

The Kiro portal (app.kiro.dev) and Kiro management console only exist in `eu-central-1` (Frankfurt) and `us-east-1` (N. Virginia). If your IAM Identity Center instance is in a different region, the portal cannot validate the IDC login and fails silently with a flickering error.

The IDC instance must be in the same region as the Kiro service (eu-central-1 or us-east-1) for the portal login to work.

### Admin setup for API keys

In the AWS console:
```
https://eu-central-1.console.aws.amazon.com/amazonq/developer/home?region=eu-central-1#/settings
```

Under "Kiro settings", toggle "Enable users to generate and use API keys" to On.

## Recommended architecture for EC2 agents

1. IDC instance in eu-central-1 (same region as Kiro service)
2. `aga-agent` service user with Pro license in that IDC
3. Generate API key for `aga-agent` via app.kiro.dev
4. Store the API key in AWS Secrets Manager or SSM Parameter Store (SecureString)
5. EC2 user-data fetches the key at boot and sets `KIRO_API_KEY` in the systemd environment
6. `kiro-cli acp` authenticates headlessly, no browser or token copy needed

This replaces the SSO token copy flow entirely. No `setup-kiro-session.sh`, no S3 `kiro-session/` prefix, no `fetchKiroSession()` in the bootstrap.

## Reference docs

- Headless mode: https://kiro.dev/docs/cli/headless/
- Authentication methods: https://kiro.dev/docs/cli/authentication
- API key governance (admin): https://kiro.dev/docs/cli/enterprise/governance/api-keys
- ACP protocol: https://kiro.dev/docs/cli/acp/
- Kiro troubleshooting: https://kiro.dev/docs/troubleshooting/
