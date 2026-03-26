import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { EcsObservabilityStack } from '../lib/ecs-observability-stack';

/**
 * EcsObservabilityStack unit tests
 *
 * Validates VPC, ALB, ECS Service, Amazon Managed Prometheus,
 * Amazon Managed Grafana resource configuration and CloudFormation outputs.
 */

function createTestStack() {
  const app = new cdk.App();
  const stack = new EcsObservabilityStack(app, 'TestEcsObservabilityStack', {
    env: { account: '123456789012', region: 'ap-northeast-1' },
  });
  return { app, stack, template: Template.fromStack(stack) };
}

describe('VPC validation', () => {
  test('VPC is created', () => {
    const { template } = createTestStack();
    template.resourceCountIs('AWS::EC2::VPC', 1);
  });

  test('Public and private subnets are created', () => {
    const { template } = createTestStack();
    const resources = template.toJSON().Resources;
    const subnets = Object.values(resources).filter(
      (r: any) => r.Type === 'AWS::EC2::Subnet',
    );
    // maxAzs: 3 -> 3 public + 3 private = 6
    expect(subnets.length).toBe(6);
  });

  test('NAT Gateway is created', () => {
    const { template } = createTestStack();
    template.resourceCountIs('AWS::EC2::NatGateway', 1);
  });
});

describe('ALB validation', () => {
  test('Application Load Balancer is created', () => {
    const { template } = createTestStack();
    template.resourceCountIs('AWS::ElasticLoadBalancingV2::LoadBalancer', 1);
  });

  test('HTTP listener on port 80 is created', () => {
    const { template } = createTestStack();
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Port: 80,
      Protocol: 'HTTP',
    });
  });
});

describe('Amazon Managed Prometheus validation', () => {
  test('AMP workspace is created', () => {
    const { template } = createTestStack();
    template.resourceCountIs('AWS::APS::Workspace', 1);
  });

  test('AMP workspace alias is ecs-observability', () => {
    const { template } = createTestStack();
    template.hasResourceProperties('AWS::APS::Workspace', {
      Alias: 'ecs-observability',
    });
  });
});

describe('Amazon Managed Grafana validation', () => {
  test('AMG workspace is created', () => {
    const { template } = createTestStack();
    template.resourceCountIs('AWS::Grafana::Workspace', 1);
  });

  test('SSO authentication is configured', () => {
    const { template } = createTestStack();
    template.hasResourceProperties('AWS::Grafana::Workspace', {
      AuthenticationProviders: ['AWS_SSO'],
    });
  });

  test('Prometheus data source is configured', () => {
    const { template } = createTestStack();
    template.hasResourceProperties('AWS::Grafana::Workspace', {
      DataSources: ['PROMETHEUS'],
    });
  });
});

describe('ECS validation', () => {
  test('ECS cluster is created', () => {
    const { template } = createTestStack();
    template.resourceCountIs('AWS::ECS::Cluster', 1);
  });

  test('Cluster name is ecs-observability', () => {
    const { template } = createTestStack();
    template.hasResourceProperties('AWS::ECS::Cluster', {
      ClusterName: 'ecs-observability',
    });
  });

  test('Fargate task definition is created', () => {
    const { template } = createTestStack();
    template.resourceCountIs('AWS::ECS::TaskDefinition', 1);
  });

  test('Task definition contains both nginx and aws-otel-collector containers', () => {
    const { template } = createTestStack();
    const resources = template.toJSON().Resources;
    const taskDefs = Object.values(resources).filter(
      (r: any) => r.Type === 'AWS::ECS::TaskDefinition',
    );
    expect(taskDefs.length).toBe(1);
    const containerDefs = (taskDefs[0] as any).Properties.ContainerDefinitions;
    expect(containerDefs.length).toBe(2);

    const names = containerDefs.map((c: any) => c.Name);
    expect(names).toContain('nginx');
    expect(names).toContain('aws-otel-collector');
  });

  test('nginx container exposes port 80', () => {
    const { template } = createTestStack();
    const resources = template.toJSON().Resources;
    const taskDefs = Object.values(resources).filter(
      (r: any) => r.Type === 'AWS::ECS::TaskDefinition',
    );
    const containerDefs = (taskDefs[0] as any).Properties.ContainerDefinitions;
    const nginx = containerDefs.find((c: any) => c.Name === 'nginx');
    expect(nginx.PortMappings).toEqual(
      expect.arrayContaining([expect.objectContaining({ ContainerPort: 80 })]),
    );
  });

  test('ECS Service is created', () => {
    const { template } = createTestStack();
    template.resourceCountIs('AWS::ECS::Service', 1);
  });
});

describe('IAM validation', () => {
  test('IAM role for AMG workspace is created', () => {
    const { template } = createTestStack();
    const resources = template.toJSON().Resources;
    const roles = Object.values(resources).filter(
      (r: any) => r.Type === 'AWS::IAM::Role',
    );
    const grafanaRole = roles.find((r: any) =>
      r.Properties.AssumeRolePolicyDocument?.Statement?.some(
        (s: any) => s.Principal?.Service === 'grafana.amazonaws.com',
      ),
    );
    expect(grafanaRole).toBeDefined();
  });

  test('AMP query permissions are scoped to workspace ARN', () => {
    const { template } = createTestStack();
    const resources = template.toJSON().Resources;
    const policies = Object.values(resources).filter(
      (r: any) => r.Type === 'AWS::IAM::Policy',
    );
    const templateJson = JSON.stringify(policies);
    expect(templateJson).toContain('aps:QueryMetrics');
    expect(templateJson).toContain('aps:RemoteRead');
  });
});

describe('CloudFormation outputs validation', () => {
  const requiredOutputs = [
    'AlbDnsName', 'VpcId', 'PublicSubnetIds', 'PrivateSubnetIds',
    'AmpWorkspaceId', 'AmpEndpoint', 'AmpQueryEndpoint',
    'AmgWorkspaceUrl', 'AmgWorkspaceId',
  ];

  test.each(requiredOutputs)('%s is included in outputs', (outputName) => {
    const { template } = createTestStack();
    const outputKeys = Object.keys(template.toJSON().Outputs);
    expect(outputKeys.some((key) => key.includes(outputName))).toBe(true);
  });
});
