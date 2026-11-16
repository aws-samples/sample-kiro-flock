#!/usr/bin/env node
/**
 * Fetches on-demand pricing for our supported Graviton EC2 instance types
 * and Fargate ARM rates from the AWS Price List API, then outputs a JSON
 * file suitable for upload to S3 as config/pricing.json.
 *
 * The Pricing API is only available in us-east-1 and ap-south-1.
 * We always query us-east-1 regardless of the deployment region, then
 * filter results to the deployment region.
 *
 * Usage:
 *   node scripts/fetch-pricing.js [--region us-east-1] > pricing.json
 *
 * Output shape:
 * {
 *   "fetchedAt": "2026-07-23T...",
 *   "region": "us-east-1",
 *   "ec2": { "t4g.medium": 0.0336, "m7g.medium": 0.0408, ... },
 *   "fargate": { "vcpuPerHour": 0.03238, "gbPerHour": 0.00356 }
 * }
 */

const {
  PricingClient,
  GetProductsCommand,
} = require("@aws-sdk/client-pricing");

// The Pricing API endpoint only exists in us-east-1 and ap-south-1.
const pricingClient = new PricingClient({ region: "us-east-1" });

// Parse --region flag or fall back to env / default.
const args = process.argv.slice(2);
const regionIdx = args.indexOf("--region");
const DEPLOY_REGION = regionIdx >= 0 && args[regionIdx + 1]
  ? args[regionIdx + 1]
  : process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || "us-east-1";

// Map region code to the Pricing API "location" name.
// NOTE: The Pricing API supports filtering by "regionCode" directly,
// which is more reliable than the human-readable "location" name.
// We use regionCode for EC2 and location for Fargate (which needs it).
const REGION_NAMES = {
  "us-east-1": "US East (N. Virginia)",
  "us-east-2": "US East (Ohio)",
  "us-west-1": "US West (N. California)",
  "us-west-2": "US West (Oregon)",
  "eu-west-1": "EU (Ireland)",
  "eu-west-2": "EU (London)",
  "eu-west-3": "EU (Paris)",
  "eu-central-1": "EU (Frankfurt)",
  "eu-north-1": "EU (Stockholm)",
  "ap-southeast-1": "Asia Pacific (Singapore)",
  "ap-southeast-2": "Asia Pacific (Sydney)",
  "ap-northeast-1": "Asia Pacific (Tokyo)",
  "ap-northeast-2": "Asia Pacific (Seoul)",
  "ap-south-1": "Asia Pacific (Mumbai)",
  "ca-central-1": "Canada (Central)",
  "sa-east-1": "South America (Sao Paulo)",
};

const location = REGION_NAMES[DEPLOY_REGION] || DEPLOY_REGION;

// Instance types we want pricing for. Generated to cover the same space
// the dashboard's instance picker can offer: handler.ts /instance-types
// dynamically discovers the LATEST current-generation Graviton type per
// family+size slot (regex ^(t|c|m|r)\d+g\.(small|medium|large|xlarge)$),
// so a hand-picked list here goes stale the moment AWS ships a new
// generation — which is exactly how c8g.xlarge ended up selectable but
// unpriced. Combinations that don't exist (e.g. t8g.*) simply return no
// price from the API and are skipped.
const EC2_FAMILIES = ["t", "c", "m", "r"];
const EC2_GENERATIONS = [4, 5, 6, 7, 8, 9];
const EC2_SIZES = ["small", "medium", "large", "xlarge"];
const EC2_TYPES = EC2_FAMILIES.flatMap((family) =>
  EC2_GENERATIONS.flatMap((gen) =>
    EC2_SIZES.map((size) => `${family}${gen}g.${size}`)
  )
);

