import { existsSync } from "node:fs";
import WebSocket from "ws";
import { hasLocalHouseAuthority, type MeasurementSample, type Sensor } from "@climate-twin/contracts";
import type {
  SensorHistoryRecoveryResult,
  SensorMetricAvailability,
} from "../../sensor-gap-recovery.js";
import { AUTOMATIC_ELECTRICITY_METRICS, EntityTarget, HA_HANDSHAKE_TIMEOUT_MS, HA_HISTORY_CHUNK_MS, HaState, HomeAssistantEntityMapping, OpeningTarget, normalizeHomeAssistantElectricityMeasurement, normalizeHomeAssistantTemperature, websocketUrl } from "../support/01-home-assistant-measurement-binding-to-validate-entit.js";
import { importEntityMappingFile, mappedEntityIds, mappingFingerprint, mappingMetricKeys, parseHaMessage, sensorMetricKey, validateEntityMappings } from "../support/02-validate-entity-mappings-to-home-assistant-bridge.js";
import { registerHomeAssistantConnectionBridgeMethods, homeAssistantConnectionBridgeState, type HomeAssistantConnectionBridgeInternals } from "../core.js";
import { assertHomeAssistantHistoryChunkLimit, boundedHomeAssistantHistoryJson, storeBoundedHomeAssistantHistorySample } from "../history-limits.js";
import { compareCodeUnits } from "../../text-order.js";

interface HistoryWindow {
  sensorId: string;
  metric: string;
  entityId: string;
  target: EntityTarget;
  startMs: number;
  endMs: number;
}

