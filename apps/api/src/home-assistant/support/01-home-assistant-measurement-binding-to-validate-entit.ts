import { existsSync, readFileSync } from "node:fs";
import { Agent as HttpAgent } from "node:http";
import { Agent as HttpsAgent } from "node:https";
import type { Socket } from "node:net";
import { resolve } from "node:path";
import WebSocket from "ws";
import type { MeasurementSample, OpeningState, OpeningStateObservation, Reading } from "@climate-twin/contracts";
import type { AppConfig } from "../../config.js";
import type { ClimateDatabase } from "../../db.js";
import type {
  SensorGapRecoveryAdapter,
  SensorHistoryRecoveryResult,
  SensorMetricAvailability,
} from "../../sensor-gap-recovery.js";
import type { MeasurementService, RuntimeStatus, TelemetryService } from "../../services.js";
import { parseHaMessage } from "./02-validate-entity-mappings-to-home-assistant-bridge.js";

export interface HomeAssistantMeasurementBinding {
  entityId: string;
  /** Expected source unit. If different from canonical, scale/offset must explicitly convert it. */
  unit?: string;
  scale?: number;
  offset?: number;
}

export type HomeAssistantMeasurementMapping = string | HomeAssistantMeasurementBinding;

export interface HomeAssistantEntityMapping {
  sensorId: string;
  temperature?: string;
  humidity?: string;
  battery?: string;
  measurements?: Record<string, HomeAssistantMeasurementMapping>;
}

export interface EntityTarget {
  sensorId: string;
  metric: string;
  expectedUnit?: string;
  scale?: number;
  offset?: number;
  automaticElectricityUnitConversion?: boolean;
  legacy: boolean;
}

export interface OpeningTarget {
  houseId: string;
  floorId: string;
  elementId: string;
  externalId: string;
  connectionId: string;
}

export interface HaState {
  entity_id?: string;
  state?: string;
  last_updated?: string;
  last_changed?: string;
  attributes?: {
    unit_of_measurement?: string;
  };
}

export interface HomeAssistantBridgeOptions {
  fetcher?: typeof fetch;
  onAvailabilityChange?: () => void;
  onOpeningStateRecorded?: (observation: OpeningStateObservation) => void;
  /**
   * Live-only source arbitration. History recovery remains available even when
   * another adapter is currently preferred.
   */
  shouldIngestLiveMeasurement?: (sensorId: string, metric: string) => boolean;
}

export interface CachedValue {
  value: number;
  timestamp: string;
}

export interface CachedSensorState {
  temperature?: CachedValue;
  humidity?: CachedValue;
  battery?: CachedValue;
}

export interface HaMessage {
  id?: number;
  type?: string;
  success?: boolean;
  message?: string;
  result?: HaState[] | null;
  event?: {
    event_type?: string;
    time_fired?: string;
    data?: {
      entity_id?: string;
      new_state?: HaState | null;
    };
  };
}

export function normalizeHomeAssistantTemperature(value: number, unit: string | undefined): number | null {
  if (!Number.isFinite(value)) return null;
  const normalized = unit?.trim().toLowerCase().replaceAll(" ", "") ?? "";
  if (normalized === "" || normalized === "\u00b0c" || normalized === "c" || normalized === "celsius") return value;
  if (normalized === "\u00b0f" || normalized === "f" || normalized === "fahrenheit") return (value - 32) * 5 / 9;
  if (normalized === "k" || normalized === "\u00b0k" || normalized === "kelvin") return value - 273.15;
  return null;
}

export const AUTOMATIC_ELECTRICITY_METRICS = new Set(["power", "energy", "electricity_price"]);

export const HA_HANDSHAKE_TIMEOUT_MS = 10_000;

export const HA_SNAPSHOT_TIMEOUT_MS = 10_000;

export const HA_SNAPSHOT_EVENT_BUFFER_LIMIT = 1_000;

export const HA_LIVENESS_INTERVAL_MS = 30_000;

export const HA_LIVENESS_TIMEOUT_MS = 90_000;

export const HA_OPENING_HEARTBEAT_MS = 5 * 60_000;

export const HA_COMPOSITE_MAX_SKEW_MS = 5 * 60_000;

export const HA_HISTORY_CHUNK_MS = 24 * 60 * 60_000;

