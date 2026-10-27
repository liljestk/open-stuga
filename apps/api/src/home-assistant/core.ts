import { hasLocalHouseAuthority, type MeasurementSample, type OpeningState, type Reading, type Sensor } from "@climate-twin/contracts";
import { existsSync } from "node:fs";
import WebSocket from "ws";
import type { AppConfig } from "../config.js";
import type { ClimateDatabase } from "../db.js";
import type { SensorHistoryRecoveryResult, SensorMetricAvailability } from "../sensor-gap-recovery.js";
import type { MeasurementService, TelemetryService } from "../services.js";
import { compareCodeUnits } from "../text-order.js";
import { assertHomeAssistantHistoryChunkLimit, boundedHomeAssistantHistoryJson, storeBoundedHomeAssistantHistorySample } from "./history-limits.js";
import { AUTOMATIC_ELECTRICITY_METRICS, CachedSensorState, EntityTarget, HA_COMPOSITE_MAX_SKEW_MS, HA_HANDSHAKE_TIMEOUT_MS, HA_HISTORY_CHUNK_MS, HA_LIVENESS_INTERVAL_MS, HA_LIVENESS_TIMEOUT_MS, HA_OPENING_HEARTBEAT_MS, HA_SNAPSHOT_EVENT_BUFFER_LIMIT, HA_SNAPSHOT_TIMEOUT_MS, HaMessage, HaState, HomeAssistantBridgeOptions, HomeAssistantEntityMapping, HomeAssistantStatusHost, normalizeHomeAssistantElectricityMeasurement, normalizeHomeAssistantTemperature, normalizeHomeAssistantTimestamp, OpeningTarget, parseHaMessage, websocketUrl } from "./support/01-home-assistant-measurement-binding-to-validate-entit.js";
import { importEntityMappingFile, mappedEntityIds, mappingFingerprint, mappingMetricKeys, sensorMetricKey, validateEntityMappings } from "./support/02-validate-entity-mappings-to-home-assistant-bridge.js";

interface HistoryWindow {
  sensorId: string;
  metric: string;
  entityId: string;
  target: EntityTarget;
  startMs: number;
  endMs: number;
}

interface EntityClaims {
  metrics: Set<string>;
  entities: Set<string>;
}

function persistedSensorMapping(sensor: Sensor, claims: EntityClaims): HomeAssistantEntityMapping {
  const persisted: Record<string, string> = sensor.measurementEntityIds ?? {};
  const mapping: HomeAssistantEntityMapping = { sensorId: sensor.id };
  const unclaimed = (metric: string, entityId: string) => !claims.metrics.has(sensorMetricKey(sensor.id, metric))
    && !claims.entities.has(entityId.trim());
  const temperature = persisted.temperature ?? sensor.temperatureEntityId;
  const humidity = persisted.humidity ?? sensor.humidityEntityId;
  const battery = persisted.battery ?? sensor.batteryEntityId;
  if (temperature && unclaimed("temperature", temperature)) mapping.temperature = temperature;
  if (humidity && unclaimed("humidity", humidity)) mapping.humidity = humidity;
  if (battery && unclaimed("battery", battery)) mapping.battery = battery;
  for (const [metric, entityId] of Object.entries(persisted)) {
    // Legacy climate/battery fields above preserve flexible temperature
    // conversion and avoid registering normalized bindings twice.
    if (["temperature", "humidity", "battery"].includes(metric) || !unclaimed(metric, entityId)) continue;
    mapping.measurements ??= {};
    mapping.measurements[metric] = entityId;
  }
  return mapping;
}

type NormalizedLiveValue = { value: number } | { error: string };

/** Entity mappings to register, and the warning to show for mapped sensors that cannot ingest. */
interface ConfiguredEntityMappings {
  mappings: HomeAssistantEntityMapping[];
  warning: string | null;
}

