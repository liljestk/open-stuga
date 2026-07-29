import type { HouseWeather, WeatherProviderName } from "./weather-thermal.js";

import type { MaintenanceTask, MaintenanceTaskInputCommon } from "./operations-maintenance.js";

import type { AlertEvent, ForecastPoint, Reading } from "./sensors-alerts.js";

import type { MeasurementSample } from "./measurement-analytics.js";

import type { OpeningStateObservation } from "./building-structure.js";

import type {
  GreeDiscoveredDevice,
  GreeIntegrationStatus,
  HeatPumpState,
} from "./heat-pumps.js";

export type TpLinkConnectionSourceType = "hub" | "energy-device";

export interface TpLinkConnectionStatus {
  id: string;
  houseId: string;
  configured: boolean;
  connected: boolean;
  lastPollAt: string | null;
  mappedDevices: number;
  discoveredDevices: number;
  hubModel: "H100" | "H200" | null;
  error: string | null;
  /** Safe local endpoint metadata. Optional for older Stugu servers. */
  host?: string | null;
  sourceType?: TpLinkConnectionSourceType | null;
  sourceModel?: string | null;
  sourceAlias?: string | null;
}

export interface IntegrationStatus {
  homeAssistant: {
    configured: boolean;
    connected: boolean;
    lastEventAt: string | null;
    mappedEntities: number;
    error: string | null;
    /** Additive per-house status; aggregate fields above remain for older clients. */
    connections?: Array<{
      houseId: string;
      configured: boolean;
      connected: boolean;
      lastEventAt: string | null;
      mappedEntities: number;
      error: string | null;
    }>;
  };
  tpLink: {
    configured: boolean;
    connected: boolean;
    lastPollAt: string | null;
    mappedDevices: number;
    discoveredDevices: number;
    hubModel: "H100" | "H200" | null;
    error: string | null;
    /** Present only when the aggregate represents one source. */
    host?: string | null;
    sourceType?: TpLinkConnectionSourceType | null;
    sourceModel?: string | null;
    sourceAlias?: string | null;
    /** Additive per-house status; aggregate fields above remain for older clients. */
    connections?: TpLinkConnectionStatus[];
  };
  webhook: {
    configured: boolean;
    lastDeliveryAt: string | null;
    error: string | null;
    /** Additive per-destination health. URLs and credentials are never exposed. */
    destinations?: Array<{
      id: string;
      lastDeliveryAt: string | null;
      error: string | null;
    }>;
  };
  /** Optional for wire compatibility with Stugu servers without native automation status. */
  telegram?: {
    /** False when the running server does not provide local secret storage and alert evaluation. */
    available: boolean;
    configured: boolean;
    connected: boolean;
    botUsername: string | null;
    chatLabel: string | null;
    lastDeliveryAt: string | null;
    error: string | null;
  };
  /**
   * Apple Notes is bridged by user-run iOS Shortcuts. Stugu never receives an
   * Apple Account credential and does not claim live document synchronization.
   */
  appleNotes?: {
    available: boolean;
    configured: boolean;
    grantCount: number;
    lastSyncAt: string | null;
    error: string | null;
  };
  mock: {
    enabled: boolean;
    intervalMs: number;
    /** `real` is a persistent one-way latch: demo telemetry can no longer be stored or generated. */
    mode: "demo" | "real";
    activatedAt: string | null;
  };
  weather: {
    /** Selection policy; omitted by older servers that always used `provider`. */
    policy?: "automatic" | WeatherProviderName;
    /** Providers installed behind the automatic router. */
    availableProviders?: WeatherProviderName[];
    provider: WeatherProviderName;
    configuredHouses: number;
    lastSuccessAt: string | null;
    error: string | null;
    /** Additive per-Home status; aggregate fields above remain for older clients. */
    connections?: Array<{
      houseId: string;
      configured: boolean;
      provider: WeatherProviderName;
      lastSuccessAt: string | null;
      error: string | null;
    }>;
  };
  /**
   * Absent on older servers and while no Gree/Wilfa heat pump has been added.
   * This keeps the integration entirely out of clients that do not use it.
   */
  gree?: GreeIntegrationStatus;
}

export interface HomeAssistantDiscoveredInstance {
  name: string;
  url: string;
  host: string;
  port: number;
  version: string | null;
}

export interface TpLinkDiscoveredSource {
  host: string;
  model: string;
  alias: string | null;
  sourceType?: "hub" | "energy-device";
  /** Stable local source identity when the device exposes one. */
  deviceId?: string | null;
  /** Present when this physical source already has a saved Stugu connection. */
  configuredConnectionId?: string;
}

