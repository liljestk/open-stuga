import { createHash } from "node:crypto";
import type { Reading } from "@climate-twin/contracts";
import type {
  SensorMetricAvailability,
} from "../../sensor-gap-recovery.js";
import { CLIMATE_UNCHANGED_HEARTBEAT_MS, CachedTpLinkDevice, REDUNDANT_SOURCE_HANDOVER_MIN_MS, STATE_UNCHANGED_HEARTBEAT_MS, STATUS_UNCHANGED_HEARTBEAT_MS, TapoOpeningTarget, TpLinkContactEventsMessage, TpLinkSnapshotDevice, TpLinkSnapshotMessage, finiteNumber, isTpLinkHubModel, nonEmptyString, normalizeTpLinkTemperature } from "../support/01-tp-link-local-climate-history-capability-revision-to.js";
import { registerTpLinkConnectionBridgeMethods, tpLinkConnectionBridgeState, type TpLinkConnectionBridgeInternals } from "../core.js";
import { compareCodeUnits } from "../../text-order.js";

interface SnapshotClock {
  timestamp: string;
  timestampMs: number;
}

const TP_LINK_DEVICE_METRICS = ["temperature", "humidity", "power", "energy"] as const;

function exposesDeviceMetric(device: CachedTpLinkDevice | undefined, metric: string): boolean {
  if (!device || !(TP_LINK_DEVICE_METRICS as readonly string[]).includes(metric)) return false;
  const value = device[metric as (typeof TP_LINK_DEVICE_METRICS)[number]];
  return value !== null && value !== undefined;
}

function mappedSensorAvailability(
  bridge: TpLinkConnectionBridgeInternals,
  deviceId: string,
  sensorId: string,
  connectionFresh: boolean,
  observedAt: string,
): SensorMetricAvailability[] {
  const sensor = bridge[tpLinkConnectionBridgeState].database.getSensor(sensorId);
  if (!sensor?.enabled) return [];
  const device = bridge[tpLinkConnectionBridgeState].currentDevices.get(deviceId);
  const metrics = new Set(bridge[tpLinkConnectionBridgeState].database.sensorSourceMetrics(sensorId, "tp-link"));
  for (const metric of TP_LINK_DEVICE_METRICS) {
    if (exposesDeviceMetric(device, metric)) metrics.add(metric);
  }
  if (metrics.size === 0 && /T3(?:10|15)/i.test(sensor.model)) {
    metrics.add("temperature");
    metrics.add("humidity");
  }
  const online = connectionFresh && Boolean(device)
    && (!device?.status || device.status.toLowerCase() === "online");
  return [...metrics].map((metric): SensorMetricAvailability => ({
    sensorId,
    metric,
    source: "tp-link",
    available: online && exposesDeviceMetric(device, metric),
    observedAt,
  }));
}

function snapshotSourceError(
  bridge: TpLinkConnectionBridgeInternals,
  message: TpLinkSnapshotMessage,
  supportedHub: boolean,
  sourceType: NonNullable<TpLinkSnapshotMessage["sourceType"]>,
  sourceDeviceId: string | null,
): string | null {
  if (!supportedHub && sourceType !== "energy-device") return `Unsupported TP-Link source model ${message.hubModel || "unknown"}`;
  if (sourceDeviceId && sourceDeviceId.length > 1_024) return "TP-Link helper returned an invalid source identity";
  const savedDeviceId = bridge[tpLinkConnectionBridgeState].managedConnection?.deviceId;
  if (savedDeviceId && (!sourceDeviceId || savedDeviceId.trim().toUpperCase() !== sourceDeviceId.trim().toUpperCase())) {
    return "TP-Link helper returned a missing or different source identity at the saved address; polling was stopped to protect device bindings";
  }
  return null;
}

