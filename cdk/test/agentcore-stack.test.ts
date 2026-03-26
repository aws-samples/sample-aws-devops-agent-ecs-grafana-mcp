import * as fs from 'fs';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib/core';
import { Template } from 'aws-cdk-lib/assertions';
import { AgentCoreStack } from '../lib/agentcore-stack';

/**
 * AgentCoreStack unit tests
 *
 * Validates AgentCore Runtime (MCP protocol), Cognito JWT authentication,
 * CloudFormation outputs, and Dockerfile contents.
 */

// Helper to create a test stack instance and template
function createTestStack() {
  const app = new cdk.App();
  const stack = new AgentCoreStack(app, 'TestAgentCoreStack', {
    grafanaSecretName: 'grafana-mcp/config',
  });
  return { app, stack, template: Template.fromStack(stack) };
}

describe('AgentCore Runtime validation', () => {
  test('AgentCore Runtime resource exists', () => {
    const { template } = createTestStack();
    const allResources = template.toJSON().Resources;
    const runtimeResources = Object.entries(allResources).filter(
      ([_, r]: [string, any]) => r.Type && r.Type.includes('Runtime') && !r.Type.includes('Endpoint'),
    );
    expect(runtimeResources.length).toBeGreaterThanOrEqual(1);
  });

  test('Runtime is configured with MCP protocol', () => {
    const { template } = createTestStack();
    const templateJson = JSON.stringify(template.toJSON());
    expect(templateJson).toContain('MCP');
  });

  test('Runtime Endpoint resource exists', () => {
    const { template } = createTestStack();
    const allResources = template.toJSON().Resources;
    const endpointResources = Object.entries(allResources).filter(
      ([_, r]: [string, any]) => r.Type && r.Type.includes('Endpoint'),
    );
    expect(endpointResources.length).toBeGreaterThanOrEqual(1);
  });

  test('Environment variables are correctly configured', () => {
    const { template } = createTestStack();
    const templateJson = JSON.stringify(template.toJSON());
    expect(templateJson).toContain('GRAFANA_SECRET_NAME');
    expect(templateJson).toContain('grafana-mcp/config');
    // Sensitive values must not appear in the template
    expect(templateJson).not.toContain('GRAFANA_SERVICE_ACCOUNT_TOKEN');
  });
});

describe('Cognito JWT authentication validation', () => {
  test('Cognito User Pool is created', () => {
    const { template } = createTestStack();
    template.resourceCountIs('AWS::Cognito::UserPool', 1);
  });

  test('Self sign-up is disabled', () => {
    const { template } = createTestStack();
    const resources = template.toJSON().Resources;
    const userPoolResources = Object.values(resources).filter(
      (r: any) => r.Type === 'AWS::Cognito::UserPool',
    );
    expect(userPoolResources.length).toBe(1);
    const userPool = userPoolResources[0] as any;
    expect(userPool.Properties.AdminCreateUserConfig?.AllowAdminCreateUserOnly).toBe(true);
  });

  test('Client Credentials flow is configured', () => {
    const { template } = createTestStack();
    template.resourceCountIs('AWS::Cognito::UserPoolClient', 1);
    const resources = template.toJSON().Resources;
    const clientResources = Object.values(resources).filter(
      (r: any) => r.Type === 'AWS::Cognito::UserPoolClient',
    );
    const client = clientResources[0] as any;
    expect(client.Properties.AllowedOAuthFlows).toContain('client_credentials');
  });

  test('App client generates a secret', () => {
    const { template } = createTestStack();
    const resources = template.toJSON().Resources;
    const clientResources = Object.values(resources).filter(
      (r: any) => r.Type === 'AWS::Cognito::UserPoolClient',
    );
    const client = clientResources[0] as any;
    expect(client.Properties.GenerateSecret).toBe(true);
  });

  test('Resource server is created with mcp-api identifier', () => {
    const { template } = createTestStack();
    template.resourceCountIs('AWS::Cognito::UserPoolResourceServer', 1);
    const resources = template.toJSON().Resources;
    const rsResources = Object.values(resources).filter(
      (r: any) => r.Type === 'AWS::Cognito::UserPoolResourceServer',
    );
    const rs = rsResources[0] as any;
    expect(rs.Properties.Identifier).toBe('mcp-api');
    expect(rs.Properties.Scopes).toEqual(
      expect.arrayContaining([expect.objectContaining({ ScopeName: 'access' })]),
    );
  });

  test('Cognito domain is created', () => {
    const { template } = createTestStack();
    template.resourceCountIs('AWS::Cognito::UserPoolDomain', 1);
  });
});

describe('CloudFormation outputs validation', () => {
  const requiredOutputs = [
    'RuntimeId', 'RuntimeEndpointId', 'RuntimeEndpointArn',
    'CognitoUserPoolId', 'CognitoClientId', 'CognitoTokenEndpoint',
  ];

  test.each(requiredOutputs)('%s is included in outputs', (outputName) => {
    const { template } = createTestStack();
    const outputKeys = Object.keys(template.toJSON().Outputs);
    expect(outputKeys.some((key) => key.includes(outputName))).toBe(true);
  });
});

describe('Dockerfile content validation', () => {
  const dockerfilePath = path.join(__dirname, '..', '..', 'docker', 'Dockerfile');
  const dockerfileContent = fs.readFileSync(dockerfilePath, 'utf-8');

  test('AWS CLI v2 is installed', () => {
    expect(dockerfileContent).toContain('awscli');
    expect(dockerfileContent).toContain('aws/install');
  });

  test('debian:bookworm-slim base image is used', () => {
    expect(dockerfileContent).toContain('debian:bookworm-slim');
  });

  test('mcp-grafana binary download exists', () => {
    expect(dockerfileContent).toContain('mcp-grafana');
    expect(dockerfileContent).toContain('github.com/grafana/mcp-grafana/releases');
  });

  test('Architecture auto-detection is included', () => {
    expect(dockerfileContent).toContain('aarch64');
    expect(dockerfileContent).toContain('arm64');
    expect(dockerfileContent).toContain('x86_64');
  });

  test('mcp-grafana starts in streamable-http mode on port 8000', () => {
    expect(dockerfileContent).toContain('streamable-http');
    expect(dockerfileContent).toContain('0.0.0.0:8000');
  });
});