export interface IntegrationDiscoveryResult {
  homeAssistant: HomeAssistantDiscoveredInstance[];
  tpLink: TpLinkDiscoveredSource[];
  /** Optional for wire compatibility with servers without direct Gree support. */
  gree?: GreeDiscoveredDevice[];
  warnings: string[];
}

export type IntegrationDiscoveryJobStatus = "running" | "completed" | "failed";

export interface IntegrationDiscoveryJob {
  id: string;
  houseId: string;
  status: IntegrationDiscoveryJobStatus;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  result: IntegrationDiscoveryResult | null;
  error: string | null;
}

export interface HomeAssistantConfigInput {
  houseId: string;
  url: string;
  token: string;
}

export interface TpLinkConfigInput {
  houseId: string;
  /** Omit to create a stable connection id for this host. */
  connectionId?: string;
  host: string;
  username: string;
  password: string;
}

export interface IntegrationConfigurationResult {
  ok: true;
  configured: true;
  integration: IntegrationStatus;
}

export interface IntegrationTestResult {
  ok: boolean;
  message: string;
}

export interface TelegramChatCandidate {
  /** Telegram's immutable numeric chat identifier, serialized to avoid JS integer truncation. */
  id: string;
  label: string;
  username: string | null;
  type: "private";
}

export interface TelegramDiscoveryResult {
  botUsername: string;
  chats: TelegramChatCandidate[];
  message: string;
}

export interface TelegramConfigInput {
  botToken: string;
  chatId: string;
}

export interface AppleNotesGrantSummary {
  id: string;
  deviceLabel: string;
  houseId: string;
  createdAt: string;
}

export interface AppleNotesGrantCreated extends AppleNotesGrantSummary {
  /** Returned once. Stugu never returns this bearer token again. */
  token: string;
  integration: IntegrationStatus;
}

export interface AppleNotesSnapshot {
  schema: "stugu.apple-notes-snapshot/v1";
  generatedAt: string;
  houseId: string;
  title: string;
  text: string;
  maintenanceTasks: MaintenanceTask[];
}

export type AppleNotesMaintenanceCaptureInput = MaintenanceTaskInputCommon & {
  schema: "stugu.apple-notes-command/v1";
  houseId: string;
  propertyId?: string;
  /** UUID generated once by the Shortcut and reused if its HTTP request is retried. */
  operationId: string;
};

export interface AppleNotesMaintenanceCaptureResult {
  ok: true;
  deduplicated: boolean;
  task: MaintenanceTask;
  receipt: string;
}

export type WeatherUpdateTrigger = "scheduled-refresh" | "on-demand";

/**
 * Provider-neutral snapshot accepted by the weather event layer. The stable ID
 * lets at-least-once consumers discard a repeated delivery.
 */
export interface WeatherUpdateEvent {
  id: string;
  type: "weather.snapshot";
  houseId: string;
  publishedAt: string;
  trigger: WeatherUpdateTrigger;
  weather: HouseWeather;
}

export type TelemetryEvent =
  | { type: "reading"; data: Reading }
  | { type: "measurement"; data: MeasurementSample }
  | { type: "alert"; data: AlertEvent }
  | { type: "integration"; data: IntegrationStatus }
  | { type: "weather"; data: WeatherUpdateEvent }
  | { type: "opening"; data: OpeningStateObservation }
  | { type: "heat-pump"; data: HeatPumpState }
  | { type: "mutation"; data: { method: string; resource: string; occurredAt: string } }
  | { type: "heartbeat"; data: { timestamp: string } };

export interface HistorySeries {
  sensorId: string;
  readings: Reading[];
  forecast: ForecastPoint[];
}

export interface MockScenario {
  id: "normal" | "shower" | "leak" | "cold-front" | "heating-failure";
  label: string;
  description: string;
}

export interface ReplayState {
  active: boolean;
  count: number;
  emitted: number;
  speed: number;
  from: string | null;
  to: string | null;
}

export interface ReplayInput {
  sensorIds?: string[];
  from?: string;
  to?: string;
  speed?: number;
}

export interface ApiError {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export const API_V1_VERSION = "v1" as const;

export const API_V2_VERSION = "v2" as const;

/** Legacy alias retained for v1 clients. */
export const API_VERSION = API_V1_VERSION;

export const API_V1_PREFIX = `/api/${API_V1_VERSION}` as const;

export const API_V2_PREFIX = `/api/${API_V2_VERSION}` as const;

/** Legacy alias retained for v1 clients. */
export const DEFAULT_API_PREFIX = API_V1_PREFIX;
