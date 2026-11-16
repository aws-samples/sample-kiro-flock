#!/usr/bin/env node
/**
 * Derive the agent-deploy bootstrap template from the CDK default.
 *
 *   npx cdk bootstrap --show-template | node scripts/make-agent-bootstrap.mjs > cdk/bootstrap/agent-bootstrap.template.yaml
 *
 * Deployer clusters run `cdk deploy` with the bootstrap roles of qualifier
 * `kflock` (toolkit stack `CDKToolkit-kflock`), not the account's default
 * bootstrap. The default deploy role may create, update and delete any stack,
 * and the default execution role is an administrator. This script keeps the
 * default template (so asset buckets, ECR repository and the publishing roles
 * behave exactly as the CDK expects) and changes three things:
 *
 *   1. DeploymentActionRole: CreateStack only with the tag KiroFlockManaged=true
 *      in the request, UpdateStack/DeleteStack/rollback only on stacks that carry
 *      it; no change-set actions (see UpdateTaggedStacks). AgaStack* and
 *      CDKToolkit* are denied outright.
 *   2. CloudFormationExecutionRole: the AdministratorAccess default is replaced
 *      by AgentDeployPolicy, and the role carries AgentPermissionsBoundary.
 *   3. AgentDeployPolicy and the boundary share one set of denies: IAM roles
 *      may be created or changed only when they carry AgentPermissionsBoundary,
 *      the boundary can be neither removed from a role nor edited, and the
 *      flock's own bucket, user pool, stacks, functions, parameters, nodes and
 *      roles are out of reach, as are IAM users, access keys and Organizations.
 *
 * The CDK CLI refuses to overwrite a bootstrap stack whose BootstrapVariant
 * differs, so the variant is renamed; `install.sh` passes `--qualifier kflock`
 * and `--toolkit-stack-name CDKToolkit-kflock`, which keeps this stack apart
 * from the account's default bootstrap.
 */
import { readFileSync } from "node:fs";
import yaml from "js-yaml";

const TAG_KEY = "KiroFlockManaged";
const TAG_VALUE = "true";

const doc = yaml.load(readFileSync(0, "utf8"));

// ---- Parameters -----------------------------------------------------------
doc.Parameters.BootstrapVariant.Default = "kiro-flock: agent deploy bootstrap";
doc.Parameters.FlockBucketName = {
  Description: "Name of the flock control-plane bucket (AgaStack). Deployed stacks and the roles they create are denied access to it.",
  Default: "",
  Type: "String",
};
doc.Parameters.FlockUserPoolArn = {
  Description: "ARN of the flock's Cognito user pool (AgaStack). Deployed stacks and the roles they create are denied access to it.",
  Default: "",
  Type: "String",
};
doc.Conditions.HasFlockBucketName = { "Fn::Not": [{ "Fn::Equals": [{ Ref: "FlockBucketName" }, ""]}] };
doc.Conditions.HasFlockUserPoolArn = { "Fn::Not": [{ "Fn::Equals": [{ Ref: "FlockUserPoolArn" }, ""]}] };

const protectedStacks = [
  { "Fn::Sub": "arn:${AWS::Partition}:cloudformation:*:${AWS::AccountId}:stack/AgaStack*/*" },
  { "Fn::Sub": "arn:${AWS::Partition}:cloudformation:*:${AWS::AccountId}:stack/CDKToolkit*/*" },
];
const flockBucketArns = {
  "Fn::If": [
    "HasFlockBucketName",
    [
      { "Fn::Sub": "arn:${AWS::Partition}:s3:::${FlockBucketName}" },
      { "Fn::Sub": "arn:${AWS::Partition}:s3:::${FlockBucketName}/*" },
    ],
    // No bucket named: deny a name that cannot exist so the statement stays valid.
    [{ "Fn::Sub": "arn:${AWS::Partition}:s3:::kiro-flock-no-bucket-configured" }],
  ],
};
const flockUserPoolArns = {
  "Fn::If": [
    "HasFlockUserPoolArn",
    [{ Ref: "FlockUserPoolArn" }],
    [{ "Fn::Sub": "arn:${AWS::Partition}:cognito-idp:*:${AWS::AccountId}:userpool/kiro-flock-no-pool-configured" }],
  ],
};
// Reads on the protected stacks stay possible (the CDK CLI describes the
// toolkit stack); every mutating action is denied.
const cfnReadOnly = [
  "cloudformation:Describe*", "cloudformation:Get*", "cloudformation:List*",
  "cloudformation:Detect*", "cloudformation:ValidateTemplate", "cloudformation:EstimateTemplateCost",
];
const boundaryArn = { "Fn::Sub": "arn:${AWS::Partition}:iam::${AWS::AccountId}:policy/kiro-flock-${Qualifier}-agent-boundary" };