export class HomeAssistantConnectionBridgeCore {
  #socket: WebSocket | null = null;
  #reconnectTimer: NodeJS.Timeout | null = null;
  #handshakeTimer: NodeJS.Timeout | null = null;
  #snapshotTimer: NodeJS.Timeout | null = null;
  #livenessTimer: NodeJS.Timeout | null = null;
  #running: boolean = false;
  #attempt: number = 0;
  #lastMessageAt: number = 0;
  #databaseDataVersion: number = 0;
  #snapshotPending: boolean = false;
  readonly #bufferedEvents: Array<{ state: HaState; fallbackTimestamp?: string }> = [];
  #mappingFingerprint: string | null = null;
  #mappingWarning: string | null = null;
  readonly #entities: Map<string, EntityTarget> = new Map<string, EntityTarget>();
  readonly #openings: Map<string, OpeningTarget> = new Map<string, OpeningTarget>();
  readonly #openingStateCache: Map<string, { target: OpeningTarget; state: OpeningState }> = new Map<string, { target: OpeningTarget; state: OpeningState }>();
  readonly #cache: Map<string, CachedSensorState> = new Map<string, CachedSensorState>();
  readonly #entityAvailability: Map<string, boolean> = new Map<string, boolean>();
  #lastOpeningHeartbeatAt: number = 0;
  readonly #config: AppConfig;
  readonly #telemetry: TelemetryService;
  readonly #measurements: MeasurementService;
  readonly #database: ClimateDatabase;
  readonly #status: HomeAssistantStatusHost;
  readonly #houseId: string | undefined;
  readonly #options: HomeAssistantBridgeOptions;

  constructor(
    config: AppConfig,
    telemetry: TelemetryService,
    measurements: MeasurementService,
    database: ClimateDatabase,
    status: HomeAssistantStatusHost,
    houseId?: string,
    options: HomeAssistantBridgeOptions = {},
  ) {
    this.#config = config;
    this.#telemetry = telemetry;
    this.#measurements = measurements;
    this.#database = database;
    this.#status = status;
    this.#houseId = houseId;
    this.#options = options;
  }

