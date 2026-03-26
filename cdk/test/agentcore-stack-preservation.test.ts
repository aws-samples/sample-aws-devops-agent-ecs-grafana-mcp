import * as cdk from 'aws-cdk-lib/core';
import { Template } from 'aws-cdk-lib/assertions';
import * as fc from 'fast-check';
import { AgentCoreStack } from '../lib/agentcore-stack';

/**
 * Preservation property tests for AgentCoreStack.
 * Verifies that environment variables, Runtime/Endpoint resources,
 * and CfnOutputs are correctly maintained.
 */

// Custom Arbitrary for valid Secrets Manager secret names
const safeSecretNameArb = fc.stringOf(
  fc.constantFrom(
    'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm',
    'n', 'o', 'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z',
    '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
    '-', '/', '_',
  ),
  { minLength: 1, maxLength: 60 },
);

describe('Preservation: environment variables', () => {
  test('Any grafanaSecretName is set as GRAFANA_SECRET_NAME env var', () => {
    fc.assert(
      fc.property(safeSecretNameArb, (grafanaSecretName) => {
        const app = new cdk.App();
        const stack = new AgentCoreStack(app, 'TestAgentCoreStack', {
          grafanaSecretName,
        });

        const template = Template.fromStack(stack);
        const templateJson = JSON.stringify(template.toJSON());

        expect(templateJson).toContain('GRAFANA_SECRET_NAME');
        expect(templateJson).not.toContain('GRAFANA_SERVICE_ACCOUNT_TOKEN');
      }),
      { numRuns: 50 },
    );
  });
});

describe('Preservation: Runtime and Endpoint creation', () => {
  test('Runtime and Endpoint resources are created for any input', () => {
    fc.assert(
      fc.property(safeSecretNameArb, (grafanaSecretName) => {
        const app = new cdk.App();
        const stack = new AgentCoreStack(app, 'TestAgentCoreStack', {
          grafanaSecretName,
        });

        const template = Template.fromStack(stack);
        const allResources = template.toJSON().Resources;

        const bedrockResources = Object.entries(allResources).filter(
          ([_, r]: [string, any]) => r.Type && r.Type.includes('Bedrock'),
        );
        expect(bedrockResources.length).toBeGreaterThanOrEqual(2);

        const types = bedrockResources.map(([_, r]: [string, any]) => r.Type);
        expect(types.some((t: string) => t.includes('Runtime') && !t.includes('Endpoint'))).toBe(true);
        expect(types.some((t: string) => t.includes('Endpoint'))).toBe(true);
      }),
      { numRuns: 50 },
    );
  });
});

describe('Preservation: CfnOutput outputs', () => {
  test('RuntimeId, RuntimeEndpointId, RuntimeEndpointArn are output for any input', () => {
    fc.assert(
      fc.property(safeSecretNameArb, (grafanaSecretName) => {
        const app = new cdk.App();
        const stack = new AgentCoreStack(app, 'TestAgentCoreStack', {
          grafanaSecretName,
        });

        const template = Template.fromStack(stack);
        const outputs = template.toJSON().Outputs;
        expect(outputs).toBeDefined();

        const outputKeys = Object.keys(outputs);
        expect(outputKeys.some((key) => key.includes('RuntimeId'))).toBe(true);
        expect(outputKeys.some((key) => key.includes('RuntimeEndpointId'))).toBe(true);
        expect(outputKeys.some((key) => key.includes('RuntimeEndpointArn'))).toBe(true);
      }),
      { numRuns: 50 },
    );
  });
});
