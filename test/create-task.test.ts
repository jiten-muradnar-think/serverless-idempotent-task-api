import { Principal } from '../src/lib/auth';
import { CreateTaskInput, createTask } from '../src/lib/create-task-service';
import { HttpError } from '../src/lib/errors';
import { payloadHash } from '../src/lib/idempotency';
import { FakeStore } from './fake-store';

const principal: Principal = {
  tenantId: 'tenant-a',
  subject: 'user-1',
  scopes: ['tasks:write'],
};

const input: CreateTaskInput = { title: 'Refill prescription', dueAt: '2026-10-05T09:00:00Z' };

const AT = '2026-09-28T10:00:00Z';

const deps = (store: FakeStore, ids: string[] = [], at: string = AT) => {
  let n = 0;
  return {
    store,
    newId: () => ids[n++] ?? `id-${n}`,
    now: () => new Date(at),
    leaseSeconds: 60,
  };
};

describe('idempotent task creation', () => {
  it('creates the task once and returns 201', async () => {
    const store = new FakeStore();
    const res = await createTask(principal, 'key-1', input, deps(store, ['task-1']));

    expect(res.status).toBe(201);
    expect(res.body.id).toBe('task-1');
    expect(res.body.tenantId).toBe('tenant-a');
    expect(store.tasks()).toHaveLength(1);
  });

  it('replays the original response on a sequential retry, without creating a second task', async () => {
    const store = new FakeStore();
    const first = await createTask(principal, 'key-1', input, deps(store, ['task-1']));
    const second = await createTask(principal, 'key-1', input, deps(store, ['task-2']));

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    expect(store.tasks()).toHaveLength(1);
  });

  it('creates exactly one task when N concurrent requests share an idempotency key', async () => {
    const store = new FakeStore();

    // Hold every caller at the conditional write until all have arrived, so
    // they genuinely contend rather than running one after another.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    let waiting = 0;
    const CONCURRENCY = 8;

    store.beforeWrite = async () => {
      waiting += 1;
      if (waiting === CONCURRENCY) release();
      await gate;
    };

    const attempts = Array.from({ length: CONCURRENCY }, (_, i) =>
      createTask(principal, 'key-1', input, deps(store, [`task-${i}`])).catch((e) => e),
    );
    const settled = await Promise.all(attempts);

    const created = settled.filter((r) => r?.status === 201);
    const replayed = settled.filter((r) => r?.status === 200);
    const inProgress = settled.filter(
      (r) => r instanceof HttpError && r.code === 'request_in_progress',
    );

    expect(created).toHaveLength(1);
    expect(store.tasks()).toHaveLength(1);
    expect(replayed.length + inProgress.length).toBe(CONCURRENCY - 1);
  });

  it('rejects the same key with a different payload instead of returning the old task', async () => {
    const store = new FakeStore();
    await createTask(principal, 'key-1', input, deps(store, ['task-1']));

    const err = await createTask(
      principal,
      'key-1',
      { title: 'Something else entirely' },
      deps(store),
    ).catch((e) => e);

    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(409);
    expect(err.code).toBe('idempotency_key_reuse');
    expect(store.tasks()).toHaveLength(1);
  });

  it('isolates tenants that reuse the same idempotency key', async () => {
    const store = new FakeStore();
    const other: Principal = { ...principal, tenantId: 'tenant-b' };

    const a = await createTask(principal, 'key-1', input, deps(store, ['task-a']));
    const b = await createTask(other, 'key-1', input, deps(store, ['task-b']));

    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.body.tenantId).toBe('tenant-b');
    expect(store.tasks()).toHaveLength(2);
  });

  it('requires an idempotency key', async () => {
    const err = await createTask(principal, '', input, deps(new FakeStore())).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(400);
  });

  it('hashes payloads independently of key order', () => {
    expect(payloadHash({ a: 1, b: { c: 2, d: 3 } })).toBe(payloadHash({ b: { d: 3, c: 2 }, a: 1 }));
    expect(payloadHash({ a: 1 })).not.toBe(payloadHash({ a: 2 }));
  });
});

