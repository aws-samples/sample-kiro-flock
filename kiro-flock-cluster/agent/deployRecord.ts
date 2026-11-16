/**
 * Deploy record writing — CloudFormation is the source of truth.
 *
 * Why this module exists
 * ----------------------
 * Deployment records (`deployed/latest.json`, `deployed/deployment-<name>.md`,
 * and the `[DEPLOYED]` marker in `deployed/changelog.md`) used to be written by
 * the *agent*, prompted to do so after observing a "succeeded" status. That
 * signal was edge-triggered, consumed-once, and stored in `/tmp`:
 *
 *   - `deploy_status` deleted the PID file after reporting success, so
 *     "succeeded" was observable for exactly one iteration. If that iteration
 *     died before finishing the write (context overflow, throttling), the
 *     signal was gone forever and the next iteration saw `no_deploy`.
 *   - `/tmp` does not survive a Fargate task restart, so a restart between
 *     submitting a deploy and observing it made the outcome unknowable.
 *   - Success was decided by grepping the CDK log for "✅" / "Stack ARN:" /
 *     "successfully" — which also mislabels `UPDATE_ROLLBACK_COMPLETE`
 *     (a failure) as a success.
 *
 * The net effect: a perfectly healthy stack with no record, and a blank
 * Continuous Deployments view in the dashboard, because `findStackName()`
 * reads `stackName` out of `latest.json`.
 *
 * This module replaces all of that with level-triggered reconciliation:
 *
 *   1. Intent is durable. `deploy_request` writes a manifest to S3
 *      (`{clusterId}/store/deploys/agent-{n}.json`) recording the stack name,
 *      system name, group, and the agent's changelog prose. Nothing is ever
 *      deleted, so the state can be re-derived any number of times.
 *   2. Truth comes from CloudFormation. `reconcileDeploy()` asks
 *      `DescribeStacks` what actually happened rather than parsing a log.
 *   3. Writes are idempotent. `recordedAt` / `recordedStackTime` on the
 *      manifest latch the write, so reconciling fifty times writes once — and
 *      a *new* deploy of the same stack (newer stack change time) writes again.
 *
 * That makes the record safe to produce from several places, all calling this
 * one function: the post-deploy hook in the detached CDK process chain (the
 * primary path, which involves no agent turn at all), and `deploy_request` /
 * `deploy_status` as a backstop for when the task was restarted mid-deploy.
 *
 * Local-mode deploys are out of scope here — they create no CloudFormation
 * stack, so there is nothing to reconcile against. `reconcileDeploy()` returns
 * `outcome: "not_applicable"` for them and leaves the manifest untouched.
 */
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import {
  CloudFormationClient,
  DescribeStacksCommand,
  DescribeStackResourcesCommand,
} from "@aws-sdk/client-cloudformation";
import {
  CloudFrontClient,
  GetDistributionCommand,
} from "@aws-sdk/client-cloudfront";

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

/** Durable record of deploy *intent*, written by `deploy_request` before the
 *  CDK process starts. Replaces `/tmp/deploy.pid` as the thing that tells us
 *  what is in flight — the PID file only ever held a number, which is why
 *  `deploy_status` could not name the stack it had just deployed. */
export interface DeployManifest {
  /** CloudFormation stack name — the field `findStackName()` ultimately needs. */
  stackName: string;
  /** Short slug identifying the system, used in the record filename. */
  systemname: string;
  mode: "local" | "remote";
  /** Directory the CDK app was deployed from. Informational. */
  cwd: string;
  /** S3 prefix under deploy-src/ holding a copy of `cwd` taken before the
   *  deploy started. Only DeployerRole can write there, so it is the record of
   *  what was deployed. Null for local-mode deploys and for manifests written
   *  before the prefix existed. */
  sourcePrefix?: string | null;
  /** One-line human description of the deploy. */
  summary: string;
  /**
   * Changelog prose, captured at request time rather than after the deploy.
   * The agent knows what it is shipping *before* it ships; the turn that
   * observes completion is the fragile one. Genuine narrative content stays
   * agent-authored, but we collect it while the author is provably alive.
   */
  changelogEntry: string | null;
  everforgeGroup: string | null;
  clusterId: string;
  agentId: string;
  region: string;
  requestedAt: string;
  pid: number | null;
  /** Set once the record has been written. The idempotency latch — and it
   *  lives in S3, so it survives the task restarts that used to lose it. */
  recordedAt: string | null;
  /** CloudFormation's own change time at the moment we wrote the record. A
   *  later deploy of the same stack has a newer time, which re-arms the
   *  write without needing the latch to be cleared. */
  recordedStackTime: string | null;
  /**
   * Set once a terminal outcome (succeeded / failed) has been reported to the
   * agent. Replaces the old trick of deleting `/tmp/deploy.pid` to make
   * "succeeded" a once-only observation: that latch was ephemeral, so a task
   * restart re-reported stale outcomes, and an iteration that died after
   * observing it lost the outcome entirely. This one is durable.
   */
  reportedAt: string | null;
  /** Populated when no URL could be resolved from the stack, so
   *  `deploy_status` can surface it to the agent. */
  urlWarning?: string | null;
}

