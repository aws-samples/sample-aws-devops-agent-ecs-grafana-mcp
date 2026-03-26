#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { Aspects } from 'aws-cdk-lib';
import { AwsSolutionsChecks } from 'cdk-nag';
import { EcsObservabilityStack } from '../lib/ecs-observability-stack';
import { AgentCoreStack } from '../lib/agentcore-stack';

const app = new cdk.App();

new EcsObservabilityStack(app, 'EcsObservabilityStack', {
  description: 'ECS environment with AMP/AMG for Grafana MCP tutorial',
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});

const grafanaSecretName = app.node.tryGetContext('grafanaSecretName') || 'grafana-mcp/config';

new AgentCoreStack(app, 'AgentCoreStack', {
  grafanaSecretName,
});

Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));
