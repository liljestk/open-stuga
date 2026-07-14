import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import WebSocket from "ws";
import type { MeasurementSample, Reading } from "@climate-twin/contracts";
import type { AppConfig } from "./config.js";
import type { ClimateDatabase } from "./db.js";
import type { MeasurementService, RuntimeStatus, TelemetryService } from "./services.js";

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

interface MappingFile {
  entities: HomeAssistantEntityMapping[];
}

interface EntityTarget {
  sensorId: string;
  metric: string | "battery";
  expectedUnit?: string;
  scale?: number;
  offset?: number;
  legacy: boolean;
}

interface HaState {
  entity_id?: string;
  state?: string;
  last_updated?: string;
  attributes?: {
    unit_of_measurement?: string;
  };
}

interface CachedValue {
  value: number;
  timestamp: string;
}

interface CachedSensorState {
  temperature?: CachedValue;
  humidity?: CachedValue;
  battery?: CachedValue;
}

interface HaMessage {
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

export function normalizeHomeAssistantTimestamp(value: string | undefined, fallback?: string): string {
  for (const candidate of [value, fallback]) {
    if (candidate && Number.isFinite(Date.parse(candidate))) return new Date(candidate).toISOString();
  }
  return new Date().toISOString();
}

function websocketUrl(url: string): string {
  const parsed = new URL(url);
  parsed.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
  parsed.pathname = `${parsed.pathname.replace(/\/$/, "")}/api/websocket`;
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

export function loadEntityMappings(path: string): HomeAssistantEntityMapping[] {
  const parsed = JSON.parse(readFileSync(resolve(path), "utf8")) as Partial<MappingFile>;
  if (!Array.isArray(parsed.entities)) throw new Error("Home Assistant entity map must contain an entities array");
  const mappings = parsed.entities.map((entry, index) => {
    if (!entry || typeof entry.sensorId !== "string" || !entry.sensorId.trim()) {
      throw new Error(`Invalid Home Assistant entity mapping at index ${index}`);
    }
    for (const key of ["temperature", "humidity", "battery"] as const) {
      if (entry[key] !== undefined && (typeof entry[key] !== "string" || !entry[key].trim())) {
        throw new Error(`Invalid ${key} mapping at index ${index}`);
      }
    }
    if (entry.measurements !== undefined) {
      if (!entry.measurements || typeof entry.measurements !== "object" || Array.isArray(entry.measurements)) {
        throw new Error(`Invalid measurements mapping at index ${index}`);
      }
      for (const [metric, binding] of Object.entries(entry.measurements)) {
        if (!/^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/.test(metric) || ["__proto__", "constructor", "prototype"].includes(metric)) {
          throw new Error(`Invalid measurement id ${metric} at index ${index}`);
        }
        if (typeof binding === "string") {
          if (!binding.trim()) throw new Error(`Invalid ${metric} measurement mapping at index ${index}`);
          continue;
        }
        if (!binding || typeof binding !== "object" || typeof binding.entityId !== "string" || !binding.entityId.trim()
          || binding.unit !== undefined && (typeof binding.unit !== "string" || !binding.unit.trim())
          || binding.scale !== undefined && !Number.isFinite(binding.scale)
          || binding.offset !== undefined && !Number.isFinite(binding.offset)) {
          throw new Error(`Invalid ${metric} measurement mapping at index ${index}`);
        }
      }
    }
    if (!entry.temperature && !entry.humidity && !entry.battery && Object.keys(entry.measurements ?? {}).length === 0) {
      throw new Error(`Home Assistant entity mapping at index ${index} has no entities`);
    }
    return entry as HomeAssistantEntityMapping;
  });
  const entityIds = new Set<string>();
  for (const mapping of mappings) {
    const configured = [mapping.temperature, mapping.humidity, mapping.battery,
      ...Object.values(mapping.measurements ?? {}).map((binding) => typeof binding === "string" ? binding : binding.entityId)];
    for (const entityId of configured) {
      if (!entityId) continue;
      const normalized = entityId.trim();
      if (entityIds.has(normalized)) throw new Error(`Home Assistant entity ${normalized} is mapped more than once`);
      entityIds.add(normalized);
    }
  }
  return mappings;
}

export class HomeAssistantBridge {
  #socket: WebSocket | null = null;
  #reconnectTimer: NodeJS.Timeout | null = null;
  #running = false;
  #attempt = 0;
  readonly #entities = new Map<string, EntityTarget>();
  readonly #cache = new Map<string, CachedSensorState>();

  constructor(
    private readonly config: AppConfig,
    private readonly telemetry: TelemetryService,
    private readonly measurements: MeasurementService,
    private readonly database: ClimateDatabase,
    private readonly status: RuntimeStatus,
  ) {}

  start(): void {
    if (this.#running) return;
    this.#running = true;
    if (!this.status.value.homeAssistant.configured || !this.config.haEntityMapFile) return;
    try {
      const mappings = loadEntityMappings(this.config.haEntityMapFile);
      for (const mapping of mappings) {
        const sensorId = mapping.sensorId.trim();
        if (mapping.temperature) this.registerEntity(mapping.temperature, { sensorId, metric: "temperature", legacy: true });
        if (mapping.humidity) this.registerEntity(mapping.humidity, { sensorId, metric: "humidity", legacy: true });
        if (mapping.battery) this.registerEntity(mapping.battery, { sensorId, metric: "battery", legacy: true });
        for (const [metric, configured] of Object.entries(mapping.measurements ?? {})) {
          const binding = typeof configured === "string" ? { entityId: configured } : configured;
          this.registerEntity(binding.entityId, {
            sensorId,
            metric,
            ...(binding.unit !== undefined ? { expectedUnit: binding.unit.trim() } : {}),
            ...(binding.scale !== undefined ? { scale: binding.scale } : {}),
            ...(binding.offset !== undefined ? { offset: binding.offset } : {}),
            legacy: false,
          });
        }
      }
      this.status.value.homeAssistant.mappedEntities = this.#entities.size;
      this.status.value.homeAssistant.error = null;
      this.status.changed();
      this.connect();
    } catch (error) {
      this.status.value.homeAssistant.error = error instanceof Error ? error.message : "Could not load entity mappings";
      this.status.changed();
    }
  }

  private registerEntity(entityId: string, target: EntityTarget): void {
    const normalized = entityId.trim();
    if (this.#entities.has(normalized)) throw new Error(`Home Assistant entity ${normalized} is mapped more than once`);
    this.#entities.set(normalized, target);
  }

  stop(): void {
    this.#running = false;
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;
    this.#socket?.close();
    this.#socket = null;
    this.status.value.homeAssistant.connected = false;
  }

  private connect(): void {
    if (!this.#running || !this.config.haUrl || !this.config.haToken) return;
    const socket = new WebSocket(websocketUrl(this.config.haUrl));
    this.#socket = socket;
    socket.on("message", (data) => this.onMessage(data.toString()));
    socket.on("error", () => {
      this.status.value.homeAssistant.error = "Home Assistant WebSocket connection failed";
      this.status.changed();
    });
    socket.on("close", () => {
      if (this.#socket !== socket) return;
      this.#socket = null;
      this.status.value.homeAssistant.connected = false;
      this.status.changed();
      this.scheduleReconnect();
    });
  }

  private onMessage(raw: string): void {
    let message: HaMessage;
    try {
      message = JSON.parse(raw) as HaMessage;
    } catch {
      return;
    }
    if (message.type === "auth_required") {
      this.#socket?.send(JSON.stringify({ type: "auth", access_token: this.config.haToken }));
      return;
    }
    if (message.type === "auth_ok") {
      this.#attempt = 0;
      this.status.value.homeAssistant.connected = true;
      this.status.value.homeAssistant.error = null;
      this.status.changed();
      this.#socket?.send(JSON.stringify({ id: 1, type: "get_states" }));
      this.#socket?.send(JSON.stringify({ id: 2, type: "subscribe_events", event_type: "state_changed" }));
      return;
    }
    if (message.type === "auth_invalid") {
      this.status.value.homeAssistant.error = "Home Assistant rejected the access token";
      this.status.changed();
      this.#socket?.close();
      return;
    }
    if (message.type === "result" && message.id === 1) {
      if (!message.success || !Array.isArray(message.result)) {
        this.status.value.homeAssistant.error = "Home Assistant initial state request failed";
        this.status.changed();
        return;
      }
      const climateUpdates = new Map<string, string>();
      for (const state of message.result) {
        const updated = this.applyState(state);
        if (!updated || updated.metric === "battery") continue;
        this.ingestMeasurementUpdate(updated);
        if (updated.metric === "temperature" || updated.metric === "humidity") {
          const previous = climateUpdates.get(updated.sensorId);
          if (!previous || Date.parse(updated.timestamp) > Date.parse(previous)) climateUpdates.set(updated.sensorId, updated.timestamp);
        }
      }
      for (const [sensorId, timestamp] of climateUpdates) this.ingestCachedClimate(sensorId, timestamp);
      return;
    }
    if (message.type === "result" && message.id === 2 && !message.success) {
      this.status.value.homeAssistant.error = "Home Assistant rejected the state_changed subscription";
      this.status.changed();
      return;
    }
    if (message.type !== "event" || message.event?.event_type !== "state_changed") return;
    const entityId = message.event.data?.entity_id;
    const newState = message.event.data?.new_state;
    if (!entityId || !newState) return;
    const updated = this.applyState({ ...newState, entity_id: entityId }, message.event.time_fired);
    if (!updated) return;
    this.status.value.homeAssistant.lastEventAt = updated.timestamp;
    if (updated.metric === "battery") {
      this.status.changed();
      return;
    }
    this.ingestMeasurementUpdate(updated);
    if (updated.metric === "temperature" || updated.metric === "humidity") this.ingestCachedClimate(updated.sensorId, updated.timestamp);
  }

  private applyState(state: HaState, fallbackTimestamp?: string): (EntityTarget & { timestamp: string; value: number }) | null {
    if (!state.entity_id) return null;
    const target = this.#entities.get(state.entity_id);
    if (!target) return null;
    const rawValue = Number(state.state);
    if (!Number.isFinite(rawValue)) return null;
    const haUnit = state.attributes?.unit_of_measurement?.trim();
    let value: number | null;
    if (target.metric === "temperature") {
      value = normalizeHomeAssistantTemperature(rawValue, haUnit);
    } else if (target.legacy || target.metric === "battery") {
      value = rawValue;
    } else {
      const definition = this.database.getMeasurementDefinition(target.metric);
      if (!definition) {
        this.status.value.homeAssistant.error = `Unknown measurement metric ${target.metric} for entity ${state.entity_id}`;
        this.status.changed();
        return null;
      }
      const expectedUnit = target.expectedUnit ?? definition.unit;
      if (!haUnit || haUnit !== expectedUnit) {
        this.status.value.homeAssistant.error = `Unit for entity ${state.entity_id} must be ${expectedUnit}`;
        this.status.changed();
        return null;
      }
      if (expectedUnit !== definition.unit && target.scale === undefined && target.offset === undefined) {
        this.status.value.homeAssistant.error = `Entity ${state.entity_id} requires an explicit scale or offset to convert ${expectedUnit} to ${definition.unit}`;
        this.status.changed();
        return null;
      }
      value = rawValue * (target.scale ?? 1) + (target.offset ?? 0);
    }
    if (value === null) {
      this.status.value.homeAssistant.error = `Unsupported temperature unit for entity ${state.entity_id}`;
      this.status.changed();
      return null;
    }
    const timestamp = normalizeHomeAssistantTimestamp(state.last_updated, fallbackTimestamp);
    const cached = this.#cache.get(target.sensorId) ?? {};
    if (target.metric === "temperature" || target.metric === "humidity" || target.metric === "battery") {
      cached[target.metric] = { value, timestamp };
    }
    this.#cache.set(target.sensorId, cached);
    return { ...target, timestamp, value };
  }

  private ingestMeasurementUpdate(update: EntityTarget & { timestamp: string; value: number }): void {
    const definition = this.database.getMeasurementDefinition(update.metric);
    if (!definition) {
      this.status.value.homeAssistant.error = `Unknown measurement metric ${update.metric}`;
      this.status.changed();
      return;
    }
    const sample: MeasurementSample = {
      sensorId: update.sensorId,
      metric: update.metric,
      value: update.value,
      canonicalUnit: definition.unit,
      timestamp: update.timestamp,
      source: "home-assistant",
      quality: "good",
    };
    try {
      this.measurements.ingest(sample);
      this.status.value.homeAssistant.lastEventAt = sample.timestamp;
      this.status.value.homeAssistant.error = null;
      this.status.changed();
    } catch (error) {
      this.status.value.homeAssistant.error = error instanceof Error ? error.message : `Could not ingest ${update.metric}`;
      this.status.changed();
    }
  }

  private ingestCachedClimate(sensorId: string, timestamp: string): void {
    const cached = this.#cache.get(sensorId);
    if (!cached?.temperature || !cached.humidity) return;
    const reading: Reading = {
      sensorId,
      timestamp,
      temperature: cached.temperature.value,
      humidity: cached.humidity.value,
      battery: cached.battery?.value ?? null,
      source: "home-assistant",
      quality: "good",
    };
    try {
      this.telemetry.ingestLegacyProjection(reading);
      this.status.value.homeAssistant.lastEventAt = reading.timestamp;
      this.status.value.homeAssistant.error = null;
      this.status.changed();
    } catch {
      this.status.value.homeAssistant.error = `Mapped entity references unknown or disabled sensor ${sensorId}`;
      this.status.changed();
    }
  }

  private scheduleReconnect(): void {
    if (!this.#running || this.#reconnectTimer) return;
    const delay = Math.min(60_000, 1_000 * 2 ** this.#attempt);
    this.#attempt = Math.min(this.#attempt + 1, 6);
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.connect();
    }, delay);
    this.#reconnectTimer.unref();
  }
}
