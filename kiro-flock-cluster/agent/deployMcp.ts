/**
 * Deploy MCP server — config-time trust, no runtime approval flow.
 *
 * Trust is decided once, when the operator configures the cluster
 * (`trustDeploy: true`). cluster_start pre-writes a trusted marker file per
 * agent at store/approvals/{clusterId}/agent-{index}.json. This server only
 * ever READS that file:
 *   - marker present with status "trusted" → deploy_request deploys immediately
 *   - marker missing or anything else     → deploy_request returns deploy_disabled
 *
 * There is no pending state, no operator decision at runtime, and nothing
 * for an agent to wait on.
 *
 * The CDK process (the `cdk` CLI baked into the agent image) is spawned
 * detached and tracked via /tmp/deploy.pid.
 * Log output persists in /tmp/cdk-deploy.log across process restarts.
 *
 * Deployment records are NOT written by the agent. They are derived from
 * CloudFormation by deployRecord.ts, from three places that all call the same
 * idempotent `reconcileDeploy()`:
 *
 *   1. A post-deploy hook inside the detached process chain (the primary
 *      path). The spawned shell runs `cdk deploy`, records its exit code, then
 *      re-invokes this file with `--record`. Because that chain is detached it
 *      outlives both this MCP process and the agent's iteration, so the record
 *      lands with no agent turn involved at all.
 *   2. `deploy_request` and `deploy_status`, as a backstop for the one case
 *      the hook cannot cover: the task being restarted mid-deploy, which takes
 *      the whole process tree with it.
 *
 * Intent is stored durably in S3 (see deployRecord.ts#manifestKey) rather than
 * in /tmp, because /tmp does not survive a task restart and the old PID file
 * held nothing but a number — `deploy_status` could not even name the stack it
 * had just deployed.
 *
 * Tools:
 *   deploy_request — start a deployment (or learn deploys are disabled)
 *   deploy_status  — check current deployment state
 *   deploy_cancel  — kill the deploy process
 *
 * Also runnable as a one-shot recorder:
 *   node deployMcp.js --record <manifestKey>
 *
 * Environment variables:
 *   AGA_BUCKET           — S3 bucket name
 *   AGA_REGION           — AWS region
 *   AGA_CLUSTER_PREFIX   — cluster id (e.g. "cluster_0")
 *   AGA_AGENT_INDEX      — agent index within the cluster (e.g. "0")
 *   AGA_EVERFORGE_GROUP  — Everforge group, if any (decides the deployed/ prefix)
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as readline from "node:readline";
import * as path from "node:path";
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import { CloudFormationClient, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import { CloudFrontClient } from "@aws-sdk/client-cloudfront";
import {
  type DeployManifest,
  type ReconcileClients,
  type ReconcileResult,
  manifestKey,
  readManifest,
  writeManifest,
  writeIntentPointer,
  reconcileDeploy,
} from "./deployRecord.js";

const BUCKET = process.env.AGA_BUCKET ?? "";
const REGION = process.env.AGA_REGION || "us-east-1";
const CLUSTER_PREFIX = process.env.AGA_CLUSTER_PREFIX || "cluster_0";
const AGENT_INDEX = process.env.AGA_AGENT_INDEX || "0";
const EVERFORGE_GROUP = process.env.AGA_EVERFORGE_GROUP || null;

if (!BUCKET) {
  process.stderr.write("AGA_BUCKET is not set\n");
  process.exit(1);
}

const s3 = new S3Client({ region: REGION });
const cfn = new CloudFormationClient({ region: REGION });
const cloudfront = new CloudFrontClient({ region: REGION });

const reconcileClients: ReconcileClients = { s3, cfn, cloudfront, bucket: BUCKET };

const AGENT_ID = `agent-${AGENT_INDEX}`;
const TRUST_KEY = `store/approvals/${CLUSTER_PREFIX}/${AGENT_ID}.json`;
const LOG_FILE = "/tmp/cdk-deploy.log";
const PID_FILE = "/tmp/deploy.pid";
const RECORD_LOG_FILE = "/tmp/deploy-record.log";
const MANIFEST_KEY = manifestKey(CLUSTER_PREFIX, AGENT_INDEX);

/** Exact marker the spawned shell appends after `cdk deploy` returns. Replaces
 *  grepping the CDK log for "✅" / "Stack ARN:" / "successfully" — the last of
 *  which CDK also prints on the way into a rollback, mislabelling failures as
 *  successes. CloudFormation is still the primary authority; this only matters
 *  when the CDK CLI died before creating a stack at all. */
