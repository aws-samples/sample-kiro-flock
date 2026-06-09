#!/usr/bin/env node
/**
 * Bundle the agent code + assets into dist/agent-bundle/ ready for upload to
 * s3://<bucket>/agent/bundle.zip by CDK's BucketDeployment.
 *
 * Output layout:
 *   dist/agent-bundle/
 *     agent/
 *       bootstrap.js            (esbuild bundle, runs on the EC2 instance)
 *       s3Mcp.js                (standalone MCP server over stdio)
 *     agents/
 *       prompts/
 *         agent-loop.md         (base prompt read at runtime)
 *         algorithms/
 *           amorphous.md        (Pass 7 per-algorithm fragments)
 *           mesh.md
 *           swarm.md
 *
 * The prompts/ tree is copied recursively so the base prompt and the
 * per-algorithm fragments travel together. Adding a new fragment file is
 * a no-op for this script — it just lands in the bundle.
 */
const path = require('node:path');
const fs = require('node:fs');
const esbuild = require('esbuild');

const repoRoot = path.resolve(__dirname, '..');
const outDir = path.join(repoRoot, 'dist', 'agent-bundle');

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(path.join(outDir, 'agent'), { recursive: true });
fs.mkdirSync(path.join(outDir, 'agents', 'prompts'), { recursive: true });

const sharedBuildOpts = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  mainFields: ['module', 'main'],
  sourcemap: false,
  logLevel: 'info',
};

esbuild.buildSync({
  ...sharedBuildOpts,
  entryPoints: [path.join(repoRoot, 'agent', 'bootstrap.ts')],
  outfile: path.join(outDir, 'agent', 'bootstrap.js'),
});

esbuild.buildSync({
  ...sharedBuildOpts,
  entryPoints: [path.join(repoRoot, 'agent', 's3Mcp.ts')],
  outfile: path.join(outDir, 'agent', 's3Mcp.js'),
});

/** Recursively copy a directory tree. Node 20 has fs.cpSync, use it. */
function copyTree(src, dst) {
  fs.cpSync(src, dst, { recursive: true });
}

// Copy the entire prompts/ tree (base + algorithm fragments).
copyTree(
  path.join(repoRoot, 'agents', 'prompts'),
  path.join(outDir, 'agents', 'prompts'),
);

console.log(`✅ agent bundle ready → ${outDir}`);
