import { useSyncExternalStore } from "react";
import { authorizationStateRevision, subscribeToApiAuthorizationChanges } from "../api";

/** Fence private query data and form state before a new account can render them. */
export function useAuthorizationRevision(): number {
  return useSyncExternalStore(subscribeToApiAuthorizationChanges, authorizationStateRevision, authorizationStateRevision);
}