function learnSnapshotSource(bridge: TpLinkConnectionBridgeInternals, source: {
  sourceDeviceId: string | null;
  sourceType: NonNullable<TpLinkSnapshotMessage["sourceType"]>;
  sourceModel: string;
  sourceAlias: string | null;
}): void {
  const managedConnection = bridge[tpLinkConnectionBridgeState].managedConnection;
  if (!managedConnection) return;
  const { sourceDeviceId, sourceType, sourceModel, sourceAlias } = source;
  const previousHost = managedConnection.host;
  const metadataChanged = managedConnection.sourceType !== sourceType
    || managedConnection.sourceModel !== sourceModel
    || (managedConnection.sourceAlias ?? null) !== sourceAlias;
  const identityLearned = Boolean(sourceDeviceId && !managedConnection.deviceId);
  if (sourceDeviceId) managedConnection.deviceId = sourceDeviceId;
  managedConnection.sourceType = sourceType;
  managedConnection.sourceModel = sourceModel;
  if (sourceAlias) managedConnection.sourceAlias = sourceAlias;
  else delete managedConnection.sourceAlias;
  if (identityLearned || metadataChanged) managedConnection.onUpdate?.({
    id: managedConnection.id,
    houseId: managedConnection.houseId,
    previousHost,
    host: previousHost,
    ...(managedConnection.deviceId ? { deviceId: managedConnection.deviceId } : {}),
    sourceType,
    sourceModel,
    sourceAlias,
  });
}

function cachedSnapshotDevice(rawDevice: TpLinkSnapshotDevice, deviceId: string, timestamp: string): CachedTpLinkDevice {
  const rawTemperature = finiteNumber(rawDevice.temperature);
  return {
    deviceId,
    model: nonEmptyString(rawDevice.model) ?? "Unknown",
    alias: nonEmptyString(rawDevice.alias),
    status: nonEmptyString(rawDevice.status),
    temperature: rawTemperature === null ? null : normalizeTpLinkTemperature(rawTemperature, nonEmptyString(rawDevice.temperatureUnit)),
    humidity: finiteNumber(rawDevice.humidity),
    battery: finiteNumber(rawDevice.battery),
    contactOpen: typeof rawDevice.contactOpen === "boolean" ? rawDevice.contactOpen : null,
    power: finiteNumber(rawDevice.power),
    energy: finiteNumber(rawDevice.energy),
    lastSeenAt: timestamp,
  };
}

function cacheSnapshotDevices(
  bridge: TpLinkConnectionBridgeInternals,
  rawDevices: TpLinkSnapshotDevice[],
  timestamp: string,
): Map<string, CachedTpLinkDevice> {
  const state = bridge[tpLinkConnectionBridgeState];
  const devices = new Map<string, CachedTpLinkDevice>();
  for (const rawDevice of rawDevices) {
    const deviceId = nonEmptyString(rawDevice?.deviceId);
    if (!deviceId) continue;
    const device = cachedSnapshotDevice(rawDevice, deviceId, timestamp);
    devices.set(deviceId, device);
    state.discovered.set(deviceId, device);
  }
  state.currentDevices.clear();
  for (const [deviceId, device] of devices) state.currentDevices.set(deviceId, device);
  state.status.value.tpLink.discoveredDevices = state.discovered.size;
  return devices;
}

// Returns the issue to report for this contact target, if any.
function ingestSnapshotOpeningState(
  bridge: TpLinkConnectionBridgeInternals,
  target: TapoOpeningTarget,
  device: CachedTpLinkDevice | undefined,
  clock: SnapshotClock,
): string | null {
  if (!device) return `Mapped Tapo contact ${target.deviceId} was not found`;
  if (device.status && device.status.toLowerCase() !== "online") return null;
  if (typeof device.contactOpen !== "boolean") return `Mapped Tapo contact ${target.deviceId} does not expose contact state`;
  const state = device.contactOpen ? "open" : "closed";
  const targetKey = `${target.floorId}\u0000${target.elementId}`;
  const previous = bridge[tpLinkConnectionBridgeState].lastIngestedOpeningStates.get(targetKey);
  if (previous?.state === state && clock.timestampMs - previous.ingestedAt < STATE_UNCHANGED_HEARTBEAT_MS) return null;
  try {
    const observation = bridge[tpLinkConnectionBridgeState].database.recordOpeningStateObservation(target.houseId, {
      floorId: target.floorId,
      elementId: target.elementId,
      state,
      source: "tapo",
      observedAt: clock.timestamp,
      externalId: target.deviceId,
      connectionId: target.connectionId,
    });
    bridge[tpLinkConnectionBridgeState].managedConnection?.onOpeningStateRecorded?.(observation);
    bridge[tpLinkConnectionBridgeState].lastIngestedOpeningStates.set(targetKey, { state, ingestedAt: clock.timestampMs });
    return null;
  } catch (error) {
    const reason = error instanceof Error ? error.message : "ingestion failed";
    return `Could not ingest Tapo contact ${target.deviceId}: ${reason}`;
  }
}

