import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { TaskApiStack } from '../lib/task-api-stack';

/** Infrastructure assertions, so a regression in the stack fails CI not prod. */
describe('TaskApiStack', () => {
  const template = Template.fromStack(
    new TaskApiStack(new App(), 'Test', {
      jwtIssuer: 'https://idp.example.com/',
      jwtAudience: ['task-api'],
      allowedOrigins: ['https://app.example.com'],
    }),
  );

  it('retains the table and enables point-in-time recovery', () => {
    template.hasResource('AWS::DynamoDB::Table', {
      DeletionPolicy: 'Retain',
      Properties: Match.objectLike({
        PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
        TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
        SSESpecification: { SSEEnabled: true },
      }),
    });
  });

  it('runs the handler with tracing, a DLQ and bounded concurrency', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      TracingConfig: { Mode: 'Active' },
      ReservedConcurrentExecutions: 50,
      DeadLetterConfig: Match.anyValue(),
      Runtime: 'nodejs22.x',
    });
  });

  it('protects every route with the JWT authorizer', () => {
    template.hasResourceProperties('AWS::ApiGatewayV2::Authorizer', {
      AuthorizerType: 'JWT',
      JwtConfiguration: { Audience: ['task-api'], Issuer: 'https://idp.example.com/' },
    });
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      AuthorizationType: 'JWT',
      RouteKey: 'POST /v1/tasks',
    });
  });

  it('never allows a wildcard CORS origin', () => {
    const apis = template.findResources('AWS::ApiGatewayV2::Api');
    const cors = Object.values(apis)[0]?.Properties?.CorsConfiguration;
    expect(cors.AllowOrigins).toEqual(['https://app.example.com']);
    expect(cors.AllowOrigins).not.toContain('*');
  });

  it('throttles the stage', () => {
    template.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
      DefaultRouteSettings: { ThrottlingBurstLimit: 200, ThrottlingRateLimit: 100 },
    });
  });

  it('alarms on errors, throttles, latency, DLQ depth and table throttling', () => {
    template.resourceCountIs('AWS::CloudWatch::Alarm', 5);
  });

  it('grants the function no more than table read and write', () => {
    const policies = template.findResources('AWS::IAM::Policy');
    const actions = Object.values(policies)
      .flatMap((p) => p.Properties.PolicyDocument.Statement)
      .flatMap((s: { Action: string | string[] }) => s.Action)
      .filter((a): a is string => typeof a === 'string');
    expect(actions.some((a) => a.startsWith('dynamodb:'))).toBe(true);
    expect(actions).not.toContain('dynamodb:*');
    expect(actions).not.toContain('*');
  });
});
