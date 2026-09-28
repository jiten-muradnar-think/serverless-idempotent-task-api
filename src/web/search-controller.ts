/**
 * Framework-free core of the tenant-scoped search.
 *
 * Keeping the race logic out of the React hook means the interesting part —
 * what happens when responses arrive out of order or after a tenant switch —
 * is testable without a DOM.
 */

export interface SearchState<T> {
  results: T[];
  loading: boolean;
  error: string | undefined;
}

export const initialState = <T>(): SearchState<T> => ({
  results: [],
  loading: false,
  error: undefined,
});

export type Fetcher<T> = (tenantId: string, query: string, signal: AbortSignal) => Promise<T[]>;

export interface Controller<T> {
  search(tenantId: string, query: string): Promise<void>;
  /** Cancel in-flight work and drop any result still on its way. */
  cancel(): void;
  getState(): SearchState<T>;
}

export function createSearchController<T>(
  fetcher: Fetcher<T>,
  onChange: (state: SearchState<T>) => void,
): Controller<T> {
  let state = initialState<T>();
  // Monotonic token. Only the newest request may touch state; anything older
  // is a late arrival from a superseded query or tenant and must be dropped.
  let generation = 0;
  let inFlight: AbortController | undefined;

  const set = (next: Partial<SearchState<T>>) => {
    state = { ...state, ...next };
    onChange(state);
  };

  const cancel = () => {
    generation += 1;
    inFlight?.abort();
    inFlight = undefined;
  };

  return {
    getState: () => state,
    cancel,

    async search(tenantId: string, query: string): Promise<void> {
      cancel();
      const mine = generation;
      const controller = new AbortController();
      inFlight = controller;

      // Reset results too: showing tenant A's rows while tenant B loads is a
      // data leak in a multi-tenant UI, not just a cosmetic glitch.
      set({ loading: true, error: undefined, results: [] });

      try {
        const results = await fetcher(tenantId, query, controller.signal);
        if (mine !== generation) return; // superseded, discard silently
        set({ results, loading: false, error: undefined });
      } catch (err) {
        if (mine !== generation) return; // late failure of a stale request
        if ((err as { name?: string })?.name === 'AbortError') return;
        set({ results: [], loading: false, error: (err as Error).message ?? 'Search failed' });
      } finally {
        if (inFlight === controller) inFlight = undefined;
      }
    },
  };
}
