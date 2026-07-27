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
import { EntityTarget, HA_COMPOSITE_MAX_SKEW_MS, HA_OPENING_HEARTBEAT_MS, HA_SNAPSHOT_EVENT_BUFFER_LIMIT, HA_SNAPSHOT_TIMEOUT_MS, HaMessage, HaState, OpeningTarget, normalizeHomeAssistantElectricityMeasurement, normalizeHomeAssistantTemperature, normalizeHomeAssistantTimestamp } from "../support/01-home-assistant-measurement-binding-to-validate-entit.js";
import "../core.js";

declare module "../core.js" {
  interface HomeAssistantConnectionBridgeInternals {
    handleResult(message: HaMessage): void;
    ingestInitialStates(states: HaState[]): void;
    handleEvent(message: HaMessage): void;
    ingestEventState(state: HaState, fallbackTimestamp?: string): void;
    updateEntityAvailability(state: HaState): boolean;
    ingestOpeningState(state: HaState, fallbackTimestamp?: string, observedAtOverride?: string): string | null;
    recordOpeningState(target: OpeningTarget, state: OpeningState, timestamp: string): string | null;
    refreshOpeningStateHeartbeats(now?: unknown ): void;
    applyState(state: HaState, fallbackTimestamp?: string): (EntityTarget & { timestamp: string; value: number }) | null;
    ingestMeasurementUpdate(update: EntityTarget & { timestamp: string; value: number }): void;
    ingestCachedClimate(sensorId: string, timestamp: string): void;
    scheduleReconnect(): void;
    clearConnectionTimers(): void;
    abortPendingSnapshot(error: string): void;
  }
}