describe('crash recovery via lease expiry', () => {
  const AFTER_LEASE = '2026-09-28T10:02:00Z'; // 120s later, lease was 60s
  const WITHIN_LEASE = '2026-09-28T10:00:30Z';

  /** Simulate a handler killed after claiming the key but before completing. */
  async function abandonedClaim(store: FakeStore) {
    store.failTransactWrite = true;
    await createTask(principal, 'key-1', input, deps(store, ['task-dead'])).catch(() => {});
    store.failTransactWrite = false;
  }

  it('a live lease still blocks a second caller', async () => {
    const store = new FakeStore();
    await abandonedClaim(store);

    const err = await createTask(
      principal,
      'key-1',
      input,
      deps(store, ['task-2'], WITHIN_LEASE),
    ).catch((e) => e);

    expect(err).toBeInstanceOf(HttpError);
    expect(err.code).toBe('request_in_progress');
    expect(err.detail.retryAfterSeconds).toBeGreaterThan(0);
    expect(store.tasks()).toHaveLength(0);
  });

  it('an expired lease is taken over, so the key does not stay locked', async () => {
    const store = new FakeStore();
    await abandonedClaim(store);
    expect(store.tasks()).toHaveLength(0); // the crashed attempt created nothing

    const res = await createTask(principal, 'key-1', input, deps(store, ['task-2'], AFTER_LEASE));

    expect(res.status).toBe(201);
    expect(res.body.id).toBe('task-2');
    expect(store.tasks()).toHaveLength(1);
  });

  it('an expired lease is not taken over by a different payload', async () => {
    const store = new FakeStore();
    await abandonedClaim(store);

    const err = await createTask(
      principal,
      'key-1',
      { title: 'A completely different task' },
      deps(store, ['task-2'], AFTER_LEASE),
    ).catch((e) => e);

    expect(err).toBeInstanceOf(HttpError);
    expect(err.code).toBe('idempotency_key_reuse');
    expect(store.tasks()).toHaveLength(0);
  });

  it('a completed record is never taken over, however old', async () => {
    const store = new FakeStore();
    const first = await createTask(principal, 'key-1', input, deps(store, ['task-1']));
    const later = await createTask(principal, 'key-1', input, deps(store, ['task-2'], AFTER_LEASE));

    expect(later.status).toBe(200);
    expect(later.body.id).toBe(first.body.id);
    expect(store.tasks()).toHaveLength(1);
  });
});

describe('data retention safety', () => {
  it('task items carry no TTL attribute, so tasks are never auto-deleted', async () => {
    const store = new FakeStore();
    await createTask(principal, 'key-1', input, deps(store, ['task-1']));

    const task = store.tasks()[0]!;
    expect(task['expiresAt']).toBeUndefined();
    expect(task['type']).toBe('TASK');
  });

  it('idempotency records do carry a TTL', async () => {
    const store = new FakeStore();
    await createTask(principal, 'key-1', input, deps(store, ['task-1']));

    const record = [...store.items.values()].find((i) => String(i.sk).startsWith('IDEMPOTENCY#'))!;
    expect(typeof record['expiresAt']).toBe('number');
  });

  it('passes a stable client request token to the transaction', async () => {
    const store = new FakeStore();
    await createTask(principal, 'key-1', input, deps(store, ['task-1']));
    expect(store.transactTokens[0]).toBeTruthy();
    expect(store.transactTokens[0]!.length).toBeLessThanOrEqual(36);
  });
});

describe('input validation', () => {
  it.each([
    ['title missing', {}],
    ['title blank', { title: '   ' }],
    ['title too long', { title: 'x'.repeat(501) }],
    ['unknown field', { title: 'ok', tenantId: 'tenant-victim' }],
    ['bad dueAt', { title: 'ok', dueAt: 'next tuesday' }],
  ])('rejects %s', async (_label, body) => {
    const err = await createTask(principal, 'key-1', body, deps(new FakeStore())).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(400);
    expect(err.code).toBe('invalid_payload');
  });

  it.each([
    ['empty', ''],
    ['too long', 'k'.repeat(129)],
    ['illegal characters', 'key with spaces'],
  ])('rejects an idempotency key that is %s', async (_label, key) => {
    const err = await createTask(principal, key, input, deps(new FakeStore())).catch((e) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err.status).toBe(400);
    expect(err.code).toBe('invalid_idempotency_key');
  });
});