function ingestMappedSnapshotDevice(
  bridge: TpLinkConnectionBridgeInternals,
  deviceId: string,
  sensorId: string,
  device: CachedTpLinkDevice | undefined,
  clock: SnapshotClock,
  issues: string[],
): void {
  const sensor = bridge[tpLinkConnectionBridgeState].database.getSensor(sensorId);
  if (!sensor) {
    issues.push(`Mapped TP-Link child ${deviceId} references unknown sensor ${sensorId}`);
    return;
  }
  // Archived sensors retain ownership of their physical child device so it
  // cannot be accidentally offered or assigned elsewhere, but do not ingest.
  if (!sensor.enabled) return;
  if (!device) {
    issues.push(`Mapped TP-Link child ${deviceId} was not found`);
    return;
  }
  if (device.status && device.status.toLowerCase() !== "online") {
    issues.push(`Mapped TP-Link child ${deviceId} is ${device.status}`);
    return;
  }
  const temperature = device.temperature;
  const humidity = device.humidity;
  const power = device.power ?? null;
  const energy = device.energy ?? null;
  const hasClimate = temperature !== null && humidity !== null;
  const hasEnergy = power !== null || energy !== null;
  if (!hasClimate && !hasEnergy) {
    issues.push(`Mapped TP-Link device ${deviceId} does not expose valid climate or energy data`);
    return;
  }
  if (hasClimate) {
    ingestSnapshotClimate(bridge, { deviceId, sensorId, temperature, humidity, battery: device.battery }, clock, issues);
  }
  if (power !== null) bridge.ingestElectricityMeasurement(deviceId, sensorId, "power", power, "W", clock.timestamp, clock.timestampMs, issues);
  if (energy !== null) bridge.ingestElectricityMeasurement(deviceId, sensorId, "energy", energy, "kWh", clock.timestamp, clock.timestampMs, issues);
}

function ingestSnapshotClimate(
  bridge: TpLinkConnectionBridgeInternals,
  climate: { deviceId: string; sensorId: string; temperature: number; humidity: number; battery: number | null },
  clock: SnapshotClock,
  issues: string[],
): void {
  const { deviceId, sensorId, temperature, humidity, battery } = climate;
  const { timestamp, timestampMs } = clock;
  const previous = bridge[tpLinkConnectionBridgeState].lastIngested.get(deviceId);
  const unchanged = previous?.sensorId === sensorId && previous.temperature === temperature
    && previous.humidity === humidity && previous.battery === battery;
  const due = !unchanged || timestampMs - previous.ingestedAt >= CLIMATE_UNCHANGED_HEARTBEAT_MS;
  if (!due) return;
  const reading: Reading = {
    sensorId,
    timestamp,
    temperature,
    humidity,
    battery,
    source: "tp-link",
    quality: "good",
  };
  const redundantHandover = bridge.isRecentHomeAssistantEquivalent(
    sensorId, "temperature", temperature, timestampMs,
  ) && bridge.isRecentHomeAssistantEquivalent(sensorId, "humidity", humidity, timestampMs);
  if (redundantHandover) {
    bridge[tpLinkConnectionBridgeState].lastIngested.set(deviceId, { sensorId, temperature, humidity, battery, ingestedAt: timestampMs });
    return;
  }
  try {
    bridge[tpLinkConnectionBridgeState].telemetry.ingest(reading);
    bridge[tpLinkConnectionBridgeState].lastIngested.set(deviceId, { sensorId, temperature, humidity, battery, ingestedAt: timestampMs });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "ingestion failed";
    issues.push(`Could not ingest TP-Link climate device ${deviceId}: ${reason}`);
  }
}