async function fetchEc2Price(instanceType) {
  try {
    const resp = await pricingClient.send(new GetProductsCommand({
      ServiceCode: "AmazonEC2",
      FormatVersion: "aws_v1",
      MaxResults: 1,
      Filters: [
        { Type: "TERM_MATCH", Field: "instanceType", Value: instanceType },
        { Type: "TERM_MATCH", Field: "regionCode", Value: DEPLOY_REGION },
        { Type: "TERM_MATCH", Field: "operatingSystem", Value: "Linux" },
        { Type: "TERM_MATCH", Field: "tenancy", Value: "Shared" },
        { Type: "TERM_MATCH", Field: "preInstalledSw", Value: "NA" },
        { Type: "TERM_MATCH", Field: "capacitystatus", Value: "Used" },
      ],
    }));

    if (!resp.PriceList || resp.PriceList.length === 0) return null;

    const product = JSON.parse(resp.PriceList[0]);
    const onDemand = product.terms?.OnDemand;
    if (!onDemand) return null;

    // Navigate: OnDemand -> first SKU -> priceDimensions -> first dim -> pricePerUnit.USD
    const skuKey = Object.keys(onDemand)[0];
    const dims = onDemand[skuKey]?.priceDimensions;
    if (!dims) return null;
    const dimKey = Object.keys(dims)[0];
    const usd = dims[dimKey]?.pricePerUnit?.USD;
    return usd ? parseFloat(usd) : null;
  } catch (err) {
    console.error(`  [warn] Failed to fetch EC2 price for ${instanceType}: ${err.message}`);
    return null;
  }
}

async function fetchFargateArmPricing() {
  // Fargate ARM pricing has two components: vCPU-hour and GB-hour.
  // ServiceCode is "AmazonECS", filtered by cpuArchitecture=ARM and regionCode.
  const result = { vcpuPerHour: null, gbPerHour: null };

  try {
    const resp = await pricingClient.send(new GetProductsCommand({
      ServiceCode: "AmazonECS",
      FormatVersion: "aws_v1",
      MaxResults: 10,
      Filters: [
        { Type: "TERM_MATCH", Field: "regionCode", Value: DEPLOY_REGION },
        { Type: "TERM_MATCH", Field: "cpuArchitecture", Value: "ARM" },
      ],
    }));

    for (const pl of (resp.PriceList || [])) {
      const product = JSON.parse(pl);
      const usagetype = product.product?.attributes?.usagetype || "";
      const onDemand = product.terms?.OnDemand;
      if (!onDemand) continue;
      const skuKey = Object.keys(onDemand)[0];
      const dims = onDemand[skuKey]?.priceDimensions;
      if (!dims) continue;
      const dimKey = Object.keys(dims)[0];
      const usd = parseFloat(dims[dimKey]?.pricePerUnit?.USD || "0");
      if (!usd) continue;

      if (usagetype.includes("Fargate-ARM-vCPU-Hours")) {
        result.vcpuPerHour = usd;
      } else if (usagetype.includes("Fargate-ARM-GB-Hours")) {
        result.gbPerHour = usd;
      }
    }
  } catch (err) {
    console.error(`  [warn] Failed to fetch Fargate pricing: ${err.message}`);
  }

  // Fallback to well-known us-east-1 ARM rates if API failed.
  if (!result.vcpuPerHour) result.vcpuPerHour = 0.03238;
  if (!result.gbPerHour) result.gbPerHour = 0.00356;

  return result;
}

async function main() {
  console.error(`Fetching pricing for region: ${DEPLOY_REGION} (${location})`);

  // Fetch EC2 prices in parallel (batched to avoid throttling).
  const ec2 = {};
  const batches = [];
  for (let i = 0; i < EC2_TYPES.length; i += 3) {
    batches.push(EC2_TYPES.slice(i, i + 3));
  }

  for (const batch of batches) {
    const results = await Promise.all(
      batch.map(async (type) => {
        const price = await fetchEc2Price(type);
        return { type, price };
      })
    );
    for (const { type, price } of results) {
      if (price != null && price > 0) {
        ec2[type] = price;
        console.error(`  EC2 ${type}: $${price}/hr`);
      }
    }
  }

  // Fetch Fargate ARM pricing.
  const fargate = await fetchFargateArmPricing();
  console.error(`  Fargate ARM: $${fargate.vcpuPerHour}/vCPU-hr, $${fargate.gbPerHour}/GB-hr`);

  const output = {
    fetchedAt: new Date().toISOString(),
    region: DEPLOY_REGION,
    ec2,
    fargate,
  };

  // Write to stdout so the caller can pipe to a file or S3.
  process.stdout.write(JSON.stringify(output, null, 2) + "\n");
}

main().catch(err => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