/** `{clusterId}/store/deploys/agent-{n}.json`.
 *
 *  Deliberately sits under the wildcard store prefix the agent role already has
 *  both GetObject and PutObject on, so no IAM change is needed. There is no
 *  DeleteObject grant on store/, which suits us: the manifest is never
 *  deleted, only updated in place. */
export function manifestKey(clusterId: string, agentIndex: string | number): string {
  return `${clusterId}/store/deploys/agent-${agentIndex}.json`;
}

/** Mirrors `lambda/s3Store.ts#deployedPrefix` so both sides agree on where
 *  records live. Everforge groups nest; ungrouped clusters share one folder. */
export function deployedPrefix(everforgeGroup?: string | null): string {
  return everforgeGroup
    ? `environment/${everforgeGroup}/deployed/`
    : `environment/deployed/`;
}

/**
 * A tiny pointer written into the group's `deployed/` folder at request time,
 * naming the authoritative manifest.
 *
 * It exists so anything that can read the bucket can find an in-flight or
 * unrecorded deploy without having to enumerate every cluster's store prefix
 * (S3 cannot wildcard the middle of a prefix, so discovery would otherwise mean
 * reading the cluster registry and listing per cluster).
 *
 * Note this is *intent*, written before the deploy finishes — as opposed to
 * `latest.json`, which is *outcome*. That distinction is what lets a reader
 * name the stack while a deploy is still running, and lets the Lambda
 * reconcile a record the agent never got around to.
 */
export interface IntentPointer {
  /** S3 key of the authoritative manifest, so readers latch the right file
   *  rather than a divergent copy. */
  manifestKey: string;
  stackName: string;
  systemname: string;
  clusterId: string;
  requestedAt: string;
}

export function intentPointerKey(everforgeGroup?: string | null): string {
  return `${deployedPrefix(everforgeGroup)}manifest.json`;
}

export async function writeIntentPointer(
  s3: S3Client,
  bucket: string,
  manifest: DeployManifest,
  manifestS3Key: string,
): Promise<void> {
  const pointer: IntentPointer = {
    manifestKey: manifestS3Key,
    stackName: manifest.stackName,
    systemname: manifest.systemname,
    clusterId: manifest.clusterId,
    requestedAt: manifest.requestedAt,
  };
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: intentPointerKey(manifest.everforgeGroup),
    Body: JSON.stringify(pointer, null, 2),
    ContentType: "application/json",
  }));
}

export async function readIntentPointer(
  s3: S3Client,
  bucket: string,
  everforgeGroup?: string | null,
): Promise<IntentPointer | null> {
  try {
    const resp = await s3.send(new GetObjectCommand({
      Bucket: bucket,
      Key: intentPointerKey(everforgeGroup),
    }));
    const body = await resp.Body?.transformToString();
    if (!body) return null;
    return JSON.parse(body) as IntentPointer;
  } catch (err: unknown) {
    const name = (err as { name?: string }).name;
    if (name === "NoSuchKey" || name === "NotFound") return null;
    throw err;
  }
}

export async function readManifest(
  s3: S3Client,
  bucket: string,
  key: string,
): Promise<DeployManifest | null> {
  try {
    const resp = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const body = await resp.Body?.transformToString();
    if (!body) return null;
    return JSON.parse(body) as DeployManifest;
  } catch (err: unknown) {
    const name = (err as { name?: string }).name;
    if (name === "NoSuchKey" || name === "NotFound") return null;
    throw err;
  }
}

