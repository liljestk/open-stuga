/**
 * Transitional server-state ownership. A resource family has exactly one owner;
 * migrations change this table in the same commit as their consumers.
 */
export const queryOwnership = {
  session: "legacy",
  workspaceInventory: "legacy",
  homeSnapshot: "legacy",
  historicalSeries: "legacy",
  sensorMutations: "query-client",
  propertyMutations: "legacy",
  alerts: "legacy",
  observations: "legacy",
  maintenance: "legacy",
  integrations: "legacy",
  homePerformance: "query-client",
  homeMonitoringCollection: "query-client",
  homeMonitoring: "query-client",
  openingActivity: "query-client",
  calendarComparison: "query-client",
  electricityTariffs: "query-client",
  analyticsExplorer: "query-client",
  energyProjection: "query-client",
  analyticsDiagnostics: "query-client",
} as const satisfies Record<string, "legacy" | "query-client">;

export type QueryResourceFamily = keyof typeof queryOwnership;
