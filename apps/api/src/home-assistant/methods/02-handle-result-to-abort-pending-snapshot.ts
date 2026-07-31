import { existsSync, readFileSync } from "node:fs";
import { Agent as HttpAgent } from "node:http";
import { Agent as HttpsAgent } from "node:https";
import type { Socket } from "node:net";
import { resolve } from "node:path";
import WebSocket from "ws";
import { hasLocalHouseAuthority, type MeasurementSample, type OpeningState, type OpeningStateObservation, type Reading } from "@climate-twin/contracts";
import type { AppConfig } from "../../config.js";
import type { ClimateDatabase } from "../../db.js";
import type {
  SensorGapRecoveryAdapter,
  SensorHistoryRecoveryResult,
  SensorMetricAvailability,
} from "../../sensor-gap-recovery.js";
import type { MeasurementService, RuntimeStatus, TelemetryService } from "../../services.js";
import { EntityTarget, HA_COMPOSITE_MAX_SKEW_MS, HA_OPENING_HEARTBEAT_MS, HA_SNAPSHOT_EVENT_BUFFER_LIMIT, HA_SNAPSHOT_TIMEOUT_MS, HaMessage, HaState, OpeningTarget, normalizeHomeAssistantElectricityMeasurement, normalizeHomeAssistantTemperature, normalizeHomeAssistantTimestamp } from "../support/01-home-assistant-measurement-binding-to-validate-entit.js";
import { registerHomeAssistantConnectionBridgeMethods, homeAssistantConnectionBridgeState, type HomeAssistantConnectionBridgeInternals } from "../core.js";

function hasLocalSensorAuthority(state: HomeAssistantConnectionBridgeInternals, sensorId: string): boolean {
  const sensor = state[homeAssistantConnectionBridgeState].database.getSensor(sensorId);
  const house = sensor ? state[homeAssistantConnectionBridgeState].database.getHouse(sensor.houseId) : null;
  return Boolean(sensor?.enabled && house && hasLocalHouseAuthority(house));
}

