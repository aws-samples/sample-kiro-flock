/**
 * Uploads local files to the cluster's S3 bucket.
 *
 * Two target areas, each with different semantics:
 *   - environment/ (per-run working area, archived on every cluster_start,
 *                  scoped per cluster as environment/{cluster_id}/)
 *   - knowledge-base/ (persistent reference material, shared across clusters)
 *
 * The kiro-flock API doesn't expose a direct upload endpoint for either area,
 * so we write to S3 directly. The bucket name and region come from env vars.
 *
 * Multi-cluster layout
 * --------------------
 * Environment uploads go under `environment/{cluster_id}/{key}`. When a
 * cluster_id is not provided, we fall back to `cluster_0` to preserve
 * backwards compatibility with single-cluster deployments.
 *
 * Knowledge-base is a single shared resource. It is not scoped by cluster_id;
 * every cluster reads the same knowledge-base.
 *
 * Required env vars (in addition to FLOCK_API_URL / FLOCK_COGNITO_TOKEN):
 *   FLOCK_S3_BUCKET  — S3 bucket name (required for any upload)
 *   FLOCK_S3_REGION  — AWS region of the bucket (default: us-east-1)
 *
 * AWS credentials must be available in the environment (e.g. via
 * AWS_PROFILE, AWS_ACCESS_KEY_ID/SECRET, or an IAM role).
 */

import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import { readFile, readdir } from "node:fs/promises";
import { join, relative, basename } from "node:path";
import type { FlockClient } from "./flockClient.js";

type Target = "environment" | "knowledge-base";

/** Default cluster used when no cluster_id is provided by the caller. */
const DEFAULT_CLUSTER_ID = "cluster_0";

export class Uploader {
  private s3: S3Client | null = null;
  private bucket: string | null = null;

  constructor(private readonly flockClient: FlockClient) {}

  private async appendReadEnvironmentToDirection(clusterId?: string): Promise<void> {
    const suffix = "Read the environment/ directory first.";
    const current = await this.flockClient.getDirection(clusterId).catch(() => "");
    if (!current.includes(suffix)) {
      await this.flockClient.setDirection(
        current ? `${current}\n\n${suffix}` : suffix,
        clusterId
      );
    }
  }

  private async getS3(): Promise<{ s3: S3Client; bucket: string }> {
    if (this.s3 && this.bucket) {
      return { s3: this.s3, bucket: this.bucket };
    }

    const bucket = process.env.FLOCK_S3_BUCKET;
    const region = process.env.FLOCK_S3_REGION ?? "us-east-1";

    if (!bucket) {
      throw new Error(
        "FLOCK_S3_BUCKET must be set to upload files. " +
        "Find the bucket name in the kiro-flock CDK stack outputs."
      );
    }

    this.bucket = bucket;
    this.s3 = new S3Client({
      region,
      credentials: fromNodeProviderChain(),
    });
    return { s3: this.s3, bucket: this.bucket };
  }

  /**
   * Build the full S3 key for a file under the given target area.
   *
   *   environment/{cluster_id}/{relativeKey}
   *   knowledge-base/{relativeKey}
   *
   * For environment uploads, clusterId defaults to cluster_0 so existing
   * single-cluster flows keep working.
   */
  private buildS3Key(target: Target, relativeKey: string, clusterId?: string): string {
    if (target === "environment") {
      const cluster = clusterId ?? DEFAULT_CLUSTER_ID;
      return `environment/${cluster}/${relativeKey}`;
    }
    return `${target}/${relativeKey}`;
  }

  /**
   * Upload a single file to the given target area.
   * Returns the key used, relative to the target prefix (i.e. the key the
   * caller supplied or a basename-derived default, not the full S3 key).
   *
   * Only environment uploads append the "read environment/ first" note to the
   * direction; knowledge-base is durable and agents read it every iteration
   * per the agent-loop prompt, so no nudge is needed.
   *
   * @param target       which area to upload into
   * @param localPath    path to the local file
   * @param key          destination key within the target area (defaults to basename)
   * @param clusterId    target cluster for environment uploads; ignored for knowledge-base
   */
  async uploadFile(
    target: Target,
    localPath: string,
    key?: string,
    clusterId?: string
  ): Promise<string> {
    const { s3, bucket } = await this.getS3();

    const resolvedKey = key ?? basename(localPath);
    const s3Key = this.buildS3Key(target, resolvedKey, clusterId);

    const content = await readFile(localPath);
    const contentType = guessContentType(localPath);

    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: s3Key,
        Body: content,
        ContentType: contentType,
      })
    );

    if (target === "environment") {
      await this.appendReadEnvironmentToDirection(clusterId);
    }
    return resolvedKey;
  }

  /**
   * Recursively upload all files in a local folder.
   * Returns the list of keys uploaded, relative to the target prefix.
   *
   * @param target       which area to upload into
   * @param localPath    path to the local folder
   * @param prefix       optional prefix within the target area
   * @param clusterId    target cluster for environment uploads; ignored for knowledge-base
   */
  async uploadFolder(
    target: Target,
    localPath: string,
    prefix?: string,
    clusterId?: string
  ): Promise<string[]> {
    const files = await collectFiles(localPath);
    const uploaded: string[] = [];

    // Upload in parallel batches of 10 to avoid overwhelming S3
    const batchSize = 10;
    for (let i = 0; i < files.length; i += batchSize) {
      const batch = files.slice(i, i + batchSize);
      const results = await Promise.all(
        batch.map(async (filePath) => {
          const rel = relative(localPath, filePath);
          const key = prefix ? `${prefix.replace(/\/$/, "")}/${rel}` : rel;
          return this.uploadFile(target, filePath, key, clusterId);
        })
      );
      uploaded.push(...results);
    }

    return uploaded;
  }
}

/** Recursively collect all file paths under a directory. */
async function collectFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const results: string[] = [];

  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await collectFiles(full)));
    } else if (entry.isFile()) {
      results.push(full);
    }
  }

  return results;
}

/** Best-effort content type from file extension. */
function guessContentType(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    md: "text/markdown",
    txt: "text/plain",
    json: "application/json",
    ts: "text/plain",
    js: "text/javascript",
    py: "text/x-python",
    html: "text/html",
    css: "text/css",
    yaml: "text/yaml",
    yml: "text/yaml",
    csv: "text/csv",
    pdf: "application/pdf",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    svg: "image/svg+xml",
  };
  return map[ext] ?? "application/octet-stream";
}
