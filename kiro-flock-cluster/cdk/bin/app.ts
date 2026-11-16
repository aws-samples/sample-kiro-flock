#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { AgaStack } from '../lib/aga-stack';

const app = new cdk.App();
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION || 'eu-central-1',
};
new AgaStack(app, 'AgaStack', { env });

// cdk-nag runs on every synth and fails it on an unsuppressed error-level
// finding. Suppressions live next to the resources they cover in
// aga-stack.ts, each with its reason, so a reader of the stack sees the
// trade-off where it is made. `verbose` prints the rule's explanation along
// with its id, which is what makes the synth output readable without a lookup.
cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