registerTpLinkConnectionBridgeMethods({
  ingestContactEvents(this: TpLinkConnectionBridgeInternals, message: TpLinkContactEventsMessage): void {
      const targets = new Map(this.configuredOpeningTargets()
        .map((target) => [target.deviceId, target] as const));
      const receivedAtMs = Date.now();
      const batchTimestampMs = Date.parse(message.timestamp);
      const latestAllowedMs = Math.min(
        receivedAtMs + 5 * 60_000,
        (Number.isFinite(batchTimestampMs) ? batchTimestampMs : receivedAtMs) + 5 * 60_000,
      );
      const events = message.events.slice(0, 2_048).flatMap((rawEvent) => {
        const deviceId = nonEmptyString(rawEvent?.deviceId);
        const eventId = nonEmptyString(rawEvent?.eventId);
        const observedAtMs = Date.parse(rawEvent?.timestamp);
        const sequence = finiteNumber(rawEvent?.sequence);
        if (!deviceId || deviceId.length > 255 || !eventId || eventId.length > 512
          || (rawEvent?.state !== "open" && rawEvent?.state !== "closed")
          || !Number.isFinite(observedAtMs) || observedAtMs <= 0 || observedAtMs > latestAllowedMs) return [];
        return [{
          deviceId, eventId, state: rawEvent.state, observedAtMs,
          sequence: sequence === null ? -1 : sequence,
        }];
      }).sort((left, right) => left.observedAtMs - right.observedAtMs
        || left.deviceId.localeCompare(right.deviceId)
        || left.sequence - right.sequence
        || left.eventId.localeCompare(right.eventId));
      const handled = new Set<string>();
      for (const event of events) {
        const target = targets.get(event.deviceId);
        const eventKey = `${event.deviceId}\u0000${event.eventId}`;
        if (!target || handled.has(eventKey)) continue;
        handled.add(eventKey);
        const id = `tapo-event:${createHash("sha256")
          .update(`${target.connectionId}\u0000${event.deviceId}\u0000${event.eventId}`)
          .digest("hex")}`;
        try {
          const observation = this[tpLinkConnectionBridgeState].database.recordOpeningStateObservation(target.houseId, {
            id,
            floorId: target.floorId,
            elementId: target.elementId,
            state: event.state,
            source: "tapo",
            observedAt: new Date(event.observedAtMs).toISOString(),
            externalId: event.deviceId,
            connectionId: target.connectionId,
          });
          this[tpLinkConnectionBridgeState].managedConnection?.onOpeningStateRecorded?.(observation);
          const targetKey = `${target.floorId}\u0000${target.elementId}`;
          const previous = this[tpLinkConnectionBridgeState].lastIngestedOpeningStates.get(targetKey);
          if (!previous || event.observedAtMs >= previous.ingestedAt) {
            this[tpLinkConnectionBridgeState].lastIngestedOpeningStates.set(
              targetKey,
              { state: event.state, ingestedAt: event.observedAtMs },
            );
          }
        } catch (error) {
          if (error && typeof error === "object" && "code" in error
            && error.code === "OPENING_OBSERVATION_ID_CONFLICT") continue;
          const reason = error instanceof Error ? error.message : "ingestion failed";
          this[tpLinkConnectionBridgeState].status.value.tpLink.error = `Could not ingest Tapo contact ${event.deviceId}: ${reason}`;
          this.publishStatusIfNeeded();
        }
      }
    },
  ingestSnapshot(this: TpLinkConnectionBridgeInternals, message: TpLinkSnapshotMessage): void {
      const timestamp = Number.isFinite(Date.parse(message.timestamp)) ? new Date(message.timestamp).toISOString() : new Date().toISOString();
      const hubModel = nonEmptyString(message.hubModel)?.toUpperCase() ?? "";
      const sourceType = message.sourceType ?? "hub";
      const sourceModel = hubModel.slice(0, 128);
      const sourceAlias = nonEmptyString(message.sourceAlias)?.slice(0, 512) ?? null;
      const supportedHub = isTpLinkHubModel(hubModel);
      const sourceDeviceId = nonEmptyString(message.sourceDeviceId);
      const sourceError = snapshotSourceError(this, message, supportedHub, sourceType, sourceDeviceId);
      if (sourceError) {
        this[tpLinkConnectionBridgeState].status.value.tpLink.connected = false;
        this[tpLinkConnectionBridgeState].status.value.tpLink.error = sourceError;
        this.publishStatusIfNeeded();
        this.notifyAvailabilityChangeIfNeeded();
        return;
      }
      learnSnapshotSource(this, { sourceDeviceId, sourceType, sourceModel, sourceAlias });

      this[tpLinkConnectionBridgeState].attempt = 0;
      this[tpLinkConnectionBridgeState].status.value.tpLink.connected = true;
      this[tpLinkConnectionBridgeState].status.value.tpLink.lastPollAt = timestamp;
      this[tpLinkConnectionBridgeState].status.value.tpLink.hubModel = supportedHub ? hubModel : null;
      this[tpLinkConnectionBridgeState].status.value.tpLink.sourceType = sourceType;
      this[tpLinkConnectionBridgeState].status.value.tpLink.sourceModel = sourceModel;
      this[tpLinkConnectionBridgeState].status.value.tpLink.sourceAlias = sourceAlias;
      const devices = cacheSnapshotDevices(this, message.devices, timestamp);
      const mappings = this.resolvedMappings();
      const issues: string[] = [];
      const clock: SnapshotClock = { timestamp, timestampMs: Date.parse(timestamp) };

      for (const target of this.configuredOpeningTargets()) {
        const issue = ingestSnapshotOpeningState(this, target, devices.get(target.deviceId), clock);
        if (issue) issues.push(issue);
      }
      for (const [deviceId, sensorId] of mappings) {
        ingestMappedSnapshotDevice(this, deviceId, sensorId, devices.get(deviceId), clock, issues);
      }

      const helperWarning = nonEmptyString(message.warning)?.slice(0, 500) ?? null;
      this[tpLinkConnectionBridgeState].status.value.tpLink.error = [helperWarning, this[tpLinkConnectionBridgeState].mappingWarning, ...issues].filter(Boolean).join("; ") || null;
      this.publishStatusIfNeeded();
      this.notifyAvailabilityChangeIfNeeded();
      const contactEventsEnabled = this[tpLinkConnectionBridgeState].contactEventsEnabled;
      if (contactEventsEnabled !== null
        && contactEventsEnabled !== (this.configuredOpeningTargets().length > 0)) this.restart();
    },
  publishStatusIfNeeded(this: TpLinkConnectionBridgeInternals, nowMs = Date.now()): void {
      const status = this[tpLinkConnectionBridgeState].status.value.tpLink;
      const signature = JSON.stringify([
        status.configured,
        status.connected,
        status.mappedDevices,
        status.discoveredDevices,
        status.hubModel,
        status.host ?? null,
        status.sourceType ?? null,
        status.sourceModel ?? null,
        status.sourceAlias ?? null,
        status.error,
      ]);
      if (signature === this[tpLinkConnectionBridgeState].lastStatusSignature
        && nowMs - this[tpLinkConnectionBridgeState].lastStatusPublishedAt < STATUS_UNCHANGED_HEARTBEAT_MS) {
        this[tpLinkConnectionBridgeState].status.synchronized?.();
        return;
      }
      this[tpLinkConnectionBridgeState].lastStatusSignature = signature;
      this[tpLinkConnectionBridgeState].lastStatusPublishedAt = nowMs;
      this[tpLinkConnectionBridgeState].status.changed();
    },
  notifyAvailabilityChangeIfNeeded(this: TpLinkConnectionBridgeInternals, now = new Date()): void {
      const signature = JSON.stringify(this.availability(now)
        .map(({ sensorId, metric, source, available }) => JSON.stringify([sensorId, metric, source, available]))
        .sort(compareCodeUnits));
      if (signature === this[tpLinkConnectionBridgeState].lastAvailabilitySignature) return;
      this[tpLinkConnectionBridgeState].lastAvailabilitySignature = signature;
      this[tpLinkConnectionBridgeState].managedConnection?.onAvailabilityChange?.();
    },
  availability(this: TpLinkConnectionBridgeInternals, now = new Date()): SensorMetricAvailability[] {
      const observedAt = now.toISOString();
      const lastPollMs = this[tpLinkConnectionBridgeState].status.value.tpLink.lastPollAt ? Date.parse(this[tpLinkConnectionBridgeState].status.value.tpLink.lastPollAt) : Number.NaN;
      const connectionFresh = this[tpLinkConnectionBridgeState].status.value.tpLink.connected && Number.isFinite(lastPollMs)
        && now.getTime() - lastPollMs <= Math.max(60_000, this[tpLinkConnectionBridgeState].config.tpLinkPollIntervalMs * 3);
      const availability: SensorMetricAvailability[] = [];
      for (const [deviceId, sensorId] of this.resolvedMappings()) {
        availability.push(...mappedSensorAvailability(this, deviceId, sensorId, connectionFresh, observedAt));
      }
      return availability;
    },
  ingestElectricityMeasurement(this: TpLinkConnectionBridgeInternals,
      deviceId: string,
      sensorId: string,
      metric: "power" | "energy",
      value: number,
      canonicalUnit: "W" | "kWh",
      timestamp: string,
      timestampMs: number,
      issues: string[],
    ): void {
      const key = `${deviceId}\u0000${metric}`;
      const previous = this[tpLinkConnectionBridgeState].lastIngestedMeasurements.get(key);
      const unchanged = previous?.sensorId === sensorId && previous.value === value;
      if (unchanged && timestampMs - previous.ingestedAt < STATE_UNCHANGED_HEARTBEAT_MS) return;
      if (this.isRecentHomeAssistantEquivalent(sensorId, metric, value, timestampMs)) {
        this[tpLinkConnectionBridgeState].lastIngestedMeasurements.set(key, { sensorId, value, ingestedAt: timestampMs });
        return;
      }
      try {
        this[tpLinkConnectionBridgeState].measurements.ingest({
          sensorId,
          metric,
          value,
          canonicalUnit,
          timestamp,
          source: "tp-link",
          quality: "good",
        });
        this[tpLinkConnectionBridgeState].lastIngestedMeasurements.set(key, { sensorId, value, ingestedAt: timestampMs });
      } catch (error) {
        const reason = error instanceof Error ? error.message : "ingestion failed";
        issues.push(`Could not ingest TP-Link ${metric} from ${deviceId}: ${reason}`);
      }
    },
  isRecentHomeAssistantEquivalent(this: TpLinkConnectionBridgeInternals,
      sensorId: string,
      metric: string,
      value: number,
      timestampMs: number,
    ): boolean {
      const latest = this[tpLinkConnectionBridgeState].database.getLatestMeasurementSample(sensorId, metric);
      if (!latest || latest.source !== "home-assistant" || latest.value !== value) return false;
      const latestMs = Date.parse(latest.timestamp);
      const handoverWindowMs = Math.max(
        REDUNDANT_SOURCE_HANDOVER_MIN_MS,
        Math.min(CLIMATE_UNCHANGED_HEARTBEAT_MS, this[tpLinkConnectionBridgeState].config.tpLinkPollIntervalMs * 3),
      );
      return Number.isFinite(latestMs) && Math.abs(timestampMs - latestMs) <= handoverWindowMs;
    },
  scheduleRestart(this: TpLinkConnectionBridgeInternals): void {
      if (!this[tpLinkConnectionBridgeState].running || this[tpLinkConnectionBridgeState].restartTimer) return;
      const delay = Math.min(60_000, 1_000 * 2 ** this[tpLinkConnectionBridgeState].attempt);
      this[tpLinkConnectionBridgeState].attempt = Math.min(this[tpLinkConnectionBridgeState].attempt + 1, 6);
      this[tpLinkConnectionBridgeState].restartTimer = setTimeout(() => {
        this[tpLinkConnectionBridgeState].restartTimer = null;
        this.spawnHelper();
      }, delay);
      this[tpLinkConnectionBridgeState].restartTimer.unref();
    },
});
