import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { AcquireOptions, ConditionFailed, Item, Store } from './store';

/**
 * Adaptive retries back off when DynamoDB throttles, rather than hammering a
 * partition that is already shedding load. Attempts are capped so a Lambda
 * cannot burn its whole timeout inside the SDK.
 */
let shared: DynamoDBDocumentClient | undefined;

/**
 * Built on first use and then reused for the life of the execution
 * environment. Creating it lazily keeps importing this module free of side
 * effects, so a caller that injects its own store never opens a socket.
 */
export function defaultClient(): DynamoDBDocumentClient {
  return (shared ??= DynamoDBDocumentClient.from(
    new DynamoDBClient({
      maxAttempts: 4,
      retryMode: 'adaptive',
      requestHandler: { requestTimeout: 3_000, connectionTimeout: 1_000 },
    }),
    { marshallOptions: { removeUndefinedValues: true } },
  ));
}

const CONDITIONAL_CHECK_FAILED = 'ConditionalCheckFailedException';
const TRANSACTION_CANCELED = 'TransactionCanceledException';

export function dynamoStore(tableName: string, client?: DynamoDBDocumentClient): Store {
  const ddb = () => client ?? defaultClient();
  return {
    async acquireReservation(item: Item, opts: AcquireOptions): Promise<void> {
      try {
        await ddb().send(
          new PutCommand({
            TableName: tableName,
            Item: item,
            // The entire concurrency guarantee lives in this expression.
            //
            // Slot is free, OR a previous holder crashed: its lease has passed
            // and the payload is identical, so taking over cannot produce a
            // task the original caller did not ask for.
            ConditionExpression:
              'attribute_not_exists(pk) OR (#status = :inProgress AND #lease < :now AND #hash = :hash)',
            ExpressionAttributeNames: {
              '#status': 'status',
              '#lease': 'leaseExpiresAt',
              '#hash': 'payloadHash',
            },
            ExpressionAttributeValues: {
              ':inProgress': 'IN_PROGRESS',
              ':now': opts.nowEpoch,
              ':hash': opts.payloadHash,
            },
          }),
        );
      } catch (err) {
        if ((err as { name?: string }).name === CONDITIONAL_CHECK_FAILED) {
          throw new ConditionFailed();
        }
        throw err;
      }
    },

    async get(pk: string, sk: string): Promise<Item | undefined> {
      const res = await ddb().send(
        // Strongly consistent: a replay must never read a stale IN_PROGRESS
        // record and report "in progress" for a request that already finished.
        new GetCommand({ TableName: tableName, Key: { pk, sk }, ConsistentRead: true }),
      );
      return res.Item as Item | undefined;
    },

    async transactWrite(items: Item[], requestToken: string): Promise<void> {
      try {
        await ddb().send(
          new TransactWriteCommand({
            TransactItems: items.map((Item) => ({ Put: { TableName: tableName, Item } })),
            // Makes an SDK-level retry of this transaction a no-op rather than
            // a second application of the same writes.
            ClientRequestToken: requestToken,
          }),
        );
      } catch (err) {
        if ((err as { name?: string }).name === TRANSACTION_CANCELED) {
          throw new ConditionFailed();
        }
        throw err;
      }
    },
  };
}
