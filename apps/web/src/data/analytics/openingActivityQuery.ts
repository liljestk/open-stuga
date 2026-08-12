import { useQuery } from "@tanstack/react-query";
import type { OpeningActivityRequest } from "@climate-twin/contracts";
import { useEffect, useMemo, useRef } from "react";
import { api } from "../../api";
import { queryClient } from "../queryClient";
import { queryKeys } from "../queryKeys";

export function useOpeningActivityQuery(
  request: OpeningActivityRequest | null,
  rangeKey: string,
  enabled = true,
) {
  const requestIdentity = request === null ? null : JSON.stringify(request);
  const queryHouseId = request?.houseId ?? null;
  const queryDataMode = request?.dataMode ?? null;
  const queryIdentity = queryHouseId === null || queryDataMode === null
    ? null
    : `${queryHouseId}\u0000${queryDataMode}\u0000${rangeKey}`;
  const queryKey = useMemo(() => queryHouseId !== null && queryDataMode !== null
    ? queryKeys.openingActivity(queryHouseId, queryDataMode, rangeKey)
    : ["analytics", "opening-activity", "disabled"] as const,
  [queryDataMode, queryHouseId, rangeKey]);
  const previous = useRef({ queryIdentity, requestIdentity });
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) => api.openingActivity(request!, signal),
    enabled: request !== null && enabled,
    retry: false,
    refetchOnMount: "always",
  }, queryClient);

  useEffect(() => {
    const prior = previous.current;
    previous.current = { queryIdentity, requestIdentity };
    if (!enabled || requestIdentity === null) return;
    if (prior.queryIdentity !== queryIdentity || prior.requestIdentity === requestIdentity) return;
    let active = true;
    void queryClient.cancelQueries({ queryKey, exact: true }).then(() => {
      if (active) void query.refetch();
    });
    return () => { active = false; };
  }, [enabled, query.refetch, queryIdentity, queryKey, requestIdentity]);

  return query;
}
