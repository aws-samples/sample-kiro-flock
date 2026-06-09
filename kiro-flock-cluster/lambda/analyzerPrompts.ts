/**
 * Templated prompts for the Bedrock-powered analyzer and optimizer.
 *
 * Both prompts receive the same data payload (cluster registry, configs,
 * directions, agent logs, environment file listing) but ask for different
 * output shapes:
 *
 *   - Analyze: structured JSON describing an organigram of clusters and
 *     their work, plus a progress summary.
 *   - Optimize: proposed direction updates for each cluster with a
 *     rationale for each change.
 *
 * The prompts instruct the model to return valid JSON matching a specific
 * schema. No markdown, no prose outside the JSON structure.
 */

export interface AnalyzerInput {
  clusters: Array<{
    id: string;
    name: string;
    algorithm: string;
    state: string;
    concurrency: number;
    direction: string;
    /** Last N log entries per agent (truncated for scale). */
    agentLogs: Array<{
      agentId: string;
      entries: Array<{ ts: string; iteration: number; action: string; result: string; next_intent: string }>;
    }>;
    /** Environment file keys (not contents) for this cluster. */
    envFiles: string[];
  }>;
  /** Shared knowledge-base file keys. */
  knowledgeBaseFiles: string[];
}

// ---- Analyze prompt --------------------------------------------------------

export function buildAnalyzePrompt(input: AnalyzerInput): string {
  const dataBlock = JSON.stringify(input, null, 2);

  return `You are an expert systems analyst reviewing a multi-cluster AI agent deployment called "kiro-flock". Each cluster is a team of AI agents working toward a shared direction (goal document). Agents coordinate through S3 logs using stigmergy (no direct messaging).

Your task: analyze the current state of all clusters and produce a structured JSON response that will be rendered as a visual dashboard.

<cluster_data>
${dataBlock}
</cluster_data>

Respond with ONLY valid JSON matching this exact schema (no markdown fences, no explanation outside the JSON):

{
  "summary": {
    "text": "1-3 sentence overall progress summary. Be specific about what has been accomplished and what remains.",
    "progressPercent": <number 0-100, your best estimate of overall task completion across all clusters>
  },
  "organigram": [
    {
      "clusterId": "<cluster id>",
      "clusterName": "<display name>",
      "role": "<short role description, e.g. 'Platform Standards', 'Auth Implementation', 'QA'>",
      "team": "<team metaphor, e.g. 'Backend Team', 'Security Team', 'Integration'>",
      "state": "<running|paused|stopped|starting>",
      "algorithm": "<amorphous|mesh|swarm>",
      "agentCount": <number>,
      "artefacts": [
        {
          "name": "<abstracted artefact name, e.g. 'Authentication Module' not 'src/auth/login.ts'>",
          "status": "<complete|in-progress|planned|blocked>",
          "description": "<one sentence describing what this artefact is>"
        }
      ],
      "currentFocus": "<one sentence: what the cluster is actively working on right now>",
      "blockers": ["<any blockers or issues, empty array if none>"],
      "dependsOn": ["<cluster IDs this cluster reads from or depends on, inferred from its direction and agent logs>"],
      "feedsInto": ["<cluster IDs that read from this cluster's output, inferred from their directions>"]
    }
  ]
}

Rules:
- artefacts should be abstracted summaries of real work products, not raw file paths. Group related files into logical artefacts.
- If a cluster has produced files in its environment, those are real artefacts. Reference them by their logical purpose.
- If a cluster has no activity yet, its artefacts array should be empty and currentFocus should say "not started".
- progressPercent should reflect actual completion based on agent logs and environment output, not just time elapsed.
- Keep role and team descriptions short (2-4 words each).
- The summary text must be concrete and actionable, not generic.
- dependsOn and feedsInto MUST be inferred from the cluster directions and agent activity, not just the environment file structure. If a direction says "read from environment/team-X/" or "check team-X's output", that cluster depends on team-X. If a QA cluster audits all other teams, it dependsOn all of them. If a build cluster integrates design and content, it dependsOn both.
- A cluster that writes feedback or QA reports to another cluster's environment feedsInto that cluster.`;
}

// ---- Optimize prompt -------------------------------------------------------

export function buildOptimizePrompt(input: AnalyzerInput, latestAnalysis?: unknown): string {
  const dataBlock = JSON.stringify(input, null, 2);

  let analysisContext = "";
  if (latestAnalysis) {
    analysisContext = `

<prior_analysis>
The following is the most recent analysis of these clusters. Use it to inform your recommendations.

${JSON.stringify(latestAnalysis, null, 2)}
</prior_analysis>

If the prior analysis contains blockers for any cluster, address those in your recommendation for that cluster. If a QA or coordinator cluster has flagged problems, the affected team's recommendation should include how to resolve them.
`;
  }

  return `You are a systems coach observing a running "kiro-flock" deployment. Each cluster is a team of AI agents working toward a shared direction. Your job is to assess each cluster and recommend what the operator should do next.

Most of the time, the right answer is "leave it alone." Clusters self-correct. Only recommend a direction change when there is a clear reason: agents are stuck, work is complete and needs a new phase, or coordination between clusters has broken down.

<cluster_data>
${dataBlock}
</cluster_data>
${analysisContext}
For each cluster, assess its health and recommend ONE action:
- "leave-running": the cluster is doing fine, no intervention needed
- "direction-update": the direction should change (provide the new text)
- "pause": the cluster has converged or is idle, pause it to save compute
- "stop": the cluster's work is done, terminate it

Respond with ONLY valid JSON matching this exact schema (no markdown fences, no explanation outside the JSON):

{
  "summary": "1-2 sentence overview of the system state and your top recommendation",
  "proposals": [
    {
      "clusterId": "<cluster id>",
      "clusterName": "<display name>",
      "action": "<leave-running|direction-update|pause|stop>",
      "confidence": "<high|medium|low>",
      "rationale": "<1-2 sentences explaining your assessment>",
      "proposedDirection": "<full new direction text if action is direction-update, otherwise null>"
    }
  ]
}

Rules:
- Every cluster in the input must have a corresponding proposal entry.
- Default to "leave-running" unless you have a specific reason to intervene. Clusters that are actively producing output and making progress should be left alone.
- "direction-update" is for when the current direction is stale (work items already done), agents are stuck in a loop, or a new phase of work should begin based on what other clusters have produced.
- "pause" is for clusters that have converged (all agents idle) and are burning compute waiting for something that hasn't happened yet.
- "stop" is for clusters whose job is fully complete with no further iterations needed.
- Proposed directions must be complete standalone documents, not diffs. Agents read them fresh each iteration.
- confidence "high" means you are certain this is the right call. "medium" means it's a good idea but the operator should verify. "low" means it's speculative.
- Do not invent work that isn't implied by the existing directions and cluster names.
- If a cluster is already paused or stopped, recommend "leave-running" only if you think it should be resumed/restarted (the operator will interpret this as a nudge). Otherwise match its current state.`;
}