const EXIT_MARKER = "AGA_CDK_EXIT=";
/**
 * Deployer clusters deploy through the `kflock` bootstrap, not the account's
 * default one. install.sh creates it from cdk/bootstrap/agent-bootstrap.template.yaml:
 * its deploy role only touches stacks tagged KiroFlockManaged=true and its
 * execution role runs under a scoped policy and a permissions boundary.
 * DeployerRole can assume only the `cdk-kflock-*` roles, so a `cdk deploy`
 * without this qualifier fails at IAM. Mirrors AGENT_BOOTSTRAP_QUALIFIER in
 * cdk/lib/aga-stack.ts and scripts/install.sh.
 */
const BOOTSTRAP_QUALIFIER = "kflock";
const TOOLKIT_STACK_NAME = `CDKToolkit-${BOOTSTRAP_QUALIFIER}`;
/** Managed policy name from cdk/bootstrap/agent-bootstrap.template.yaml (`kiro-flock-${Qualifier}-agent-boundary`). */
const PERMISSIONS_BOUNDARY_NAME = `kiro-flock-${BOOTSTRAP_QUALIFIER}-agent-boundary`;
/**
 * Where the source of every remote deploy is copied before `cdk deploy` runs.
 * Every agent can write under environment/, so a cluster without trustDeploy
 * could place the app a deployer then deploys; this prefix is writable by
 * DeployerRole only (AgentRole carries an explicit deny), so the record of what
 * was deployed cannot be altered afterwards. Mirrors DEPLOY_SRC_PREFIX in
 * cdk/lib/aga-stack.ts.
 */
const DEPLOY_SRC_PREFIX = "deploy-src";
/** Folders never part of a deploy's source of record. */
const SNAPSHOT_SKIP = new Set(["node_modules", "cdk.out", ".git", ".cdk.staging"]);
/** Upper bound on one snapshot; a CDK app past this is not source but build output. */
const SNAPSHOT_MAX_BYTES = 200 * 1024 * 1024;

const DISABLED_MESSAGE =
  "Deployments are disabled for this cluster (trustDeploy is not set). " +
  "This is a permanent configuration decision — do NOT retry, do NOT wait. " +
  "Log it and continue with non-deployment work.";

// ---- Trust marker shape (written by cluster_start when trustDeploy=true) ----

interface TrustFile {
  status: string; // only "trusted" grants deployment
}

// ---- S3 helpers ----

async function s3Get(key: string): Promise<string | null> {
  try {
    const resp = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    return (await resp.Body?.transformToString()) ?? null;
  } catch (err: unknown) {
    if ((err as { name?: string }).name === "NoSuchKey") return null;
    throw err;
  }
}

/** True when this agent's cluster was configured with trustDeploy. Stale
 *  files from the removed approval flow (status "pending"/"approved"/
 *  "rejected") read as untrusted. */
async function isTrusted(): Promise<boolean> {
  const raw = await s3Get(TRUST_KEY);
  if (!raw) return false;
  try {
    return (JSON.parse(raw) as TrustFile).status === "trusted";
  } catch {
    return false;
  }
}

// ---- Bootstrap preflight & failure classification ----
//
// The single most expensive deploy failure observed in the field: a CDK app
// pinned its stack to a region other than the cluster's home region (the
// classic driver is Lambda@Edge forcing us-east-1). That region had no
// CDKToolkit bootstrap stack and the deploy role is denied CreateChangeSet on
// it, so three consecutive deploys died at bootstrap and the system served a
// stale build for 68 minutes while the agents diagnosed it from raw CDK
// output. Two mitigations here:
//
//   1. deploy_request preflights the HOME region's CDKToolkit stack once and
//      attaches a warning when it is missing (non-blocking — custom toolkit
//      qualifiers exist, and CloudFormation is still the final authority).
//   2. deploy_status classifies bootstrap/cross-region failures from the CDK
//      log and answers with a targeted message instead of "check logTail".

/** Cached preflight verdict. null = bootstrapped or unknown-but-fine;
 *  a string = warning to attach. Only a confirmed-good result is cached,
 *  so a missing toolkit is re-checked (the operator may bootstrap mid-run). */
let bootstrapConfirmedOk = false;

