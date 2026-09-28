import { handler } from '../src/handlers/create-task';
import { FakeStore } from './fake-store';

const event = (over: Record<string, unknown> = {}) => ({
  headers: { 'Idempotency-Key': 'key-1' },
  body: JSON.stringify({ title: 'Refill prescription' }),
  requestContext: {
    requestId: 'req-1',
    authorizer: {
      jwt: { claims: { sub: 'user-1', 'custom:tenant_id': 'tenant-a', scope: 'tasks:write' } },
    },
  },
  ...over,
});

describe('POST /v1/tasks handler', () => {
  it('returns 201 on first call and 200 on replay', async () => {
    const store = new FakeStore();
    const a = await handler(event(), undefined, { store });
    const b = await handler(event(), undefined, { store });

    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(200);
    expect(JSON.parse(b.body).id).toBe(JSON.parse(a.body).id);
  });

  it('returns 401 when the token carries no tenant', async () => {
    const res = await handler(
      event({ requestContext: { requestId: 'r', authorizer: { jwt: { claims: { sub: 'u' } } } } }),
      undefined,
      { store: new FakeStore() },
    );
    expect(res.statusCode).toBe(401);
  });

  it('rejects a tenantId supplied in the request body rather than silently dropping it', async () => {
    const res = await handler(
      event({ body: JSON.stringify({ title: 'x', tenantId: 'tenant-victim' }) }),
      undefined,
      { store: new FakeStore() },
    );
    // Silently ignoring the field would leave the caller believing it applied.
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).code).toBe('invalid_payload');
  });

  it('derives tenant from the token, not from anything the client controls', async () => {
    const res = await handler(event(), undefined, { store: new FakeStore() });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).tenantId).toBe('tenant-a');
  });

  it('returns a Location header on creation and flags a replay', async () => {
    const store = new FakeStore();
    const a = await handler(event(), undefined, { store });
    const b = await handler(event(), undefined, { store });

    expect(a.headers['location']).toBe(`/v1/tasks/${JSON.parse(a.body).id}`);
    expect(a.headers['idempotency-replayed']).toBe('false');
    expect(b.headers['idempotency-replayed']).toBe('true');
    expect(a.headers['cache-control']).toBe('no-store');
  });

  it('rejects a body over the size limit before parsing it', async () => {
    const res = await handler(
      event({ body: JSON.stringify({ title: 'x'.repeat(40_000) }) }),
      undefined,
      { store: new FakeStore() },
    );
    expect(res.statusCode).toBe(413);
  });

  it('never returns internal error detail to the caller', async () => {
    const store = new FakeStore();
    store.failTransactWrite = true;
    const res = await handler(event(), undefined, { store });

    expect(res.statusCode).toBe(500);
    expect(JSON.parse(res.body)).toEqual({
      code: 'internal_error',
      message: 'Internal server error',
      requestId: 'req-1',
    });
  });

  it('returns 400 for malformed JSON', async () => {
    const res = await handler(event({ body: '{nope' }), undefined, { store: new FakeStore() });
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when the Idempotency-Key header is absent', async () => {
    const res = await handler(event({ headers: {} }), undefined, { store: new FakeStore() });
    expect(res.statusCode).toBe(400);
  });

  it('accepts the header in any casing', async () => {
    const res = await handler(event({ headers: { 'IDEMPOTENCY-KEY': 'k9' } }), undefined, {
      store: new FakeStore(),
    });
    expect(res.statusCode).toBe(201);
  });
});
