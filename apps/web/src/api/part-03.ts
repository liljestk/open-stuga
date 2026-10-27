import type { ApiReadSchedulingClass } from "./support/requestScheduler";
import type { ActionPlaybook, ActionRun, ActionRunStartInput, AlertEvent, AlertRule, AlertRulePatch, AnalyticsCoverageRequest, AnalyticsCoverageResponse, AnalyticsDiagnostics, AnalyticsQueryRequest, AnalyticsQueryResponse, AppleNotesGrantCreated, AppleNotesGrantSummary, BackupOperationStatus, CalendarComparisonRequest, CalendarComparisonResponse, ConnectedDeviceCommand, ConnectedDevicePlacementPatch, ConnectedDeviceState, CoordinateDefaults, DailyAnalyticsFindingsResponse, DataExportPreview, DataExportPrivacyLevel, DurableDerivedAnalyticsResponse, EnergyOptimizationReport, GreeDiscoveredDevice, HeatPumpPlacementPatch, HeatPumpState, HomeMonitoringCollectionResponse, HomeMonitoringDetailResponse, HomePerformanceResponse, IntegrationStatus, IntegrationTestResult, MaintenanceTask, MaintenanceTaskInput, MaintenanceTaskPatch, MaintenanceTaskRevision, ManualObservation, ManualObservationInput, ManualObservationPatch, MeasurementDefinition, MockScenario, NotificationDeliveryStatus, ObservationRevision, OpeningActivityRequest, OpeningActivityResponse, ScheduledDataExport, ScheduledDataExportInput, ScheduledDataExportUpdate, SensorDataGap, SetupDoctorReport, StaticParameter, TelegramConfigInput, TelegramDiscoveryResult, TpLinkDiscoveredDevice, TuyaConfigInput, TuyaDiscoveredDevice, TuyaDiscoveryInput } from "@climate-twin/contracts";
import { expectShape, isAnalyticsDiagnostics, isNotificationDeliveryList, isNotificationDeliveryStatus, withSignal } from "@climate-twin/contracts";
import { API_BASE, completeCollection, entity, list, observationResponse, request, requestV2 } from "./support";
import type { AppleNotesSetupMetadata, LocationSuggestion, MaintenanceTaskFilters, TpLinkHistoryExportJob, TpLinkHistoryExportJobsResponse } from "./support";
import { discoverIntegrationsInBackground, latestIntegrationDiscovery, resumeIntegrationDiscovery } from "./integration-discovery";