async function checkCdkBootstrap(): Promise<string | null> {
  if (bootstrapConfirmedOk) return null;
  try {
    await cfn.send(new DescribeStacksCommand({ StackName: TOOLKIT_STACK_NAME }));
    bootstrapConfirmedOk = true;
    return null;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (/does not exist/i.test(message)) {
      return (
        `Region ${REGION} has no ${TOOLKIT_STACK_NAME} stack: the kiro-flock agent bootstrap is missing. ` +
        `The deploy will fail at bootstrap. The operator creates it by running the flock's install.sh ` +
        `(step "agent bootstrap"); nothing on this cluster can fix it. Report it and continue with other work.`
      );
    }
    // Permission or transient error probing the toolkit: stay silent, the
    // deploy itself will produce the authoritative answer.
    return null;
  }
}

/** Match the log tail against known fail-before-CloudFormation causes and
 *  return a targeted, actionable message, or null when unrecognised. */
function classifyDeployFailure(logTail: string): string | null {
  if (/has not been bootstrapped|cdk bootstrap|CDKToolkit/i.test(logTail)) {
    return (
      "The deploy died at CDK bootstrap. Most common cause: the stack pins a region other than " +
      `this cluster's home region (${REGION}) — e.g. Lambda@Edge forcing us-east-1. Only the home ` +
      "region is bootstrapped and the deploy role is scoped to it. Do NOT retry the same stack: " +
      "restructure to deploy in the home region (e.g. a regional Lambda Function URL instead of " +
      "Lambda@Edge) and record the decision for your neighbours."
    );
  }
  if (/not authorized to perform|AccessDenied/i.test(logTail)) {
    return (
      "The deploy failed on IAM authorization before reaching your stack. The deploy role covers " +
      `standard CDK deploys in ${REGION}; cross-region deploys and unusual resource types fall ` +
      "outside it. Check logTail for the denied action and restructure rather than retrying."
    );
  }
  return null;
}

// ---- Process management ----

