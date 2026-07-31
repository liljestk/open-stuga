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
  homeEnergySummary: (houseId: string, intervalId: string, durationMs: number) => (
    ["house", houseId, "energy-summary", intervalId, durationMs] as const
  ),
  connectedDevices: (houseId: string) => (
    ["connected-devices", houseId] as const
  ),
  openingActivity: (request: OpeningActivityRequest) => (
    ["analytics", "opening-activity", request.houseId, fingerprint(request)] as const
  ),
  calendarComparison: (request: CalendarComparisonRequest) => (
    ["analytics", "calendar-comparison", request.houseId, fingerprint(request)] as const
  ),
};