// ---- 0. Asset repository: scan what agents publish --------------------------
// Container assets a deployer agent publishes are agent-built images; scanning
// them on push costs nothing and is what trivy's AWS-0030 asks for.
doc.Resources.ContainerAssetsRepository.Properties.ImageScanningConfiguration = { ScanOnPush: true };

// ---- 1. Deploy role: tag-scoped CloudFormation -----------------------------
const deployRole = doc.Resources.DeploymentActionRole.Properties;
const policy = deployRole.Policies.find((p) => p.PolicyName === "default").PolicyDocument;
const keep = policy.Statement.filter((s) => s.Sid !== "DeployPermissions" && s.Sid !== "CliPermissions" && s.Sid !== "Refactor");
policy.Statement = [
  // Deploys run with `cdk deploy --method direct` (the Deploy MCP passes it):
  // CreateStack for a new stack and UpdateStack for an existing one, no change
  // sets. A change set's tags are applied on ExecuteChangeSet, so at that moment
  // a brand-new stack and an untagged existing stack both have no tags and IAM
  // cannot tell them apart; with direct calls CreateStack carries the tag in the
  // request (aws:RequestTag) and UpdateStack is judged on the stack's own tag
  // (aws:ResourceTag). An untagged existing stack can therefore be neither
  // updated nor tagged.
  {
    Sid: "UpdateTaggedStacks",
    Effect: "Allow",
    Action: [
      "cloudformation:UpdateStack",
      "cloudformation:RollbackStack",
      "cloudformation:ContinueUpdateRollback",
      "cloudformation:DeleteStack",
      "cloudformation:UpdateTerminationProtection",
      "cloudformation:TagResource",
      "cloudformation:UntagResource",
    ],
    Resource: "*",
    Condition: { StringEquals: { [`aws:ResourceTag/${TAG_KEY}`]: TAG_VALUE } },
  },
  {
    Sid: "CreateTaggedStacks",
    Effect: "Allow",
    Action: ["cloudformation:CreateStack"],
    Resource: "*",
    Condition: { StringEquals: { [`aws:RequestTag/${TAG_KEY}`]: TAG_VALUE } },
  },
  {
    // Tagging a stack as part of creating it (cloudformation:CreateAction).
    Sid: "TagOnCreate",
    Effect: "Allow",
    Action: ["cloudformation:TagResource"],
    Resource: "*",
    Condition: {
      StringEquals: { "cloudformation:CreateAction": "CreateStack", [`aws:RequestTag/${TAG_KEY}`]: TAG_VALUE },
    },
  },
  {
    Sid: "ProtectedStacks",
    Effect: "Deny",
    NotAction: cfnReadOnly,
    Resource: protectedStacks,
  },
  {
    // UntagResource is allowed above so the CDK can manage a stack's other
    // tags; the deploy tag itself must stay, or the stack leaves the scope of
    // every rule here and of the dashboard's destroy.
    Sid: "KeepDeployTag",
    Effect: "Deny",
    Action: ["cloudformation:UntagResource"],
    Resource: "*",
    Condition: { "ForAnyValue:StringEquals": { "aws:TagKeys": TAG_KEY } },
  },
  {
    Sid: "CallerIdentity",
    Effect: "Allow",
    Action: ["sts:GetCallerIdentity"],
    Resource: "*",
  },
  ...keep,
];

// ---- 2. Execution role: scoped policy + boundary ----------------------------
const execRole = doc.Resources.CloudFormationExecutionRole.Properties;
execRole.ManagedPolicyArns = [{ Ref: "AgentDeployPolicy" }];
execRole.PermissionsBoundary = { Ref: "AgentPermissionsBoundary" };