function readPid(): number | null {
  try {
    const raw = fs.readFileSync(PID_FILE, "utf8").trim();
    const pid = parseInt(raw, 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

/** Alive and not a zombie. On Fargate the container's PID 1 is the agent's
 *  node process, which never reaps the detached deploy shell, so a finished
 *  deploy lingers as a zombie that `kill(pid, 0)` still reports as alive; the
 *  agent then saw "deploying" forever while the stack had long rolled back.
 *  /proc/<pid>/stat field 3 is the state; `Z` means it has exited. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const state = stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3);
    return state !== "Z" && state !== "X";
  } catch {
    return true; // no /proc (not Linux): trust kill(0)
  }
}

function readLogTail(lines = 50): string {
  try {
    const content = fs.readFileSync(LOG_FILE, "utf8");
    const all = content.split("\n");
    return all.slice(-lines).join("\n");
  } catch {
    return "(no log file)";
  }
}

/**
 * Make the CDK attach the kflock permissions boundary to every IAM role the
 * agent's app synthesizes, by setting `@aws-cdk/core:permissionsBoundary` in
 * the user-level ~/.cdk.json. The execution role's policy denies
 * iam:CreateRole without that boundary, so a deploy of any app that creates a
 * role (BucketDeployment, every Lambda) fails otherwise. User-level so the
 * agent's own cdk.json stays untouched; a project-level value would win, and
 * IAM refuses any other boundary anyway. Other keys in the file are kept.
 */
function writeBoundaryContext(): void {
  const file = `${process.env.HOME ?? "/home/agent"}/.cdk.json`;
  let doc: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) doc = parsed as Record<string, unknown>;
  } catch { /* absent or unreadable: start fresh */ }
  const context = (doc.context && typeof doc.context === "object" ? doc.context : {}) as Record<string, unknown>;
  doc.context = { ...context, "@aws-cdk/core:permissionsBoundary": { name: PERMISSIONS_BOUNDARY_NAME } };
  fs.writeFileSync(file, JSON.stringify(doc, null, 2));
}
interface DeployParams {
  cwd: string;
  stackName: string;
  mode: "local" | "remote";
}

/** Single-quote for `sh -c`. Stack names and paths reach the shell as data,
 *  so they get quoted rather than interpolated raw. */
function sq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Copy the folder about to be deployed to deploy-src/<group>/<stack>/<time>/.
 * Returns the S3 prefix written, which the deployment record carries.
 */
async function snapshotSource(cwd: string, stackName: string, requestedAt: string): Promise<string> {
  const root = path.resolve(cwd);
  const safeStack = stackName.replace(/[^A-Za-z0-9_.-]/g, "_");
  const prefix = `${DEPLOY_SRC_PREFIX}/${EVERFORGE_GROUP ?? "default"}/${safeStack}/${requestedAt.replace(/[:.]/g, "-")}/`;
  let total = 0;
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SNAPSHOT_SKIP.has(entry.name)) walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      total += fs.statSync(full).size;
      if (total > SNAPSHOT_MAX_BYTES) {
        throw new Error(`source under ${cwd} exceeds ${SNAPSHOT_MAX_BYTES / (1024 * 1024)} MB after skipping ${[...SNAPSHOT_SKIP].join(", ")}`);
      }
      files.push(full);
    }
  };
  walk(root);
  for (const file of files) {
    const rel = path.relative(root, file).split(path.sep).join("/");
    await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: `${prefix}${rel}`, Body: fs.createReadStream(file) }));
  }
  return prefix;
}
function startDeployProcess(params: DeployParams): { pid: number } | { immediate: true } {
  if (params.mode === "local") {
    // Local mode: MCP only gates permission. Agent does the work itself.
    return { immediate: true };
  }

  // Remote mode: spawn CDK deploy as detached process
  fs.writeFileSync(LOG_FILE, "", "utf8");
  const logFd = fs.openSync(LOG_FILE, "w");

  // The deploy runs as a three-step shell chain rather than a bare `cdk`:
  //
  //   1. cdk deploy
  //   2. append the exit code as an exact marker
  //   3. re-invoke this file in --record mode
  //
  // Step 3 is the whole point. It runs in the detached tree, so it survives
  // this MCP process exiting and the agent's iteration ending — the record
  // gets written by the deploy itself instead of by a later agent turn that
  // may never happen. Its output goes to a separate log so `logTail` keeps
  // showing CDK output rather than recorder chatter.
  // Every stack this flock deploys is tagged, and CloudFormation copies stack
  // tags onto each resource that supports them. The tags are what the control
  // plane's IAM is scoped by: the Lambda may only delete stacks carrying
  // KiroFlockManaged, and a deployer agent may only push to CodeCommit
  // repositories carrying it. Without them this deploy would succeed and then
  // be undeletable from the dashboard. Keys match DEPLOY_TAG_KEY in the stack.
  const tags = [
    `--tags KiroFlockManaged=true`,
    `--tags ${sq(`KiroFlockGroup=${EVERFORGE_GROUP ?? "default"}`)}`,
    `--tags ${sq(`KiroFlockCluster=${CLUSTER_PREFIX}`)}`,
  ].join(" ");
  // The qualifier selects the kflock bootstrap roles and asset bucket for an
  // app that does not set its own synthesizer; an app that hardcodes another
  // qualifier would try hnb659fds, which DeployerRole cannot assume.
  // `--method direct`: CreateStack / UpdateStack instead of change sets. The
  // kflock deploy role is tag-scoped, and a change set's tags only land on
  // ExecuteChangeSet, so a new stack could never be executed; a direct
  // CreateStack carries the tag in the request.
  // The permissions boundary is written to ~/.cdk.json (writeBoundaryContext),
  // not passed with --context: on the command line the value reaches the app
  // as a string and the CDK silently ignores it, so the roles went out without
  // a boundary and the execution role refused them.
  writeBoundaryContext();
  const bootstrap = [
    `--toolkit-stack-name ${sq(TOOLKIT_STACK_NAME)}`,
    `--context ${sq(`@aws-cdk/core:bootstrapQualifier=${BOOTSTRAP_QUALIFIER}`)}`,
    `--method direct`,
  ].join(" ");
  // `cdk` is the CLI baked into the agent image (docker/Dockerfile.agent) or
  // installed by the EC2 user data; never fetched at run time.
  const script = [
    `cdk deploy ${sq(params.stackName)} --require-approval never ${bootstrap} ${tags}`,
    `echo "${EXIT_MARKER}$?" >> ${sq(LOG_FILE)}`,
    `${sq(process.execPath)} ${sq(__filename)} --record ${sq(MANIFEST_KEY)} >> ${sq(RECORD_LOG_FILE)} 2>&1`,
  ].join("\n");

  const proc = spawn("sh", ["-c", script], {
    cwd: params.cwd,
    stdio: ["ignore", logFd, logFd],
    detached: true,
    env: { ...process.env, AWS_DEFAULT_REGION: REGION },
  });

  // This is the shell's pid, so aliveness covers the whole chain including the
  // recorder — "deploying" stays true until the record has been written.
  const pid = proc.pid!;
  fs.writeFileSync(PID_FILE, String(pid), "utf8");
  proc.unref();

  // Close log fd in this process (the child inherited it)
  try { fs.closeSync(logFd); } catch { /* ok */ }

  return { pid };
}

