import { randomUUID } from 'node:crypto';
import { Principal } from './auth';
import { badRequest, conflict } from './errors';
import { IdempotencyRecord, idempotencySk, payloadHash, taskSk, tenantPk } from './idempotency';
import { Logger, createLogger } from './logger';
import { CreateTaskBody, createTaskSchema, formatIssues, idempotencyKeySchema } from './schema';
import { ConditionFailed, Store } from './store';

export type CreateTaskInput = CreateTaskBody;

export interface TaskResponse {
  id: string;
  tenantId: string;
  title: string;
  dueAt?: string;
  assigneeId?: string;
  createdBy: string;
  createdAt: string;
}

export interface CreateTaskResult {
  status: 201 | 200;
  body: TaskResponse;
}

export interface Deps {
  store: Store;
  now?: () => Date;
  newId?: () => string;
  logger?: Logger;
  leaseSeconds?: number;
  idempotencyTtlSeconds?: number;
}

const DEFAULT_LEASE_SECONDS = 60;
const DEFAULT_TTL_SECONDS = 24 * 60 * 60;

/**
 * Idempotent task creation.
 *
 * Correctness under concurrency rests on one conditional write. Exactly one
 * caller can claim a given (tenant, idempotency key), so exactly one task is
 * ever created for it. Losers read the winner's record and either replay its
 * response or are told the request is still in flight.
 *
 * The claim carries a short lease. If the winner dies before completing, the
 * lease expires and the next caller with the identical payload takes over,
 * rather than the key staying locked for its full retention window.
 */
export async function createTask(
  principal: Principal,
  rawIdempotencyKey: string,
  rawInput: unknown,
  deps: Deps,
): Promise<CreateTaskResult> {
  const {
    store,
    now = () => new Date(),
    newId = randomUUID,
    logger = createLogger('error'),
    leaseSeconds = DEFAULT_LEASE_SECONDS,
    idempotencyTtlSeconds = DEFAULT_TTL_SECONDS,
  } = deps;

  const keyResult = idempotencyKeySchema.safeParse(rawIdempotencyKey);
  if (!keyResult.success) {
    throw badRequest('invalid_idempotency_key', formatIssues(keyResult.error));
  }
  const idempotencyKey = keyResult.data;

  const parsed = createTaskSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw badRequest('invalid_payload', formatIssues(parsed.error));
  }
  const input = parsed.data;

  const pk = tenantPk(principal.tenantId);
  const sk = idempotencySk(idempotencyKey);
  const hash = payloadHash(input);
  const taskId = newId();
  const timestamp = now();
  const nowEpoch = Math.floor(timestamp.getTime() / 1000);

  const reservation: IdempotencyRecord = {
    pk,
    sk,
    status: 'IN_PROGRESS',
    payloadHash: hash,
    taskId,
    leaseExpiresAt: nowEpoch + leaseSeconds,
    expiresAt: nowEpoch + idempotencyTtlSeconds,
  };

  try {
    await store.acquireReservation(reservation, { nowEpoch, payloadHash: hash });
  } catch (err) {
    if (!(err instanceof ConditionFailed)) throw err;
    logger.info('idempotency_key_contended', { idempotencyKeyHash: shortHash(idempotencyKey) });
    return replay(store, pk, sk, hash, nowEpoch);
  }

  const task: TaskResponse = {
    id: taskId,
    tenantId: principal.tenantId,
    title: input.title,
    ...(input.dueAt !== undefined ? { dueAt: input.dueAt } : {}),
    ...(input.assigneeId !== undefined ? { assigneeId: input.assigneeId } : {}),
    createdBy: principal.subject,
    createdAt: timestamp.toISOString(),
  };

  // Write the task and complete the reservation atomically, so a crash can
  // never leave a COMPLETED marker without the task it refers to.
  //
  // The task item deliberately carries no expiresAt. DynamoDB TTL is set on
  // the table, so an accidental TTL attribute here would silently delete real
  // tasks after the idempotency retention window.
  await store.transactWrite(
    [
      { pk, sk: taskSk(taskId), type: 'TASK', ...task },
      { ...reservation, status: 'COMPLETED', response: task },
    ],
    `create-task-${principal.tenantId}-${idempotencyKey}`.slice(0, 36),
  );

  // Audit trail: who created what, under which tenant, at what time. No task
  // content, which may be clinical.
  logger.info('task_created', {
    taskId,
    tenantId: principal.tenantId,
    actor: principal.subject,
    createdAt: task.createdAt,
  });

  return { status: 201, body: task };
}

async function replay(
  store: Store,
  pk: string,
  sk: string,
  hash: string,
  nowEpoch: number,
): Promise<CreateTaskResult> {
  const existing = (await store.get(pk, sk)) as IdempotencyRecord | undefined;

  // The record vanished between the failed claim and this read, so the TTL
  // fired mid-flight. Ask the client to retry rather than risk a duplicate.
  if (!existing) {
    throw conflict('idempotency_race', 'Concurrent request in flight, retry shortly');
  }

  // Same key, different body: the client reused a key for a different request.
  // Never silently return the old task, and never overwrite it.
  if (existing.payloadHash !== hash) {
    throw conflict(
      'idempotency_key_reuse',
      'This Idempotency-Key was already used with a different payload',
    );
  }

  if (existing.status === 'COMPLETED') {
    return { status: 200, body: existing.response as TaskResponse };
  }

  // Live lease: the original request is genuinely still running.
  const retryAfter = Math.max(1, existing.leaseExpiresAt - nowEpoch);
  throw conflict(
    'request_in_progress',
    'A request with this Idempotency-Key is still in progress',
    { retryAfterSeconds: retryAfter },
  );
}

/** Keys can be client-chosen; log a short digest rather than the value. */
const shortHash = (key: string) => payloadHash(key).slice(0, 12);
