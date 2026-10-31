import { type CloudExportProvider, type CloudflareSetupStartInput, type ExportDestinationKind, type SystemStorageSettings, type SystemUpdateSettings, withSignal, type DataExportPrivacyLevel, type MockScenario, type ScheduledDataExportInput, type ScheduledDataExportUpdate } from "@climate-twin/contracts";
import { request } from "./support/request";
import type { SystemUpdateOperationInput } from "./support/response-types";
import { API_BASE } from "./support/client-state";
import type { ApiReadSchedulingClass } from "./support/requestScheduler";
import { backupOperationStatusShape, cloudflareSetupStartResultShape, cloudflareSetupStatusResponseShape, dataExportPreviewShape, exportDestinationStatusShape, hostSystemHealthShape, localMcpRuntimeStartResultShape, localMcpRuntimeStatusShape, mockScenarioShape, scheduledDataExportShape, setupDoctorReportShape, systemStorageStatusShape, systemUpdateStatusShape } from "./support/entity-shapes";
import { noContent, boolean, arrayOf, fields } from "./support/response-shapes";

/** Host health, updates, storage, the local MCP runtime, Cloudflare set-up, backups, exports and the setup doctor. */
export const systemApi = {
  hostSystemHealth: () => request("/system/health", hostSystemHealthShape),
  localMcpRuntimeStatus: () => request("/system/mcp-runtime", localMcpRuntimeStatusShape),
  startLocalMcpRuntime: () => request("/system/mcp-runtime/start", localMcpRuntimeStartResultShape, { method: "POST" }),
  stopLocalMcpRuntime: () => request("/system/mcp-runtime/stop", localMcpRuntimeStatusShape, { method: "POST" }),
  systemUpdateStatus: () => request("/system/updates", systemUpdateStatusShape),
  checkSystemUpdates: () => request("/system/updates/check", systemUpdateStatusShape, { method: "POST" }),
  updateSystemUpdateSettings: (settings: SystemUpdateSettings) => request("/system/updates/settings", systemUpdateStatusShape, {
      method: "PATCH",
      body: JSON.stringify(settings),
    }),
  installLatestSystemUpdate: () => request("/system/updates/install", systemUpdateStatusShape, { method: "POST" }),
  operateSystemUpdate: (input: SystemUpdateOperationInput) => request("/system/updates/operations", systemUpdateStatusShape, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  systemStorageStatus: (signal?: AbortSignal) => request(
      "/system/storage", systemStorageStatusShape,
      withSignal(signal),
    ),
  updateSystemStorage: (input: {
    settings: SystemStorageSettings;
    expectedRevision: string;
    confirmation: "APPLY_STORAGE" | "MOVE_STORAGE";
  }) => request("/system/storage", systemStorageStatusShape, {
      method: "PUT",
      body: JSON.stringify(input),
    }),
  exportDestinations: (signal?: AbortSignal) => request("/system/export-destinations", exportDestinationStatusShape, withSignal(signal)),
  selectExportDestination: (selected: ExportDestinationKind) => request("/system/export-destinations", exportDestinationStatusShape, {
      method: "PUT",
      body: JSON.stringify({ selected }),
    }),
  connectExportDestination: (provider: CloudExportProvider) => request(
      `/system/export-destinations/${provider}/connect`, exportDestinationStatusShape, { method: "POST" },
    ),
  submitExportDestinationCode: (provider: CloudExportProvider, connectionId: string, code: string) => request(
      `/system/export-destinations/${provider}/code`, exportDestinationStatusShape, {
        method: "POST",
        body: JSON.stringify({ connectionId, code }),
      },
    ),
  cancelExportDestinationConnection: () => request("/system/export-destinations/connection", exportDestinationStatusShape, { method: "DELETE" }),
  disconnectExportDestination: (provider: CloudExportProvider) => request(
      `/system/export-destinations/${provider}`, exportDestinationStatusShape, { method: "DELETE" },
    ),
  cloudflareSetupStatus: () => request("/cloudflare/setup", cloudflareSetupStatusResponseShape),
  startCloudflareSetup: (input: CloudflareSetupStartInput) => request("/cloudflare/setup/start", cloudflareSetupStartResultShape, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  setupDoctor: async () => (await request("/setup/doctor", fields({ report: setupDoctorReportShape }))).report,
  dataExportPreview: async (privacyLevel: DataExportPrivacyLevel, includeTelemetry: boolean) => (await request(`/data-export/preview?privacyLevel=${encodeURIComponent(privacyLevel)}&includeTelemetry=${includeTelemetry}`, fields({ preview: dataExportPreviewShape }))).preview,
  dataExportUrl: (privacyLevel: DataExportPrivacyLevel, includeTelemetry: boolean) => `${API_BASE}/data-export?privacyLevel=${encodeURIComponent(privacyLevel)}&includeTelemetry=${includeTelemetry}`,
  scheduledDataExports: async (houseId: string, signal?: AbortSignal) => (await request(`/houses/${encodeURIComponent(houseId)}/scheduled-data-exports`, fields({ exports: arrayOf(scheduledDataExportShape) }), withSignal(signal))).exports,
  createScheduledDataExport: async (houseId: string, input: ScheduledDataExportInput) => (await request(`/houses/${encodeURIComponent(houseId)}/scheduled-data-exports`, fields({ export: scheduledDataExportShape }), {
        method: "POST",
        body: JSON.stringify(input),
      })).export,
  updateScheduledDataExport: async (houseId: string, id: string, input: ScheduledDataExportUpdate) => (await request(`/houses/${encodeURIComponent(houseId)}/scheduled-data-exports/${encodeURIComponent(id)}`, fields({ export: scheduledDataExportShape }), {
        method: "PUT",
        body: JSON.stringify(input),
      })).export,
  deleteScheduledDataExport: (houseId: string, id: string) => request(
      `/houses/${encodeURIComponent(houseId)}/scheduled-data-exports/${encodeURIComponent(id)}`, noContent,
      { method: "DELETE" },
    ),
  runScheduledDataExport: async (houseId: string, id: string) => (await request(`/houses/${encodeURIComponent(houseId)}/scheduled-data-exports/${encodeURIComponent(id)}/run`, fields({ export: scheduledDataExportShape }), { method: "POST" })).export,
  backupStatus: async () => (await request("/backups/status", fields({ backup: backupOperationStatusShape }))).backup,
  requestBackup: async () => (await request("/backups", fields({ backup: backupOperationStatusShape }), { method: "POST" })).backup,
  scenarios: async (schedulingClass: ApiReadSchedulingClass = "background") => (await request("/mock/scenarios", fields({ scenarios: arrayOf(mockScenarioShape) }), { schedulingClass })).scenarios,
  runScenario: (scenarioId: MockScenario["id"]) => request("/mock/scenario", fields({ ok: boolean }), { method: "POST", body: JSON.stringify({ scenarioId }) }),
};
