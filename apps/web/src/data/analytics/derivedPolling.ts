import type { DurableDerivedAnalyticsResponse } from "@climate-twin/contracts";
import { useCallback, useEffect, useState } from "react";

type DerivedStatus = Pick<DurableDerivedAnalyticsResponse<unknown>, "state" | "job"> | null | undefined;

/** How often a panel re-reads a saved analysis while its background job is pending. */
export const DERIVED_POLL_MS = 30_000;
/**
 * After the viewer asks for a recalculation the panel checks back this often,
 * so its button and notice settle soon after the job does instead of up to
 * half a minute later.
 */
export const DERIVED_FOLLOW_POLL_MS = 5_000;
/** A job still queued after this long is left to the ordinary poll, and the button is usable again. */
export const DERIVED_FOLLOW_LIMIT_MS = 120_000;

export function isDerivedJobPending(status: DerivedStatus): boolean {
  return status?.state === "queued" || status?.state === "refreshing";
}

/** The delay before the next read of a saved analysis, or null when nothing will change on its own. */
export function derivedPollDelayMs(status: DerivedStatus, following: boolean): number | null {
  if (isDerivedJobPending(status)) return following ? DERIVED_FOLLOW_POLL_MS : DERIVED_POLL_MS;
  return status?.state === "failed" && status.job?.nextAttemptAt ? DERIVED_POLL_MS : null;
}

/**
 * Follows the viewer's own recalculation: `recalculating` stays true from the
 * request until its job settles, so the button keeps saying so.
 */
export function useRecalculationFollow(status: DerivedStatus, requestOpen: boolean) {
  const [following, setFollowing] = useState(false);
  useEffect(() => {
    if (following && !requestOpen && !isDerivedJobPending(status)) setFollowing(false);
  }, [following, requestOpen, status]);
  useEffect(() => {
    if (!following) return;
    const timer = setTimeout(() => setFollowing(false), DERIVED_FOLLOW_LIMIT_MS);
    return () => clearTimeout(timer);
  }, [following]);
  const start = useCallback(() => setFollowing(true), []);
  const stop = useCallback(() => setFollowing(false), []);
  return {
    following,
    start,
    stop,
    recalculating: following && (requestOpen || isDerivedJobPending(status)),
  };
}