registerHomeAssistantConnectionBridgeMethods({
  handleResult(this: HomeAssistantConnectionBridgeInternals, message: HaMessage): void {
      if (message.id === 1) {
        if (!message.success || !Array.isArray(message.result)) {
          this.abortPendingSnapshot("Home Assistant initial state request failed");
          return;
        }
        if (!this[homeAssistantConnectionBridgeState].snapshotPending) return;
        if (this[homeAssistantConnectionBridgeState].snapshotTimer) clearTimeout(this[homeAssistantConnectionBridgeState].snapshotTimer);
        this[homeAssistantConnectionBridgeState].snapshotTimer = null;
        this[homeAssistantConnectionBridgeState].snapshotPending = false;
        this[homeAssistantConnectionBridgeState].attempt = 0;
        this[homeAssistantConnectionBridgeState].status.value.homeAssistant.connected = true;
        this[homeAssistantConnectionBridgeState].status.value.homeAssistant.error = this[homeAssistantConnectionBridgeState].mappingWarning;
        this[homeAssistantConnectionBridgeState].status.changed();
        this.ingestInitialStates(message.result);
        const buffered = this[homeAssistantConnectionBridgeState].bufferedEvents.splice(0).sort((left, right) => (
          Date.parse(left.state.last_updated ?? left.fallbackTimestamp ?? "")
          - Date.parse(right.state.last_updated ?? right.fallbackTimestamp ?? "")
        ));
        for (const event of buffered) this.ingestEventState(event.state, event.fallbackTimestamp);
        this.startLivenessWatchdog();
        return;
      }
      if (message.id === 2) {
        if (!message.success) {
          this[homeAssistantConnectionBridgeState].status.value.homeAssistant.connected = false;
          this[homeAssistantConnectionBridgeState].status.value.homeAssistant.error = "Home Assistant rejected the state_changed subscription";
          this[homeAssistantConnectionBridgeState].status.changed();
          this[homeAssistantConnectionBridgeState].socket?.close();
          return;
        }
        this[homeAssistantConnectionBridgeState].snapshotPending = true;
        this[homeAssistantConnectionBridgeState].bufferedEvents.length = 0;
        if (this[homeAssistantConnectionBridgeState].handshakeTimer) clearTimeout(this[homeAssistantConnectionBridgeState].handshakeTimer);
        this[homeAssistantConnectionBridgeState].handshakeTimer = null;
        const socket = this[homeAssistantConnectionBridgeState].socket;
        this[homeAssistantConnectionBridgeState].snapshotTimer = setTimeout(() => {
          if (this[homeAssistantConnectionBridgeState].socket === socket && this[homeAssistantConnectionBridgeState].snapshotPending) {
            this.abortPendingSnapshot("Home Assistant initial state request timed out");
          }
        }, HA_SNAPSHOT_TIMEOUT_MS);
        this[homeAssistantConnectionBridgeState].snapshotTimer.unref();
        this[homeAssistantConnectionBridgeState].socket?.send(JSON.stringify({ id: 1, type: "get_states" }));
      }
    },
  ingestInitialStates(this: HomeAssistantConnectionBridgeInternals, states: HaState[]): void {
      const climateUpdates = new Map<string, string>();
      const observedAt = new Date().toISOString();
      let availabilityChanged = false;
      for (const entityId of this[homeAssistantConnectionBridgeState].entities.keys()) {
        if (this[homeAssistantConnectionBridgeState].entityAvailability.get(entityId) !== false) availabilityChanged = true;
        this[homeAssistantConnectionBridgeState].entityAvailability.set(entityId, false);
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
      this[homeAssistantConnectionBridgeState].lastOpeningHeartbeatAt = Date.now();
      for (const [sensorId, timestamp] of climateUpdates) this.ingestCachedClimate(sensorId, timestamp);
      if (availabilityChanged) this[homeAssistantConnectionBridgeState].options.onAvailabilityChange?.();
    },
  handleEvent(this: HomeAssistantConnectionBridgeInternals, message: HaMessage): void {
      if (message.event?.event_type !== "state_changed") return;
      const entityId = message.event.data?.entity_id;
      const newState = message.event.data?.new_state;
      if (!entityId || !newState || (!this[homeAssistantConnectionBridgeState].entities.has(entityId) && !this[homeAssistantConnectionBridgeState].openings.has(entityId))) return;
      const state = { ...newState, entity_id: entityId };
      if (this[homeAssistantConnectionBridgeState].snapshotPending) {
        if (this[homeAssistantConnectionBridgeState].bufferedEvents.length >= HA_SNAPSHOT_EVENT_BUFFER_LIMIT) {
          this.abortPendingSnapshot("Home Assistant initial state event buffer limit exceeded");
          return;
        }
        this[homeAssistantConnectionBridgeState].bufferedEvents.push({ state, ...(message.event.time_fired ? { fallbackTimestamp: message.event.time_fired } : {}) });
        return;
      }
      this.ingestEventState(state, message.event.time_fired);
    },
  ingestEventState(this: HomeAssistantConnectionBridgeInternals, state: HaState, fallbackTimestamp?: string): void {
      if (this.updateEntityAvailability(state)) this[homeAssistantConnectionBridgeState].options.onAvailabilityChange?.();
      const openingTimestamp = this.ingestOpeningState(state, fallbackTimestamp);
      const updated = this.applyState(state, fallbackTimestamp);
      if (!updated && !openingTimestamp) return;
      this[homeAssistantConnectionBridgeState].status.value.homeAssistant.lastEventAt = updated?.timestamp ?? openingTimestamp;
      if (!updated) {
        this[homeAssistantConnectionBridgeState].status.changed();
        return;
      }
      if (updated.metric === "battery") {
        this[homeAssistantConnectionBridgeState].status.changed();
        return;
      }
      this.ingestMeasurementUpdate(updated);
      if (updated.metric === "temperature" || updated.metric === "humidity") this.ingestCachedClimate(updated.sensorId, updated.timestamp);
    },
  updateEntityAvailability(this: HomeAssistantConnectionBridgeInternals, state: HaState): boolean {
      if (!state.entity_id || !this[homeAssistantConnectionBridgeState].entities.has(state.entity_id)) return false;
      const available = this.normalizeHistoryValue(this[homeAssistantConnectionBridgeState].entities.get(state.entity_id)!, state) !== null;
      const previous = this[homeAssistantConnectionBridgeState].entityAvailability.get(state.entity_id) ?? false;
      this[homeAssistantConnectionBridgeState].entityAvailability.set(state.entity_id, available);
      return previous !== available;
    },
  ingestOpeningState(this: HomeAssistantConnectionBridgeInternals, state: HaState, fallbackTimestamp?: string, observedAtOverride?: string): string | null {
      if (!state.entity_id) return null;
      const target = this[homeAssistantConnectionBridgeState].openings.get(state.entity_id);
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
      this[homeAssistantConnectionBridgeState].openingStateCache.set(target.externalId, { target, state: openingState });
      return this.recordOpeningState(target, openingState, timestamp);
    },
  recordOpeningState(this: HomeAssistantConnectionBridgeInternals, target: OpeningTarget, state: OpeningState, timestamp: string): string | null {
      const house = this[homeAssistantConnectionBridgeState].database.getHouse(target.houseId);
      if (!house || !hasLocalHouseAuthority(house)) return null;
      try {
        const observation = this[homeAssistantConnectionBridgeState].database.recordOpeningStateObservation(target.houseId, {
          floorId: target.floorId,
          elementId: target.elementId,
          state,
          source: "home-assistant",
          observedAt: timestamp,
          externalId: target.externalId,
          connectionId: target.connectionId,
        });
        this[homeAssistantConnectionBridgeState].options.onOpeningStateRecorded?.(observation);
        return timestamp;
      } catch (error) {
        this[homeAssistantConnectionBridgeState].status.value.homeAssistant.error = error instanceof Error ? error.message : `Could not ingest opening state for ${target.externalId}`;
        this[homeAssistantConnectionBridgeState].status.changed();
        return null;
      }
    },
  refreshOpeningStateHeartbeats(this: HomeAssistantConnectionBridgeInternals, now = Date.now()): void {
      if (now - this[homeAssistantConnectionBridgeState].lastOpeningHeartbeatAt < HA_OPENING_HEARTBEAT_MS) return;
      this[homeAssistantConnectionBridgeState].lastOpeningHeartbeatAt = now;
      const observedAt = new Date(now).toISOString();
      for (const { target, state } of this[homeAssistantConnectionBridgeState].openingStateCache.values()) {
        this.recordOpeningState(target, state, observedAt);
      }
    },
  applyState(this: HomeAssistantConnectionBridgeInternals, state: HaState, fallbackTimestamp?: string): (EntityTarget & { timestamp: string; value: number }) | null {
      if (!state.entity_id) return null;
      const target = this[homeAssistantConnectionBridgeState].entities.get(state.entity_id);
      if (!target) return null;
      if (!this[homeAssistantConnectionBridgeState].database.getSensor(target.sensorId)?.enabled) return null;
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
          this[homeAssistantConnectionBridgeState].status.value.homeAssistant.error = `Unsupported unit ${haUnit ?? "(missing)"} for ${target.metric} entity ${state.entity_id}`;
          this[homeAssistantConnectionBridgeState].status.changed();
          return null;
        }
      } else {
        const definition = this[homeAssistantConnectionBridgeState].database.getMeasurementDefinition(target.metric);
        if (!definition) {
          this[homeAssistantConnectionBridgeState].status.value.homeAssistant.error = `Unknown measurement metric ${target.metric} for entity ${state.entity_id}`;
          this[homeAssistantConnectionBridgeState].status.changed();
          return null;
        }
        const expectedUnit = target.expectedUnit ?? definition.unit;
        if (!haUnit || haUnit !== expectedUnit) {
          this[homeAssistantConnectionBridgeState].status.value.homeAssistant.error = `Unit for entity ${state.entity_id} must be ${expectedUnit}`;
          this[homeAssistantConnectionBridgeState].status.changed();
          return null;
        }
        if (expectedUnit !== definition.unit && target.scale === undefined && target.offset === undefined) {
          this[homeAssistantConnectionBridgeState].status.value.homeAssistant.error = `Entity ${state.entity_id} requires an explicit scale or offset to convert ${expectedUnit} to ${definition.unit}`;
          this[homeAssistantConnectionBridgeState].status.changed();
          return null;
        }
        value = rawValue * (target.scale ?? 1) + (target.offset ?? 0);
      }
      if (value === null) {
        this[homeAssistantConnectionBridgeState].status.value.homeAssistant.error = `Unsupported temperature unit for entity ${state.entity_id}`;
        this[homeAssistantConnectionBridgeState].status.changed();
        return null;
      }
      const timestamp = normalizeHomeAssistantTimestamp(state.last_updated, fallbackTimestamp);
      const cached = this[homeAssistantConnectionBridgeState].cache.get(target.sensorId) ?? {};
      if (target.metric === "temperature" || target.metric === "humidity" || target.metric === "battery") {
        const previous = cached[target.metric];
        if (previous && Date.parse(timestamp) < Date.parse(previous.timestamp)) return null;
        cached[target.metric] = { value, timestamp };
      }
      this[homeAssistantConnectionBridgeState].cache.set(target.sensorId, cached);
      return { ...target, timestamp, value };
    },
  ingestMeasurementUpdate(this: HomeAssistantConnectionBridgeInternals, update: EntityTarget & { timestamp: string; value: number }): void {
      if (!hasLocalSensorAuthority(this, update.sensorId)) return;
      const definition = this[homeAssistantConnectionBridgeState].database.getMeasurementDefinition(update.metric);
      if (!definition) {
        this[homeAssistantConnectionBridgeState].status.value.homeAssistant.error = `Unknown measurement metric ${update.metric}`;
        this[homeAssistantConnectionBridgeState].status.changed();
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
      if (this[homeAssistantConnectionBridgeState].options.shouldIngestLiveMeasurement?.(sample.sensorId, sample.metric) === false) {
        // Keep connection freshness accurate while the faster direct source owns
        // the canonical live stream. HA recorder history remains a recovery path.
        this[homeAssistantConnectionBridgeState].status.value.homeAssistant.lastEventAt = sample.timestamp;
        this[homeAssistantConnectionBridgeState].status.value.homeAssistant.error = this[homeAssistantConnectionBridgeState].mappingWarning;
        this[homeAssistantConnectionBridgeState].status.changed();
        return;
      }
      try {
        this[homeAssistantConnectionBridgeState].measurements.ingest(sample);
        this[homeAssistantConnectionBridgeState].status.value.homeAssistant.lastEventAt = sample.timestamp;
        this[homeAssistantConnectionBridgeState].status.value.homeAssistant.error = this[homeAssistantConnectionBridgeState].mappingWarning;
        this[homeAssistantConnectionBridgeState].status.changed();
      } catch (error) {
        this[homeAssistantConnectionBridgeState].status.value.homeAssistant.error = error instanceof Error ? error.message : `Could not ingest ${update.metric}`;
        this[homeAssistantConnectionBridgeState].status.changed();
      }
    },
  ingestCachedClimate(this: HomeAssistantConnectionBridgeInternals, sensorId: string, timestamp: string): void {
      if (!hasLocalSensorAuthority(this, sensorId)) return;
      if (this[homeAssistantConnectionBridgeState].options.shouldIngestLiveMeasurement?.(sensorId, "temperature") === false
        || this[homeAssistantConnectionBridgeState].options.shouldIngestLiveMeasurement?.(sensorId, "humidity") === false) return;
      const cached = this[homeAssistantConnectionBridgeState].cache.get(sensorId);
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
        this[homeAssistantConnectionBridgeState].telemetry.ingestLegacyProjection(reading);
        this[homeAssistantConnectionBridgeState].status.value.homeAssistant.lastEventAt = reading.timestamp;
        this[homeAssistantConnectionBridgeState].status.value.homeAssistant.error = this[homeAssistantConnectionBridgeState].mappingWarning;
        this[homeAssistantConnectionBridgeState].status.changed();
      } catch {
        this[homeAssistantConnectionBridgeState].status.value.homeAssistant.error = `Mapped entity references unknown or disabled sensor ${sensorId}`;
        this[homeAssistantConnectionBridgeState].status.changed();
      }
    },
  scheduleReconnect(this: HomeAssistantConnectionBridgeInternals): void {
      if (!this[homeAssistantConnectionBridgeState].running || this[homeAssistantConnectionBridgeState].reconnectTimer) return;
      const delay = Math.min(60_000, 1_000 * 2 ** this[homeAssistantConnectionBridgeState].attempt);
      this[homeAssistantConnectionBridgeState].attempt = Math.min(this[homeAssistantConnectionBridgeState].attempt + 1, 6);
      this[homeAssistantConnectionBridgeState].reconnectTimer = setTimeout(() => {
        this[homeAssistantConnectionBridgeState].reconnectTimer = null;
        this.connect();
      }, delay);
      this[homeAssistantConnectionBridgeState].reconnectTimer.unref();
    },
  clearConnectionTimers(this: HomeAssistantConnectionBridgeInternals): void {
      if (this[homeAssistantConnectionBridgeState].handshakeTimer) clearTimeout(this[homeAssistantConnectionBridgeState].handshakeTimer);
      if (this[homeAssistantConnectionBridgeState].snapshotTimer) clearTimeout(this[homeAssistantConnectionBridgeState].snapshotTimer);
      if (this[homeAssistantConnectionBridgeState].livenessTimer) clearInterval(this[homeAssistantConnectionBridgeState].livenessTimer);
      this[homeAssistantConnectionBridgeState].handshakeTimer = null;
      this[homeAssistantConnectionBridgeState].snapshotTimer = null;
      this[homeAssistantConnectionBridgeState].livenessTimer = null;
    },
  abortPendingSnapshot(this: HomeAssistantConnectionBridgeInternals, error: string): void {
      if (!this[homeAssistantConnectionBridgeState].snapshotPending) return;
      if (this[homeAssistantConnectionBridgeState].snapshotTimer) clearTimeout(this[homeAssistantConnectionBridgeState].snapshotTimer);
      this[homeAssistantConnectionBridgeState].snapshotTimer = null;
      this[homeAssistantConnectionBridgeState].snapshotPending = false;
      this[homeAssistantConnectionBridgeState].bufferedEvents.length = 0;
      this[homeAssistantConnectionBridgeState].status.value.homeAssistant.connected = false;
      this[homeAssistantConnectionBridgeState].status.value.homeAssistant.error = error;
      this[homeAssistantConnectionBridgeState].status.changed();
      this[homeAssistantConnectionBridgeState].socket?.terminate();
    },
});