/**
 * Converts common Home Assistant electricity units to the built-in canonical
 * units: W, cumulative kWh, and €/kWh. This is deliberately limited to simple
 * string mappings; explicit mapping objects keep their configured unit/scale.
 */
export function normalizeHomeAssistantElectricityMeasurement(
  metric: string,
  value: number,
  unit: string | undefined,
): number | null {
  if (!Number.isFinite(value) || !unit) return null;
  const normalized = unit.trim().toLowerCase().replace(/\s+/g, "");
  if (metric === "power") {
    if (normalized === "w") return value;
    if (normalized === "kw") return value * 1_000;
    return null;
  }
  if (metric === "energy") {
    if (normalized === "wh") return value / 1_000;
    if (normalized === "kwh") return value;
    if (normalized === "mwh") return value * 1_000;
    return null;
  }
  if (metric === "electricity_price") {
    if (normalized === "€/kwh" || normalized === "eur/kwh") return value;
    if (["c/kwh", "ct/kwh", "cent/kwh", "snt/kwh"].includes(normalized)) return value / 100;
    if (normalized === "€/mwh" || normalized === "eur/mwh") return value / 1_000;
  }
  return null;
}

export function normalizeHomeAssistantTimestamp(value: string | undefined, fallback?: string): string {
  for (const candidate of [value, fallback]) {
    if (candidate && Number.isFinite(Date.parse(candidate))) return new Date(candidate).toISOString();
  }
  return new Date().toISOString();
}

export function websocketUrl(url: string): string {
  const parsed = new URL(url);
  parsed.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
  parsed.pathname = `${parsed.pathname.replace(/\/$/, "")}/api/websocket`;
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

export interface HomeAssistantCredentialTestResult {
  ok: boolean;
  connected: boolean;
  message: string;
  details?: Record<string, unknown>;
}

/** Authenticates, subscribes, and loads a temporary state snapshot without mutating runtime configuration. */
export function testHomeAssistantCredentials(
  url: string,
  token: string,
  timeoutMs = 7_500,
): Promise<HomeAssistantCredentialTestResult> {
  return new Promise((resolveTest) => {
    const endpoint = websocketUrl(url);
    // Draft validation gets a private agent so teardown can also destroy a TCP
    // connection whose HTTP upgrade never receives a response. `ws.terminate()`
    // alone cannot reliably release that pre-upgrade socket on every Node path.
    const agent = endpoint.startsWith("wss:") ? new HttpsAgent() : new HttpAgent();
    let settled = false;
    let resetPendingHandshake = false;
    let transport: Socket | null = null;
    const socket = new WebSocket(endpoint, {
      agent,
      finishRequest: (request) => {
        const captureTransport = (value: Socket): void => {
          transport = value;
          if (settled) {
            if (resetPendingHandshake) value.resetAndDestroy();
            else value.destroy();
          }
        };
        if (request.socket) captureTransport(request.socket);
        else request.once("socket", captureTransport);
        request.end();
      },
    });
    let subscriptionReady = false;
    const finish = (result: HomeAssistantCredentialTestResult): void => {
      if (settled) return;
      resetPendingHandshake = socket.readyState === WebSocket.CONNECTING;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      // `ws` can emit an asynchronous error when a CONNECTING socket is
      // terminated. Keep an error sink installed throughout teardown so a
      // timed-out draft validation can never become an uncaught process error.
      socket.on("error", () => undefined);
      if (resetPendingHandshake && transport && !transport.destroyed) {
        // A pre-upgrade peer may not be reading yet, so a normal FIN can leave
        // its half-open socket resident. Reset this temporary validation TCP
        // connection before asking `ws` to abort its ClientRequest.
        transport.resetAndDestroy();
      }
      try {
        if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
      } catch { /* The draft socket may have closed concurrently. */ }
      transport?.destroy();
      agent.destroy();
      resolveTest(result);
    };
    const timer = setTimeout(() => finish({
      ok: false,
      connected: false,
      message: "Home Assistant did not complete WebSocket validation in time.",
    }), timeoutMs);
    timer.unref();
    socket.on("message", (data) => {
      const message = parseHaMessage(data.toString());
      if (!message) return;
      if (message.type === "auth_required") socket.send(JSON.stringify({ type: "auth", access_token: token }));
      else if (message.type === "auth_invalid") finish({
        ok: false, connected: false, message: "Home Assistant rejected the access token.",
      });
      else if (message.type === "auth_ok") {
        socket.send(JSON.stringify({ id: 1, type: "subscribe_events", event_type: "state_changed" }));
      } else if (message.type === "result" && message.id === 1) {
        if (!message.success) {
          finish({ ok: false, connected: false, message: "Home Assistant rejected the state-change subscription." });
          return;
        }
        subscriptionReady = true;
        socket.send(JSON.stringify({ id: 2, type: "get_states" }));
      } else if (message.type === "result" && message.id === 2 && subscriptionReady) {
        finish(message.success && Array.isArray(message.result)
          ? { ok: true, connected: true, message: "Home Assistant credentials, state snapshot, and state streaming are available." }
          : { ok: false, connected: false, message: "Home Assistant initial state request failed." });
      }
    });
    socket.once("error", () => finish({
      ok: false, connected: false, message: "Home Assistant WebSocket connection failed.",
    }));
    socket.once("close", () => finish({
      ok: false, connected: false, message: "Home Assistant closed the connection before validation completed.",
    }));
  });
}

export function validateMeasurementBinding(metric: string, binding: unknown, index: number): void {
  if (!/^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/.test(metric)
    || ["__proto__", "constructor", "prototype"].includes(metric)) {
    throw new Error(`Invalid measurement id ${metric} at index ${index}`);
  }
  if (typeof binding === "string") {
    if (!binding.trim()) throw new Error(`Invalid ${metric} measurement mapping at index ${index}`);
    return;
  }
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
    throw new Error(`Invalid ${metric} measurement mapping at index ${index}`);
  }
  const candidate = binding as Partial<HomeAssistantMeasurementBinding>;
  if (typeof candidate.entityId !== "string" || !candidate.entityId.trim()
    || candidate.unit !== undefined && (typeof candidate.unit !== "string" || !candidate.unit.trim())
    || candidate.scale !== undefined && !Number.isFinite(candidate.scale)
    || candidate.offset !== undefined && !Number.isFinite(candidate.offset)) {
    throw new Error(`Invalid ${metric} measurement mapping at index ${index}`);
  }
}