export async function writeManifest(
  s3: S3Client,
  bucket: string,
  key: string,
  manifest: DeployManifest,
): Promise<void> {
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: JSON.stringify(manifest, null, 2),
    ContentType: "application/json",
  }));
}

// ---------------------------------------------------------------------------
// CloudFormation status classification
// ---------------------------------------------------------------------------

export type DeployOutcome =
  | "deploying"
  | "succeeded"
  | "failed"
  | "no_stack"
  | "not_applicable";

/** The only three statuses that mean "this deploy worked". Everything else
 *  that is not in-progress is a failure — including `UPDATE_ROLLBACK_COMPLETE`,
 *  which the old log-grep counted as success because CDK still prints
 *  "successfully" on the way to a rollback. */
const SUCCESS_STATUSES = new Set([
  "CREATE_COMPLETE",
  "UPDATE_COMPLETE",
  "IMPORT_COMPLETE",
]);

export function classifyStackStatus(status: string): DeployOutcome {
  if (status.endsWith("_IN_PROGRESS")) return "deploying";
  if (SUCCESS_STATUSES.has(status)) return "succeeded";
  return "failed";
}

// ---------------------------------------------------------------------------
// URL resolution
// ---------------------------------------------------------------------------

/**
 * Output keys we accept as the public site URL, in priority order. Agent-
 * authored stacks are inconsistent about naming, so we cast a reasonably wide
 * net rather than mandating one key.
 */
const SITE_URL_KEYS = [
  "SiteUrl", "SiteURL", "Url", "URL", "WebsiteUrl", "WebsiteURL",
  "AppUrl", "AppURL", "CloudFrontUrl", "CloudFrontURL",
  "DistributionDomainName", "DistributionDomain",
];

/** Output keys we accept as the API URL. Kept separate from the site URL: the
 *  previous operator-side writer set `apiUrl: url` — the same value for both —
 *  which made the field useless for discovery by other clusters. */
const API_URL_KEYS = [
  "ApiUrl", "ApiURL", "ApiEndpoint", "ApiGatewayUrl", "HttpApiUrl", "RestApiUrl",
];

/** Stack outputs often hold a bare domain (`d111111abcdef8.cloudfront.net`)
 *  rather than a URL. The dashboard drops it straight into an iframe `src`,
 *  so it has to carry a scheme. */
