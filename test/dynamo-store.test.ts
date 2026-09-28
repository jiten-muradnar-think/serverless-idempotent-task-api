import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { dynamoStore } from '../src/lib/dynamo-store';
import { ConditionFailed } from '../src/lib/store';

/** Captures what the adapter actually sends to DynamoDB. */
function spyClient(behaviour: (input: Record<string, unknown>) => unknown = () => ({})) {
  const sent: Record<string, unknown>[] = [];
  const client = {
    send: (cmd: { input: Record<string, unknown> }) => {
      sent.push(cmd.input);
      const result = behaviour(cmd.input);
      return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
    },
  } as unknown as DynamoDBDocumentClient;
  return { client, sent };
}

const named = (name: string) => Object.assign(new Error(name), { name });

const reservation = { pk: 'TENANT#a', sk: 'IDEMPOTENCY#k', payloadHash: 'h1' };
const opts = { nowEpoch: 1_700_000_000, payloadHash: 'h1' };

describe('DynamoDB adapter', () => {
  it('guards the claim so a free slot or an expired matching lease may be taken', async () => {
    const { client, sent } = spyClient();
    await dynamoStore('tasks', client).acquireReservation(reservation, opts);

    const input = sent[0]!;
    expect(input['ConditionExpression']).toBe(
      'attribute_not_exists(pk) OR (#status = :inProgress AND #lease < :now AND #hash = :hash)',
    );
    expect(input['ExpressionAttributeValues']).toEqual({
      ':inProgress': 'IN_PROGRESS',
      ':now': opts.nowEpoch,
      ':hash': 'h1',
    });
    expect(input['TableName']).toBe('tasks');
  });

  it('translates a lost race into ConditionFailed, not a raw AWS error', async () => {
    const { client } = spyClient(() => named('ConditionalCheckFailedException'));
    await expect(
      dynamoStore('tasks', client).acquireReservation(reservation, opts),
    ).rejects.toBeInstanceOf(ConditionFailed);
  });

  it('propagates unexpected AWS errors untouched', async () => {
    const { client } = spyClient(() => named('ProvisionedThroughputExceededException'));
    await expect(
      dynamoStore('tasks', client).acquireReservation(reservation, opts),
    ).rejects.toHaveProperty('name', 'ProvisionedThroughputExceededException');
  });

  it('reads the reservation with strong consistency', async () => {
    const { client, sent } = spyClient(() => ({ Item: { pk: 'p', sk: 's' } }));
    const item = await dynamoStore('tasks', client).get('p', 's');

    expect(sent[0]!['ConsistentRead']).toBe(true);
    expect(item).toEqual({ pk: 'p', sk: 's' });
  });

  it('returns undefined when the reservation is absent', async () => {
    const { client } = spyClient(() => ({}));
    await expect(dynamoStore('tasks', client).get('p', 's')).resolves.toBeUndefined();
  });

  it('sends both writes in one transaction with a dedupe token', async () => {
    const { client, sent } = spyClient();
    await dynamoStore('tasks', client).transactWrite(
      [
        { pk: 'p', sk: 'TASK#1' },
        { pk: 'p', sk: 'IDEMPOTENCY#k' },
      ],
      'token-1',
    );

    const input = sent[0]!;
    expect(input['ClientRequestToken']).toBe('token-1');
    expect(input['TransactItems']).toHaveLength(2);
  });

  it('translates a cancelled transaction into ConditionFailed', async () => {
    const { client } = spyClient(() => named('TransactionCanceledException'));
    await expect(
      dynamoStore('tasks', client).transactWrite([{ pk: 'p', sk: 's' }], 't'),
    ).rejects.toBeInstanceOf(ConditionFailed);
  });
});
