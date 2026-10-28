import { type CloudflareSetupStartInput, type CloudflareSetupStartResult, type CloudflareSetupStatusResponse, type HostSystemHealth, type LocalMcpRuntimeStartResult, type LocalMcpRuntimeStatus, type SystemStorageSettings, type SystemStorageStatus, type SystemUpdateSettings, type SystemUpdateStatus, withSignal, type BackupOperationStatus, type DataExportPreview, type DataExportPrivacyLevel, type MockScenario, type ScheduledDataExport, type ScheduledDataExportInput, type ScheduledDataExportUpdate, type SetupDoctorReport } from "@climate-twin/contracts";
import { request, list } from "./support/request";
import type { SystemUpdateOperationInput } from "./support/response-types";
import { API_BASE } from "./support/client-state";
import type { ApiReadSchedulingClass } from "./support/requestScheduler";

/** Host health, updates, storage, the local MCP runtime, Cloudflare set-up, backups, exports and the setup doctor. */
export const systemApi = {
  hostSystemHealth: () => request<HostSystemHealth>("/system/health"),
  localMcpRuntimeStatus: () => request<LocalMcpRuntimeStatus>("/system/mcp-runtime"),
  startLocalMcpRuntime: () => request<LocalMcpRuntimeStartResult>("/system/mcp-runtime/start", { method: "POST" }),
  stopLocalMcpRuntime: () => request<LocalMcpRuntimeStatus>("/system/mcp-runtime/stop", { method: "POST" }),
  systemUpdateStatus: () => request<SystemUpdateStatus>("/system/updates"),
  checkSystemUpdates: () => request<SystemUpdateStatus>("/system/updates/check", { method: "POST" }),
  updateSystemUpdateSettings: (settings: SystemUpdateSettings) => request<SystemUpdateStatus>("/system/updates/settings", {
      method: "PATCH",
      body: JSON.stringify(settings),
    }),
  installLatestSystemUpdate: () => request<SystemUpdateStatus>("/system/updates/install", { method: "POST" }),
  operateSystemUpdate: (input: SystemUpdateOperationInput) => request<SystemUpdateStatus>("/system/updates/operations", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  systemStorageStatus: (signal?: AbortSignal) => request<SystemStorageStatus>(
      "/system/storage",
      withSignal(signal),
    ),
  updateSystemStorage: (input: {
    settings: SystemStorageSettings;
    expectedRevision: string;
    confirmation: "APPLY_STORAGE" | "MOVE_STORAGE";
  }) => request<SystemStorageStatus>("/system/storage", {
      method: "PUT",
      body: JSON.stringify(input),
    }),
  cloudflareSetupStatus: () => request<CloudflareSetupStatusResponse>("/cloudflare/setup"),
  startCloudflareSetup: (input: CloudflareSetupStartInput) => request<CloudflareSetupStartResult>("/cloudflare/setup/start", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  setupDoctor: async () => (await request<{ report: SetupDoctorReport }>("/setup/doctor")).report,
  dataExportPreview: async (privacyLevel: DataExportPrivacyLevel, includeTelemetry: boolean) => (await request<{ preview: DataExportPreview }>(`/data-export/preview?privacyLevel=${encodeURIComponent(privacyLevel)}&includeTelemetry=${includeTelemetry}`)).preview,
  dataExportUrl: (privacyLevel: DataExportPrivacyLevel, includeTelemetry: boolean) => `${API_BASE}/data-export?privacyLevel=${encodeURIComponent(privacyLevel)}&includeTelemetry=${includeTelemetry}`,
  scheduledDataExports: async (houseId: string, signal?: AbortSignal) => list<ScheduledDataExport>(
      await request<unknown>(`/houses/${encodeURIComponent(houseId)}/scheduled-data-exports`, withSignal(signal)),
      "exports",
    ),
  createScheduledDataExport: async (houseId: string, input: ScheduledDataExportInput) => (await request<{ export: ScheduledDataExport }>(`/houses/${encodeURIComponent(houseId)}/scheduled-data-exports`, {
        method: "POST",
        body: JSON.stringify(input),
      })).export,
  updateScheduledDataExport: async (houseId: string, id: string, input: ScheduledDataExportUpdate) => (await request<{ export: ScheduledDataExport }>(`/houses/${encodeURIComponent(houseId)}/scheduled-data-exports/${encodeURIComponent(id)}`, {
        method: "PUT",
        body: JSON.stringify(input),
      })).export,
  deleteScheduledDataExport: (houseId: string, id: string) => request<void>(
      `/houses/${encodeURIComponent(houseId)}/scheduled-data-exports/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    ),
  runScheduledDataExport: async (houseId: string, id: string) => (await request<{ export: ScheduledDataExport }>(`/houses/${encodeURIComponent(houseId)}/scheduled-data-exports/${encodeURIComponent(id)}/run`, { method: "POST" })).export,
  backupStatus: async () => (await request<{ backup: BackupOperationStatus }>("/backups/status")).backup,
  requestBackup: async () => (await request<{ backup: BackupOperationStatus }>("/backups", { method: "POST" })).backup,
  scenarios: async (schedulingClass: ApiReadSchedulingClass = "background") => list<MockScenario>(await request<unknown>("/mock/scenarios", { schedulingClass }), "scenarios"),
  runScenario: (scenarioId: MockScenario["id"]) => request<{ ok: boolean }>("/mock/scenario", { method: "POST", body: JSON.stringify({ scenarioId }) }),
};