function normaliseUrl(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

function pickOutput(
  outputs: Record<string, string>,
  keys: string[],
): string | null {
  for (const key of keys) {
    const value = outputs[key];
    if (value && value.trim()) return normaliseUrl(value);
  }
  return null;
}

export interface ResolvedUrls {
  url: string | null;
  apiUrl: string | null;
  /** How the site URL was found, for the record and for debugging. */
  source: "outputs" | "cloudfront" | "apigateway" | "unresolved";
  warnings: string[];
}

/**
 * Resolve the site and API URLs for a deployed stack.
 *
 * Stack outputs are the contract and the primary path. The resource-derived
 * fallbacks exist because agent-authored CDK stacks routinely forget to
 * declare outputs, and a record with a stack name but no URL leaves the
 * live-preview pane empty.
 *
 * CloudFront needs an API call: a distribution's physical id (`E1ABCDEF`) has
 * no derivable relationship to its default domain
 * (`d111111abcdef8.cloudfront.net`), so `DescribeStackResources` alone cannot
 * get us there. API Gateway is different — the invoke URL is constructible
 * from the REST API id and the region with no extra call and no extra
 * permission.
 */
export async function resolveUrls(
  cfn: CloudFormationClient,
  cloudfront: CloudFrontClient,
  stackName: string,
  region: string,
  outputs: Record<string, string>,
): Promise<ResolvedUrls> {
  const warnings: string[] = [];

  const outputSite = pickOutput(outputs, SITE_URL_KEYS);
  const outputApi = pickOutput(outputs, API_URL_KEYS);

  if (outputSite) {
    return { url: outputSite, apiUrl: outputApi, source: "outputs", warnings };
  }

  // No usable site output — go looking at the stack's resources.
  let resources: { type: string; physicalId: string }[] = [];
  try {
    const desc = await cfn.send(new DescribeStackResourcesCommand({ StackName: stackName }));
    resources = (desc.StackResources || []).map((r) => ({
      type: r.ResourceType || "",
      physicalId: r.PhysicalResourceId || "",
    }));
  } catch (err: unknown) {
    warnings.push(
      `Could not describe stack resources to derive a URL: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const distribution = resources.find(
    (r) => r.type === "AWS::CloudFront::Distribution" && r.physicalId,
  );
  if (distribution) {
    try {
      const resp = await cloudfront.send(
        new GetDistributionCommand({ Id: distribution.physicalId }),
      );
      const domain = resp.Distribution?.DomainName;
      if (domain) {
        return {
          url: normaliseUrl(domain),
          apiUrl: outputApi,
          source: "cloudfront",
          warnings,
        };
      }
    } catch (err: unknown) {
      warnings.push(
        `CloudFront distribution ${distribution.physicalId} found but its domain could not be read: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // CDK's default REST API stage is "prod"; the invoke URL is fully
  // determined by the api id, region, and stage.
  const restApi = resources.find(
    (r) => r.type === "AWS::ApiGateway::RestApi" && r.physicalId,
  );
  if (restApi) {
    const invokeUrl = `https://${restApi.physicalId}.execute-api.${region}.amazonaws.com/prod/`;
    return {
      url: invokeUrl,
      apiUrl: outputApi ?? invokeUrl,
      source: "apigateway",
      warnings,
    };
  }

  warnings.push(
    `Stack ${stackName} exposes no site URL. Declare a CfnOutput named "SiteUrl" (or "Url"/"ApiUrl") ` +
    `so the deployment record can carry it — the Continuous Deployments live preview will be empty until you do.`,
  );
  return { url: null, apiUrl: outputApi, source: "unresolved", warnings };
}

// ---------------------------------------------------------------------------
// Record writing
// ---------------------------------------------------------------------------

export interface RecordFacts {
  stackStatus: string;
  url: string | null;
  apiUrl: string | null;
  urlSource: string;
  outputs: Record<string, string>;
  /** CloudFormation's LastUpdatedTime ?? CreationTime. */
  stackChangeTime: string;
}

function buildLatestJson(manifest: DeployManifest, facts: RecordFacts, timestamp: string) {
  return {
    stackName: manifest.stackName,
    timestamp,
    status: facts.stackStatus,
    url: facts.url,
    apiUrl: facts.apiUrl,
    urlSource: facts.urlSource,
    region: manifest.region,
    systemname: manifest.systemname,
    deployedBy: manifest.agentId,
    clusterId: manifest.clusterId,
    sourcePrefix: manifest.sourcePrefix ?? null,
    stackChangeTime: facts.stackChangeTime,
    outputs: facts.outputs,
  };
}

function buildRecordMarkdown(manifest: DeployManifest, facts: RecordFacts, timestamp: string): string {
  const outputEntries = Object.entries(facts.outputs);
  const frontmatterOutputs = outputEntries.length
    ? ["outputs:", ...outputEntries.map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`)]
    : [];
  const bodyOutputs = outputEntries.length
    ? ["", "**Outputs:**", ...outputEntries.map(([k, v]) => `- **${k}**: ${v}`)]
    : [];

  return [
    "---",
    `systemname: ${manifest.systemname}`,
    `mode: ${manifest.mode}`,
    `agentId: ${manifest.agentId}`,
    `clusterId: ${manifest.clusterId}`,
    `deployedAt: ${timestamp}`,
    `stackName: ${manifest.stackName}`,
    `stackStatus: ${facts.stackStatus}`,
    ...(facts.url ? [`url: ${JSON.stringify(facts.url)}`] : []),
    ...(facts.apiUrl ? [`apiUrl: ${JSON.stringify(facts.apiUrl)}`] : []),
    ...frontmatterOutputs,
    "---",
    "",
    `# Deployment: ${manifest.systemname}`,
    "",
    manifest.summary || `Remote deployment (CDK) by ${manifest.agentId}.`,
    "",
    `**Stack:** ${manifest.stackName}`,
    `**Status:** ${facts.stackStatus}`,
    `**URL:** ${facts.url ?? "(none exposed by the stack)"}`,
    ...(facts.apiUrl ? [`**API URL:** ${facts.apiUrl}`] : []),
    ...bodyOutputs,
    "",
    `_Record written from CloudFormation state by the deploy MCP._`,
    "",
  ].join("\n");
}

/**
 * Write the three deployment artifacts. Called only when reconciliation has
 * decided a write is due, so this function does not re-check the latch.
 *
 * `latest.json` is written even when no URL could be resolved: the
 * dashboard's `findStackName()` only needs `stackName`, and that alone
 * restores the stack button, the monitoring grid, and the graphs. Only the
 * live-preview iframe needs `url`. A stackName-only record is far better
 * than no record.
 */
async function writeArtifacts(
  s3: S3Client,
  bucket: string,
  manifest: DeployManifest,
  facts: RecordFacts,
  timestamp: string,
): Promise<string[]> {
  const prefix = deployedPrefix(manifest.everforgeGroup);
  const written: string[] = [];

  // 1. latest.json — the file the Continuous Deployments view reads.
  const latestKey = `${prefix}latest.json`;
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: latestKey,
    Body: JSON.stringify(buildLatestJson(manifest, facts, timestamp), null, 2),
    ContentType: "application/json",
  }));
  written.push(latestKey);

  // 2. changelog.md — move the [DEPLOYED] marker to this deploy's entry and
  //    prepend it. The prose is the agent's, captured at request time; the
  //    marker flip is mechanical, which is why it belongs here and not in a
  //    prompt instruction.
  const changelogKey = `${prefix}changelog.md`;
  let existing = "";
  try {
    const resp = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: changelogKey }));
    existing = (await resp.Body?.transformToString()) ?? "";
  } catch { /* first deploy — no changelog yet */ }
  const cleaned = existing.replace(/\[DEPLOYED\]\s*/g, "");

  const prose = manifest.changelogEntry?.trim()
    || `Deployed ${manifest.stackName}.`;
  const entry = [
    `## [DEPLOYED] ${timestamp} — ${manifest.systemname}`,
    "",
    prose,
    "",
    `- Stack: ${manifest.stackName} (${facts.stackStatus})`,
    `- URL: ${facts.url ?? "(none exposed by the stack)"}`,
    `- Deployed by: ${manifest.agentId} (${manifest.clusterId})`,
    ...(manifest.sourcePrefix ? [`- Source: s3://<flock bucket>/${manifest.sourcePrefix}`] : []),
    "",
  ].join("\n");

  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: changelogKey,
    Body: entry + "\n" + cleaned,
    ContentType: "text/markdown",
  }));
  written.push(changelogKey);

  // 3. deployment-<systemname>.md — the per-system record other clusters read
  //    to discover endpoints.
  const recordKey = `${prefix}deployment-${manifest.systemname}.md`;
  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: recordKey,
    Body: buildRecordMarkdown(manifest, facts, timestamp),
    ContentType: "text/markdown",
  }));
  written.push(recordKey);

  return written;
}