// ---- Detect deploy completion from a running/completed process ----

interface DeployProcessState {
  running: boolean;
  /** Exit code of `cdk deploy`, or null when the process is still running or
   *  died without writing the marker (killed, or the instance was reaped). */
  exitCode: number | null;
  pid: number | null;
}

/**
 * What the *local process* is doing. Deliberately narrow: this no longer tries
 * to decide whether the deploy succeeded, because a log file cannot answer
 * that reliably. It reports process liveness and the exact exit code, and
 * CloudFormation decides the outcome.
 */
function getDeployProcessState(): DeployProcessState {
  const pid = readPid();
  if (!pid) return { running: false, exitCode: null, pid: null };

  if (isProcessAlive(pid)) {
    return { running: true, exitCode: null, pid };
  }

  try {
    const content = fs.readFileSync(LOG_FILE, "utf8");
    // Last marker wins — the log is truncated per deploy, but be safe.
    const matches = [...content.matchAll(/AGA_CDK_EXIT=(-?\d+)/g)];
    const last = matches[matches.length - 1];
    if (last) return { running: false, exitCode: parseInt(last[1], 10), pid };
  } catch { /* no log */ }

  return { running: false, exitCode: null, pid };
}

// ---- Reconciliation helpers ----

/** Reconcile the current manifest against CloudFormation. Returns null when
 *  there is no manifest (nothing has ever been deployed by this agent) or the
 *  manifest is local-mode. Never throws: a reconcile failure must not break
 *  `deploy_status`, since the agent still needs an answer. */
async function reconcileCurrent(): Promise<{ manifest: DeployManifest; result: ReconcileResult } | null> {
  let manifest: DeployManifest | null;
  try {
    manifest = await readManifest(s3, BUCKET, MANIFEST_KEY);
  } catch {
    return null;
  }
  if (!manifest || manifest.mode !== "remote") return null;

  try {
    const result = await reconcileDeploy(reconcileClients, manifest, MANIFEST_KEY);
    return { manifest, result };
  } catch (err: unknown) {
    return {
      manifest,
      result: {
        outcome: "no_stack",
        stackStatus: null,
        recordWritten: false,
        writtenKeys: [],
        url: null,
        apiUrl: null,
        warnings: [`Reconcile failed: ${err instanceof Error ? err.message : String(err)}`],
      },
    };
  }
}

/** Mark a terminal outcome as reported, so the agent sees it exactly once.
 *  Durable (S3), unlike the old approach of deleting the PID file. Returns
 *  true when this call is the first to report. */
async function claimTerminalReport(): Promise<boolean> {
  const fresh = await readManifest(s3, BUCKET, MANIFEST_KEY);
  if (!fresh) return true;
  if (fresh.reportedAt) return false;
  await writeManifest(s3, BUCKET, MANIFEST_KEY, {
    ...fresh,
    reportedAt: new Date().toISOString(),
  });
  return true;
}

// ---- MCP tool definitions ----

