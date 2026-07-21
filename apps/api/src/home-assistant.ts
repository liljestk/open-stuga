import { existsSync, readFileSync } from "node:fs";
import { Agent as HttpAgent } from "node:http";
import { Agent as HttpsAgent } from "node:https";
import type { Socket } from "node:net";
import { resolve } from "node:path";
import WebSocket from "ws";
import type { MeasurementSample, OpeningState, Reading } from "@climate-twin/contracts";
import type { AppConfig } from "./config.js";
import type { ClimateDatabase } from "./db.js";
import type {
  SensorGapRecoveryAdapter,
  SensorHistoryRecoveryResult,
  SensorMetricAvailability,
} from "./sensor-gap-recovery.js";
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

interface EntityTarget {
  sensorId: string;
  metric: string;
  expectedUnit?: string;
  scale?: number;
  offset?: number;
  automaticElectricityUnitConversion?: boolean;
  legacy: boolean;
}

interface OpeningTarget {
  houseId: string;
  floorId: string;
  elementId: string;
  externalId: string;
  connectionId: string;
}

interface HaState {
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

const AUTOMATIC_ELECTRICITY_METRICS = new Set(["power", "energy", "electricity_price"]);
const HA_HANDSHAKE_TIMEOUT_MS = 10_000;
const HA_SNAPSHOT_TIMEOUT_MS = 10_000;
const HA_SNAPSHOT_EVENT_BUFFER_LIMIT = 1_000;
const HA_LIVENESS_INTERVAL_MS = 30_000;
const HA_LIVENESS_TIMEOUT_MS = 90_000;
const HA_OPENING_HEARTBEAT_MS = 5 * 60_000;
const HA_COMPOSITE_MAX_SKEW_MS = 5 * 60_000;
const HA_HISTORY_CHUNK_MS = 24 * 60 * 60_000;

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

function websocketUrl(url: string): string {
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

function validateMeasurementBinding(metric: string, binding: unknown, index: number): void {
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

function validateMeasurementMappings(value: unknown, index: number): void {
  if (value === undefined) return;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid measurements mapping at index ${index}`);
  }
  for (const [metric, binding] of Object.entries(value)) {
    validateMeasurementBinding(metric, binding, index);
  }
}

function validateEntityMapping(value: unknown, index: number): HomeAssistantEntityMapping {
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

function validateEntityMappings(value: unknown): HomeAssistantEntityMapping[] {
  if (!Array.isArray(value)) throw new Error("Home Assistant entity map must contain an entities array");
  const mappings = value.map(validateEntityMapping);
  assertUniqueEntityIds(mappings);
  assertUniqueSensorMetricClaims(mappings);
  return mappings.sort((left, right) => {
    const leftJson = JSON.stringify(left);
    const rightJson = JSON.stringify(right);
    return leftJson < rightJson ? -1 : leftJson > rightJson ? 1 : 0;
  });
}

function mappedEntityIds(mapping: HomeAssistantEntityMapping): string[] {
  const measurements = Object.values(mapping.measurements ?? {}).map((binding) => (
    typeof binding === "string" ? binding : binding.entityId
  ));
  return [mapping.temperature, mapping.humidity, mapping.battery, ...measurements]
    .filter((entityId): entityId is string => Boolean(entityId));
}

function assertUniqueEntityIds(mappings: HomeAssistantEntityMapping[]): void {
  const entityIds = new Set<string>();
  for (const mapping of mappings) {
    for (const entityId of mappedEntityIds(mapping)) {
      const normalized = entityId.trim();
      if (entityIds.has(normalized)) throw new Error(`Home Assistant entity ${normalized} is mapped more than once`);
      entityIds.add(normalized);
    }
  }
}

function mappingMetricKeys(mapping: HomeAssistantEntityMapping): string[] {
  return [
    ...(mapping.temperature ? ["temperature"] : []),
    ...(mapping.humidity ? ["humidity"] : []),
    ...(mapping.battery ? ["battery"] : []),
    ...Object.keys(mapping.measurements ?? {}),
  ];
}

function sensorMetricKey(sensorId: string, metric: string): string {
  return `${sensorId.trim()}\u0000${metric}`;
}

function assertUniqueSensorMetricClaims(mappings: HomeAssistantEntityMapping[]): void {
  const claims = new Set<string>();
  for (const mapping of mappings) {
    for (const metric of mappingMetricKeys(mapping)) {
      const claim = sensorMetricKey(mapping.sensorId, metric);
      if (claims.has(claim)) {
        throw new Error(`Home Assistant sensor ${mapping.sensorId} metric ${metric} is mapped more than once`);
      }
      claims.add(claim);
    }
  }
}

function mappingFingerprint(mappings: HomeAssistantEntityMapping[]): string {
  const normalized = mappings.map((mapping) => ({
    sensorId: mapping.sensorId.trim(),
    temperature: mapping.temperature?.trim() ?? null,
    humidity: mapping.humidity?.trim() ?? null,
    battery: mapping.battery?.trim() ?? null,
    measurements: Object.entries(mapping.measurements ?? {})
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([metric, configured]) => {
        const binding = typeof configured === "string" ? { entityId: configured } : configured;
        return [metric, {
          entityId: binding.entityId.trim(),
          unit: binding.unit?.trim() ?? null,
          scale: binding.scale ?? null,
          offset: binding.offset ?? null,
        }];
      }),
  }));
  normalized.sort((left, right) => {
    const leftJson = JSON.stringify(left);
    const rightJson = JSON.stringify(right);
    return leftJson < rightJson ? -1 : leftJson > rightJson ? 1 : 0;
  });
  return JSON.stringify(normalized);
}

function parseHaMessage(raw: string): HaMessage | null {
  try {
    return JSON.parse(raw) as HaMessage;
  } catch {
    return null;
  }
}

export function loadEntityMappings(path: string): HomeAssistantEntityMapping[] {
  const parsed = JSON.parse(readFileSync(resolve(path), "utf8")) as { entities?: unknown };
  return validateEntityMappings(parsed.entities);
}

function importEntityMappingFile(database: ClimateDatabase, path: string): HomeAssistantEntityMapping[] {
  const mappings = loadEntityMappings(path);
  database.saveIntegrationMappingSet("home-assistant", mappings);
  return mappings;
}

interface HomeAssistantStatusHost {
  value: RuntimeStatus["value"];
  changed(): void;
}

class HomeAssistantConnectionBridge {
  #socket: WebSocket | null = null;
  #reconnectTimer: NodeJS.Timeout | null = null;
  #handshakeTimer: NodeJS.Timeout | null = null;
  #snapshotTimer: NodeJS.Timeout | null = null;
  #livenessTimer: NodeJS.Timeout | null = null;
  #running = false;
  #attempt = 0;
  #lastMessageAt = 0;
  #databaseDataVersion = 0;
  #snapshotPending = false;
  readonly #bufferedEvents: Array<{ state: HaState; fallbackTimestamp?: string }> = [];
  #mappingFingerprint: string | null = null;
  #mappingWarning: string | null = null;
  readonly #entities = new Map<string, EntityTarget>();
  readonly #openings = new Map<string, OpeningTarget>();
  readonly #openingStateCache = new Map<string, { target: OpeningTarget; state: OpeningState }>();
  readonly #cache = new Map<string, CachedSensorState>();
  readonly #entityAvailability = new Map<string, boolean>();
  #lastOpeningHeartbeatAt = 0;

  constructor(
    private readonly config: AppConfig,
    private readonly telemetry: TelemetryService,
    private readonly measurements: MeasurementService,
    private readonly database: ClimateDatabase,
    private readonly status: HomeAssistantStatusHost,
    private readonly houseId?: string,
    private readonly options: HomeAssistantBridgeOptions = {},
  ) {}

  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#databaseDataVersion = this.databaseDataVersion();
    if (!this.status.value.homeAssistant.configured) return;
    try {
      const mappings = this.configuredMappings();
      const openingTargets = this.configuredOpeningTargets();
      this.#mappingFingerprint = this.combinedMappingFingerprint(mappings, openingTargets);
      for (const mapping of mappings) this.registerMapping(mapping);
      for (const target of openingTargets) this.registerOpening(target);
      this.status.value.homeAssistant.mappedEntities = new Set([...this.#entities.keys(), ...this.#openings.keys()]).size;
      this.status.value.homeAssistant.error = this.#mappingWarning;
      this.status.changed();
      this.connect();
    } catch (error) {
      this.status.value.homeAssistant.error = error instanceof Error ? error.message : "Could not load entity mappings";
      this.status.changed();
    }
  }

  availability(now = new Date()): SensorMetricAvailability[] {
    const observedAt = now.toISOString();
    return [...this.#entities.entries()]
      .filter(([, target]) => target.metric !== "battery")
      .map(([entityId, target]) => ({
        sensorId: target.sensorId,
        metric: target.metric,
        source: "home-assistant" as const,
        available: this.status.value.homeAssistant.connected && this.#entityAvailability.get(entityId) === true,
        observedAt,
      }));
  }

  async recoverHistory(sensorId: string, metric: string, from: string, to: string): Promise<SensorHistoryRecoveryResult> {
    const binding = [...this.#entities.entries()].find(([, target]) => target.sensorId === sensorId && target.metric === metric);
    if (!binding || !this.config.haUrl || !this.config.haToken) {
      return { state: "not-supported", samples: [], error: "The sensor metric has no active Home Assistant history binding" };
    }
    const [entityId, target] = binding;
    const startMs = Date.parse(from);
    const endMs = Date.parse(to);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
      return { state: "complete", samples: [], error: null };
    }
    const samples = new Map<string, MeasurementSample>();
    for (let cursor = startMs; cursor < endMs; cursor += HA_HISTORY_CHUNK_MS) {
      const chunkEnd = Math.min(endMs, cursor + HA_HISTORY_CHUNK_MS);
      const endpoint = new URL(this.config.haUrl);
      endpoint.pathname = `${endpoint.pathname.replace(/\/$/, "")}/api/history/period/${encodeURIComponent(new Date(cursor).toISOString())}`;
      endpoint.search = new URLSearchParams({
        end_time: new Date(chunkEnd).toISOString(),
        filter_entity_id: entityId,
      }).toString();
      endpoint.hash = "";
      const response = await (this.options.fetcher ?? fetch)(endpoint, {
        headers: { authorization: `Bearer ${this.config.haToken}`, accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      });
      if (response.status === 404) {
        return { state: "not-supported", samples: [], error: "Home Assistant recorder history is not available" };
      }
      if (!response.ok) throw new Error(`Home Assistant history request failed with status ${response.status}`);
      const body = await response.json() as unknown;
      if (!Array.isArray(body)) throw new Error("Home Assistant history returned an invalid response");
      for (const group of body) {
        if (!Array.isArray(group)) continue;
        for (const candidate of group) {
          if (!candidate || typeof candidate !== "object") continue;
          const state = { ...(candidate as HaState), entity_id: entityId };
          const value = this.normalizeHistoryValue(target, state);
          const sourceTimestamp = [state.last_updated, state.last_changed]
            .find((timestamp) => timestamp && Number.isFinite(Date.parse(timestamp)));
          if (!sourceTimestamp) continue;
          const timestamp = new Date(sourceTimestamp).toISOString();
          if (value === null || Date.parse(timestamp) < startMs || Date.parse(timestamp) > endMs) continue;
          const definition = this.database.getMeasurementDefinition(metric);
          if (!definition?.enabled) continue;
          samples.set(timestamp, {
            sensorId,
            metric,
            value,
            canonicalUnit: definition.unit,
            timestamp,
            source: "home-assistant",
            quality: "good",
          });
        }
      }
    }
    return { state: "complete", samples: [...samples.values()].sort((left, right) => left.timestamp.localeCompare(right.timestamp)), error: null };
  }

  private normalizeHistoryValue(target: EntityTarget, state: HaState): number | null {
    const rawValue = Number(state.state);
    if (!Number.isFinite(rawValue)) return null;
    const haUnit = state.attributes?.unit_of_measurement?.trim();
    if (target.metric === "temperature") return normalizeHomeAssistantTemperature(rawValue, haUnit);
    if (target.legacy || target.metric === "battery") return rawValue;
    if (target.automaticElectricityUnitConversion) {
      return normalizeHomeAssistantElectricityMeasurement(target.metric, rawValue, haUnit);
    }
    const definition = this.database.getMeasurementDefinition(target.metric);
    if (!definition) return null;
    const expectedUnit = target.expectedUnit ?? definition.unit;
    if (!haUnit || haUnit !== expectedUnit) return null;
    if (expectedUnit !== definition.unit && target.scale === undefined && target.offset === undefined) return null;
    return rawValue * (target.scale ?? 1) + (target.offset ?? 0);
  }

  private configuredMappings(): HomeAssistantEntityMapping[] {
    let fileMappings: HomeAssistantEntityMapping[] = [];
    // The compatibility map is workspace-global and must never leak into a
    // house-scoped UI connection. For the one legacy connection, an existing
    // file is an explicit bootstrap/update and SQLite is the durable fallback.
    if (this.houseId === undefined) {
      const path = this.config.haEntityMapFile;
      if (path && existsSync(path)) {
        fileMappings = importEntityMappingFile(this.database, path);
      } else {
        const stored = this.database.getIntegrationMappingSet<unknown>("home-assistant");
        fileMappings = stored ? validateEntityMappings(stored.mappings) : [];
      }
      const unavailableSensorIds = [...new Set(fileMappings
        .filter((mapping) => !this.database.getSensor(mapping.sensorId)?.enabled)
        .map((mapping) => mapping.sensorId))].sort();
      this.#mappingWarning = unavailableSensorIds.length > 0
        ? `Ignored Home Assistant mappings for unknown or disabled sensors: ${unavailableSensorIds.join(", ")}`
        : null;
      // Existing disabled sensors keep their entity/metric ownership below,
      // but only enabled sensors are registered for ingestion.
    }
    const claimMappings = fileMappings.filter((mapping) => this.database.getSensor(mapping.sensorId));
    const activeFileMappings = fileMappings.filter((mapping) => this.database.getSensor(mapping.sensorId)?.enabled);
    const fileClaims = new Set(claimMappings.flatMap((mapping) => (
      mappingMetricKeys(mapping).map((metric) => sensorMetricKey(mapping.sensorId, metric))
    )));
    const fileEntityClaims = new Set(claimMappings.flatMap(mappedEntityIds).map((entityId) => entityId.trim()));
    const persistedMappings: HomeAssistantEntityMapping[] = [];
    for (const sensor of this.database.listSensors(this.houseId)) {
      if (!sensor.enabled) continue;
      const persisted = sensor.measurementEntityIds ?? {};
      const mapping: HomeAssistantEntityMapping = { sensorId: sensor.id };
      const temperature = persisted.temperature ?? sensor.temperatureEntityId;
      const humidity = persisted.humidity ?? sensor.humidityEntityId;
      const battery = persisted.battery ?? sensor.batteryEntityId;
      if (temperature && !fileClaims.has(sensorMetricKey(sensor.id, "temperature"))
        && !fileEntityClaims.has(temperature.trim())) mapping.temperature = temperature;
      if (humidity && !fileClaims.has(sensorMetricKey(sensor.id, "humidity"))
        && !fileEntityClaims.has(humidity.trim())) mapping.humidity = humidity;
      if (battery && !fileClaims.has(sensorMetricKey(sensor.id, "battery"))
        && !fileEntityClaims.has(battery.trim())) mapping.battery = battery;
      for (const [metric, entityId] of Object.entries(persisted)) {
        // Legacy climate/battery fields above preserve flexible temperature
        // conversion and avoid registering normalized bindings twice.
        if (["temperature", "humidity", "battery"].includes(metric)
          || fileClaims.has(sensorMetricKey(sensor.id, metric))
          || fileEntityClaims.has(entityId.trim())) continue;
        mapping.measurements ??= {};
        mapping.measurements[metric] = entityId;
      }
      if (mappedEntityIds(mapping).length > 0) persistedMappings.push(mapping);
    }
    return [...activeFileMappings, ...persistedMappings];
  }

  private configuredOpeningTargets(): OpeningTarget[] {
    const houses = this.houseId ? [this.database.getHouse(this.houseId)].filter(Boolean) : this.database.listHouses().slice(0, 1);
    return houses.flatMap((house) => house!.floors.flatMap((floor) => (floor.planElements ?? []).flatMap((element) => {
      if ((element.kind !== "door" && element.kind !== "window" && element.kind !== "vent") || element.stateBinding?.provider !== "home-assistant") return [];
      if (element.stateBinding.connectionId && element.stateBinding.connectionId !== house!.id) return [];
      return [{ houseId: house!.id, floorId: floor.id, elementId: element.id,
        externalId: element.stateBinding.externalId, connectionId: house!.id }];
    })));
  }

  private combinedMappingFingerprint(mappings: HomeAssistantEntityMapping[], openings = this.configuredOpeningTargets()): string {
    return `${mappingFingerprint(mappings)}|${JSON.stringify(openings.slice().sort((left, right) => left.externalId.localeCompare(right.externalId)))}`;
  }

  private registerMapping(mapping: HomeAssistantEntityMapping): void {
    const sensorId = mapping.sensorId.trim();
    if (mapping.temperature) this.registerEntity(mapping.temperature, { sensorId, metric: "temperature", legacy: true });
    if (mapping.humidity) this.registerEntity(mapping.humidity, { sensorId, metric: "humidity", legacy: true });
    if (mapping.battery) this.registerEntity(mapping.battery, { sensorId, metric: "battery", legacy: true });
    for (const [metric, configured] of Object.entries(mapping.measurements ?? {})) {
      const simple = typeof configured === "string";
      const binding = simple ? { entityId: configured } : configured;
      this.registerEntity(binding.entityId, {
        sensorId,
        metric,
        ...(binding.unit !== undefined ? { expectedUnit: binding.unit.trim() } : {}),
        ...(binding.scale !== undefined ? { scale: binding.scale } : {}),
        ...(binding.offset !== undefined ? { offset: binding.offset } : {}),
        ...(simple && AUTOMATIC_ELECTRICITY_METRICS.has(metric)
          ? { automaticElectricityUnitConversion: true }
          : {}),
        legacy: false,
      });
    }
  }

  private registerEntity(entityId: string, target: EntityTarget): void {
    const normalized = entityId.trim();
    if (this.#entities.has(normalized)) throw new Error(`Home Assistant entity ${normalized} is mapped more than once`);
    this.#entities.set(normalized, target);
    this.#entityAvailability.set(normalized, false);
  }

  private registerOpening(target: OpeningTarget): void {
    const normalized = target.externalId.trim();
    if (this.#openings.has(normalized)) throw new Error(`Home Assistant opening entity ${normalized} is mapped more than once`);
    this.#openings.set(normalized, { ...target, externalId: normalized });
  }

  stop(): void {
    this.#running = false;
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = null;
    this.clearConnectionTimers();
    this.#snapshotPending = false;
    this.#bufferedEvents.length = 0;
    this.#socket?.close();
    this.#socket = null;
    this.status.value.homeAssistant.connected = false;
  }

  restart(): void {
    this.stop();
    this.#attempt = 0;
    this.#entities.clear();
    this.#openings.clear();
    this.#openingStateCache.clear();
    this.#lastOpeningHeartbeatAt = 0;
    this.#cache.clear();
    this.#entityAvailability.clear();
    this.#mappingWarning = null;
    this.status.value.homeAssistant.mappedEntities = 0;
    this.status.value.homeAssistant.error = null;
    this.start();
  }

  refreshMappings(): void {
    if (!this.#running) return;
    try {
      const mappings = this.configuredMappings();
      if (this.combinedMappingFingerprint(mappings) === this.#mappingFingerprint) return;
    } catch {
      // restart() preserves the existing status/error behavior for an invalid
      // file or persisted binding while keeping route mutations successful.
    }
    this.restart();
  }

  private connect(): void {
    if (!this.#running || !this.config.haUrl || !this.config.haToken) return;
    const socket = new WebSocket(websocketUrl(this.config.haUrl));
    this.#socket = socket;
    this.#lastMessageAt = Date.now();
    this.#handshakeTimer = setTimeout(() => {
      if (this.#socket !== socket || this.status.value.homeAssistant.connected) return;
      this.status.value.homeAssistant.error = "Home Assistant WebSocket handshake timed out";
      this.status.changed();
      socket.close();
    }, HA_HANDSHAKE_TIMEOUT_MS);
    this.#handshakeTimer.unref();
    socket.on("message", (data) => {
      if (this.#socket === socket) {
        this.#lastMessageAt = Date.now();
        this.onMessage(data.toString());
      }
    });
    socket.on("pong", () => { if (this.#socket === socket) this.#lastMessageAt = Date.now(); });
    socket.on("error", () => {
      if (this.#socket !== socket) return;
      this.status.value.homeAssistant.error = "Home Assistant WebSocket connection failed";
      this.status.changed();
      socket.terminate();
    });
    socket.on("close", () => {
      if (this.#socket !== socket) return;
      this.clearConnectionTimers();
      this.#socket = null;
      this.#snapshotPending = false;
      this.#bufferedEvents.length = 0;
      this.status.value.homeAssistant.connected = false;
      this.status.changed();
      this.options.onAvailabilityChange?.();
      this.scheduleReconnect();
    });
  }

  private onMessage(raw: string): void {
    const message = parseHaMessage(raw);
    if (!message) return;
    switch (message.type) {
      case "auth_required":
        this.#socket?.send(JSON.stringify({ type: "auth", access_token: this.config.haToken }));
        break;
      case "auth_ok":
        this.handleAuthenticated();
        break;
      case "auth_invalid":
        this.status.value.homeAssistant.error = "Home Assistant rejected the access token";
        this.status.changed();
        this.#socket?.close();
        break;
      case "result":
        this.handleResult(message);
        break;
      case "event":
        this.handleEvent(message);
        break;
    }
  }

  private handleAuthenticated(): void {
    // Subscribe before taking the snapshot. Events received while get_states is
    // in flight are buffered and replayed after it, closing the snapshot gap.
    this.#socket?.send(JSON.stringify({ id: 2, type: "subscribe_events", event_type: "state_changed" }));
  }

  private handleResult(message: HaMessage): void {
    if (message.id === 1) {
      if (!message.success || !Array.isArray(message.result)) {
        this.abortPendingSnapshot("Home Assistant initial state request failed");
        return;
      }
      if (!this.#snapshotPending) return;
      if (this.#snapshotTimer) clearTimeout(this.#snapshotTimer);
      this.#snapshotTimer = null;
      this.#snapshotPending = false;
      this.#attempt = 0;
      this.status.value.homeAssistant.connected = true;
      this.status.value.homeAssistant.error = this.#mappingWarning;
      this.status.changed();
      this.ingestInitialStates(message.result);
      const buffered = this.#bufferedEvents.splice(0).sort((left, right) => (
        Date.parse(left.state.last_updated ?? left.fallbackTimestamp ?? "")
        - Date.parse(right.state.last_updated ?? right.fallbackTimestamp ?? "")
      ));
      for (const event of buffered) this.ingestEventState(event.state, event.fallbackTimestamp);
      this.startLivenessWatchdog();
      return;
    }
    if (message.id === 2) {
      if (!message.success) {
        this.status.value.homeAssistant.connected = false;
        this.status.value.homeAssistant.error = "Home Assistant rejected the state_changed subscription";
        this.status.changed();
        this.#socket?.close();
        return;
      }
      this.#snapshotPending = true;
      this.#bufferedEvents.length = 0;
      if (this.#handshakeTimer) clearTimeout(this.#handshakeTimer);
      this.#handshakeTimer = null;
      const socket = this.#socket;
      this.#snapshotTimer = setTimeout(() => {
        if (this.#socket === socket && this.#snapshotPending) {
          this.abortPendingSnapshot("Home Assistant initial state request timed out");
        }
      }, HA_SNAPSHOT_TIMEOUT_MS);
      this.#snapshotTimer.unref();
      this.#socket?.send(JSON.stringify({ id: 1, type: "get_states" }));
    }
  }

  private ingestInitialStates(states: HaState[]): void {
    const climateUpdates = new Map<string, string>();
    const observedAt = new Date().toISOString();
    let availabilityChanged = false;
    for (const entityId of this.#entities.keys()) {
      if (this.#entityAvailability.get(entityId) !== false) availabilityChanged = true;
      this.#entityAvailability.set(entityId, false);
    }
    for (const state of states) {
      availabilityChanged = this.updateEntityAvailability(state) || availabilityChanged;
      this.ingestOpeningState(state, undefined, observedAt);
      const updated = this.applyState(state);
      if (!updated || updated.metric === "battery") continue;
      this.ingestMeasurementUpdate(updated);
      if (updated.metric === "temperature" || updated.metric === "humidity") {
        const previous = climateUpdates.get(updated.sensorId);
        if (!previous || Date.parse(updated.timestamp) > Date.parse(previous)) {
          climateUpdates.set(updated.sensorId, updated.timestamp);
        }
      }
    }
    this.#lastOpeningHeartbeatAt = Date.now();
    for (const [sensorId, timestamp] of climateUpdates) this.ingestCachedClimate(sensorId, timestamp);
    if (availabilityChanged) this.options.onAvailabilityChange?.();
  }

  private handleEvent(message: HaMessage): void {
    if (message.event?.event_type !== "state_changed") return;
    const entityId = message.event.data?.entity_id;
    const newState = message.event.data?.new_state;
    if (!entityId || !newState || (!this.#entities.has(entityId) && !this.#openings.has(entityId))) return;
    const state = { ...newState, entity_id: entityId };
    if (this.#snapshotPending) {
      if (this.#bufferedEvents.length >= HA_SNAPSHOT_EVENT_BUFFER_LIMIT) {
        this.abortPendingSnapshot("Home Assistant initial state event buffer limit exceeded");
        return;
      }
      this.#bufferedEvents.push({ state, ...(message.event.time_fired ? { fallbackTimestamp: message.event.time_fired } : {}) });
      return;
    }
    this.ingestEventState(state, message.event.time_fired);
  }

  private ingestEventState(state: HaState, fallbackTimestamp?: string): void {
    if (this.updateEntityAvailability(state)) this.options.onAvailabilityChange?.();
    const openingTimestamp = this.ingestOpeningState(state, fallbackTimestamp);
    const updated = this.applyState(state, fallbackTimestamp);
    if (!updated && !openingTimestamp) return;
    this.status.value.homeAssistant.lastEventAt = updated?.timestamp ?? openingTimestamp;
    if (!updated) {
      this.status.changed();
      return;
    }
    if (updated.metric === "battery") {
      this.status.changed();
      return;
    }
    this.ingestMeasurementUpdate(updated);
    if (updated.metric === "temperature" || updated.metric === "humidity") this.ingestCachedClimate(updated.sensorId, updated.timestamp);
  }

  private updateEntityAvailability(state: HaState): boolean {
    if (!state.entity_id || !this.#entities.has(state.entity_id)) return false;
    const available = this.normalizeHistoryValue(this.#entities.get(state.entity_id)!, state) !== null;
    const previous = this.#entityAvailability.get(state.entity_id) ?? false;
    this.#entityAvailability.set(state.entity_id, available);
    return previous !== available;
  }

  private ingestOpeningState(state: HaState, fallbackTimestamp?: string, observedAtOverride?: string): string | null {
    if (!state.entity_id) return null;
    const target = this.#openings.get(state.entity_id);
    if (!target) return null;
    const normalized = state.state?.trim().toLowerCase();
    const openingState = normalized === "on" || normalized === "open"
      ? "open"
      : normalized === "off" || normalized === "closed"
        ? "closed"
        : normalized === "unknown" || normalized === "unavailable"
          ? "unknown"
          : null;
    if (!openingState) return null;
    const timestamp = observedAtOverride ?? normalizeHomeAssistantTimestamp(state.last_updated, fallbackTimestamp);
    this.#openingStateCache.set(target.externalId, { target, state: openingState });
    return this.recordOpeningState(target, openingState, timestamp);
  }

  private recordOpeningState(target: OpeningTarget, state: OpeningState, timestamp: string): string | null {
    try {
      this.database.recordOpeningStateObservation(target.houseId, {
        floorId: target.floorId,
        elementId: target.elementId,
        state,
        source: "home-assistant",
        observedAt: timestamp,
        externalId: target.externalId,
        connectionId: target.connectionId,
      });
      return timestamp;
    } catch (error) {
      this.status.value.homeAssistant.error = error instanceof Error ? error.message : `Could not ingest opening state for ${target.externalId}`;
      this.status.changed();
      return null;
    }
  }

  private refreshOpeningStateHeartbeats(now = Date.now()): void {
    if (now - this.#lastOpeningHeartbeatAt < HA_OPENING_HEARTBEAT_MS) return;
    this.#lastOpeningHeartbeatAt = now;
    const observedAt = new Date(now).toISOString();
    for (const { target, state } of this.#openingStateCache.values()) {
      this.recordOpeningState(target, state, observedAt);
    }
  }

  private applyState(state: HaState, fallbackTimestamp?: string): (EntityTarget & { timestamp: string; value: number }) | null {
    if (!state.entity_id) return null;
    const target = this.#entities.get(state.entity_id);
    if (!target) return null;
    if (!this.database.getSensor(target.sensorId)?.enabled) return null;
    const rawValue = Number(state.state);
    if (!Number.isFinite(rawValue)) return null;
    const haUnit = state.attributes?.unit_of_measurement?.trim();
    let value: number | null;
    if (target.metric === "temperature") {
      value = normalizeHomeAssistantTemperature(rawValue, haUnit);
    } else if (target.legacy || target.metric === "battery") {
      value = rawValue;
    } else if (target.automaticElectricityUnitConversion) {
      value = normalizeHomeAssistantElectricityMeasurement(target.metric, rawValue, haUnit);
      if (value === null) {
        this.status.value.homeAssistant.error = `Unsupported unit ${haUnit ?? "(missing)"} for ${target.metric} entity ${state.entity_id}`;
        this.status.changed();
        return null;
      }
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
      const previous = cached[target.metric];
      if (previous && Date.parse(timestamp) < Date.parse(previous.timestamp)) return null;
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
      this.status.value.homeAssistant.error = this.#mappingWarning;
      this.status.changed();
    } catch (error) {
      this.status.value.homeAssistant.error = error instanceof Error ? error.message : `Could not ingest ${update.metric}`;
      this.status.changed();
    }
  }

  private ingestCachedClimate(sensorId: string, timestamp: string): void {
    const cached = this.#cache.get(sensorId);
    if (!cached?.temperature || !cached.humidity) return;
    const temperatureMs = Date.parse(cached.temperature.timestamp);
    const humidityMs = Date.parse(cached.humidity.timestamp);
    if (![temperatureMs, humidityMs].every(Number.isFinite)
      || Math.abs(temperatureMs - humidityMs) > HA_COMPOSITE_MAX_SKEW_MS) return;
    const readingMs = Math.max(temperatureMs, humidityMs, Date.parse(timestamp));
    const battery = cached.battery && Math.abs(Date.parse(cached.battery.timestamp) - readingMs) <= HA_COMPOSITE_MAX_SKEW_MS
      ? cached.battery.value
      : null;
    const reading: Reading = {
      sensorId,
      timestamp: new Date(readingMs).toISOString(),
      temperature: cached.temperature.value,
      humidity: cached.humidity.value,
      battery,
      source: "home-assistant",
      quality: temperatureMs === humidityMs ? "good" : "estimated",
    };
    try {
      this.telemetry.ingestLegacyProjection(reading);
      this.status.value.homeAssistant.lastEventAt = reading.timestamp;
      this.status.value.homeAssistant.error = this.#mappingWarning;
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

  private clearConnectionTimers(): void {
    if (this.#handshakeTimer) clearTimeout(this.#handshakeTimer);
    if (this.#snapshotTimer) clearTimeout(this.#snapshotTimer);
    if (this.#livenessTimer) clearInterval(this.#livenessTimer);
    this.#handshakeTimer = null;
    this.#snapshotTimer = null;
    this.#livenessTimer = null;
  }

  private abortPendingSnapshot(error: string): void {
    if (!this.#snapshotPending) return;
    if (this.#snapshotTimer) clearTimeout(this.#snapshotTimer);
    this.#snapshotTimer = null;
    this.#snapshotPending = false;
    this.#bufferedEvents.length = 0;
    this.status.value.homeAssistant.connected = false;
    this.status.value.homeAssistant.error = error;
    this.status.changed();
    this.#socket?.terminate();
  }

  private startLivenessWatchdog(): void {
    if (this.#livenessTimer) clearInterval(this.#livenessTimer);
    this.#livenessTimer = setInterval(() => {
      const dataVersion = this.databaseDataVersion();
      if (dataVersion !== this.#databaseDataVersion) {
        this.#databaseDataVersion = dataVersion;
        this.refreshMappings();
        return;
      }
      const socket = this.#socket;
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      if (Date.now() - this.#lastMessageAt > HA_LIVENESS_TIMEOUT_MS) {
        this.status.value.homeAssistant.connected = false;
        this.status.value.homeAssistant.error = "Home Assistant connection became unresponsive";
        this.status.changed();
        socket.terminate();
        return;
      }
      try {
        socket.ping();
        this.refreshOpeningStateHeartbeats();
      } catch {
        socket.terminate();
      }
    }, HA_LIVENESS_INTERVAL_MS);
    this.#livenessTimer.unref();
  }

  private databaseDataVersion(): number {
    try {
      return Number((this.database.db.prepare("PRAGMA data_version").get() as { data_version?: number }).data_version ?? 0);
    } catch {
      return this.#databaseDataVersion;
    }
  }
}

/** Maintains one independent Home Assistant WebSocket session per house. */
export class HomeAssistantBridge implements SensorGapRecoveryAdapter {
  readonly source = "home-assistant" as const;
  readonly #workers = new Map<string, { bridge: HomeAssistantConnectionBridge; status: HomeAssistantStatusHost }>();
  #running = false;

  constructor(
    private readonly config: AppConfig,
    private readonly telemetry: TelemetryService,
    private readonly measurements: MeasurementService,
    private readonly database: ClimateDatabase,
    private readonly status: RuntimeStatus,
    private readonly options: HomeAssistantBridgeOptions = {},
  ) {}

  private configuredConnections(): Array<{ houseId: string; url: string; token: string }> {
    const explicit = (this.config.homeAssistantConnections ?? [])
      .filter((connection) => this.database.getHouse(connection.houseId));
    if (explicit.length > 0) return explicit.map((connection) => ({ ...connection }));
    const houseId = this.database.listHouses()[0]?.id;
    return !this.config.homeAssistantLegacyDisabled && houseId && this.config.haUrl && this.config.haToken
      ? [{ houseId, url: this.config.haUrl, token: this.config.haToken }]
      : [];
  }

  start(): void {
    if (this.#running) return;
    const mappingPath = this.config.haEntityMapFile;
    if (mappingPath && existsSync(mappingPath)) {
      let mappings: HomeAssistantEntityMapping[] | undefined;
      try {
        mappings = loadEntityMappings(mappingPath);
      } catch {
        // A legacy worker, when present, reports the invalid file and remains
        // fail-closed. Never replace the last-good SQLite revision here.
      }
      // Persistence failures are operational failures, not source-validation
      // failures: do not claim a healthy manager while the valid map is file-only.
      if (mappings) this.database.saveIntegrationMappingSet("home-assistant", mappings);
    }
    this.#running = true;
    for (const connection of this.configuredConnections()) {
      const localValue = structuredClone(this.status.value);
      localValue.homeAssistant = {
        configured: true,
        connected: false,
        lastEventAt: null,
        mappedEntities: 0,
        error: null,
        connections: [],
      };
      const localStatus: HomeAssistantStatusHost = { value: localValue, changed: () => this.aggregateStatus() };
      const localConfig: AppConfig = {
        ...this.config,
        haUrl: connection.url,
        haToken: connection.token,
        homeAssistantConnections: [],
        // The legacy file cannot safely describe more than one house.
        haEntityMapFile: this.config.homeAssistantConnections?.length ? null : this.config.haEntityMapFile,
      };
      const bridge = new HomeAssistantConnectionBridge(
        localConfig,
        this.telemetry,
        this.measurements,
        this.database,
        localStatus,
        (this.config.homeAssistantConnections?.length ?? 0) > 0 ? connection.houseId : undefined,
        this.options,
      );
      this.#workers.set(connection.houseId, { bridge, status: localStatus });
      bridge.start();
    }
    this.aggregateStatus();
  }

  stop(): void {
    this.#running = false;
    for (const worker of this.#workers.values()) worker.bridge.stop();
    this.#workers.clear();
    this.aggregateStatus();
  }

  restart(): void {
    this.stop();
    this.start();
  }

  refreshMappings(): void {
    for (const worker of this.#workers.values()) worker.bridge.refreshMappings();
  }

  availability(now = new Date()): SensorMetricAvailability[] {
    return [...this.#workers.values()].flatMap((worker) => worker.bridge.availability(now));
  }

  recoverHistory(sensorId: string, metric: string, from: string, to: string): Promise<SensorHistoryRecoveryResult> {
    const houseId = this.database.getSensor(sensorId)?.houseId;
    const worker = houseId ? this.#workers.get(houseId) : undefined;
    if (!worker) {
      return Promise.resolve({ state: "not-supported", samples: [], error: "No Home Assistant connection owns this sensor" });
    }
    return worker.bridge.recoverHistory(sensorId, metric, from, to);
  }

  private aggregateStatus(): void {
    const connections = [...this.#workers.entries()].map(([houseId, worker]) => ({
      houseId,
      configured: true,
      connected: worker.status.value.homeAssistant.connected,
      lastEventAt: worker.status.value.homeAssistant.lastEventAt,
      mappedEntities: worker.status.value.homeAssistant.mappedEntities,
      error: worker.status.value.homeAssistant.error,
    }));
    const aggregate = this.status.value.homeAssistant;
    aggregate.connections = connections;
    aggregate.configured = connections.length > 0 || this.configuredConnections().length > 0;
    aggregate.connected = connections.some((connection) => connection.connected);
    aggregate.lastEventAt = connections.map((connection) => connection.lastEventAt)
      .filter((value): value is string => Boolean(value)).sort().at(-1) ?? null;
    aggregate.mappedEntities = connections.reduce((total, connection) => total + connection.mappedEntities, 0);
    aggregate.error = connections.length > 0 && connections.every((connection) => connection.error)
      ? connections.map((connection) => connection.error).filter(Boolean).join("; ")
      : null;
    this.status.changed();
  }
}