// ---------------------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------------------

export interface ReconcileClients {
  s3: S3Client;
  cfn: CloudFormationClient;
  cloudfront: CloudFrontClient;
  bucket: string;
}

export interface ReconcileResult {
  outcome: DeployOutcome;
  /** CloudFormation's status string, passed through untouched so callers can
   *  distinguish "never deployed" from "deployed, record write pending". */
  stackStatus: string | null;
  recordWritten: boolean;
  writtenKeys: string[];
  url: string | null;
  apiUrl: string | null;
  warnings: string[];
}

/**
 * Bring the deployment record into line with what CloudFormation says.
 *
 * Safe to call repeatedly and concurrently: the write is latched on the
 * manifest, so the post-deploy hook and a later `deploy_status` racing each
 * other produce one record, not two. Worst case both see an unlatched
 * manifest and both write identical content.
 */
export async function reconcileDeploy(
  clients: ReconcileClients,
  manifest: DeployManifest,
  manifestS3Key: string,
): Promise<ReconcileResult> {
  const base: ReconcileResult = {
    outcome: "no_stack",
    stackStatus: null,
    recordWritten: false,
    writtenKeys: [],
    url: null,
    apiUrl: null,
    warnings: [],
  };

  // Local-mode deploys create no stack. Nothing to reconcile against.
  if (manifest.mode === "local") {
    return { ...base, outcome: "not_applicable" };
  }

  let stack;
  try {
    const resp = await clients.cfn.send(
      new DescribeStacksCommand({ StackName: manifest.stackName }),
    );
    stack = resp.Stacks?.[0];
  } catch (err: unknown) {
    // CloudFormation raises ValidationError for a stack that does not exist.
    // That is a real answer, not an error: the CDK CLI failed before it got
    // as far as creating the stack. The caller falls back to the process
    // exit sentinel for that case.
    const message = err instanceof Error ? err.message : String(err);
    if (/does not exist/i.test(message)) {
      return { ...base, outcome: "no_stack" };
    }
    return {
      ...base,
      outcome: "no_stack",
      warnings: [`CloudFormation describe failed: ${message}`],
    };
  }

  if (!stack || !stack.StackStatus) {
    return { ...base, outcome: "no_stack" };
  }

  const stackStatus = stack.StackStatus;
  const outcome = classifyStackStatus(stackStatus);

  if (outcome !== "succeeded") {
    return { ...base, outcome, stackStatus };
  }

  const stackChangeTime = (stack.LastUpdatedTime ?? stack.CreationTime ?? new Date()).toISOString();

  // Latch check. Write when we have never written, or when CloudFormation has
  // moved on since the last record (a fresh deploy of the same stack).
  const alreadyRecorded =
    manifest.recordedAt !== null &&
    manifest.recordedStackTime !== null &&
    manifest.recordedStackTime >= stackChangeTime;

  const outputs: Record<string, string> = {};
  for (const o of stack.Outputs || []) {
    if (o.OutputKey && o.OutputValue !== undefined) outputs[o.OutputKey] = o.OutputValue;
  }

  const resolved = await resolveUrls(
    clients.cfn,
    clients.cloudfront,
    manifest.stackName,
    manifest.region,
    outputs,
  );

  if (alreadyRecorded) {
    return {
      ...base,
      outcome,
      stackStatus,
      url: resolved.url,
      apiUrl: resolved.apiUrl,
      warnings: resolved.warnings,
    };
  }

  const timestamp = new Date().toISOString();
  const facts: RecordFacts = {
    stackStatus,
    url: resolved.url,
    apiUrl: resolved.apiUrl,
    urlSource: resolved.source,
    outputs,
    stackChangeTime,
  };

  const writtenKeys = await writeArtifacts(
    clients.s3,
    clients.bucket,
    manifest,
    facts,
    timestamp,
  );

  // Latch, so subsequent reconciles are no-ops.
  const updated: DeployManifest = {
    ...manifest,
    recordedAt: timestamp,
    recordedStackTime: stackChangeTime,
    urlWarning: resolved.warnings.length ? resolved.warnings.join(" ") : null,
  };
  await writeManifest(clients.s3, clients.bucket, manifestS3Key, updated);

  return {
    outcome,
    stackStatus,
    recordWritten: true,
    writtenKeys,
    url: resolved.url,
    apiUrl: resolved.apiUrl,
    warnings: resolved.warnings,
  };
}