const tools = [
  {
    name: "deploy_request",
    description:
      "Start a deployment. Trust is decided at cluster configuration time: if this cluster was started with trustDeploy, the deploy starts immediately (remote mode spawns a detached cdk deploy; local mode returns permission to proceed). If not, returns deploy_disabled — a permanent answer, never retry or wait. Deployment records (latest.json, the deployment record, and the [DEPLOYED] changelog entry) are written automatically from CloudFormation state when the deploy finishes — you do not write them yourself, which is why changelog_entry is collected here rather than after the deploy.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string", description: "Local folder containing the CDK app or workload to deploy" },
        stackName: { type: "string", description: "CloudFormation stack name (remote) or service name (local)" },
        mode: { type: "string", enum: ["local", "remote"], description: "Deploy mode: 'local' runs on this instance, 'remote' uses cdk deploy" },
        summary: { type: "string", description: "Short human description of what you are deploying" },
        systemname: { type: "string", description: "System name from your direction, or a short slug" },
        changelog_entry: {
          type: "string",
          description:
            "What changed in this deploy and why, in prose. Written verbatim into the changelog under a [DEPLOYED] heading once the deploy completes. Write it now, before the deploy runs — you know what you are shipping, and this is the last point at which your narrative is guaranteed to be captured.",
        },
      },
      required: ["cwd", "stackName", "mode", "summary", "systemname", "changelog_entry"],
    },
  },
  {
    name: "deploy_status",
    description:
      "Check the current deployment state, derived from CloudFormation rather than from log parsing. Returns one of: no_deploy (nothing in flight — call deploy_request), deploying (with logTail), succeeded, failed, deploy_disabled (deployments off for this cluster, permanent). Also returns stackStatus (CloudFormation's own status string, verbatim), recordWritten, url, and any warnings — e.g. that the stack exposes no URL output. Terminal outcomes are reported once; after that the status returns to no_deploy with a lastDeploy summary.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "deploy_cancel",
    description: "Kill the running deploy process and cancel the CloudFormation stack update.",
    inputSchema: {
      type: "object",
      properties: {
        stackName: { type: "string", description: "Stack the deploy was for (informational; a CloudFormation operation already in progress is not cancelled)" },
      },
    },
  },
];

// ---- JSON-RPC protocol ----

