/**
 * Server-state ownership. A resource family has exactly one owner;
 * migrations change this table in the same commit as their consumers.
 *
 * - "legacy": the bootstrap store (useClimateData) loads and refreshes it.
 * - "query-client": TanStack Query owns it under a queryKeys entry.
 * - "page-local": one page or panel loads it with its own effect (and polls
 *   where noted); the next change to that page should move it to useQuery.
 *
 * check-architecture-boundaries requires every queryKeys entry to be listed here
 * as query-client, and every query-client family to be a queryKeys entry or a
 * mutation family.
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
  // Query-client families are named after their queryKeys entry.
  homePerformance: "query-client",
  homeMonitoringCollection: "query-client",
  homeMonitoring: "query-client",
  openingActivity: "query-client",
  calendarComparison: "query-client",
  electricityTariff: "query-client",
  electricityInvoices: "query-client",
  houseElectricityPrice: "query-client",
  homeEnergySummary: "query-client",
  homeEnergyProjection: "query-client",
  analyticsExplorerContext: "query-client",
  analyticsExplorer: "query-client",
  analyticsExplorerForecasts: "query-client",
  analyticsDiagnostics: "query-client",
  connectedDevices: "query-client",
  heatPumps: "query-client",
  // PropertyManagementPage: capabilities, endpoints, and a polled map snapshot.
  tracking: "page-local",
  // PropertyManagementPage: attachments and links of the selected equipment.
  equipmentResources: "page-local",
  // StugubyPage: Stuguby list, publications and grants.
  stuguby: "page-local",
  // SystemUpdatesPage: polled update status.
  systemUpdates: "page-local",
  // HostSystemAlertsPanel: polled host health.
  hostHealth: "page-local",
  // IntegrationsPage: discovery jobs; GreeSetupPanel: heat-pump discovery.
  integrationDiscovery: "page-local",
  // AutomationSetupPanel: Apple Notes grants.
  appleNotesGrants: "page-local",
  // BugReportRelayPanel: relay configuration.
  bugReportRelay: "page-local",
  // DeveloperPage: local MCP runtime status.
  localMcpRuntime: "page-local",
  // SetupOperationsPanel: backups and export previews.
  backups: "page-local",
  // MobileGlanceOverview: the measurement snapshot of the selected Home.
  glanceSnapshot: "page-local",
} as const satisfies Record<string, "legacy" | "query-client" | "page-local">;

export type QueryResourceFamily = keyof typeof queryOwnership;
