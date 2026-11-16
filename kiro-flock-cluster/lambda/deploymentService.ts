/**
 * DeploymentService — deployment records only.
 *
 * Trust is decided at cluster configuration time (`trustDeploy`); the
 * runtime approval flow (pending → operator decision) was removed. The only
 * approval-adjacent state left in S3 is the trusted marker files that
 * cluster_start pre-writes at store/approvals/{clusterId}/agent-{N}.json,
 * and those are written by handler.ts and read by the agent-side deploy MCP.
 *
 * S3 layout owned here:
 *   environment/deployed/deployment-<systemname>.md — deployment records
 */
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";

const s3 = new S3Client({});

// ---------------------------------------------------------------------------
// Data models
// ---------------------------------------------------------------------------

export interface DeployRecord {
  systemname: string;
  mode: "local" | "remote";
  agentId: string;
  clusterId: string;
  deployedAt: string;
  // local mode
  privateIp?: string;
  port?: number;
  path?: string;
  // remote mode
  stackName?: string;
  outputs?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Deployment record write
// ---------------------------------------------------------------------------

export async function writeRecord(
  bucket: string,
  record: DeployRecord,
): Promise<string> {
  const key = `environment/deployed/deployment-${record.systemname}.md`;

  // Build markdown with YAML frontmatter
  const frontmatter: Record<string, unknown> = {
    systemname: record.systemname,
    mode: record.mode,
    agentId: record.agentId,
    clusterId: record.clusterId,
    deployedAt: record.deployedAt,
  };

  if (record.mode === "local") {
    frontmatter.privateIp = record.privateIp;
    frontmatter.port = record.port;
    frontmatter.path = record.path;
  } else {
    frontmatter.stackName = record.stackName;
    frontmatter.outputs = record.outputs;
  }

  const yamlLines = Object.entries(frontmatter).map(([k, v]) => {
    if (typeof v === "object" && v !== null) {
      const nested = Object.entries(v as Record<string, string>)
        .map(([ok, ov]) => `  ${ok}: "${ov}"`)
        .join("\n");
      return `${k}:\n${nested}`;
    }
    return `${k}: ${JSON.stringify(v)}`;
  });

  let body: string;
  if (record.mode === "local") {
    body = [
      "---",
      ...yamlLines,
      "---",
      "",
      `# Deployment: ${record.systemname}`,
      "",
      `Local deployment on ${record.agentId} in ${record.clusterId}.`,
      "",
      `- Reach it at http://${record.privateIp}:${record.port}${record.path || "/"} (within the cluster SG only).`,
      "",
    ].join("\n");
  } else {
    const outputLines = record.outputs
      ? Object.entries(record.outputs).map(([k, v]) => `- **${k}**: ${v}`)
      : [];
    body = [
      "---",
      ...yamlLines,
      "---",
      "",
      `# Deployment: ${record.systemname}`,
      "",
      `Remote deployment (CDK) by ${record.agentId} in ${record.clusterId}.`,
      "",
      `**Stack:** ${record.stackName}`,
      "",
      "**Outputs:**",
      ...outputLines,
      "",
    ].join("\n");
  }

  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: body,
    ContentType: "text/markdown",
  }));

  return key;
}

// ---------------------------------------------------------------------------
// Deployment record list
// ---------------------------------------------------------------------------

export async function listRecords(
  bucket: string,
  systemname?: string,
): Promise<DeployRecord[]> {
  if (!systemname) return [];

  const prefix = "environment/deployed/";
  const listed = await s3.send(new ListObjectsV2Command({
    Bucket: bucket,
    Prefix: prefix,
  }));

  const keys = (listed.Contents ?? [])
    .map(o => o.Key)
    .filter((k): k is string => !!k);

  if (keys.length === 0) return [];

  const records: DeployRecord[] = [];

  for (const key of keys) {
    try {
      const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      const content = await res.Body?.transformToString();
      if (!content) continue;

      const parsed = parseFrontmatter(content);
      if (!parsed) continue;
      if (parsed.systemname === systemname) {
        records.push(parsed);
      }
    } catch {
      // skip unreadable records
    }
  }

  return records;
}

/** Parse YAML frontmatter from a deployment record markdown file. */
function parseFrontmatter(content: string): DeployRecord | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;

  const lines = match[1].split("\n");
  const data: Record<string, unknown> = {};
  let currentKey: string | null = null;
  let nestedObj: Record<string, string> | null = null;

  for (const line of lines) {
    // Nested key-value (indented with 2 spaces)
    if (line.startsWith("  ") && currentKey) {
      const kvMatch = line.trim().match(/^([^:]+):\s*"?(.+?)"?$/);
      if (kvMatch && nestedObj) {
        nestedObj[kvMatch[1]] = kvMatch[2];
      }
      continue;
    }

    // Save any pending nested object
    if (currentKey && nestedObj) {
      data[currentKey] = nestedObj;
      nestedObj = null;
      currentKey = null;
    }

    // Top-level key with no value (start of nested object)
    const noValMatch = line.match(/^([^:]+):$/);
    if (noValMatch) {
      currentKey = noValMatch[1];
      nestedObj = {};
      continue;
    }

    // Top-level key-value
    const kvMatch = line.match(/^([^:]+):\s*(.+)$/);
    if (kvMatch) {
      let val: unknown = kvMatch[2];
      // Strip JSON quotes
      if (typeof val === "string" && val.startsWith('"') && val.endsWith('"')) {
        val = val.slice(1, -1);
      }
      // Parse numbers
      if (typeof val === "string" && /^\d+$/.test(val)) {
        val = parseInt(val, 10);
      }
      data[kvMatch[1]] = val;
      currentKey = null;
    }
  }

  // Flush trailing nested
  if (currentKey && nestedObj) {
    data[currentKey] = nestedObj;
  }

  if (!data.systemname || !data.mode) return null;

  return {
    systemname: data.systemname as string,
    mode: data.mode as "local" | "remote",
    agentId: (data.agentId as string) ?? "",
    clusterId: (data.clusterId as string) ?? "",
    deployedAt: (data.deployedAt as string) ?? "",
    privateIp: data.privateIp as string | undefined,
    port: data.port as number | undefined,
    path: data.path as string | undefined,
    stackName: data.stackName as string | undefined,
    outputs: data.outputs as Record<string, string> | undefined,
  };
}

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}
