import { useQuery } from "@tanstack/react-query";
import type { OpeningActivityRequest } from "@climate-twin/contracts";
import { api } from "../../api";
import { queryClient } from "../queryClient";
import { queryKeys } from "../queryKeys";

export function useOpeningActivityQuery(
  request: OpeningActivityRequest | null,
  enabled = true,
) {
  return useQuery({
    queryKey: request
      ? queryKeys.openingActivity(request)
      : ["analytics", "opening-activity", "disabled"],
    queryFn: ({ signal }) => api.openingActivity(request!, signal),
    enabled: request !== null && enabled,
  }, queryClient);
}