export const apiPart03 = {
  updateAlertRule: async (id: string, patch: AlertRulePatch) => {
      const response = await request<AlertRule | { rule: AlertRule }>(`/alert-rules/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) });
      return "rule" in response ? response.rule : response;
    },
  alerts: async (schedulingClass: ApiReadSchedulingClass = "background") => list<AlertEvent>(await request<unknown>("/alerts", { schedulingClass }), ["alerts", "events", "data"]),
  acknowledgeAlert: (id: string) => request<AlertEvent>(`/alerts/${encodeURIComponent(id)}/acknowledge`, { method: "POST" }),
  notificationDeliveries: async (options: { limit?: number } = {}): Promise<NotificationDeliveryStatus[]> => {
      const endpoint = `/notification-deliveries${options.limit ? `?limit=${options.limit}` : ""}`;
      const body = await request<{ deliveries?: unknown }>(endpoint);
      return expectShape(body.deliveries, isNotificationDeliveryList, endpoint);
    },
  retryNotificationDelivery: async (id: string): Promise<NotificationDeliveryStatus> => {
      const endpoint = `/notification-deliveries/${encodeURIComponent(id)}/retry`;
      const body = await request<{ delivery?: unknown }>(endpoint, { method: "POST" });
      return expectShape(body.delivery, isNotificationDeliveryStatus, endpoint);
    },
  actionPlaybooks: async (metric?: string) => list<ActionPlaybook>(await request<unknown>(`/action-playbooks${metric ? `?metric=${encodeURIComponent(metric)}` : ""}`), ["playbooks", "data"]),
  alertActionPlaybooks: async (alertId: string) => list<ActionPlaybook>(await request<unknown>(`/alerts/${encodeURIComponent(alertId)}/action-playbooks`), ["playbooks", "data"]),
  actionRuns: async (
      options: { active?: boolean; houseId?: string; sensorId?: string; alertEventId?: string; limit?: number } = {},
      signal?: AbortSignal,
    ) => {
      const query = new URLSearchParams();
      if (options.active) query.set("active", "true");
      if (options.houseId) query.set("houseId", options.houseId);
      if (options.sensorId) query.set("sensorId", options.sensorId);
      if (options.alertEventId) query.set("alertEventId", options.alertEventId);
      if (options.limit) query.set("limit", String(options.limit));
      return list<ActionRun>(await request<unknown>(
        `/action-runs${query.size ? `?${query}` : ""}`,
        withSignal(signal),
      ), ["runs", "data"]);
    },
  startActionRun: async (input: ActionRunStartInput) => entity(await request<ActionRun | { run: ActionRun }>("/action-runs", { method: "POST", body: JSON.stringify(input) }), "run"),
  completeActionRun: async (id: string) => entity(await request<ActionRun | { run: ActionRun }>(`/action-runs/${encodeURIComponent(id)}/complete`, { method: "POST" }), "run"),
  cancelActionRun: async (id: string, note?: string) => entity(await request<ActionRun | { run: ActionRun }>(`/action-runs/${encodeURIComponent(id)}/cancel`, { method: "POST", body: JSON.stringify({ note: note ?? null }) }), "run"),
  observations: async (houseId: string, schedulingClass: ApiReadSchedulingClass = "background") => list<ManualObservation>(await request<unknown>(`/observations?houseId=${encodeURIComponent(houseId)}`, { schedulingClass }), ["observations", "data"]),
  createObservation: async (observation: ManualObservationInput) => observationResponse(await request<ManualObservation | { observation: ManualObservation }>("/observations", { method: "POST", body: JSON.stringify(observation) })),
  updateObservation: async (id: string, patch: ManualObservationPatch) => observationResponse(await request<ManualObservation | { observation: ManualObservation }>(`/observations/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) })),
  observationRevisions: async (id: string) => list<ObservationRevision>(await request<unknown>(`/observations/${encodeURIComponent(id)}/revisions`), ["revisions", "data"]),
  maintenanceTasks: async (filters: MaintenanceTaskFilters = {}, schedulingClass: ApiReadSchedulingClass = "background") => {
      const query = new URLSearchParams();
      if (filters.propertyId) query.set("propertyId", filters.propertyId);
      if (filters.houseId) query.set("houseId", filters.houseId);
      if (filters.areaId) query.set("areaId", filters.areaId);
      if (filters.equipmentId) query.set("equipmentId", filters.equipmentId);
      const suffix = query.size ? `?${query.toString()}` : "";
      return completeCollection<MaintenanceTask>(`/maintenance-tasks${suffix}`, ["maintenanceTasks", "data"], { schedulingClass });
    },
  createMaintenanceTask: (input: MaintenanceTaskInput) => request<MaintenanceTask>("/maintenance-tasks", { method: "POST", body: JSON.stringify(input) }),
  maintenanceTask: (id: string) => request<MaintenanceTask>(`/maintenance-tasks/${encodeURIComponent(id)}`),
  updateMaintenanceTask: (id: string, patch: MaintenanceTaskPatch) => request<MaintenanceTask>(`/maintenance-tasks/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) }),
  maintenanceTaskRevisions: async (id: string) => list<MaintenanceTaskRevision>(await request<unknown>(`/maintenance-tasks/${encodeURIComponent(id)}/revisions`), ["revisions", "data"]),
  deleteMaintenanceTask: (id: string) => request<void>(`/maintenance-tasks/${encodeURIComponent(id)}`, { method: "DELETE" }),
  staticParameters: async (houseId: string, schedulingClass: ApiReadSchedulingClass = "background") => list<StaticParameter>(await request<unknown>(`/static-parameters?houseId=${encodeURIComponent(houseId)}`, { schedulingClass }), ["parameters", "staticParameters", "data"]),
  energyOptimization: async (propertyId: string, windowHours = 2, signal?: AbortSignal) => entity(await request<EnergyOptimizationReport | { report: EnergyOptimizationReport }>(`/properties/${encodeURIComponent(propertyId)}/energy-optimization?windowHours=${encodeURIComponent(windowHours)}`, withSignal(signal)), "report"),
  setupDoctor: async () => entity(await request<SetupDoctorReport | { report: SetupDoctorReport }>("/setup/doctor"), "report"),
  dataExportPreview: async (privacyLevel: DataExportPrivacyLevel, includeTelemetry: boolean) => entity(await request<DataExportPreview | { preview: DataExportPreview }>(`/data-export/preview?privacyLevel=${encodeURIComponent(privacyLevel)}&includeTelemetry=${includeTelemetry}`), "preview"),
  dataExportUrl: (privacyLevel: DataExportPrivacyLevel, includeTelemetry: boolean) => `${API_BASE}/data-export?privacyLevel=${encodeURIComponent(privacyLevel)}&includeTelemetry=${includeTelemetry}`,
  scheduledDataExports: async (houseId: string, signal?: AbortSignal) => list<ScheduledDataExport>(
      await request<unknown>(`/houses/${encodeURIComponent(houseId)}/scheduled-data-exports`, withSignal(signal)),
      ["exports", "data"],
    ),
  createScheduledDataExport: async (houseId: string, input: ScheduledDataExportInput) => entity(
      await request<ScheduledDataExport | { export: ScheduledDataExport }>(`/houses/${encodeURIComponent(houseId)}/scheduled-data-exports`, {
        method: "POST",
        body: JSON.stringify(input),
      }),
      "export",
    ),
  updateScheduledDataExport: async (houseId: string, id: string, input: ScheduledDataExportUpdate) => entity(
      await request<ScheduledDataExport | { export: ScheduledDataExport }>(`/houses/${encodeURIComponent(houseId)}/scheduled-data-exports/${encodeURIComponent(id)}`, {
        method: "PUT",
        body: JSON.stringify(input),
      }),
      "export",
    ),
  deleteScheduledDataExport: (houseId: string, id: string) => request<void>(
      `/houses/${encodeURIComponent(houseId)}/scheduled-data-exports/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    ),
  runScheduledDataExport: async (houseId: string, id: string) => entity(
      await request<ScheduledDataExport | { export: ScheduledDataExport }>(`/houses/${encodeURIComponent(houseId)}/scheduled-data-exports/${encodeURIComponent(id)}/run`, { method: "POST" }),
      "export",
    ),
  backupStatus: async () => entity(await request<BackupOperationStatus | { backup: BackupOperationStatus }>("/backups/status"), "backup"),
  requestBackup: async () => entity(await request<BackupOperationStatus | { backup: BackupOperationStatus }>("/backups", { method: "POST" }), "backup"),
  createStaticParameter: (parameter: Omit<StaticParameter, "id">) => request<StaticParameter>("/static-parameters", { method: "POST", body: JSON.stringify(parameter) }),
  integrations: (houseId?: string) => request<IntegrationStatus>(`/integrations/status${houseId ? `?houseId=${encodeURIComponent(houseId)}` : ""}`),
  discoverIntegrations: discoverIntegrationsInBackground,
  resumeIntegrationDiscovery,
  latestIntegrationDiscovery,
  discoverTelegram: (botToken: string, signal?: AbortSignal) => request<TelegramDiscoveryResult>("/integrations/telegram/discover", {
      method: "POST",
      body: JSON.stringify({ botToken }),
      ...withSignal(signal),
    }),
  configureTelegram: (configuration: TelegramConfigInput) => request<{ ok: boolean; configured: boolean; integration: IntegrationStatus }>("/integrations/telegram/config", {
      method: "PUT",
      body: JSON.stringify(configuration),
    }),
  testTelegram: () => request<IntegrationTestResult>("/integrations/telegram/test", { method: "POST" }),
  disconnectTelegram: () => request<{ ok: boolean; integration: IntegrationStatus }>("/integrations/telegram/config", { method: "DELETE" }),
  appleNotesSetup: () => request<AppleNotesSetupMetadata>("/integrations/apple-notes/setup"),
  appleNotesGrants: async () => list<AppleNotesGrantSummary>(await request<unknown>("/integrations/apple-notes/grants"), ["grants", "data"]),
  createAppleNotesGrant: (input: { houseId: string; deviceLabel: string }) => request<AppleNotesGrantCreated>("/integrations/apple-notes/grants", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  revokeAppleNotesGrant: (id: string) => request<{ ok: boolean; integration: IntegrationStatus }>(`/integrations/apple-notes/grants/${encodeURIComponent(id)}`, { method: "DELETE" }),
  searchLocations: async (query: string, language = "en", signal?: AbortSignal) => (
      await request<{ results: LocationSuggestion[] }>(`/locations/search?q=${encodeURIComponent(query)}&language=${encodeURIComponent(language)}`, withSignal(signal))
    ).results,
  coordinateDefaults: (latitude: number, longitude: number) => request<CoordinateDefaults>(
      `/locations/defaults?latitude=${encodeURIComponent(latitude)}&longitude=${encodeURIComponent(longitude)}`,
    ),
  configureHomeAssistant: (configuration: { houseId: string; url: string; token: string }) => request<{ ok: boolean; configured: boolean; houseId: string; integration: IntegrationStatus }>("/integrations/home-assistant/config", {
      method: "PUT",
      body: JSON.stringify(configuration),
    }),
  configureTpLink: (configuration: {
    houseId: string;
    connectionId?: string;
    host: string;
  } & (
    { username: string; password: string; credentialSourceConnectionId?: never }
    | { credentialSourceConnectionId: string; username?: never; password?: never }
  )) => request<{ ok: boolean; configured: boolean; created?: boolean; connectionId?: string; houseId?: string; deviceId?: string | null; sourceType?: "hub" | "energy-device" | null; sourceModel?: string | null; sourceAlias?: string | null; warning?: string | null; integration: IntegrationStatus }>("/integrations/tp-link/config", {
      method: "PUT",
      body: JSON.stringify(configuration),
    }),
  discoverGree: async (houseId: string) => list<GreeDiscoveredDevice>(
      await request<unknown>("/integrations/gree/discover", {
        method: "POST",
        body: JSON.stringify({ houseId }),
      }),
      ["devices", "data"],
    ),
  discoverGreeCloud: async (configuration: { houseId: string; username: string; password: string }) => list<GreeDiscoveredDevice>(
      await request<unknown>("/integrations/gree/cloud/discover", {
        method: "POST",
        body: JSON.stringify(configuration),
      }),
      ["devices", "data"],
    ),
  configureGree: (configuration: { houseId: string; mac: string }) => request<{
    ok: boolean;
    configured: boolean;
    connectionId: string;
    houseId: string;
    state: HeatPumpState;
    integration: IntegrationStatus;
  }>("/integrations/gree/config", {
    method: "PUT",
    body: JSON.stringify(configuration),
  }),
  configureGreeCloud: (configuration: { houseId: string; mac: string; username: string; password: string }) => request<{
    ok: boolean;
    configured: boolean;
    connectionId: string;
    houseId: string;
    state: HeatPumpState;
    integration: IntegrationStatus;
  }>("/integrations/gree/cloud/config", {
    method: "PUT",
    body: JSON.stringify(configuration),
  }),
  disconnectHomeAssistant: (houseId: string) => request<{ ok: boolean; integration: IntegrationStatus }>(`/integrations/home-assistant/config/${encodeURIComponent(houseId)}`, {
      method: "DELETE",
    }),
  disconnectTpLink: (connectionId: string) => request<{ ok: boolean; detachedSensorIds: string[]; integration: IntegrationStatus }>(`/integrations/tp-link/config/${encodeURIComponent(connectionId)}`, {
      method: "DELETE",
    }),
  disconnectGree: (connectionId: string) => request<{ ok: boolean; integration: IntegrationStatus }>(`/integrations/gree/config/${encodeURIComponent(connectionId)}`, {
      method: "DELETE",
    }),
  discoverTuya: async (input: TuyaDiscoveryInput) => list<TuyaDiscoveredDevice>(
      await request<unknown>("/integrations/tuya/discover", {
        method: "POST",
        body: JSON.stringify(input),
      }),
      ["devices", "data"],
    ),
  configureTuya: (configuration: TuyaConfigInput) => request<{
    ok: boolean;
    configured: boolean;
    connectionId: string;
    state: ConnectedDeviceState;
    integration: IntegrationStatus;
  }>("/integrations/tuya/config", {
    method: "PUT",
    body: JSON.stringify(configuration),
  }),
  disconnectTuya: (connectionId: string) => request<{ ok: boolean; integration: IntegrationStatus }>(
      `/integrations/tuya/config/${encodeURIComponent(connectionId)}`,
      { method: "DELETE" },
    ),
  connectedDevices: async (houseId?: string, signal?: AbortSignal) => list<ConnectedDeviceState>(
      await request<unknown>(
        `/connected-devices${houseId ? `?houseId=${encodeURIComponent(houseId)}` : ""}`,
        withSignal(signal),
      ),
      ["devices", "data"],
    ),
  commandConnectedDevice: (connectionId: string, command: ConnectedDeviceCommand) => request<{
    ok: boolean;
    deduplicated: boolean;
    state: ConnectedDeviceState;
  }>(`/connected-devices/${encodeURIComponent(connectionId)}/commands`, {
    method: "POST",
    body: JSON.stringify(command),
  }),
  placeConnectedDevice: (connectionId: string, placement: ConnectedDevicePlacementPatch) => request<{
    state: ConnectedDeviceState | null;
    energySensorId: string | null;
  }>(`/connected-devices/${encodeURIComponent(connectionId)}/placement`, {
    method: "PATCH",
    body: JSON.stringify(placement),
  }),
  heatPumpStates: async (houseId?: string, signal?: AbortSignal) => list<HeatPumpState>(
      await request<unknown>(
        `/heat-pumps${houseId ? `?houseId=${encodeURIComponent(houseId)}` : ""}`,
        withSignal(signal),
      ),
      ["states", "data"],
    ),
  placeHeatPump: (connectionId: string, placement: HeatPumpPlacementPatch) => request<{
    state: HeatPumpState | null;
  }>(`/heat-pumps/${encodeURIComponent(connectionId)}/placement`, {
    method: "PATCH",
    body: JSON.stringify(placement),
  }),
  heatPumpHistory: async (
    connectionId: string,
    options: { from?: string; to?: string; limit?: number } = {},
  ) => {
    const query = new URLSearchParams();
    if (options.from) query.set("from", options.from);
    if (options.to) query.set("to", options.to);
    if (options.limit) query.set("limit", String(options.limit));
    const suffix = query.size ? `?${query.toString()}` : "";
    return list<HeatPumpState>(
      await request<unknown>(`/heat-pumps/${encodeURIComponent(connectionId)}/history${suffix}`),
      ["states", "data"],
    );
  },
  moveHomeAssistant: (fromHouseId: string, houseId: string) => request<{ ok: boolean; fromHouseId: string; houseId: string; integration: IntegrationStatus }>(`/integrations/home-assistant/config/${encodeURIComponent(fromHouseId)}`, {
      method: "PATCH",
      body: JSON.stringify({ houseId }),
    }),
  moveTpLink: (connectionId: string, houseId: string) => request<{ ok: boolean; fromHouseId: string; houseId: string; detachedSensorIds: string[]; integration: IntegrationStatus }>(`/integrations/tp-link/config/${encodeURIComponent(connectionId)}`, {
      method: "PATCH",
      body: JSON.stringify({ houseId }),
    }),
  testHomeAssistant: (houseId?: string) => request<{ ok: boolean; message?: string }>(`/integrations/home-assistant/test${houseId ? `?houseId=${encodeURIComponent(houseId)}` : ""}`, { method: "POST" }),
  testTpLink: (houseId?: string) => request<{ ok: boolean; message?: string }>(`/integrations/tp-link/test${houseId ? `?houseId=${encodeURIComponent(houseId)}` : ""}`, { method: "POST" }),
  testHomeAssistantDraft: (configuration: { url: string; token: string }) => request<IntegrationTestResult>("/integrations/home-assistant/test-draft", {
      method: "POST",
      body: JSON.stringify(configuration),
    }),
  testTpLinkDraft: (configuration: { host: string; username: string; password: string }) => request<IntegrationTestResult>("/integrations/tp-link/test-draft", {
      method: "POST",
      body: JSON.stringify(configuration),
    }),
  tpLinkDevices: async (houseId?: string) => list<TpLinkDiscoveredDevice>(
      await request<unknown>(`/integrations/tp-link/devices${houseId ? `?houseId=${encodeURIComponent(houseId)}` : ""}`),
      ["devices", "data"],
    ),
  tpLinkHistoryExportJobs: () => request<TpLinkHistoryExportJobsResponse>("/integrations/tp-link/history-export/jobs"),
  createTpLinkHistoryExportCanary: (input: {
      sensorId: string;
      metric: "temperature" | "humidity";
      from: string;
      to: string;
    }) => request<{ job: TpLinkHistoryExportJob }>("/integrations/tp-link/history-export/canary", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  retryTpLinkHistoryExportJob: async (id: string): Promise<void> => {
      await request<unknown>(`/integrations/tp-link/history-export/jobs/${encodeURIComponent(id)}/retry`, { method: "POST" });
    },
  cancelTpLinkHistoryExportJob: async (id: string): Promise<void> => {
      await request<unknown>(`/integrations/tp-link/history-export/jobs/${encodeURIComponent(id)}`, { method: "DELETE" });
    },
  sensorDataGaps: async (houseId?: string, limit = 500, signal?: AbortSignal): Promise<SensorDataGap[]> => {
      const query = new URLSearchParams({ limit: String(limit) });
      if (houseId) query.set("houseId", houseId);
      return list<SensorDataGap>(
        await request<unknown>(`/integrations/sensor-data-gaps?${query}`, withSignal(signal)),
        ["gaps", "data"],
      );
    },
  scenarios: async (schedulingClass: ApiReadSchedulingClass = "background") => list<MockScenario>(await request<unknown>("/mock/scenarios", { schedulingClass }), ["scenarios", "data"]),
  runScenario: (scenarioId: MockScenario["id"]) => request<{ ok: boolean }>("/mock/scenario", { method: "POST", body: JSON.stringify({ scenarioId }) }),
  measurementDefinitions: async (schedulingClass: ApiReadSchedulingClass = "background") => (await requestV2<{ definitions: MeasurementDefinition[] }>("/measurement-definitions", { schedulingClass })).definitions,
  analyticsFindings: (houseId: string, signal?: AbortSignal) => requestV2<DailyAnalyticsFindingsResponse>(
      `/analytics/findings?houseId=${encodeURIComponent(houseId)}`,
      withSignal(signal),
    ),
  analyticsDiagnostics: async (houseId: string, signal?: AbortSignal): Promise<AnalyticsDiagnostics> => expectShape(
      (await requestV2<{ diagnostics?: unknown }>(`/analytics/diagnostics?houseId=${encodeURIComponent(houseId)}`, signal ? { signal } : undefined)).diagnostics,
      isAnalyticsDiagnostics,
      "/analytics/diagnostics",
    ),
  openingActivity: (input: OpeningActivityRequest, signal?: AbortSignal) => requestV2<OpeningActivityResponse>(
      "/analytics/opening-activity",
      {
        method: "POST",
        schedulingClass: "background",
        body: JSON.stringify(input),
        ...withSignal(signal),
      },
    ),
  calendarComparison: (
    input: CalendarComparisonRequest,
    signal?: AbortSignal,
  ) => requestV2<CalendarComparisonResponse>("/analytics/calendar-comparison", {
    method: "POST",
    schedulingClass: "background",
    body: JSON.stringify(input),
    ...withSignal(signal),
  }),
  homePerformance: (
    houseId: string,
    dataMode: "live" | "demo",
    signal?: AbortSignal,
  ) => requestV2<DurableDerivedAnalyticsResponse<HomePerformanceResponse>>(
      `/analytics/home-performance?houseId=${encodeURIComponent(houseId)}&dataMode=${dataMode}`,
      withSignal(signal),
    ),
  refreshHomePerformance: (
    houseId: string,
    dataMode: "live" | "demo",
    signal?: AbortSignal,
  ) => requestV2<DurableDerivedAnalyticsResponse<HomePerformanceResponse>>(
      `/analytics/home-performance?houseId=${encodeURIComponent(houseId)}&dataMode=${dataMode}`,
      { method: "POST", schedulingClass: "background", ...withSignal(signal) },
    ),
  homeMonitoringCollection: (
    dataMode: "live" | "demo",
    signal?: AbortSignal,
  ) => requestV2<HomeMonitoringCollectionResponse>(
    `/monitoring/houses?dataMode=${dataMode}`,
    withSignal(signal),
  ),
  homeMonitoring: (
    houseId: string,
    dataMode: "live" | "demo",
    signal?: AbortSignal,
  ) => requestV2<HomeMonitoringDetailResponse>(
    `/monitoring/houses/${encodeURIComponent(houseId)}?dataMode=${dataMode}&include=insights`,
    withSignal(signal),
  ),
  analyticsCoverage: (input: AnalyticsCoverageRequest, signal?: AbortSignal) => requestV2<AnalyticsCoverageResponse>("/analytics/coverage", {
      method: "POST",
      schedulingClass: "background",
      body: JSON.stringify(input),
      ...withSignal(signal),
    }),
  analyticsQuery: (input: AnalyticsQueryRequest, signal?: AbortSignal) => requestV2<AnalyticsQueryResponse>("/analytics/query", {
      method: "POST",
      schedulingClass: "background",
      body: JSON.stringify(input),
      ...withSignal(signal),
    }),
};
