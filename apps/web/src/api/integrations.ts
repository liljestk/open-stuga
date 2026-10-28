import { type AppleNotesGrantCreated, type AppleNotesGrantSummary, type ConnectedDeviceState, type GreeDiscoveredDevice, type HeatPumpState, type IntegrationStatus, type IntegrationTestResult, type TelegramConfigInput, type TelegramDiscoveryResult, type TpLinkDiscoveredDevice, type TuyaConfigInput, type TuyaDiscoveredDevice, type TuyaDiscoveryInput, withSignal } from "@climate-twin/contracts";
import { list, request } from "./support/request";
import type { AppleNotesSetupMetadata, TpLinkHistoryExportJob, TpLinkHistoryExportJobsResponse } from "./support/response-types";
import { discoverIntegrationsInBackground, latestIntegrationDiscovery, resumeIntegrationDiscovery } from "./integration-discovery";

/** Integration status, discovery, provider set-up and tests, Telegram, Apple Notes and TP-Link history exports. */
export const integrationsApi = {
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
  appleNotesGrants: async () => list<AppleNotesGrantSummary>(await request<unknown>("/integrations/apple-notes/grants"), "grants"),
  createAppleNotesGrant: (input: { houseId: string; deviceLabel: string }) => request<AppleNotesGrantCreated>("/integrations/apple-notes/grants", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  revokeAppleNotesGrant: (id: string) => request<{ ok: boolean; integration: IntegrationStatus }>(`/integrations/apple-notes/grants/${encodeURIComponent(id)}`, { method: "DELETE" }),
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
      "devices",
    ),
  discoverGreeCloud: async (configuration: { houseId: string; username: string; password: string }) => list<GreeDiscoveredDevice>(
      await request<unknown>("/integrations/gree/cloud/discover", {
        method: "POST",
        body: JSON.stringify(configuration),
      }),
      "devices",
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
      "devices",
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
      "devices",
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
};
