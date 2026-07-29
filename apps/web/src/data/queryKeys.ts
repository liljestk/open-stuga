import type {
  CalendarComparisonRequest,
  DataMode,
  OpeningActivityRequest,
} from "@climate-twin/contracts";

function fingerprint(value: unknown): string {
  return JSON.stringify(value, (_key, item) => (
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right)))
      : item
  ));
}

export const queryKeys = {
  all: ["stugu"] as const,
  homePerformance: (houseId: string, dataMode: DataMode) => (
    ["house", houseId, "analytics", "home-performance", dataMode] as const
  ),
  homeMonitoringCollection: (dataMode: DataMode) => (
    ["monitoring", "houses", dataMode] as const
  ),
  homeMonitoring: (houseId: string, dataMode: DataMode) => (
    ["house", houseId, "monitoring", dataMode] as const
  ),
  openingActivity: (request: OpeningActivityRequest) => (
    ["analytics", "opening-activity", fingerprint(request)] as const
  ),
  calendarComparison: (request: CalendarComparisonRequest) => (
    ["analytics", "calendar-comparison", fingerprint(request)] as const
  ),
};
