import { CfnOutput, Duration, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import { CfnStage, CorsHttpMethod, HttpApi, HttpMethod } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpJwtAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import { Alarm, ComparisonOperator, Metric, TreatMissingData } from 'aws-cdk-lib/aws-cloudwatch';
import { AttributeType, BillingMode, Table, TableEncryption } from 'aws-cdk-lib/aws-dynamodb';
import { Architecture, Runtime, Tracing } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Queue, QueueEncryption } from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';

export interface TaskApiStackProps extends StackProps {
  /** JWT issuer URL, e.g. https://cognito-idp.eu-west-1.amazonaws.com/<pool-id> */
  readonly jwtIssuer: string;
  readonly jwtAudience: string[];
  /** Browser origins allowed to call the API. Never '*' with credentials. */
  readonly allowedOrigins: string[];
  /** Ceiling on concurrent executions, so one API cannot starve the account. */
  readonly reservedConcurrency?: number;
}

const LAMBDA_TIMEOUT = Duration.seconds(10);
/** Must exceed the Lambda timeout, so a lease expires only once a holder is dead. */
const LEASE_SECONDS = 60;

export class TaskApiStack extends Stack {
  constructor(scope: Construct, id: string, props: TaskApiStackProps) {
    super(scope, id, props);

    const table = new Table(this, 'TasksTable', {
      partitionKey: { name: 'pk', type: AttributeType.STRING },
      sortKey: { name: 'sk', type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      encryption: TableEncryption.AWS_MANAGED,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      // Only idempotency records carry expiresAt. Task items deliberately omit
      // it, so real tasks are never expired by this setting.
      timeToLiveAttribute: 'expiresAt',
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // Failed async invocations land here instead of disappearing.
    const dlq = new Queue(this, 'CreateTaskDlq', {
      encryption: QueueEncryption.SQS_MANAGED,
      retentionPeriod: Duration.days(14),
      enforceSSL: true,
    });

    const logGroup = new LogGroup(this, 'CreateTaskLogs', {
      retention: RetentionDays.SIX_MONTHS,
      // Logs carry the audit trail, so they outlive the stack like the table.
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const createTask = new NodejsFunction(this, 'CreateTaskFn', {
      entry: 'src/handlers/create-task.ts',
      handler: 'handler',
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      memorySize: 512,
      timeout: LAMBDA_TIMEOUT,
      logGroup,
      tracing: Tracing.ACTIVE,
      deadLetterQueue: dlq,
      reservedConcurrentExecutions: props.reservedConcurrency ?? 50,
      environment: {
        TABLE_NAME: table.tableName,
        LEASE_SECONDS: String(LEASE_SECONDS),
        LOG_LEVEL: 'info',
        NODE_OPTIONS: '--enable-source-maps',
        AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1',
      },
      bundling: { minify: true, sourceMap: true },
    });

    // Least privilege: read and write items in this one table, nothing else.
    table.grantReadWriteData(createTask);

    const api = new HttpApi(this, 'TaskHttpApi', {
      // Authorization is enforced at the edge; the handler trusts only claims
      // that this authorizer has already verified.
      defaultAuthorizer: new HttpJwtAuthorizer('JwtAuthorizer', props.jwtIssuer, {
        jwtAudience: props.jwtAudience,
      }),
      corsPreflight: {
        allowOrigins: props.allowedOrigins,
        allowMethods: [CorsHttpMethod.POST, CorsHttpMethod.OPTIONS],
        allowHeaders: ['content-type', 'authorization', 'idempotency-key'],
        exposeHeaders: ['location', 'idempotency-replayed', 'retry-after'],
        allowCredentials: true,
        maxAge: Duration.hours(1),
      },
    });

    api.addRoutes({
      path: '/v1/tasks',
      methods: [HttpMethod.POST],
      integration: new HttpLambdaIntegration('CreateTaskIntegration', createTask),
    });

    // Stage-level throttling caps the blast radius of a misbehaving client.
    const stage = api.defaultStage?.node.defaultChild as CfnStage | undefined;
    if (!stage) {
      throw new Error('HttpApi has no default stage, so throttling cannot be applied');
    }
    stage.defaultRouteSettings = { throttlingBurstLimit: 200, throttlingRateLimit: 100 };

    this.alarms(createTask, table, dlq);

    new CfnOutput(this, 'ApiUrl', { value: api.apiEndpoint });
    new CfnOutput(this, 'TableName', { value: table.tableName });
    new CfnOutput(this, 'DeadLetterQueueUrl', { value: dlq.queueUrl });
  }

  /** Alarms on the four things that actually page someone. */
  private alarms(fn: NodejsFunction, table: Table, dlq: Queue): void {
    new Alarm(this, 'CreateTaskErrorAlarm', {
      alarmDescription: 'Handler is returning unhandled errors',
      metric: fn.metricErrors({ period: Duration.minutes(5) }),
      threshold: 5,
      evaluationPeriods: 2,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });

    new Alarm(this, 'CreateTaskThrottleAlarm', {
      alarmDescription: 'Reserved concurrency is being exhausted',
      metric: fn.metricThrottles({ period: Duration.minutes(5) }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });

    new Alarm(this, 'CreateTaskLatencyAlarm', {
      alarmDescription: 'p99 latency approaching the function timeout',
      metric: fn.metricDuration({ period: Duration.minutes(5), statistic: 'p99' }),
      threshold: LAMBDA_TIMEOUT.toMilliseconds() * 0.8,
      evaluationPeriods: 3,
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });

    new Alarm(this, 'DlqNotEmptyAlarm', {
      alarmDescription: 'Invocations have failed into the dead letter queue',
      metric: dlq.metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(5) }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });

    new Alarm(this, 'TableThrottleAlarm', {
      alarmDescription: 'DynamoDB is throttling reads or writes',
      metric: new Metric({
        namespace: 'AWS/DynamoDB',
        metricName: 'ThrottledRequests',
        dimensionsMap: { TableName: table.tableName },
        period: Duration.minutes(5),
        statistic: 'Sum',
      }),
      threshold: 10,
      evaluationPeriods: 2,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });
  }
}