// The denies shared by the execution role and by every role an agent stack creates.
const sharedDenies = [
  {
    Sid: "DenyFlockControlPlane",
    Effect: "Deny",
    Action: ["s3:*"],
    Resource: flockBucketArns,
  },
  {
    Sid: "DenyFlockUserPool",
    Effect: "Deny",
    Action: ["cognito-idp:*"],
    Resource: flockUserPoolArns,
  },
  {
    Sid: "DenyProtectedStacks",
    Effect: "Deny",
    NotAction: cfnReadOnly,
    Resource: protectedStacks,
  },
  {
    Sid: "DenyBootstrapAndFlockRoles",
    Effect: "Deny",
    Action: ["sts:AssumeRole", "iam:*"],
    Resource: [
      { "Fn::Sub": "arn:${AWS::Partition}:iam::${AWS::AccountId}:role/cdk-*" },
      { "Fn::Sub": "arn:${AWS::Partition}:iam::${AWS::AccountId}:role/AgaStack-*" },
    ],
  },
  {
    Sid: "DenyIdentityAndAccount",
    Effect: "Deny",
    Action: [
      "iam:*User*",
      "iam:*AccessKey*",
      "iam:*Group*",
      "iam:*LoginProfile*",
      "iam:*MFADevice*",
      "iam:*SAMLProvider*",
      "iam:*OpenIDConnectProvider*",
      "iam:*AccountAlias*",
      "iam:*AccountPasswordPolicy*",
      "organizations:*",
      "account:*",
      "billing:*",
      "ce:*",
      "cur:*",
      "sso:*",
      "sso-directory:*",
      "controltower:*",
      "trustedadvisor:*",
      "support:*",
    ],
    Resource: "*",
  },
  {
    // Every write to a role is judged on the boundary it carries (for CreateRole
    // and PutRolePermissionsBoundary: the one being set). A role without the
    // boundary has no value for the key, so StringNotEquals matches and the
    // write is refused: an agent stack can neither create an unbounded role nor
    // attach policies to, or rewrite the trust of, a role it did not create.
    Sid: "DenyRoleChangesOutsideBoundary",
    Effect: "Deny",
    Action: [
      "iam:CreateRole",
      "iam:PutRolePermissionsBoundary",
      "iam:PutRolePolicy",
      "iam:AttachRolePolicy",
      "iam:DetachRolePolicy",
      "iam:DeleteRolePolicy",
      "iam:UpdateAssumeRolePolicy",
    ],
    Resource: "*",
    Condition: { StringNotEquals: { "iam:PermissionsBoundary": boundaryArn } },
  },
  {
    // DeleteRolePermissionsBoundary acts on a role, not on the policy, so it is
    // denied on every role that carries the boundary. PutRolePermissionsBoundary
    // is not here: for it the key holds the boundary being set, and this would
    // refuse re-applying ours; swapping in another is refused above.
    Sid: "DenyBoundaryRemoval",
    Effect: "Deny",
    Action: ["iam:DeleteRolePermissionsBoundary"],
    Resource: { "Fn::Sub": "arn:${AWS::Partition}:iam::*:role/*" },
    Condition: { StringEquals: { "iam:PermissionsBoundary": boundaryArn } },
  },
  {
    Sid: "DenyBoundaryEdits",
    Effect: "Deny",
    Action: ["iam:CreatePolicyVersion", "iam:DeletePolicy", "iam:DeletePolicyVersion", "iam:SetDefaultPolicyVersion"],
    Resource: boundaryArn,
  },
  // ---- The flock's own resources, by name or tag ----
  {
    // The API Lambda reads and writes the flock bucket and passes DeployerRole;
    // new code in it would be the flock's control plane in an agent's hands.
    Sid: "DenyFlockFunctions",
    Effect: "Deny",
    NotAction: ["lambda:Get*", "lambda:List*"],
    Resource: { "Fn::Sub": "arn:${AWS::Partition}:lambda:*:${AWS::AccountId}:function:AgaStack-*" },
  },
  {
    // /aga/kiro-api-key and whatever else install.sh keeps there.
    Sid: "DenyFlockParameters",
    Effect: "Deny",
    Action: ["ssm:*Parameter*"],
    Resource: { "Fn::Sub": "arn:${AWS::Partition}:ssm:*:${AWS::AccountId}:parameter/aga/*" },
  },
  {
    // The flock's EC2 nodes carry Project=kiro-flock; a command on one of them
    // is a command inside another cluster's agent.
    Sid: "DenyCommandsOnFlockNodes",
    Effect: "Deny",
    Action: ["ssm:SendCommand", "ssm:StartSession"],
    Resource: { "Fn::Sub": "arn:${AWS::Partition}:ec2:*:${AWS::AccountId}:instance/*" },
    Condition: { StringEquals: { "aws:ResourceTag/Project": "kiro-flock" } },
  },
  {
    // Stacks the flock did not deploy are not an agent's to change or remove,
    // however broad cloudformation:* in ApplicationServices is.
    Sid: "DenyUntaggedStackChanges",
    Effect: "Deny",
    Action: ["cloudformation:UpdateStack", "cloudformation:DeleteStack"],
    Resource: "*",
    Condition: { Null: { [`aws:ResourceTag/${TAG_KEY}`]: "true" } },
  },
  {
    // Removing the tag would take a stack out of every tag-scoped rule above
    // and out of the dashboard's destroy.
    Sid: "DenyUntaggingFlockStacks",
    Effect: "Deny",
    Action: ["cloudformation:UntagResource", "tag:UntagResources"],
    Resource: "*",
    Condition: { "ForAnyValue:StringEquals": { "aws:TagKeys": TAG_KEY } },
  },
];

