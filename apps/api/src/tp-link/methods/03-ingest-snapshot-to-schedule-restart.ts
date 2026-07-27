import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { createInterface } from "node:readline";
import type { OpeningStateObservation, Reading, TpLinkDiscoveredDevice } from "@climate-twin/contracts";
import type { AppConfig } from "../../config.js";
import type { ClimateDatabase } from "../../db.js";
import type {
  SensorGapRecoveryAdapter,
  SensorHistoryRecoveryResult,
  SensorMetricAvailability,
} from "../../sensor-gap-recovery.js";
import { MeasurementService, RuntimeStatus, TelemetryService } from "../../services.js";
import { CLIMATE_UNCHANGED_HEARTBEAT_MS, CachedTpLinkDevice, REDUNDANT_SOURCE_HANDOVER_MIN_MS, STATE_UNCHANGED_HEARTBEAT_MS, TpLinkSnapshotMessage, finiteNumber, nonEmptyString, normalizeTpLinkTemperature } from "../support/01-tp-link-local-climate-history-capability-revision-to.js";
import { registerTpLinkConnectionBridgeMethods, tpLinkConnectionBridgeState, type TpLinkConnectionBridgeInternals } from "../core.js";

registerTpLinkConnectionBridgeMethods({
  ingestSnapshot(this: TpLinkConnectionBridgeInternals, message: TpLinkSnapshotMessage): void {
      const timestamp = Number.isFinite(Date.parse(message.timestamp)) ? new Date(message.timestamp).toISOString() : new Date().toISOString();
      const hubModel = nonEmptyString(message.hubModel)?.toUpperCase() ?? "";
      const sourceType = message.sourceType ?? "hub";
      const supportedHub = hubModel === "H100" || hubModel === "H200";
      if (!supportedHub && sourceType !== "energy-device") {
        this[tpLinkConnectionBridgeState].status.value.tpLink.connected = false;
        this[tpLinkConnectionBridgeState].status.value.tpLink.error = `Unsupported TP-Link source model ${message.hubModel || "unknown"}`;
        this[tpLinkConnectionBridgeState].status.changed();
        return;
      }

      const sourceDeviceId = nonEmptyString(message.sourceDeviceId);
      if (sourceDeviceId && sourceDeviceId.length > 1_024) {
        this[tpLinkConnectionBridgeState].status.value.tpLink.connected = false;
        this[tpLinkConnectionBridgeState].status.value.tpLink.error = "TP-Link helper returned an invalid source identity";
        this[tpLinkConnectionBridgeState].status.changed();
        this[tpLinkConnectionBridgeState].managedConnection?.onAvailabilityChange?.();
        return;
      }
      if (this[tpLinkConnectionBridgeState].managedConnection?.deviceId && (!sourceDeviceId
        || this[tpLinkConnectionBridgeState].managedConnection.deviceId.trim().toUpperCase() !== sourceDeviceId.trim().toUpperCase())) {
        this[tpLinkConnectionBridgeState].status.value.tpLink.connected = false;
        this[tpLinkConnectionBridgeState].status.value.tpLink.error = "TP-Link helper returned a missing or different source identity at the saved address; polling was stopped to protect device bindings";
        this[tpLinkConnectionBridgeState].status.changed();
        this[tpLinkConnectionBridgeState].managedConnection.onAvailabilityChange?.();
        return;
      }
      if (sourceDeviceId && this[tpLinkConnectionBridgeState].managedConnection && !this[tpLinkConnectionBridgeState].managedConnection.deviceId) {
        const previousHost = this[tpLinkConnectionBridgeState].managedConnection.host;
        this[tpLinkConnectionBridgeState].managedConnection.deviceId = sourceDeviceId;
        this[tpLinkConnectionBridgeState].managedConnection.onUpdate?.({
          id: this[tpLinkConnectionBridgeState].managedConnection.id,
          houseId: this[tpLinkConnectionBridgeState].managedConnection.houseId,
          previousHost,
          host: previousHost,
          deviceId: sourceDeviceId,
        });
      }

      this[tpLinkConnectionBridgeState].attempt = 0;
      this[tpLinkConnectionBridgeState].status.value.tpLink.connected = true;
      this[tpLinkConnectionBridgeState].status.value.tpLink.lastPollAt = timestamp;
      this[tpLinkConnectionBridgeState].status.value.tpLink.hubModel = supportedHub ? hubModel : null;
      const devices = new Map<string, CachedTpLinkDevice>();
      for (const rawDevice of message.devices) {
        const deviceId = nonEmptyString(rawDevice?.deviceId);
        if (!deviceId) continue;
        const rawTemperature = finiteNumber(rawDevice.temperature);
        const device: CachedTpLinkDevice = {
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
        devices.set(deviceId, device);
        this[tpLinkConnectionBridgeState].discovered.set(deviceId, device);
      }
      this[tpLinkConnectionBridgeState].currentDevices.clear();
      for (const [deviceId, device] of devices) this[tpLinkConnectionBridgeState].currentDevices.set(deviceId, device);
      this[tpLinkConnectionBridgeState].status.value.tpLink.discoveredDevices = this[tpLinkConnectionBridgeState].discovered.size;
      const mappings = this.resolvedMappings();
      const issues: string[] = [];
      const timestampMs = Date.parse(timestamp);

      for (const target of this.configuredOpeningTargets()) {
        const device = devices.get(target.deviceId);
        if (!device) {
          issues.push(`Mapped Tapo contact ${target.deviceId} was not found`);
          continue;
        }
        if (device.status && device.status.toLowerCase() !== "online") continue;
        if (typeof device.contactOpen !== "boolean") {
          issues.push(`Mapped Tapo contact ${target.deviceId} does not expose contact state`);
          continue;
        }
        const state = device.contactOpen ? "open" : "closed";
        const targetKey = `${target.floorId}\u0000${target.elementId}`;
        const previous = this[tpLinkConnectionBridgeState].lastIngestedOpeningStates.get(targetKey);
        if (previous?.state === state && timestampMs - previous.ingestedAt < STATE_UNCHANGED_HEARTBEAT_MS) continue;
        try {
          const observation = this[tpLinkConnectionBridgeState].database.recordOpeningStateObservation(target.houseId, {
            floorId: target.floorId,
            elementId: target.elementId,
            state,
            source: "tapo",
            observedAt: timestamp,
            externalId: target.deviceId,
            connectionId: target.connectionId,
          });
          this[tpLinkConnectionBridgeState].managedConnection?.onOpeningStateRecorded?.(observation);
          this[tpLinkConnectionBridgeState].lastIngestedOpeningStates.set(targetKey, { state, ingestedAt: timestampMs });
        } catch (error) {
          const reason = error instanceof Error ? error.message : "ingestion failed";
          issues.push(`Could not ingest Tapo contact ${target.deviceId}: ${reason}`);
        }
      }

      for (const [deviceId, sensorId] of mappings) {
        const sensor = this[tpLinkConnectionBridgeState].database.getSensor(sensorId);
        if (!sensor) {
          issues.push(`Mapped TP-Link child ${deviceId} references unknown sensor ${sensorId}`);
          continue;
        }
        // Archived sensors retain ownership of their physical child device so it
        // cannot be accidentally offered or assigned elsewhere, but do not ingest.
        if (!sensor.enabled) continue;
        const device = devices.get(deviceId);
        if (!device) {
          issues.push(`Mapped TP-Link child ${deviceId} was not found`);
          continue;
        }
        if (device.status && device.status.toLowerCase() !== "online") {
          issues.push(`Mapped TP-Link child ${deviceId} is ${device.status}`);
          continue;
        }
        const temperature = device.temperature;
        const humidity = device.humidity;
        const battery = device.battery;
        const power = device.power ?? null;
        const energy = device.energy ?? null;
        const hasClimate = temperature !== null && humidity !== null;
        const hasEnergy = power !== null || energy !== null;
        if (!hasClimate && !hasEnergy) {
          issues.push(`Mapped TP-Link device ${deviceId} does not expose valid climate or energy data`);
          continue;
        }

        if (hasClimate) {
          const previous = this[tpLinkConnectionBridgeState].lastIngested.get(deviceId);
          const unchanged = previous?.sensorId === sensorId && previous.temperature === temperature
            && previous.humidity === humidity && previous.battery === battery;
          if (!unchanged || timestampMs - previous.ingestedAt >= CLIMATE_UNCHANGED_HEARTBEAT_MS) {
            const reading: Reading = {
              sensorId,
              timestamp,
              temperature,
              humidity,
              battery,
              source: "tp-link",
              quality: "good",
            };
            const redundantHandover = this.isRecentHomeAssistantEquivalent(
              sensorId, "temperature", temperature, timestampMs,
            ) && this.isRecentHomeAssistantEquivalent(sensorId, "humidity", humidity, timestampMs);
            if (redundantHandover) {
              this[tpLinkConnectionBridgeState].lastIngested.set(deviceId, { sensorId, temperature, humidity, battery, ingestedAt: timestampMs });
            } else {
              try {
                this[tpLinkConnectionBridgeState].telemetry.ingest(reading);
                this[tpLinkConnectionBridgeState].lastIngested.set(deviceId, { sensorId, temperature, humidity, battery, ingestedAt: timestampMs });
              } catch (error) {
                const reason = error instanceof Error ? error.message : "ingestion failed";
                issues.push(`Could not ingest TP-Link climate device ${deviceId}: ${reason}`);
              }
            }
          }
        }
        if (power !== null) this.ingestElectricityMeasurement(deviceId, sensorId, "power", power, "W", timestamp, timestampMs, issues);
        if (energy !== null) this.ingestElectricityMeasurement(deviceId, sensorId, "energy", energy, "kWh", timestamp, timestampMs, issues);
      }

      this[tpLinkConnectionBridgeState].status.value.tpLink.error = [this[tpLinkConnectionBridgeState].mappingWarning, ...issues].filter(Boolean).join("; ") || null;
      this[tpLinkConnectionBridgeState].status.changed();
      this[tpLinkConnectionBridgeState].managedConnection?.onAvailabilityChange?.();
    },
  availability(this: TpLinkConnectionBridgeInternals, now = new Date()): SensorMetricAvailability[] {
      const observedAt = now.toISOString();
      const lastPollMs = this[tpLinkConnectionBridgeState].status.value.tpLink.lastPollAt ? Date.parse(this[tpLinkConnectionBridgeState].status.value.tpLink.lastPollAt) : Number.NaN;
      const connectionFresh = this[tpLinkConnectionBridgeState].status.value.tpLink.connected && Number.isFinite(lastPollMs)
        && now.getTime() - lastPollMs <= Math.max(60_000, this[tpLinkConnectionBridgeState].config.tpLinkPollIntervalMs * 3);
      const availability: SensorMetricAvailability[] = [];
      for (const [deviceId, sensorId] of this.resolvedMappings()) {
        const sensor = this[tpLinkConnectionBridgeState].database.getSensor(sensorId);
        if (!sensor?.enabled) continue;
        const device = this[tpLinkConnectionBridgeState].currentDevices.get(deviceId);
        const metrics = new Set(this[tpLinkConnectionBridgeState].database.sensorSourceMetrics(sensorId, "tp-link"));
        if (device?.temperature !== null && device?.temperature !== undefined) metrics.add("temperature");
        if (device?.humidity !== null && device?.humidity !== undefined) metrics.add("humidity");
        if (device?.power !== null && device?.power !== undefined) metrics.add("power");
        if (device?.energy !== null && device?.energy !== undefined) metrics.add("energy");
        if (metrics.size === 0 && /T3(?:10|15)/i.test(sensor.model)) {
          metrics.add("temperature");
          metrics.add("humidity");
        }
        const online = connectionFresh && Boolean(device)
          && (!device?.status || device.status.toLowerCase() === "online");
        for (const metric of metrics) {
          const exposesMetric = metric === "temperature" ? device?.temperature !== null && device?.temperature !== undefined
            : metric === "humidity" ? device?.humidity !== null && device?.humidity !== undefined
              : metric === "power" ? device?.power !== null && device?.power !== undefined
                : metric === "energy" ? device?.energy !== null && device?.energy !== undefined
                  : false;
          availability.push({ sensorId, metric, source: "tp-link", available: online && exposesMetric, observedAt });
        }
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
