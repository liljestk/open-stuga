import { useQuery } from "@tanstack/react-query";
import type { CalendarComparisonRequest } from "@climate-twin/contracts";
import { api } from "../../api";
import { queryClient } from "../queryClient";
import { queryKeys } from "../queryKeys";

const disabledRequest: CalendarComparisonRequest = {
  apiVersion: "1.0",
  requestId: "calendar-comparison-disabled",
  houseId: "disabled",
  dataMode: "demo",
  sensorIds: ["disabled"],
  measurementId: "disabled",
  unit: "month",
  anchor: { month: 1, day: 1, week: 1 },
  aggregation: "default",
  qualityFilter: { include: ["good"] },
};

export function useCalendarComparisonQuery(
  request: CalendarComparisonRequest | null,
  enabled = true,
) {
  const resolved = request ?? disabledRequest;
  return useQuery({
    queryKey: queryKeys.calendarComparison(resolved),
    queryFn: ({ signal }) => api.calendarComparison(resolved, signal),
    enabled: request !== null && enabled,
    staleTime: 60_000,
  }, queryClient);
}
