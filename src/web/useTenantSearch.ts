import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Controller,
  Fetcher,
  SearchState,
  createSearchController,
  initialState,
} from './search-controller';

/**
 * Tenant-scoped search hook.
 *
 * Re-runs when the tenant or query changes, aborts the previous request, and
 * guarantees that a response which arrives after a tenant switch can never be
 * rendered against the new tenant.
 */
export function useTenantSearch<T>(
  tenantId: string,
  query: string,
  fetcher: Fetcher<T>,
): SearchState<T> {
  const [state, setState] = useState<SearchState<T>>(initialState<T>);

  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const controller: Controller<T> = useMemo(
    () => createSearchController<T>((t, q, signal) => fetcherRef.current(t, q, signal), setState),
    [],
  );

  useEffect(() => {
    if (query.trim() === '') {
      controller.cancel();
      setState(initialState<T>());
      return;
    }

    void controller.search(tenantId, query);

    // Runs on tenant change, query change and unmount.
    return () => controller.cancel();
  }, [controller, tenantId, query]);

  return state;
}