export function validateMeasurementMappings(value: unknown, index: number): void {
  if (value === undefined) return;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid measurements mapping at index ${index}`);
  }
  for (const [metric, binding] of Object.entries(value)) {
    validateMeasurementBinding(metric, binding, index);
  }
}

export function validateEntityMapping(value: unknown, index: number): HomeAssistantEntityMapping {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid Home Assistant entity mapping at index ${index}`);
  }
  const entry = value as Partial<HomeAssistantEntityMapping>;
  if (typeof entry.sensorId !== "string" || !entry.sensorId.trim()) {
    throw new Error(`Invalid Home Assistant entity mapping at index ${index}`);
  }
  for (const key of ["temperature", "humidity", "battery"] as const) {
    const entityId = entry[key];
    if (entityId !== undefined && (typeof entityId !== "string" || !entityId.trim())) {
      throw new Error(`Invalid ${key} mapping at index ${index}`);
    }
  }
  validateMeasurementMappings(entry.measurements, index);
  if (!entry.temperature && !entry.humidity && !entry.battery
    && Object.keys(entry.measurements ?? {}).length === 0) {
    throw new Error(`Home Assistant entity mapping at index ${index} has no entities`);
  }
  const mapping: HomeAssistantEntityMapping = { sensorId: entry.sensorId.trim() };
  if (entry.temperature !== undefined) mapping.temperature = entry.temperature.trim();
  if (entry.humidity !== undefined) mapping.humidity = entry.humidity.trim();
  if (entry.battery !== undefined) mapping.battery = entry.battery.trim();
  if (entry.measurements !== undefined) {
    mapping.measurements = {};
    for (const [metric, configured] of Object.entries(entry.measurements)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) {
      if (typeof configured === "string") {
        mapping.measurements[metric] = configured.trim();
        continue;
      }
      const binding: HomeAssistantMeasurementBinding = { entityId: configured.entityId.trim() };
      if (configured.unit !== undefined) binding.unit = configured.unit.trim();
      if (configured.scale !== undefined) binding.scale = configured.scale;
      if (configured.offset !== undefined) binding.offset = configured.offset;
      mapping.measurements[metric] = binding;
    }
  }
  return mapping;
}