/**
 * Reconcile a group's deploy from its intent pointer.
 *
 * The outermost backstop, for the case neither the post-deploy hook nor the
 * agent's own `deploy_status` can cover: the cluster was stopped before anyone
 * observed the completed deploy. Anything with bucket read/write and
 * CloudFormation read can call this — in practice the API Lambda, on the
 * Continuous Deployments routes, so a stale view repairs itself the moment
 * someone looks at it.
 *
 * Returns the stack name even when no record was written, so a caller can name
 * the stack (and therefore render monitoring) while a deploy is still running.
 * Never throws.
 */
export async function reconcileFromPointer(
  clients: ReconcileClients,
  everforgeGroup: string | null,
): Promise<{ stackName: string; result: ReconcileResult | null } | null> {
  try {
    const pointer = await readIntentPointer(clients.s3, clients.bucket, everforgeGroup);
    if (!pointer) return null;

    const manifest = await readManifest(clients.s3, clients.bucket, pointer.manifestKey);
    if (!manifest) {
      // Pointer without a manifest: the store prefix was rotated. The stack
      // name is still useful.
      return { stackName: pointer.stackName, result: null };
    }

    const result = await reconcileDeploy(clients, manifest, pointer.manifestKey);
    return { stackName: manifest.stackName, result };
  } catch {
    return null;
  }
}
