import type {
  CalendarComparisonRequest,
  DataMode,
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
  houseElectricityPrice: (houseId: string) => (
    ["house", houseId, "electricity-price"] as const
  ),
  electricityTariff: (propertyId: string) => (
    ["property", propertyId, "electricity", "tariff"] as const
  ),
  electricityInvoices: (propertyId: string) => (
    ["property", propertyId, "electricity", "invoices"] as const
  ),
  connectedDevices: (houseId: string) => (
    ["connected-devices", houseId] as const
  ),
  heatPumps: (houseId: string) => (
    ["heat-pumps", houseId] as const
  ),
  openingActivity: (houseId: string, dataMode: DataMode, range: string) => (
    ["analytics", "opening-activity", houseId, dataMode, range] as const
  ),
  calendarComparison: (request: CalendarComparisonRequest) => (
    ["analytics", "calendar-comparison", request.houseId, fingerprint(request)] as const
  ),
};
