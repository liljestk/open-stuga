import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, type PropsWithChildren } from "react";
import {
  cancelPendingApiRequests,
  subscribeToApiAuthorizationChanges,
} from "../api";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      staleTime: 15_000,
      gcTime: 5 * 60_000,
    },
    mutations: { retry: 0 },
  },
});

export function ServerStateProvider({ children }: PropsWithChildren) {
  useEffect(() => subscribeToApiAuthorizationChanges(() => {
    cancelPendingApiRequests();
    void queryClient.cancelQueries();
    queryClient.clear();
  }), []);
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