  // Returns the recorder history groups for one chunk, or null when the recorder is unavailable.
  private async fetchHistoryChunk(entityId: string, cursor: number, chunkEnd: number): Promise<unknown[] | null> {
    const endpoint = new URL(this.#config.haUrl as string);
    endpoint.pathname = `${endpoint.pathname.replace(/\/$/, "")}/api/history/period/${encodeURIComponent(new Date(cursor).toISOString())}`;
    endpoint.search = new URLSearchParams({
      end_time: new Date(chunkEnd).toISOString(),
      filter_entity_id: entityId,
    }).toString();
    endpoint.hash = "";
    const response = await (this.#options.fetcher ?? fetch)(endpoint, {
      headers: { authorization: `Bearer ${this.#config.haToken}`, accept: "application/json" },
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Home Assistant history request failed with status ${response.status}`);
    const body = await boundedHomeAssistantHistoryJson(response);
    if (!Array.isArray(body)) throw new Error("Home Assistant history returned an invalid response");
    return body;
  }

  private historySample(window: HistoryWindow, candidate: unknown): MeasurementSample | null {
    if (!candidate || typeof candidate !== "object") return null;
    const state = { ...(candidate as HaState), entity_id: window.entityId };
    const value = this.normalizeHistoryValue(window.target, state);
    const sourceTimestamp = [state.last_updated, state.last_changed]
      .find((timestamp) => timestamp && Number.isFinite(Date.parse(timestamp)));
    if (!sourceTimestamp) return null;
    const timestamp = new Date(sourceTimestamp).toISOString();
    if (value === null || Date.parse(timestamp) < window.startMs || Date.parse(timestamp) > window.endMs) return null;
    const definition = this.#database.getMeasurementDefinition(window.metric);
    if (!definition?.enabled) return null;
    return {
      sensorId: window.sensorId,
      metric: window.metric,
      value,
      canonicalUnit: definition.unit,
      timestamp,
      source: "home-assistant",
      quality: "good",
    };
  }

  private collectHistorySamples(window: HistoryWindow, body: unknown[], samples: Map<string, MeasurementSample>): void {
    for (const group of body) {
      if (!Array.isArray(group)) continue;
      for (const candidate of group) {
        const sample = this.historySample(window, candidate);
        if (sample) storeBoundedHomeAssistantHistorySample(samples, sample);
      }
    }
  }

  private legacyEntityMappings(scopedHouseId: string | undefined): ConfiguredEntityMappings {
    const path = this.#config.haEntityMapFile;
    let fileMappings: HomeAssistantEntityMapping[];
    if (path && existsSync(path)) {
      fileMappings = importEntityMappingFile(this.#database, path);
    } else {
      const stored = this.#database.getIntegrationMappingSet<unknown>("home-assistant");
      fileMappings = stored ? validateEntityMappings(stored.mappings) : [];
    }
    fileMappings = fileMappings.filter((mapping) => {
      const sensor = this.#database.getSensor(mapping.sensorId);
      const house = sensor
        ? this.#database.getHouse(sensor.houseId)
        : null;
      return Boolean(
        sensor
        && (!scopedHouseId || sensor.houseId === scopedHouseId)
        && house
        && hasLocalHouseAuthority(house),
      );
    });
    const unavailableSensorIds = [...new Set(fileMappings
      .filter((mapping) => !this.#database.getSensor(mapping.sensorId)?.enabled)
      .map((mapping) => mapping.sensorId))].sort(compareCodeUnits);
    const warning = unavailableSensorIds.length > 0
      ? `Ignored Home Assistant mappings for unknown or disabled sensors: ${unavailableSensorIds.join(", ")}`
      : null;
    // Existing disabled sensors keep their entity/metric ownership in the caller,
    // but only enabled sensors are registered for ingestion.
    return { mappings: fileMappings, warning };
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#databaseDataVersion = this.databaseDataVersion();
    if (!this.#status.value.homeAssistant.configured) return;
    try {
      const { mappings, warning } = this.configuredMappings();
      this.#mappingWarning = warning;
      const openingTargets = this.configuredOpeningTargets();
      this.#mappingFingerprint = this.combinedMappingFingerprint(mappings, openingTargets);
      for (const mapping of mappings) this.registerMapping(mapping);
      for (const target of openingTargets) this.registerOpening(target);
      this.#status.value.homeAssistant.mappedEntities = new Set([...this.#entities.keys(), ...this.#openings.keys()]).size;
      this.#status.value.homeAssistant.error = this.#mappingWarning;
      this.#status.changed();
      this.connect();
    } catch (error) {
      this.#status.value.homeAssistant.error = error instanceof Error ? error.message : "Could not load entity mappings";
      this.#status.changed();
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
        available: this.#status.value.homeAssistant.connected && this.#entityAvailability.get(entityId) === true,
        observedAt,
      }));
  }

  async recoverHistory(sensorId: string, metric: string, from: string, to: string): Promise<SensorHistoryRecoveryResult> {
    const binding = [...this.#entities.entries()].find(([, target]) => target.sensorId === sensorId && target.metric === metric);
    const sensor = this.#database.getSensor(sensorId);
    const house = sensor ? this.#database.getHouse(sensor.houseId) : null;
    if (!house || !hasLocalHouseAuthority(house)) {
      return { state: "not-supported", samples: [], error: "Home Assistant history recovery requires local Home authority" };
    }
    if (!binding || !this.#config.haUrl || !this.#config.haToken) {
      return { state: "not-supported", samples: [], error: "The sensor metric has no active Home Assistant history binding" };
    }
    const [entityId, target] = binding;
    const startMs = Date.parse(from);
    const endMs = Date.parse(to);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
      return { state: "complete", samples: [], error: null };
    }
    assertHomeAssistantHistoryChunkLimit(startMs, endMs);
    const window: HistoryWindow = { sensorId, metric, entityId, target, startMs, endMs };
    const samples = new Map<string, MeasurementSample>();
    for (let cursor = startMs; cursor < endMs; cursor += HA_HISTORY_CHUNK_MS) {
      const body = await this.fetchHistoryChunk(entityId, cursor, Math.min(endMs, cursor + HA_HISTORY_CHUNK_MS));
      if (!body) {
        return { state: "not-supported", samples: [], error: "Home Assistant recorder history is not available" };
      }
      this.collectHistorySamples(window, body, samples);
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
    const definition = this.#database.getMeasurementDefinition(target.metric);
    if (!definition) return null;
    const expectedUnit = target.expectedUnit ?? definition.unit;
    if (!haUnit || haUnit !== expectedUnit) return null;
    if (expectedUnit !== definition.unit && target.scale === undefined && target.offset === undefined) return null;
    return rawValue * (target.scale ?? 1) + (target.offset ?? 0);
  }

  private configuredMappings(): ConfiguredEntityMappings {
    const scopedHouseId = this.#houseId;
    // The compatibility map is workspace-global and must never leak into a
    // house-scoped UI connection. For the one legacy connection, an existing
    // file is an explicit bootstrap/update and SQLite is the durable fallback.
    const legacy = this.#houseId === undefined
      ? this.legacyEntityMappings(scopedHouseId)
      : { mappings: [], warning: null };
    const fileMappings = legacy.mappings;
    const claimMappings = fileMappings.filter((mapping) => this.#database.getSensor(mapping.sensorId));
    const activeFileMappings = fileMappings.filter((mapping) => this.#database.getSensor(mapping.sensorId)?.enabled);
    const claims: EntityClaims = {
      metrics: new Set(claimMappings.flatMap((mapping) => (
        mappingMetricKeys(mapping).map((metric) => sensorMetricKey(mapping.sensorId, metric))
      ))),
      entities: new Set(claimMappings.flatMap(mappedEntityIds).map((entityId) => entityId.trim())),
    };
    const persistedMappings: HomeAssistantEntityMapping[] = [];
    for (const sensor of this.#database.listSensors(scopedHouseId)) {
      const house = this.#database.getHouse(sensor.houseId);
      if (!house || !hasLocalHouseAuthority(house)) continue;
      if (!sensor.enabled) continue;
      const mapping = persistedSensorMapping(sensor, claims);
      if (mappedEntityIds(mapping).length > 0) persistedMappings.push(mapping);
    }
    return { mappings: [...activeFileMappings, ...persistedMappings], warning: legacy.warning };
  }

  private configuredOpeningTargets(): OpeningTarget[] {
    const houseId = this.#houseId
      ?? this.#database.listHouses().find(hasLocalHouseAuthority)?.id;
    const houses = houseId
      ? [this.#database.getHouse(houseId)]
          .filter((house) => Boolean(house && hasLocalHouseAuthority(house)))
      : [];
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
    this.#status.value.homeAssistant.connected = false;
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
    this.#status.value.homeAssistant.mappedEntities = 0;
    this.#status.value.homeAssistant.error = null;
    this.start();
  }

  refreshMappings(): void {
    if (!this.#running) return;
    try {
      const { mappings } = this.configuredMappings();
      if (this.combinedMappingFingerprint(mappings) === this.#mappingFingerprint) return;
    } catch {
      // restart() preserves the existing status/error behavior for an invalid
      // file or persisted binding while keeping route mutations successful.
    }
    this.restart();
  }

  private connect(): void {
    if (!this.#running || !this.#config.haUrl || !this.#config.haToken) return;
    const socket = new WebSocket(websocketUrl(this.#config.haUrl));
    this.#socket = socket;
    this.#lastMessageAt = Date.now();
    this.#handshakeTimer = setTimeout(() => {
      if (this.#socket !== socket || this.#status.value.homeAssistant.connected) return;
      this.#status.value.homeAssistant.error = "Home Assistant WebSocket handshake timed out";
      this.#status.changed();
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
      this.#status.value.homeAssistant.error = "Home Assistant WebSocket connection failed";
      this.#status.changed();
      socket.terminate();
    });
    socket.on("close", () => {
      if (this.#socket !== socket) return;
      this.clearConnectionTimers();
      this.#socket = null;
      this.#snapshotPending = false;
      this.#bufferedEvents.length = 0;
      this.#status.value.homeAssistant.connected = false;
      this.#status.changed();
      this.#options.onAvailabilityChange?.();
      this.scheduleReconnect();
    });
  }

  private onMessage(raw: string): void {
    const message = parseHaMessage(raw);
    if (!message) return;
    switch (message.type) {
      case "auth_required":
        this.#socket?.send(JSON.stringify({ type: "auth", access_token: this.#config.haToken }));
        break;
      case "auth_ok":
        this.handleAuthenticated();
        break;
      case "auth_invalid":
        this.#status.value.homeAssistant.error = "Home Assistant rejected the access token";
        this.#status.changed();
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

  private hasLocalSensorAuthority(sensorId: string): boolean {
    const sensor = this.#database.getSensor(sensorId);
    const house = sensor ? this.#database.getHouse(sensor.houseId) : null;
    return Boolean(sensor?.enabled && house && hasLocalHouseAuthority(house));
  }

  // Converts a live entity state to the canonical unit, or explains why it was rejected.
  private normalizedLiveValue(target: EntityTarget, entityId: string, rawValue: number, haUnit: string | undefined): NormalizedLiveValue {
    if (target.metric === "temperature") {
      const value = normalizeHomeAssistantTemperature(rawValue, haUnit);
      return value === null ? { error: `Unsupported temperature unit for entity ${entityId}` } : { value };
    }
    if (target.legacy || target.metric === "battery") return { value: rawValue };
    if (target.automaticElectricityUnitConversion) {
      const value = normalizeHomeAssistantElectricityMeasurement(target.metric, rawValue, haUnit);
      return value === null ? { error: `Unsupported unit ${haUnit ?? "(missing)"} for ${target.metric} entity ${entityId}` } : { value };
    }
    const definition = this.#database.getMeasurementDefinition(target.metric);
    if (!definition) return { error: `Unknown measurement metric ${target.metric} for entity ${entityId}` };
    const expectedUnit = target.expectedUnit ?? definition.unit;
    if (!haUnit || haUnit !== expectedUnit) return { error: `Unit for entity ${entityId} must be ${expectedUnit}` };
    if (expectedUnit !== definition.unit && target.scale === undefined && target.offset === undefined) {
      return { error: `Entity ${entityId} requires an explicit scale or offset to convert ${expectedUnit} to ${definition.unit}` };
    }
    return { value: rawValue * (target.scale ?? 1) + (target.offset ?? 0) };
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
      this.#status.value.homeAssistant.connected = true;
      this.#status.value.homeAssistant.error = this.#mappingWarning;
      this.#status.changed();
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
        this.#status.value.homeAssistant.connected = false;
        this.#status.value.homeAssistant.error = "Home Assistant rejected the state_changed subscription";
        this.#status.changed();
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
    if (availabilityChanged) this.#options.onAvailabilityChange?.();
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
    if (this.updateEntityAvailability(state)) this.#options.onAvailabilityChange?.();
    const openingTimestamp = this.ingestOpeningState(state, fallbackTimestamp);
    const updated = this.applyState(state, fallbackTimestamp);
    if (!updated && !openingTimestamp) return;
    this.#status.value.homeAssistant.lastEventAt = updated?.timestamp ?? openingTimestamp;
    if (!updated) {
      this.#status.changed();
      return;
    }
    if (updated.metric === "battery") {
      this.#status.changed();
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
    const house = this.#database.getHouse(target.houseId);
    if (!house || !hasLocalHouseAuthority(house)) return null;
    try {
      const observation = this.#database.recordOpeningStateObservation(target.houseId, {
        floorId: target.floorId,
        elementId: target.elementId,
        state,
        source: "home-assistant",
        observedAt: timestamp,
        externalId: target.externalId,
        connectionId: target.connectionId,
      });
      this.#options.onOpeningStateRecorded?.(observation);
      return timestamp;
    } catch (error) {
      this.#status.value.homeAssistant.error = error instanceof Error ? error.message : `Could not ingest opening state for ${target.externalId}`;
      this.#status.changed();
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
    if (!this.#database.getSensor(target.sensorId)?.enabled) return null;
    const rawValue = Number(state.state);
    if (!Number.isFinite(rawValue)) return null;
    const haUnit = state.attributes?.unit_of_measurement?.trim();
    const normalized = this.normalizedLiveValue(target, state.entity_id, rawValue, haUnit);
    if ("error" in normalized) {
      this.#status.value.homeAssistant.error = normalized.error;
      this.#status.changed();
      return null;
    }
    const value = normalized.value;
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
    if (!this.hasLocalSensorAuthority(update.sensorId)) return;
    const definition = this.#database.getMeasurementDefinition(update.metric);
    if (!definition) {
      this.#status.value.homeAssistant.error = `Unknown measurement metric ${update.metric}`;
      this.#status.changed();
      return;
    }
    const sample: MeasurementSample = {
      sensorId: update.sensorId,
      metric: update.metric,
      value: update.value,
      canonicalUnit: definition.unit,
      timestamp: update.timestamp,
      source: "home-assistant",
      // HA exposes a normalized entity state, not proof that the upstream
      // value is a direct calibrated observation. Keep generic entities
      // estimated until a future binding contract can validate provenance.
      quality: "estimated",
    };
    if (this.#options.shouldIngestLiveMeasurement?.(sample.sensorId, sample.metric) === false) {
      // Keep connection freshness accurate while the faster direct source owns
      // the canonical live stream. HA recorder history remains a recovery path.
      this.#status.value.homeAssistant.lastEventAt = sample.timestamp;
      this.#status.value.homeAssistant.error = this.#mappingWarning;
      this.#status.changed();
      return;
    }
    try {
      this.#measurements.ingest(sample);
      this.#status.value.homeAssistant.lastEventAt = sample.timestamp;
      this.#status.value.homeAssistant.error = this.#mappingWarning;
      this.#status.changed();
    } catch (error) {
      this.#status.value.homeAssistant.error = error instanceof Error ? error.message : `Could not ingest ${update.metric}`;
      this.#status.changed();
    }
  }

  private ingestCachedClimate(sensorId: string, timestamp: string): void {
    if (!this.hasLocalSensorAuthority(sensorId)) return;
    if (this.#options.shouldIngestLiveMeasurement?.(sensorId, "temperature") === false
      || this.#options.shouldIngestLiveMeasurement?.(sensorId, "humidity") === false) return;
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
      this.#telemetry.ingestLegacyProjection(reading);
      this.#status.value.homeAssistant.lastEventAt = reading.timestamp;
      this.#status.value.homeAssistant.error = this.#mappingWarning;
      this.#status.changed();
    } catch {
      this.#status.value.homeAssistant.error = `Mapped entity references unknown or disabled sensor ${sensorId}`;
      this.#status.changed();
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
    this.#status.value.homeAssistant.connected = false;
    this.#status.value.homeAssistant.error = error;
    this.#status.changed();
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
        this.#status.value.homeAssistant.connected = false;
        this.#status.value.homeAssistant.error = "Home Assistant connection became unresponsive";
        this.#status.changed();
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
      return Number((this.#database.db.prepare("PRAGMA data_version").get() as { data_version?: number }).data_version ?? 0);
    } catch {
      return this.#databaseDataVersion;
    }
  }
}
