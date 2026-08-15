import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect, type PropsWithChildren } from "react";
import {
  ApiRequestError,
  cancelPendingApiRequests,
  subscribeToApiAuthorizationChanges,
} from "../api";

export function shouldRetryServerQuery(failureCount: number, error: unknown): boolean {
  if (failureCount >= 1) return false;
  const name = error && typeof error === "object" && "name" in error
    ? String((error as { name?: unknown }).name)
    : "";
  if (name === "AbortError" || name === "TimeoutError") return false;
  if (error instanceof ApiRequestError && error.status < 500) return false;
  return true;
}

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: shouldRetryServerQuery,
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
