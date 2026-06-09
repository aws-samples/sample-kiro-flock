# Troubleshooting

Known issues, their symptoms, root causes, and workarounds.

---

## Agents stuck in "starting" status (rate limiting)

**Symptoms**

- Agents show `status: "starting"` in the dashboard for 5-15+ minutes after launch
- EC2 instances are running (CPU metrics flowing, network active)
- Only a handful of agents in each cluster produce log entries; the rest stay silent
- The problem is worse with larger deployments (100+ agents across many clusters)

**Root cause**

The Kiro CLI backend rate-limits API requests. When many agents boot simultaneously and all call the Kiro API at the same time, most get throttled. The CLI retries 3 times per prompt call with ~10s backoff between attempts. After 3 failures, the agent loop's iteration produces no output (no ndjson entry written), sleeps for `loopIntervalSeconds`, and tries again.

The agents are NOT dead. They keep retrying indefinitely. As other agents complete their iterations and go idle, rate limit pressure drops and the stalled agents eventually get through.

**How to confirm**

Check the service journal on a stalled instance via SSM:

```bash
aws ssm send-command \
  --instance-ids <instance-id> \
  --document-name "AWS-RunShellScript" \
  --parameters 'commands=["journalctl -u aga-agent --no-pager | grep -i rate_limit | tail -10"]' \
  --region eu-central-1
```

If you see `_kiro.dev/error/rate_limit` notifications, this is the issue.

**Workaround**

None required. The agents self-recover as rate limit pressure subsides. In practice:
- Small clusters (5-16 agents): all agents get through within 2-3 minutes
- Medium clusters (20-30 agents): most agents active within 5-10 minutes
- Large WeltenBuilder deployments (100-200 agents): expect 10-20 minutes before all agents have completed at least one iteration

The agents that get through first produce useful output immediately. The stalled ones catch up and fill gaps once they break through. This is compatible with the amorphous computing model: early agents claim the obvious tasks, late arrivals observe what's done and pick up what's missing.

---

## Template for new entries

```markdown
## <Short title>

**Symptoms**

- What the user sees

**Root cause**

Why it happens (one paragraph)

**How to confirm**

Commands or checks to verify this is the issue

**Workaround**

What to do right now
```
