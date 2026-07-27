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
import "../core.js";

declare module "../core.js" {
  interface TpLinkConnectionBridgeInternals {
    ingestSnapshot(message: TpLinkSnapshotMessage): void;
    availability(now?: unknown ): SensorMetricAvailability[];
    ingestElectricityMeasurement(
        deviceId: string,
        sensorId: string,
        metric: "power" | "energy",
        value: number,
        canonicalUnit: "W" | "kWh",
        timestamp: string,
        timestampMs: number,
        issues: string[],
      ): void;
    isRecentHomeAssistantEquivalent(
        sensorId: string,
        metric: string,
        value: number,
        timestampMs: number,
      ): boolean;
    scheduleRestart(): void;
  }

  interface TpLinkConnectionBridgeCore {
    availability(now?: unknown ): SensorMetricAvailability[];
  }
}
