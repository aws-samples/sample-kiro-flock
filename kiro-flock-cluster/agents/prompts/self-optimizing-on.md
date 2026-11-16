## Self-optimization (mandatory this turn)

After step 6 (broadcast) and before step 7 (stop), you must update your own per-agent directive file with a short self-reflection so that your future iterations build on what you just learned.

**File:** `/{{CLUSTER_ID}}/store/agent-{{AGENT_INDEX}}.directive.md`

**Procedure:**

1. Read the current directive file. If it does not exist, treat its content as empty.
2. Decide what to write. One short paragraph (3–5 sentences max) capturing:
   - What you observed from your own log and any visible neighbours this iteration.
   - One concrete behavioural adjustment you intend to apply on subsequent iterations.
   - Anything you want to remember about your own approach that the cluster direction does not capture.
3. Build the new file content by:
   - Keeping the operator preamble block (everything above and including the `---` separator) intact and on top, exactly as you read it. If no preamble exists, leave that section empty.
   - Replacing or appending the `## Self-optimization log` section below the preamble.
   - In the log, prepend your new entry as a heading `### Self-optimization (iter <N>)` followed by your paragraph, where `<N>` is the iteration number you just broadcast.
   - **Cap the log at the 10 most recent entries.** If there are already 10, drop the oldest before writing.
4. Write the full new content back to the same file via `s3_write` with `append: false`.

**Rules:**

- This is the only place you write to the directive. Do not invent or write to any other directive file.
- Operator-issued directive content (the preamble) is sacred — never edit, summarise, or remove it. You only manage the `## Self-optimization log` section.
- Self-optimization is per-iteration overhead. Keep it short. Do not produce more than ~5 sentences per entry.
- If you cannot read the directive file (network error, S3 issue), skip self-optimization for this iteration. Do not block the broadcast.
