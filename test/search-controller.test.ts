import { createSearchController } from '../src/web/search-controller';

type Row = { id: string };

/** A fetcher whose responses are resolved by hand, so ordering is explicit. */
function deferredFetcher() {
  const pending: {
    tenantId: string;
    resolve: (r: Row[]) => void;
    reject: (e: Error) => void;
    aborted: boolean;
  }[] = [];
  const fetcher = (tenantId: string, _q: string, signal: AbortSignal) =>
    new Promise<Row[]>((resolve, reject) => {
      const entry = { tenantId, resolve, reject, aborted: false };
      signal.addEventListener('abort', () => {
        entry.aborted = true;
      });
      pending.push(entry);
    });
  return { fetcher, pending };
}

const flush = () => new Promise((r) => setImmediate(r));

describe('tenant search race conditions', () => {
  it('ignores a response for the old tenant that arrives after the tenant changed', async () => {
    const { fetcher, pending } = deferredFetcher();
    const seen: unknown[] = [];
    const c = createSearchController<Row>(fetcher, (s) => seen.push(s));

    void c.search('tenant-a', 'aspirin');
    void c.search('tenant-b', 'aspirin');
    await flush();

    // Tenant A's request was aborted the moment the tenant changed...
    expect(pending[0]!.aborted).toBe(true);

    // ...and even if the network still delivers it, it must not be rendered.
    pending[0]!.resolve([{ id: 'from-tenant-a' }]);
    await flush();
    expect(c.getState().results).toEqual([]);
    expect(c.getState().loading).toBe(true);

    pending[1]!.resolve([{ id: 'from-tenant-b' }]);
    await flush();
    expect(c.getState()).toEqual({
      results: [{ id: 'from-tenant-b' }],
      loading: false,
      error: undefined,
    });
  });

  it('ignores a late error from a superseded request', async () => {
    const { fetcher, pending } = deferredFetcher();
    const c = createSearchController<Row>(fetcher, () => {});

    void c.search('tenant-a', 'x');
    void c.search('tenant-b', 'x');
    await flush();

    pending[0]!.reject(new Error('tenant A blew up'));
    await flush();
    expect(c.getState().error).toBeUndefined();

    pending[1]!.resolve([{ id: 'b' }]);
    await flush();
    expect(c.getState().error).toBeUndefined();
    expect(c.getState().results).toEqual([{ id: 'b' }]);
  });

  it('surfaces an error only for the current request', async () => {
    const { fetcher, pending } = deferredFetcher();
    const c = createSearchController<Row>(fetcher, () => {});

    void c.search('tenant-a', 'x');
    await flush();
    pending[0]!.reject(new Error('boom'));
    await flush();

    expect(c.getState()).toEqual({ results: [], loading: false, error: 'boom' });
  });

  it('clears stale results immediately on tenant change, never showing another tenant data', async () => {
    const { fetcher, pending } = deferredFetcher();
    const c = createSearchController<Row>(fetcher, () => {});

    void c.search('tenant-a', 'x');
    await flush();
    pending[0]!.resolve([{ id: 'a' }]);
    await flush();
    expect(c.getState().results).toEqual([{ id: 'a' }]);

    void c.search('tenant-b', 'x');
    expect(c.getState().results).toEqual([]);
    expect(c.getState().loading).toBe(true);
  });

  it('cancel aborts in-flight work and drops its result', async () => {
    const { fetcher, pending } = deferredFetcher();
    const c = createSearchController<Row>(fetcher, () => {});

    void c.search('tenant-a', 'x');
    await flush();
    c.cancel();
    expect(pending[0]!.aborted).toBe(true);

    pending[0]!.resolve([{ id: 'late' }]);
    await flush();
    expect(c.getState().results).toEqual([]);
  });
});