function respond(id: string | number | null, result: unknown): void {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

function respondError(id: string | number | null, code: number, message: string): void {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
}

function toolResult(id: string | number | null, data: Record<string, unknown>): void {
  respond(id, { content: [{ type: "text", text: JSON.stringify(data) }] });
}

// ---- Tool handlers ----

async function handleDeployRequest(id: string | number | null, args: Record<string, unknown>): Promise<void> {
  const cwd = args.cwd as string;
  const stackName = args.stackName as string;
  const mode = args.mode as "local" | "remote";
  const summary = args.summary as string;
  const systemname = args.systemname as string;
  const changelogEntry = (args.changelog_entry as string | undefined) ?? null;

  if (!cwd || !stackName || !mode || !summary || !systemname) {
    toolResult(id, { error: "cwd, stackName, mode, summary, and systemname are all required" });
    return;
  }

  // Check if there's already a live CDK process running
  const procState = getDeployProcessState();
  if (procState.running) {
    toolResult(id, { status: "deploying", pid: procState.pid, logTail: readLogTail(20) });
    return;
  }

  if (!(await isTrusted())) {
    toolResult(id, { status: "deploy_disabled", message: DISABLED_MESSAGE });
    return;
  }

  // Settle any previous deploy before starting a new one. Without this, a
  // deploy that completed while the task was restarted would be overwritten by
  // the fresh manifest and its record lost for good — the exact failure this
  // whole mechanism exists to prevent.
  await reconcileCurrent();

  const requestedAt = new Date().toISOString();
  // Remote mode: the source of record goes to deploy-src/ before anything
  // else happens. A snapshot that fails is a deploy that does not start.
  let sourcePrefix: string | null = null;
  if (mode === "remote") {
    try {
      sourcePrefix = await snapshotSource(cwd, stackName, requestedAt);
    } catch (err: unknown) {
      toolResult(id, { error: `could not snapshot the deploy source: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }
  }
  // Record intent durably *before* spawning. The manifest is what the
  // post-deploy hook reads, so it has to exist first.
  const manifest: DeployManifest = {
    stackName,
    systemname,
    mode,
    cwd,
    sourcePrefix,
    summary,
    changelogEntry,
    everforgeGroup: EVERFORGE_GROUP,
    clusterId: CLUSTER_PREFIX,
    agentId: AGENT_ID,
    region: REGION,
    requestedAt,
    pid: null,
    recordedAt: null,
    recordedStackTime: null,
    reportedAt: null,
    urlWarning: null,
  };
  await writeManifest(s3, BUCKET, MANIFEST_KEY, manifest);
  // Pointer in the group's deployed/ folder so the Lambda (and therefore the
  // dashboard) can find this deploy without enumerating cluster store prefixes.
  await writeIntentPointer(s3, BUCKET, manifest, MANIFEST_KEY);

  const result = startDeployProcess({ cwd, stackName, mode });
  if ("immediate" in result) {
    toolResult(id, { status: "deploying", mode: "local", message: "Trusted. Proceed with local deployment." });
    return;
  }

  await writeManifest(s3, BUCKET, MANIFEST_KEY, { ...manifest, pid: result.pid });

  // Preflight after spawning, not before — the answer is advisory and must
  // never delay or block the deploy itself.
  const bootstrapWarning = await checkCdkBootstrap().catch(() => null);

  toolResult(id, {
    status: "deploying",
    pid: result.pid,
    ...(bootstrapWarning ? { warnings: [bootstrapWarning] } : {}),
    message:
      "Deploy started. The deployment record (latest.json, deployment record, [DEPLOYED] changelog entry) " +
      "will be written automatically from CloudFormation state when it finishes. Do not write those files yourself.",
  });
}

async function handleDeployStatus(id: string | number | null): Promise<void> {
  const procState = getDeployProcessState();

  // Always reconcile. It is idempotent and cheap, and it is what closes the
  // window where a task restart lost the outcome of a completed deploy.
  const reconciled = await reconcileCurrent();

  if (procState.running) {
    toolResult(id, {
      status: "deploying",
      pid: procState.pid,
      stackStatus: reconciled?.result.stackStatus ?? null,
      logTail: readLogTail(),
    });
    return;
  }

  if (reconciled) {
    const { manifest, result } = reconciled;

    // CloudFormation still churning even though our process is gone: the task
    // was restarted mid-deploy. The stack is the truth, so report it.
    if (result.outcome === "deploying") {
      toolResult(id, {
        status: "deploying",
        stackStatus: result.stackStatus,
        message:
          "CloudFormation is still updating this stack, but the local deploy process is gone " +
          "(the task was most likely restarted). The record will be written as soon as the stack settles.",
        logTail: readLogTail(20),
      });
      return;
    }

    if (result.outcome === "succeeded" || result.outcome === "failed") {
      const first = await claimTerminalReport();
      if (first) {
        toolResult(id, {
          status: result.outcome,
          stackStatus: result.stackStatus,
          stackName: manifest.stackName,
          systemname: manifest.systemname,
          recordWritten: result.recordWritten,
          writtenKeys: result.writtenKeys,
          url: result.url,
          apiUrl: result.apiUrl,
          warnings: result.warnings,
          logTail: readLogTail(),
          message: result.outcome === "succeeded"
            ? "Deployment records have already been written from CloudFormation state. Broadcast deploy.completed; do not write latest.json or the deployment record yourself."
            : "Deploy failed. Record the failure in deploy-log.md and broadcast deploy.failed.",
        });
        return;
      }
      // Already reported. Fall through to no_deploy with a summary so the
      // agent does not loop on a stale terminal status.
      toolResult(id, {
        status: "no_deploy",
        message: "No deployment in progress. Call deploy_request when you have something to ship.",
        lastDeploy: {
          stackName: manifest.stackName,
          systemname: manifest.systemname,
          outcome: result.outcome,
          stackStatus: result.stackStatus,
          recordedAt: manifest.recordedAt,
          url: result.url,
        },
      });
      return;
    }

    // outcome === "no_stack": CDK never got as far as creating the stack.
    // This is the one case where the process exit code is the best signal.
    if (procState.pid && procState.exitCode !== null && procState.exitCode !== 0) {
      const first = await claimTerminalReport();
      if (first) {
        const logTail = readLogTail();
        const classified = classifyDeployFailure(logTail);
        toolResult(id, {
          status: "failed",
          stackStatus: null,
          exitCode: procState.exitCode,
          warnings: result.warnings,
          message: classified ??
            (`cdk exited ${procState.exitCode} and no CloudFormation stack named "${manifest.stackName}" exists. ` +
            "The deploy failed before reaching CloudFormation — check logTail for a synth or credentials error."),
          logTail,
        });
        return;
      }
    }
  }

  // No manifest, or nothing conclusive. Ready state depends only on trust.
  if (await isTrusted()) {
    toolResult(id, { status: "no_deploy", message: "No deployment in progress. Call deploy_request to deploy." });
  } else {
    toolResult(id, { status: "deploy_disabled", message: DISABLED_MESSAGE });
  }
}

function handleDeployCancel(id: string | number | null, args: Record<string, unknown>): void {
  const stackName = args.stackName as string | undefined;
  const results: string[] = [];
  const pid = readPid();
  if (pid && isProcessAlive(pid)) {
    try {
      // The shell was spawned detached, so it leads its own process group;
      // the negative pid reaches `cdk` and its children as well as the shell.
      process.kill(-pid, "SIGTERM");
      results.push(`Stopped the deploy process group (PID ${pid})`);
    } catch (err) {
      results.push(`Could not stop the deploy process: ${err}`);
    }
  } else {
    results.push("No running deploy process to stop");
  }
  try { fs.unlinkSync(PID_FILE); } catch { /* ok */ }
  // CloudFormation is not cancelled from here: the agent image has no aws CLI,
  // and neither this agent nor the kflock deploy role holds CancelUpdateStack.
  // An in-flight create or update finishes or rolls back on its own;
  // deploy_status reports the outcome.
  if (stackName) {
    results.push(`Any CloudFormation operation on ${stackName} already in progress continues to completion or rollback; poll deploy_status for the result.`);
  }
  toolResult(id, { status: "cancelled", details: results });
}

// ---- One-shot recorder mode (`--record <manifestKey>`) ----

/**
 * Invoked by the detached shell chain immediately after `cdk deploy` returns.
 * This is the primary path by which deployment records get written, and it
 * involves no agent turn: the process that ran the deploy also writes the
 * record, so an iteration dying at the wrong moment can no longer hide a
 * successful deploy.
 *
 * Deliberately forgiving. If the stack is still settling (CloudFormation can
 * lag the CDK CLI slightly) nothing is written and the backstop reconcile in
 * `deploy_status` picks it up. Exits 0 either way — a failure here must not
 * look like a deploy failure.
 */
async function runRecorderMode(key: string): Promise<void> {
  try {
    const manifest = await readManifest(s3, BUCKET, key);
    if (!manifest) {
      process.stdout.write(`[record] no manifest at ${key}; nothing to do\n`);
      return;
    }
    const result = await reconcileDeploy(reconcileClients, manifest, key);
    process.stdout.write(
      `[record] outcome=${result.outcome} stackStatus=${result.stackStatus ?? "-"} ` +
      `written=${result.recordWritten} url=${result.url ?? "-"}\n`,
    );
    for (const w of result.warnings) process.stdout.write(`[record] warning: ${w}\n`);
    for (const k of result.writtenKeys) process.stdout.write(`[record] wrote ${k}\n`);
  } catch (err: unknown) {
    process.stdout.write(
      `[record] failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
    );
  }
}

const recordFlagIndex = process.argv.indexOf("--record");
if (recordFlagIndex !== -1) {
  const key = process.argv[recordFlagIndex + 1] ?? MANIFEST_KEY;
  void runRecorderMode(key).then(() => process.exit(0));
} else {
  startMcpServer();
}

// ---- JSON-RPC stdin/stdout transport ----

function startMcpServer(): void {
const rl = readline.createInterface({ input: process.stdin });

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let msg: { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }

  const { method, id = null } = msg;

  switch (method) {
    case "initialize":
      respond(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "aga-deploy", version: "4.0.0" },
      });
      break;

    case "notifications/initialized":
      break; // no response

    case "tools/list":
      respond(id, { tools });
      break;

    case "tools/call": {
      const params = msg.params as { name: string; arguments?: Record<string, unknown> };
      const toolName = params.name;
      const toolArgs = params.arguments || {};

      // Both handlers touch S3 and CloudFormation. A rejection that escapes
      // here would never produce a JSON-RPC response, leaving the agent
      // blocked on a call that can never return — so every async path gets a
      // terminal error response instead.
      const failTool = (err: unknown) => {
        toolResult(id, {
          status: "error",
          error: err instanceof Error ? err.message : String(err),
          message: "The deploy MCP failed to complete this call. Broadcast the failure and continue with other work.",
        });
      };

      switch (toolName) {
        case "deploy_request":
          handleDeployRequest(id, toolArgs).catch(failTool);
          break;
        case "deploy_status":
          handleDeployStatus(id).catch(failTool);
          break;
        case "deploy_cancel":
          handleDeployCancel(id, toolArgs);
          break;
        default:
          respondError(id, -32601, `Unknown tool: ${toolName}`);
      }
      break;
    }

    default:
      if (id != null) {
        respondError(id, -32601, `Method not found: ${method}`);
      }
  }
});

rl.on("close", () => process.exit(0));
}