// Returns the recorder history groups for one chunk, or null when the recorder is unavailable.
async function fetchHistoryChunk(
  bridge: HomeAssistantConnectionBridgeInternals,
  entityId: string,
  cursor: number,
  chunkEnd: number,
): Promise<unknown[] | null> {
  const state = bridge[homeAssistantConnectionBridgeState];
  const endpoint = new URL(state.config.haUrl as string);
  endpoint.pathname = `${endpoint.pathname.replace(/\/$/, "")}/api/history/period/${encodeURIComponent(new Date(cursor).toISOString())}`;
  endpoint.search = new URLSearchParams({
    end_time: new Date(chunkEnd).toISOString(),
    filter_entity_id: entityId,
  }).toString();
  endpoint.hash = "";
  const response = await (state.options.fetcher ?? fetch)(endpoint, {
    headers: { authorization: `Bearer ${state.config.haToken}`, accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Home Assistant history request failed with status ${response.status}`);
  const body = await boundedHomeAssistantHistoryJson(response);
  if (!Array.isArray(body)) throw new Error("Home Assistant history returned an invalid response");
  return body;
}

function historySample(
  bridge: HomeAssistantConnectionBridgeInternals,
  window: HistoryWindow,
  candidate: unknown,
): MeasurementSample | null {
  if (!candidate || typeof candidate !== "object") return null;
  const state = { ...(candidate as HaState), entity_id: window.entityId };
  const value = bridge.normalizeHistoryValue(window.target, state);
  const sourceTimestamp = [state.last_updated, state.last_changed]
    .find((timestamp) => timestamp && Number.isFinite(Date.parse(timestamp)));
  if (!sourceTimestamp) return null;
  const timestamp = new Date(sourceTimestamp).toISOString();
  if (value === null || Date.parse(timestamp) < window.startMs || Date.parse(timestamp) > window.endMs) return null;
  const definition = bridge[homeAssistantConnectionBridgeState].database.getMeasurementDefinition(window.metric);
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

function collectHistorySamples(
  bridge: HomeAssistantConnectionBridgeInternals,
  window: HistoryWindow,
  body: unknown[],
  samples: Map<string, MeasurementSample>,
): void {
  for (const group of body) {
    if (!Array.isArray(group)) continue;
    for (const candidate of group) {
      const sample = historySample(bridge, window, candidate);
      if (sample) storeBoundedHomeAssistantHistorySample(samples, sample);
    }
  }
}

// Sensor metrics and entity ids that the compatibility map already owns.
interface EntityClaims {
  metrics: Set<string>;
  entities: Set<string>;
}

function legacyEntityMappings(
  bridge: HomeAssistantConnectionBridgeInternals,
  scopedHouseId: string | undefined,
): HomeAssistantEntityMapping[] {
  const state = bridge[homeAssistantConnectionBridgeState];
  const path = state.config.haEntityMapFile;
  let fileMappings: HomeAssistantEntityMapping[];
  if (path && existsSync(path)) {
    fileMappings = importEntityMappingFile(state.database, path);
  } else {
    const stored = state.database.getIntegrationMappingSet<unknown>("home-assistant");
    fileMappings = stored ? validateEntityMappings(stored.mappings) : [];
  }
  fileMappings = fileMappings.filter((mapping) => {
    const sensor = state.database.getSensor(mapping.sensorId);
    const house = sensor
      ? state.database.getHouse(sensor.houseId)
      : null;
    return Boolean(
      sensor
      && (!scopedHouseId || sensor.houseId === scopedHouseId)
      && house
      && hasLocalHouseAuthority(house),
    );
  });
  const unavailableSensorIds = [...new Set(fileMappings
    .filter((mapping) => !state.database.getSensor(mapping.sensorId)?.enabled)
    .map((mapping) => mapping.sensorId))].sort(compareCodeUnits);
  state.mappingWarning = unavailableSensorIds.length > 0
    ? `Ignored Home Assistant mappings for unknown or disabled sensors: ${unavailableSensorIds.join(", ")}`
    : null;
  // Existing disabled sensors keep their entity/metric ownership in the caller,
  // but only enabled sensors are registered for ingestion.
  return fileMappings;
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

registerHomeAssistantConnectionBridgeMethods({
  start(this: HomeAssistantConnectionBridgeInternals): void {
      if (this[homeAssistantConnectionBridgeState].running) return;
      this[homeAssistantConnectionBridgeState].running = true;
      this[homeAssistantConnectionBridgeState].databaseDataVersion = this.databaseDataVersion();
      if (!this[homeAssistantConnectionBridgeState].status.value.homeAssistant.configured) return;
      try {
        const mappings = this.configuredMappings();
        const openingTargets = this.configuredOpeningTargets();
        this[homeAssistantConnectionBridgeState].mappingFingerprint = this.combinedMappingFingerprint(mappings, openingTargets);
        for (const mapping of mappings) this.registerMapping(mapping);
        for (const target of openingTargets) this.registerOpening(target);
        this[homeAssistantConnectionBridgeState].status.value.homeAssistant.mappedEntities = new Set([...this[homeAssistantConnectionBridgeState].entities.keys(), ...this[homeAssistantConnectionBridgeState].openings.keys()]).size;
        this[homeAssistantConnectionBridgeState].status.value.homeAssistant.error = this[homeAssistantConnectionBridgeState].mappingWarning;
        this[homeAssistantConnectionBridgeState].status.changed();
        this.connect();
      } catch (error) {
        this[homeAssistantConnectionBridgeState].status.value.homeAssistant.error = error instanceof Error ? error.message : "Could not load entity mappings";
        this[homeAssistantConnectionBridgeState].status.changed();
      }
    },
  availability(this: HomeAssistantConnectionBridgeInternals, now = new Date()): SensorMetricAvailability[] {
      const observedAt = now.toISOString();
      return [...this[homeAssistantConnectionBridgeState].entities.entries()]
        .filter(([, target]) => target.metric !== "battery")
        .map(([entityId, target]) => ({
          sensorId: target.sensorId,
          metric: target.metric,
          source: "home-assistant" as const,
          available: this[homeAssistantConnectionBridgeState].status.value.homeAssistant.connected && this[homeAssistantConnectionBridgeState].entityAvailability.get(entityId) === true,
          observedAt,
        }));
    },
  async recoverHistory(this: HomeAssistantConnectionBridgeInternals, sensorId: string, metric: string, from: string, to: string): Promise<SensorHistoryRecoveryResult> {
      const binding = [...this[homeAssistantConnectionBridgeState].entities.entries()].find(([, target]) => target.sensorId === sensorId && target.metric === metric);
      const sensor = this[homeAssistantConnectionBridgeState].database.getSensor(sensorId);
      const house = sensor ? this[homeAssistantConnectionBridgeState].database.getHouse(sensor.houseId) : null;
      if (!house || !hasLocalHouseAuthority(house)) {
        return { state: "not-supported", samples: [], error: "Home Assistant history recovery requires local Home authority" };
      }
      if (!binding || !this[homeAssistantConnectionBridgeState].config.haUrl || !this[homeAssistantConnectionBridgeState].config.haToken) {
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
        const body = await fetchHistoryChunk(this, entityId, cursor, Math.min(endMs, cursor + HA_HISTORY_CHUNK_MS));
        if (!body) {
          return { state: "not-supported", samples: [], error: "Home Assistant recorder history is not available" };
        }
        collectHistorySamples(this, window, body, samples);
      }
      return { state: "complete", samples: [...samples.values()].sort((left, right) => left.timestamp.localeCompare(right.timestamp)), error: null };
    },
  normalizeHistoryValue(this: HomeAssistantConnectionBridgeInternals, target: EntityTarget, state: HaState): number | null {
      const rawValue = Number(state.state);
      if (!Number.isFinite(rawValue)) return null;
      const haUnit = state.attributes?.unit_of_measurement?.trim();
      if (target.metric === "temperature") return normalizeHomeAssistantTemperature(rawValue, haUnit);
      if (target.legacy || target.metric === "battery") return rawValue;
      if (target.automaticElectricityUnitConversion) {
        return normalizeHomeAssistantElectricityMeasurement(target.metric, rawValue, haUnit);
      }
      const definition = this[homeAssistantConnectionBridgeState].database.getMeasurementDefinition(target.metric);
      if (!definition) return null;
      const expectedUnit = target.expectedUnit ?? definition.unit;
      if (!haUnit || haUnit !== expectedUnit) return null;
      if (expectedUnit !== definition.unit && target.scale === undefined && target.offset === undefined) return null;
      return rawValue * (target.scale ?? 1) + (target.offset ?? 0);
    },
  configuredMappings(this: HomeAssistantConnectionBridgeInternals): HomeAssistantEntityMapping[] {
      const scopedHouseId = this[homeAssistantConnectionBridgeState].houseId;
      // The compatibility map is workspace-global and must never leak into a
      // house-scoped UI connection. For the one legacy connection, an existing
      // file is an explicit bootstrap/update and SQLite is the durable fallback.
      const fileMappings = this[homeAssistantConnectionBridgeState].houseId === undefined
        ? legacyEntityMappings(this, scopedHouseId)
        : [];
      const claimMappings = fileMappings.filter((mapping) => this[homeAssistantConnectionBridgeState].database.getSensor(mapping.sensorId));
      const activeFileMappings = fileMappings.filter((mapping) => this[homeAssistantConnectionBridgeState].database.getSensor(mapping.sensorId)?.enabled);
      const claims: EntityClaims = {
        metrics: new Set(claimMappings.flatMap((mapping) => (
          mappingMetricKeys(mapping).map((metric) => sensorMetricKey(mapping.sensorId, metric))
        ))),
        entities: new Set(claimMappings.flatMap(mappedEntityIds).map((entityId) => entityId.trim())),
      };
      const persistedMappings: HomeAssistantEntityMapping[] = [];
      for (const sensor of this[homeAssistantConnectionBridgeState].database.listSensors(scopedHouseId)) {
        const house = this[homeAssistantConnectionBridgeState].database.getHouse(sensor.houseId);
        if (!house || !hasLocalHouseAuthority(house)) continue;
        if (!sensor.enabled) continue;
        const mapping = persistedSensorMapping(sensor, claims);
        if (mappedEntityIds(mapping).length > 0) persistedMappings.push(mapping);
      }
      return [...activeFileMappings, ...persistedMappings];
    },
  configuredOpeningTargets(this: HomeAssistantConnectionBridgeInternals): OpeningTarget[] {
      const houseId = this[homeAssistantConnectionBridgeState].houseId
        ?? this[homeAssistantConnectionBridgeState].database.listHouses().find(hasLocalHouseAuthority)?.id;
      const houses = houseId
        ? [this[homeAssistantConnectionBridgeState].database.getHouse(houseId)]
            .filter((house) => Boolean(house && hasLocalHouseAuthority(house)))
        : [];
      return houses.flatMap((house) => house!.floors.flatMap((floor) => (floor.planElements ?? []).flatMap((element) => {
        if ((element.kind !== "door" && element.kind !== "window" && element.kind !== "vent") || element.stateBinding?.provider !== "home-assistant") return [];
        if (element.stateBinding.connectionId && element.stateBinding.connectionId !== house!.id) return [];
        return [{ houseId: house!.id, floorId: floor.id, elementId: element.id,
          externalId: element.stateBinding.externalId, connectionId: house!.id }];
      })));
    },
  combinedMappingFingerprint(this: HomeAssistantConnectionBridgeInternals, mappings: HomeAssistantEntityMapping[], openings = this.configuredOpeningTargets()): string {
      return `${mappingFingerprint(mappings)}|${JSON.stringify(openings.slice().sort((left, right) => left.externalId.localeCompare(right.externalId)))}`;
    },
  registerMapping(this: HomeAssistantConnectionBridgeInternals, mapping: HomeAssistantEntityMapping): void {
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
    },
  registerEntity(this: HomeAssistantConnectionBridgeInternals, entityId: string, target: EntityTarget): void {
      const normalized = entityId.trim();
      if (this[homeAssistantConnectionBridgeState].entities.has(normalized)) throw new Error(`Home Assistant entity ${normalized} is mapped more than once`);
      this[homeAssistantConnectionBridgeState].entities.set(normalized, target);
      this[homeAssistantConnectionBridgeState].entityAvailability.set(normalized, false);
    },
  registerOpening(this: HomeAssistantConnectionBridgeInternals, target: OpeningTarget): void {
      const normalized = target.externalId.trim();
      if (this[homeAssistantConnectionBridgeState].openings.has(normalized)) throw new Error(`Home Assistant opening entity ${normalized} is mapped more than once`);
      this[homeAssistantConnectionBridgeState].openings.set(normalized, { ...target, externalId: normalized });
    },
  stop(this: HomeAssistantConnectionBridgeInternals): void {
      this[homeAssistantConnectionBridgeState].running = false;
      if (this[homeAssistantConnectionBridgeState].reconnectTimer) clearTimeout(this[homeAssistantConnectionBridgeState].reconnectTimer);
      this[homeAssistantConnectionBridgeState].reconnectTimer = null;
      this.clearConnectionTimers();
      this[homeAssistantConnectionBridgeState].snapshotPending = false;
      this[homeAssistantConnectionBridgeState].bufferedEvents.length = 0;
      this[homeAssistantConnectionBridgeState].socket?.close();
      this[homeAssistantConnectionBridgeState].socket = null;
      this[homeAssistantConnectionBridgeState].status.value.homeAssistant.connected = false;
    },
  restart(this: HomeAssistantConnectionBridgeInternals): void {
      this.stop();
      this[homeAssistantConnectionBridgeState].attempt = 0;
      this[homeAssistantConnectionBridgeState].entities.clear();
      this[homeAssistantConnectionBridgeState].openings.clear();
      this[homeAssistantConnectionBridgeState].openingStateCache.clear();
      this[homeAssistantConnectionBridgeState].lastOpeningHeartbeatAt = 0;
      this[homeAssistantConnectionBridgeState].cache.clear();
      this[homeAssistantConnectionBridgeState].entityAvailability.clear();
      this[homeAssistantConnectionBridgeState].mappingWarning = null;
      this[homeAssistantConnectionBridgeState].status.value.homeAssistant.mappedEntities = 0;
      this[homeAssistantConnectionBridgeState].status.value.homeAssistant.error = null;
      this.start();
    },
  refreshMappings(this: HomeAssistantConnectionBridgeInternals): void {
      if (!this[homeAssistantConnectionBridgeState].running) return;
      try {
        const mappings = this.configuredMappings();
        if (this.combinedMappingFingerprint(mappings) === this[homeAssistantConnectionBridgeState].mappingFingerprint) return;
      } catch {
        // restart() preserves the existing status/error behavior for an invalid
        // file or persisted binding while keeping route mutations successful.
      }
      this.restart();
    },
  connect(this: HomeAssistantConnectionBridgeInternals): void {
      if (!this[homeAssistantConnectionBridgeState].running || !this[homeAssistantConnectionBridgeState].config.haUrl || !this[homeAssistantConnectionBridgeState].config.haToken) return;
      const socket = new WebSocket(websocketUrl(this[homeAssistantConnectionBridgeState].config.haUrl));
      this[homeAssistantConnectionBridgeState].socket = socket;
      this[homeAssistantConnectionBridgeState].lastMessageAt = Date.now();
      this[homeAssistantConnectionBridgeState].handshakeTimer = setTimeout(() => {
        if (this[homeAssistantConnectionBridgeState].socket !== socket || this[homeAssistantConnectionBridgeState].status.value.homeAssistant.connected) return;
        this[homeAssistantConnectionBridgeState].status.value.homeAssistant.error = "Home Assistant WebSocket handshake timed out";
        this[homeAssistantConnectionBridgeState].status.changed();
        socket.close();
      }, HA_HANDSHAKE_TIMEOUT_MS);
      this[homeAssistantConnectionBridgeState].handshakeTimer.unref();
      socket.on("message", (data) => {
        if (this[homeAssistantConnectionBridgeState].socket === socket) {
          this[homeAssistantConnectionBridgeState].lastMessageAt = Date.now();
          this.onMessage(data.toString());
        }
      });
      socket.on("pong", () => { if (this[homeAssistantConnectionBridgeState].socket === socket) this[homeAssistantConnectionBridgeState].lastMessageAt = Date.now(); });
      socket.on("error", () => {
        if (this[homeAssistantConnectionBridgeState].socket !== socket) return;
        this[homeAssistantConnectionBridgeState].status.value.homeAssistant.error = "Home Assistant WebSocket connection failed";
        this[homeAssistantConnectionBridgeState].status.changed();
        socket.terminate();
      });
      socket.on("close", () => {
        if (this[homeAssistantConnectionBridgeState].socket !== socket) return;
        this.clearConnectionTimers();
        this[homeAssistantConnectionBridgeState].socket = null;
        this[homeAssistantConnectionBridgeState].snapshotPending = false;
        this[homeAssistantConnectionBridgeState].bufferedEvents.length = 0;
        this[homeAssistantConnectionBridgeState].status.value.homeAssistant.connected = false;
        this[homeAssistantConnectionBridgeState].status.changed();
        this[homeAssistantConnectionBridgeState].options.onAvailabilityChange?.();
        this.scheduleReconnect();
      });
    },
  onMessage(this: HomeAssistantConnectionBridgeInternals, raw: string): void {
      const message = parseHaMessage(raw);
      if (!message) return;
      switch (message.type) {
        case "auth_required":
          this[homeAssistantConnectionBridgeState].socket?.send(JSON.stringify({ type: "auth", access_token: this[homeAssistantConnectionBridgeState].config.haToken }));
          break;
        case "auth_ok":
          this.handleAuthenticated();
          break;
        case "auth_invalid":
          this[homeAssistantConnectionBridgeState].status.value.homeAssistant.error = "Home Assistant rejected the access token";
          this[homeAssistantConnectionBridgeState].status.changed();
          this[homeAssistantConnectionBridgeState].socket?.close();
          break;
        case "result":
          this.handleResult(message);
          break;
        case "event":
          this.handleEvent(message);
          break;
      }
    },
  handleAuthenticated(this: HomeAssistantConnectionBridgeInternals): void {
      // Subscribe before taking the snapshot. Events received while get_states is
      // in flight are buffered and replayed after it, closing the snapshot gap.
      this[homeAssistantConnectionBridgeState].socket?.send(JSON.stringify({ id: 2, type: "subscribe_events", event_type: "state_changed" }));
    },
});
