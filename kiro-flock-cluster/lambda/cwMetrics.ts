// CloudWatch metrics for agent EC2 instances.
// Uses the built-in AWS/EC2 namespace: CPUUtilization, NetworkOut, DiskWriteBytes.
// All published by EC2 automatically, no CloudWatch agent needed.

import { CloudWatchClient, GetMetricDataCommand, type MetricDataQuery } from "@aws-sdk/client-cloudwatch";

const cw = new CloudWatchClient({});

const METRICS = [
  { name: "CPUUtilization", stat: "Average", key: "cpu" },
  { name: "NetworkIn", stat: "Sum", key: "netIn" },
  { name: "NetworkOut", stat: "Sum", key: "netOut" },
  { name: "StatusCheckFailed", stat: "Maximum", key: "status" },
] as const;

export interface AgentMetrics {
  cpu: number | null;     // percent
  netIn: number | null;   // bytes
  netOut: number | null;  // bytes
  status: number | null;  // 0 = ok, 1 = failed
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export { formatBytes };

export async function getInstanceMetrics(instanceIds: string[]): Promise<Record<string, AgentMetrics>> {
  if (instanceIds.length === 0) return {};

  const queries: MetricDataQuery[] = instanceIds.flatMap((id, i) =>
    METRICS.map((m, j) => ({
      Id: `m_${i}_${j}`,
      MetricStat: {
        Metric: {
          Namespace: "AWS/EC2",
          MetricName: m.name,
          Dimensions: [{ Name: "InstanceId", Value: id }],
        },
        Period: 300,
        Stat: m.stat,
      },
    }))
  );

  const now = new Date();
  const res = await cw.send(new GetMetricDataCommand({
    MetricDataQueries: queries,
    StartTime: new Date(now.getTime() - 10 * 60 * 1000),
    EndTime: now,
  }));

  const result: Record<string, AgentMetrics> = {};
  for (const id of instanceIds) {
    result[id] = { cpu: null, netIn: null, netOut: null, status: null };
  }

  for (const r of res.MetricDataResults ?? []) {
    const match = r.Id?.match(/^m_(\d+)_(\d+)$/);
    if (!match) continue;
    const instanceId = instanceIds[Number(match[1])];
    const metricKey = METRICS[Number(match[2])]?.key;
    const values = r.Values ?? [];
    if (values.length > 0 && instanceId && metricKey) {
      (result[instanceId] as any)[metricKey] = values[0];
    }
  }

  return result;
}
