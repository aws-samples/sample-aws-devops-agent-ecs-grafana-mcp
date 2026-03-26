import * as path from 'path';
import * as cdk from 'aws-cdk-lib/core';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import {
  Runtime,
  AgentRuntimeArtifact,
  ProtocolType,
  RuntimeAuthorizerConfiguration,
} from '@aws-cdk/aws-bedrock-agentcore-alpha';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';

/**
 * AgentCoreStack properties
 */
export interface AgentCoreStackProps extends cdk.StackProps {
  /** Secrets Manager secret name for Grafana connection info */
  readonly grafanaSecretName: string;
}

/**
 * AgentCore Runtime + Cognito JWT authentication stack
 * - Cognito User Pool: JWT authentication via Client Credentials flow
 * - AgentCore Runtime: Runs mcp-grafana container with MCP protocol
 * - Bearer Token authenticated access
 */
export class AgentCoreStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: AgentCoreStackProps) {
    super(scope, id, props);

    // --- Cognito User Pool (Client Credentials flow) ---

    const userPool = new cognito.UserPool(this, 'McpUserPool', {
      selfSignUpEnabled: false,
      userPoolName: 'grafana-mcp-user-pool',
      passwordPolicy: {
        minLength: 8,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
      },
      advancedSecurityMode: cognito.AdvancedSecurityMode.ENFORCED,
    });

    // Cognito domain (token endpoint)
    const domain = userPool.addDomain('McpDomain', {
      cognitoDomain: {
        domainPrefix: `grafana-mcp-${cdk.Aws.ACCOUNT_ID}`,
      },
    });

    // Resource server (scope definition)
    const resourceServer = userPool.addResourceServer('McpResourceServer', {
      identifier: 'mcp-api',
      scopes: [
        {
          scopeName: 'access',
          scopeDescription: 'MCP API access',
        },
      ],
    });

    // App client (Client Credentials flow)
    const client = userPool.addClient('McpClient', {
      generateSecret: true,
      oAuth: {
        flows: { clientCredentials: true },
        scopes: [
          cognito.OAuthScope.resourceServer(resourceServer, {
            scopeName: 'access',
            scopeDescription: 'MCP API access',
          }),
        ],
      },
    });

    // --- AgentCore Runtime with Cognito JWT authentication ---

    // Grafana credentials retrieved from Secrets Manager at container startup
    const grafanaSecret = secretsmanager.Secret.fromSecretNameV2(
      this, 'GrafanaSecret', props.grafanaSecretName,
    );

    const runtime = new Runtime(this, 'GrafanaMcpRuntime', {
      runtimeName: 'grafana_mcp_server',
      description: 'Grafana MCP Server on AgentCore Runtime',
      protocolConfiguration: ProtocolType.MCP,
      authorizerConfiguration: RuntimeAuthorizerConfiguration.usingCognito(
        userPool,
        [client],
        undefined,
        ['mcp-api/access'],
      ),
      agentRuntimeArtifact: AgentRuntimeArtifact.fromAsset(
        path.join(__dirname, '..', '..', 'docker'),
      ),
      environmentVariables: {
        GRAFANA_SECRET_NAME: props.grafanaSecretName,
      },
    });

    grafanaSecret.grantRead(runtime);

    // --- CloudWatch Logs delivery ---

    const logGroup = new logs.LogGroup(this, 'RuntimeLogGroup', {
      logGroupName: `/aws/bedrock-agentcore/runtime/${runtime.agentRuntimeId}`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const deliverySourceName = `agentcore-runtime-logs`;
    const deliverySource = new cdk.CfnResource(this, 'LogDeliverySource', {
      type: 'AWS::Logs::DeliverySource',
      properties: {
        Name: deliverySourceName,
        LogType: 'APPLICATION_LOGS',
        ResourceArn: runtime.agentRuntimeArn,
      },
    });

    const deliveryDestination = new cdk.CfnResource(this, 'LogDeliveryDestination', {
      type: 'AWS::Logs::DeliveryDestination',
      properties: {
        Name: `agentcore-runtime-cwl-dest`,
        DestinationResourceArn: logGroup.logGroupArn,
      },
    });

    const delivery = new cdk.CfnResource(this, 'LogDelivery', {
      type: 'AWS::Logs::Delivery',
      properties: {
        DeliverySourceName: deliverySourceName,
        DeliveryDestinationArn: deliveryDestination.getAtt('Arn').toString(),
      },
    });
    delivery.addDependency(deliverySource);
    delivery.addDependency(deliveryDestination);

    // Runtime Endpoint
    const endpoint = runtime.addEndpoint('GrafanaMcpEndpoint', {
      description: 'Grafana MCP Server endpoint',
    });

    // CloudFormation outputs
    new cdk.CfnOutput(this, 'RuntimeId', {
      value: runtime.agentRuntimeId,
      description: 'AgentCore Runtime ID',
    });

    new cdk.CfnOutput(this, 'RuntimeEndpointId', {
      value: endpoint.endpointId,
      description: 'AgentCore Runtime Endpoint ID',
    });

    new cdk.CfnOutput(this, 'RuntimeEndpointArn', {
      value: endpoint.agentRuntimeEndpointArn,
      description: 'AgentCore Runtime Endpoint ARN',
    });

    new cdk.CfnOutput(this, 'CognitoUserPoolId', {
      value: userPool.userPoolId,
      description: 'Cognito User Pool ID',
    });

    new cdk.CfnOutput(this, 'CognitoClientId', {
      value: client.userPoolClientId,
      description: 'Cognito App Client ID',
    });

    new cdk.CfnOutput(this, 'CognitoTokenEndpoint', {
      value: `https://${domain.domainName}.auth.${this.region}.amazoncognito.com/oauth2/token`,
      description: 'Cognito Token Endpoint URL',
    });

    // cdk-nag suppressions
    NagSuppressions.addResourceSuppressions(userPool, [
      { id: 'AwsSolutions-COG2', reason: 'MFA not required for Client Credentials flow (machine-to-machine)' },
    ]);
    NagSuppressions.addResourceSuppressions(runtime, [
      { id: 'AwsSolutions-IAM5', reason: 'Wildcard permissions auto-generated by AgentCore Runtime CDK construct' },
    ], true);
  }
}
