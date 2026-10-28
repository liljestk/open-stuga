import { type TelegramConfigInput, type TuyaConfigInput, type TuyaDiscoveryInput, withSignal } from "@climate-twin/contracts";
import { request } from "./support/request";
import type { AppleNotesSetupMetadata } from "./support/response-types";
import { discoverIntegrationsInBackground, latestIntegrationDiscovery, resumeIntegrationDiscovery } from "./integration-discovery";
import { appleNotesGrantCreatedShape, appleNotesGrantSummaryShape, connectedDeviceStateShape, greeDiscoveredDeviceShape, heatPumpStateShape, integrationStatusShape, integrationTestResultShape, telegramDiscoveryResultShape, tpLinkDiscoveredDeviceShape, tpLinkHistoryExportJobShape, tpLinkHistoryExportJobsResponseShape, tuyaDiscoveredDeviceShape } from "./support/entity-shapes";
import { anyBody, string, boolean, nullable, optional, arrayOf, fields } from "./support/response-shapes";

/** Integration status, discovery, provider set-up and tests, Telegram, Apple Notes and TP-Link history exports. */
export const integrationsApi = {
  integrations: (houseId?: string) => request(`/integrations/status${houseId ? `?houseId=${encodeURIComponent(houseId)}` : ""}`, integrationStatusShape),
  discoverIntegrations: discoverIntegrationsInBackground,
  resumeIntegrationDiscovery,
  latestIntegrationDiscovery,
  discoverTelegram: (botToken: string, signal?: AbortSignal) => request("/integrations/telegram/discover", telegramDiscoveryResultShape, {
      method: "POST",
      body: JSON.stringify({ botToken }),
      ...withSignal(signal),
    }),
  configureTelegram: (configuration: TelegramConfigInput) => request("/integrations/telegram/config", fields({ ok: boolean, configured: boolean, integration: integrationStatusShape }), {
      method: "PUT",
      body: JSON.stringify(configuration),
    }),
  testTelegram: () => request("/integrations/telegram/test", integrationTestResultShape, { method: "POST" }),
  disconnectTelegram: () => request("/integrations/telegram/config", fields({ ok: boolean, integration: integrationStatusShape }), { method: "DELETE" }),
  appleNotesSetup: (): Promise<AppleNotesSetupMetadata> => request("/integrations/apple-notes/setup", fields({
      available: optional(boolean),
      snapshotPath: optional(string),
      capturePath: optional(string),
      limitations: optional(arrayOf(string)),
      steps: optional(arrayOf(string)),
    })),
  appleNotesGrants: async () => (await request("/integrations/apple-notes/grants", fields({ grants: arrayOf(appleNotesGrantSummaryShape) }))).grants,
  createAppleNotesGrant: (input: { houseId: string; deviceLabel: string }) => request("/integrations/apple-notes/grants", appleNotesGrantCreatedShape, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  revokeAppleNotesGrant: (id: string) => request(`/integrations/apple-notes/grants/${encodeURIComponent(id)}`, fields({ ok: boolean, integration: integrationStatusShape }), { method: "DELETE" }),
  configureHomeAssistant: (configuration: { houseId: string; url: string; token: string }) => request("/integrations/home-assistant/config", fields({ ok: boolean, configured: boolean, houseId: string, integration: integrationStatusShape }), {
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
  )) => request("/integrations/tp-link/config", fields({ ok: boolean, configured: boolean, created: optional(boolean), connectionId: optional(string), houseId: optional(string), deviceId: optional(nullable(string)), sourceType: optional(nullable(string)), sourceModel: optional(nullable(string)), sourceAlias: optional(nullable(string)), warning: optional(nullable(string)), integration: integrationStatusShape }), {
      method: "PUT",
      body: JSON.stringify(configuration),
    }),
  discoverGree: async (houseId: string) => (await request("/integrations/gree/discover", fields({ devices: arrayOf(greeDiscoveredDeviceShape) }), {
        method: "POST",
        body: JSON.stringify({ houseId }),
      })).devices,
  discoverGreeCloud: async (configuration: { houseId: string; username: string; password: string }) => (await request("/integrations/gree/cloud/discover", fields({ devices: arrayOf(greeDiscoveredDeviceShape) }), {
        method: "POST",
        body: JSON.stringify(configuration),
      })).devices,
  configureGree: (configuration: { houseId: string; mac: string }) => request("/integrations/gree/config", fields({ ok: boolean, configured: boolean, connectionId: string, houseId: string, state: heatPumpStateShape, integration: integrationStatusShape }), {
    method: "PUT",
    body: JSON.stringify(configuration),
  }),
  configureGreeCloud: (configuration: { houseId: string; mac: string; username: string; password: string }) => request("/integrations/gree/cloud/config", fields({ ok: boolean, configured: boolean, connectionId: string, houseId: string, state: heatPumpStateShape, integration: integrationStatusShape }), {
    method: "PUT",
    body: JSON.stringify(configuration),
  }),
  disconnectHomeAssistant: (houseId: string) => request(`/integrations/home-assistant/config/${encodeURIComponent(houseId)}`, fields({ ok: boolean, integration: integrationStatusShape }), {
      method: "DELETE",
    }),
  disconnectTpLink: (connectionId: string) => request(`/integrations/tp-link/config/${encodeURIComponent(connectionId)}`, fields({ ok: boolean, detachedSensorIds: arrayOf(string), integration: integrationStatusShape }), {
      method: "DELETE",
    }),
  disconnectGree: (connectionId: string) => request(`/integrations/gree/config/${encodeURIComponent(connectionId)}`, fields({ ok: boolean, integration: integrationStatusShape }), {
      method: "DELETE",
    }),
  discoverTuya: async (input: TuyaDiscoveryInput) => (await request("/integrations/tuya/discover", fields({ devices: arrayOf(tuyaDiscoveredDeviceShape) }), {
        method: "POST",
        body: JSON.stringify(input),
      })).devices,
  configureTuya: (configuration: TuyaConfigInput) => request("/integrations/tuya/config", fields({ ok: boolean, configured: boolean, connectionId: string, state: connectedDeviceStateShape, integration: integrationStatusShape }), {
    method: "PUT",
    body: JSON.stringify(configuration),
  }),
  disconnectTuya: (connectionId: string) => request(
      `/integrations/tuya/config/${encodeURIComponent(connectionId)}`, fields({ ok: boolean, integration: integrationStatusShape }),
      { method: "DELETE" },
    ),
  moveHomeAssistant: (fromHouseId: string, houseId: string) => request(`/integrations/home-assistant/config/${encodeURIComponent(fromHouseId)}`, fields({ ok: boolean, fromHouseId: string, houseId: string, integration: integrationStatusShape }), {
      method: "PATCH",
      body: JSON.stringify({ houseId }),
    }),
  moveTpLink: (connectionId: string, houseId: string) => request(`/integrations/tp-link/config/${encodeURIComponent(connectionId)}`, fields({ ok: boolean, fromHouseId: string, houseId: string, detachedSensorIds: arrayOf(string), integration: integrationStatusShape }), {
      method: "PATCH",
      body: JSON.stringify({ houseId }),
    }),
  testHomeAssistant: (houseId?: string) => request(`/integrations/home-assistant/test${houseId ? `?houseId=${encodeURIComponent(houseId)}` : ""}`, fields({ ok: boolean, message: optional(string) }), { method: "POST" }),
  testTpLink: (houseId?: string) => request(`/integrations/tp-link/test${houseId ? `?houseId=${encodeURIComponent(houseId)}` : ""}`, fields({ ok: boolean, message: optional(string) }), { method: "POST" }),
  testHomeAssistantDraft: (configuration: { url: string; token: string }) => request("/integrations/home-assistant/test-draft", integrationTestResultShape, {
      method: "POST",
      body: JSON.stringify(configuration),
    }),
  testTpLinkDraft: (configuration: { host: string; username: string; password: string }) => request("/integrations/tp-link/test-draft", integrationTestResultShape, {
      method: "POST",
      body: JSON.stringify(configuration),
    }),
  tpLinkDevices: async (houseId?: string) => (await request(`/integrations/tp-link/devices${houseId ? `?houseId=${encodeURIComponent(houseId)}` : ""}`, fields({ devices: arrayOf(tpLinkDiscoveredDeviceShape) }))).devices,
  tpLinkHistoryExportJobs: () => request("/integrations/tp-link/history-export/jobs", tpLinkHistoryExportJobsResponseShape),
  createTpLinkHistoryExportCanary: (input: {
      sensorId: string;
      metric: "temperature" | "humidity";
      from: string;
      to: string;
    }) => request("/integrations/tp-link/history-export/canary", fields({ job: tpLinkHistoryExportJobShape }), {
      method: "POST",
      body: JSON.stringify(input),
    }),
  retryTpLinkHistoryExportJob: async (id: string): Promise<void> => {
      await request(`/integrations/tp-link/history-export/jobs/${encodeURIComponent(id)}/retry`, anyBody, { method: "POST" });
    },
  cancelTpLinkHistoryExportJob: async (id: string): Promise<void> => {
      await request(`/integrations/tp-link/history-export/jobs/${encodeURIComponent(id)}`, anyBody, { method: "DELETE" });
    },
};