doc.Resources.AgentDeployPolicy = {
  Type: "AWS::IAM::ManagedPolicy",
  Properties: {
    ManagedPolicyName: { "Fn::Sub": "kiro-flock-${Qualifier}-agent-deploy" },
    Description: "What CloudFormation may do on behalf of a kiro-flock deployer cluster. Replaces AdministratorAccess on the bootstrap execution role.",
    PolicyDocument: {
      Version: "2012-10-17",
      Statement: [
        {
          // Everything an application stack commonly needs. Services that
          // manage identity, the account or billing are denied below.
          Sid: "ApplicationServices",
          Effect: "Allow",
          Action: [
            "acm:*", "apigateway:*", "appsync:*", "application-autoscaling:*", "autoscaling:*",
            "bedrock:*", "cloudformation:*", "cloudfront:*", "cloudwatch:*", "codebuild:*",
            "codecommit:*", "codepipeline:*", "cognito-idp:*", "cognito-identity:*", "dynamodb:*",
            "ec2:*", "ecr:*", "ecs:*", "elasticloadbalancing:*", "events:*", "firehose:*",
            "kinesis:*", "kms:*", "lambda:*", "logs:*", "rds:*", "route53:*", "s3:*",
            "scheduler:*", "secretsmanager:*", "ses:*", "sns:*", "sqs:*", "ssm:*", "states:*",
            "wafv2:*", "xray:*",
          ],
          Resource: "*",
        },
        {
          // Roles and policies for the application's own services, within the boundary.
          Sid: "ApplicationRoles",
          Effect: "Allow",
          Action: [
            "iam:CreateRole", "iam:DeleteRole", "iam:GetRole", "iam:UpdateRole", "iam:UpdateRoleDescription",
            "iam:UpdateAssumeRolePolicy", "iam:TagRole", "iam:UntagRole", "iam:ListRoleTags",
            "iam:PutRolePolicy", "iam:DeleteRolePolicy", "iam:GetRolePolicy", "iam:ListRolePolicies",
            "iam:AttachRolePolicy", "iam:DetachRolePolicy", "iam:ListAttachedRolePolicies",
            "iam:PutRolePermissionsBoundary",
            "iam:CreatePolicy", "iam:DeletePolicy", "iam:GetPolicy", "iam:GetPolicyVersion",
            "iam:ListPolicyVersions", "iam:CreatePolicyVersion", "iam:DeletePolicyVersion", "iam:TagPolicy", "iam:UntagPolicy",
            "iam:CreateServiceLinkedRole", "iam:ListRoles", "iam:ListPolicies",
            "iam:CreateInstanceProfile", "iam:DeleteInstanceProfile", "iam:GetInstanceProfile",
            "iam:AddRoleToInstanceProfile", "iam:RemoveRoleFromInstanceProfile", "iam:TagInstanceProfile",
          ],
          Resource: "*",
        },
        {
          // CloudFormation propagates stack tags to the roles an agent stack
          // creates, so the deploy tag names exactly those roles. Pre-existing
          // roles (the flock's, the bootstrap's) cannot be passed to a service.
          Sid: "PassOwnRoles",
          Effect: "Allow",
          Action: ["iam:PassRole"],
          Resource: "*",
          // iam:ResourceTag, not aws:ResourceTag: the global key is not set on
          // PassRole requests, so a condition on it never matched (seen on the
          // first deploy: the role carried the tag and PassRole was refused).
          Condition: { StringEquals: { [`iam:ResourceTag/${TAG_KEY}`]: TAG_VALUE } },
        },
        ...sharedDenies,
      ],
    },
  },
};

// The CDK's optional example boundary is never created here (its condition
// stays false); dropping it keeps scanners from reporting a policy that does
// not exist.
delete doc.Resources.CdkBoostrapPermissionsBoundaryPolicy;

doc.Resources.AgentPermissionsBoundary = {
  Type: "AWS::IAM::ManagedPolicy",
  Properties: {
    ManagedPolicyName: { "Fn::Sub": "kiro-flock-${Qualifier}-agent-boundary" },
    Description: "Permissions boundary carried by the bootstrap execution role and by every role a kiro-flock deployer stack creates.",
    PolicyDocument: {
      Version: "2012-10-17",
      Statement: [
        { Sid: "WithinBoundary", Effect: "Allow", Action: "*", Resource: "*" },
        ...sharedDenies,
      ],
    },
  },
};

// The deploy role passes the execution role; nothing else changes there.
process.stdout.write(yaml.dump(doc, { lineWidth: 200, noRefs: true, quotingType: '"' }));
