/**
 * Shared infra-pricing helpers.
 *
 * Single source of truth for reading `config/pricing.json` (written by
 * install.sh) and turning it into a per-agent hourly USD rate. Used by
 * snapshotBuilder.ts (live infra cost), dashboardBuilder.ts (per-run cost
 * series), and handler.ts (run.json totals at archive time).
 */
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import type { ClusterConfig } from "./s3Store";

/** Shape of config/pricing.json written by install.sh. */
export interface PricingCatalog {
  fetchedAt: string;
  region: string;
  ec2: Record<string, number>; // instanceType -> USD/hr
  fargate: { vcpuPerHour: number; gbPerHour: number };
}

/** Fargate task size -> vCPU and memory GB. Mirrors ecsManager TASK_SIZES. */
export const FARGATE_SIZES: Record<string, { vcpus: number; memoryGb: number }> = {
  small:  { vcpus: 2,  memoryGb: 4 },
  medium: { vcpus: 4,  memoryGb: 8 },
  large:  { vcpus: 8,  memoryGb: 16 },
  xlarge: { vcpus: 16, memoryGb: 32 },
};

let _pricingCache: PricingCatalog | null | undefined = undefined;
let _pricingCacheAtMs = 0;
// Re-read config/pricing.json from S3 at most this often. Lambda containers
// are kept warm across many invocations, so an unconditional "cache for
// container lifetime" would mean a container that went warm before
// install.sh wrote/fixed the file never sees the update until AWS happens
// to recycle it. A short TTL keeps the GetObject cost negligible while
// ensuring a fresh install.sh run is picked up quickly.
const PRICING_CACHE_TTL_MS = 5 * 60_000;

/** Load the pricing catalog from S3, cached with a short TTL. */
export async function loadPricingCatalog(s3: S3Client, bucket: string): Promise<PricingCatalog | null> {
  if (_pricingCache !== undefined && Date.now() - _pricingCacheAtMs < PRICING_CACHE_TTL_MS) {
    return _pricingCache;
  }
  try {
    const res = await s3.send(new GetObjectCommand({
      Bucket: bucket,
      Key: "config/pricing.json",
    }));
    const text = await res.Body!.transformToString();
    _pricingCache = JSON.parse(text) as PricingCatalog;
  } catch (err: unknown) {
    // Never silent: a missing file is expected on pre-pricing deployments,
    // but AccessDenied here means a broken IAM grant and must be visible.
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`loadPricingCatalog: config/pricing.json unavailable — infra cost will be null: ${message}`);
    _pricingCache = null;
  }
  _pricingCacheAtMs = Date.now();
  return _pricingCache;
}

/**
 * Hourly infra rate for ONE agent runtime (one EC2 instance or one Fargate
 * task) under this cluster's config. Null when pricing/config is missing
 * or the instance type has no pricing entry.
 */
export function perAgentHourlyRate(
  pricing: PricingCatalog | null,
  config: Pick<ClusterConfig, "computeType" | "instanceType" | "taskSize"> | null,
): number | null {
  if (!pricing || !config) return null;
  const computeType = config.computeType === "ecs" ? "ecs" : "ec2";
  if (computeType === "ec2") {
    const instanceType = config.instanceType || "t4g.medium";
    const hourlyRate = pricing.ec2[instanceType];
    if (!hourlyRate) {
      console.warn(`infraCost: no pricing entry for instanceType "${instanceType}"`);
      return null;
    }
    return hourlyRate;
  }
  // Fargate: vCPU rate + GB rate for the configured task size.
  const size = FARGATE_SIZES[config.taskSize || "medium"] || FARGATE_SIZES.medium;
  return pricing.fargate.vcpuPerHour * size.vcpus + pricing.fargate.gbPerHour * size.memoryGb;
}
