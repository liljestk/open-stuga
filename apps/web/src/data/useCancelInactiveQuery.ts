import { useEffect } from "react";
import { hashKey, type QueryKey } from "@tanstack/react-query";
import { queryClient } from "./queryClient";

/** Disabling an observer does not cancel its request in TanStack Query. */
export function useCancelInactiveQuery(queryKey: QueryKey, enabled: boolean): void {
  const queryHash = hashKey(queryKey);
  useEffect(() => {
    if (enabled) return;
    let disposed = false;
    let queued = false;
    const cancelIfInactive = () => {
      if (queued) return;
      queued = true;
      // Observers can transfer enabled ownership within the same commit.
      // Check after every observer has applied its new options.
      queueMicrotask(() => {
        queued = false;
        if (disposed) return;
        const query = queryClient.getQueryCache().get(queryHash);
        if (!query || query.isActive() || query.state.fetchStatus === "idle") return;
        // Revert to the cached result without interrupting another observer.
        void queryClient.cancelQueries({ predicate: (candidate) => candidate === query && !candidate.isActive() });
      });
    };
    cancelIfInactive();
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      // An enabled observer can unmount while this disabled one stays mounted.
      if (event.query.queryHash === queryHash
        && (event.type === "observerRemoved" || event.type === "observerOptionsUpdated")) cancelIfInactive();
    });
    return () => { disposed = true; unsubscribe(); };
  }, [enabled, queryHash]);
}
