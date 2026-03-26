import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as aps from 'aws-cdk-lib/aws-aps';
import * as grafana from 'aws-cdk-lib/aws-grafana';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';

export class EcsObservabilityStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // VPC (Public/Private Subnets, NAT Gateway)
    // sample-grafana-remote-mcp requires subnet count to be a multiple of AZ count, so use all AZs in the region
    const vpc = new ec2.Vpc(this, 'EcsObservabilityVpc', {
      maxAzs: 3,
      natGateways: 1,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          cidrMask: 24,
          name: 'Private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
      ],
    });

    // ALB (Internet-facing, HTTP listener port 80)
    const alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc,
      internetFacing: true,
    });

    const listener = alb.addListener('HttpListener', {
      port: 80,
      protocol: elbv2.ApplicationProtocol.HTTP,
      defaultAction: elbv2.ListenerAction.fixedResponse(404, {
        contentType: 'text/plain',
        messageBody: 'Not Found',
      }),
    });

    // Amazon Managed Prometheus Workspace
    const ampWorkspace = new aps.CfnWorkspace(this, 'AmpWorkspace', {
      alias: 'ecs-observability',
    });

    const ampEndpoint = `https://aps-workspaces.${this.region}.amazonaws.com/workspaces/${ampWorkspace.attrWorkspaceId}/api/v1/remote_write`;

    new cdk.CfnOutput(this, 'AmpWorkspaceId', {
      value: ampWorkspace.attrWorkspaceId,
    });

    new cdk.CfnOutput(this, 'AmpEndpoint', {
      value: ampEndpoint,
    });

    const ampQueryEndpoint = `https://aps-workspaces.${this.region}.amazonaws.com/workspaces/${ampWorkspace.attrWorkspaceId}`;

    new cdk.CfnOutput(this, 'AmpQueryEndpoint', {
      value: ampQueryEndpoint,
    });

    // Amazon Managed Grafana Workspace (SSO)
    const amgRole = new iam.Role(this, 'AmgWorkspaceRole', {
      assumedBy: new iam.ServicePrincipal('grafana.amazonaws.com'),
      description: 'IAM role for Amazon Managed Grafana to access AMP',
    });

    // Workspace-scoped actions (can be restricted to the specific AMP workspace)
    amgRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'aps:QueryMetrics',
          'aps:GetLabels',
          'aps:GetSeries',
          'aps:GetMetricMetadata',
          'aps:RemoteRead',
        ],
        resources: [ampWorkspace.attrArn],
      }),
    );

    // Account-level actions (do not support resource-level restrictions)
    amgRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'aps:ListWorkspaces',
          'aps:DescribeWorkspace',
        ],
        resources: ['*'],
      }),
    );

    const amgWorkspace = new grafana.CfnWorkspace(this, 'AmgWorkspace', {
      name: 'ecs-observability',
      accountAccessType: 'CURRENT_ACCOUNT',
      authenticationProviders: ['AWS_SSO'],
      permissionType: 'SERVICE_MANAGED',
      dataSources: ['PROMETHEUS'],
      roleArn: amgRole.roleArn,
    });

    new cdk.CfnOutput(this, 'AmgWorkspaceUrl', {
      value: `https://${amgWorkspace.attrEndpoint}`,
    });

    new cdk.CfnOutput(this, 'AmgWorkspaceId', {
      value: amgWorkspace.attrId,
    });

    // ECS Fargate Cluster & Task Definition (nginx + aws-otel-collector)
    const cluster = new ecs.Cluster(this, 'EcsCluster', {
      vpc,
      clusterName: 'ecs-observability',
    });

    const taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDef', {
      memoryLimitMiB: 512,
      cpu: 256,
    });

    // Grant aps:RemoteWrite to the task execution role
    taskDefinition.executionRole?.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonECSTaskExecutionRolePolicy'),
    );

    // Grant aps:RemoteWrite to the task role (used by the OTEL collector at runtime)
    taskDefinition.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['aps:RemoteWrite'],
        resources: [ampWorkspace.attrArn],
      }),
    );

    // nginx container
    taskDefinition.addContainer('nginx', {
      image: ecs.ContainerImage.fromRegistry('public.ecr.aws/nginx/nginx:latest'),
      essential: true,
      portMappings: [{ containerPort: 80 }],
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'nginx',
        logRetention: logs.RetentionDays.ONE_WEEK,
      }),
    });

    // aws-otel-collector sidecar container
    const otelConfigYaml = [
      'receivers:',
      '  awsecscontainermetrics:',
      '    collection_interval: 15s',
      'exporters:',
      '  prometheusremotewrite:',
      `    endpoint: "https://aps-workspaces.\${AWS_REGION}.amazonaws.com/workspaces/\${AMP_WORKSPACE_ID}/api/v1/remote_write"`,
      '    auth:',
      '      authenticator: sigv4auth',
      '    resource_to_telemetry_conversion:',
      '      enabled: true',
      'extensions:',
      '  sigv4auth:',
      '    region: "${AWS_REGION}"',
      '    service: "aps"',
      'service:',
      '  extensions: [sigv4auth]',
      '  pipelines:',
      '    metrics:',
      '      receivers: [awsecscontainermetrics]',
      '      exporters: [prometheusremotewrite]',
    ].join('\n');

    taskDefinition.addContainer('aws-otel-collector', {
      image: ecs.ContainerImage.fromRegistry('public.ecr.aws/aws-observability/aws-otel-collector:latest'),
      essential: false,
      environment: {
        AOT_CONFIG_CONTENT: otelConfigYaml,
        AWS_REGION: this.region,
        AMP_WORKSPACE_ID: ampWorkspace.attrWorkspaceId,
      },
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'otel-collector',
        logRetention: logs.RetentionDays.ONE_WEEK,
      }),
    });

    // ECS Service & ALB integration
    const service = new ecs.FargateService(this, 'EcsService', {
      cluster,
      taskDefinition,
      desiredCount: 1,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    });

    listener.addTargets('EcsTargetGroup', {
      port: 80,
      targets: [service],
      healthCheck: {
        path: '/',
        healthyHttpCodes: '200',
      },
    });

    new cdk.CfnOutput(this, 'AlbDnsName', {
      value: alb.loadBalancerDnsName,
    });

    new cdk.CfnOutput(this, 'VpcId', {
      value: vpc.vpcId,
    });

    new cdk.CfnOutput(this, 'PublicSubnetIds', {
      value: vpc.publicSubnets.map(s => s.subnetId).join(','),
    });

    new cdk.CfnOutput(this, 'PrivateSubnetIds', {
      value: vpc.privateSubnets.map(s => s.subnetId).join(','),
    });

    // cdk-nag suppressions (tutorial use only)
    NagSuppressions.addResourceSuppressions(vpc, [
      { id: 'AwsSolutions-VPC7', reason: 'VPC Flow Logs not required for tutorial purposes' },
    ]);
    NagSuppressions.addResourceSuppressions(alb, [
      { id: 'AwsSolutions-ELB2', reason: 'Access logs not required for tutorial purposes' },
      { id: 'AwsSolutions-EC23', reason: 'ALB allows 0.0.0.0/0 inbound access for tutorial purposes' },
    ], true);
    NagSuppressions.addResourceSuppressions(cluster, [
      { id: 'AwsSolutions-ECS4', reason: 'Container Insights not required for tutorial purposes' },
    ]);
    NagSuppressions.addResourceSuppressions(taskDefinition, [
      { id: 'AwsSolutions-ECS2', reason: 'OTEL collector configuration must be passed via environment variables' },
    ]);
    NagSuppressions.addResourceSuppressions(amgRole, [
      {
        id: 'AwsSolutions-IAM5',
        reason: 'aps:ListWorkspaces and aps:DescribeWorkspace do not support resource-level restrictions',
        appliesTo: ['Resource::*'],
      },
    ], true);
  }
}
