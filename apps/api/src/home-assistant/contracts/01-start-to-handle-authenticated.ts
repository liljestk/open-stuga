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
import { AUTOMATIC_ELECTRICITY_METRICS, EntityTarget, HA_HANDSHAKE_TIMEOUT_MS, HA_HISTORY_CHUNK_MS, HaState, HomeAssistantEntityMapping, OpeningTarget, normalizeHomeAssistantElectricityMeasurement, normalizeHomeAssistantTemperature, websocketUrl } from "../support/01-home-assistant-measurement-binding-to-validate-entit.js";
import { importEntityMappingFile, mappedEntityIds, mappingFingerprint, mappingMetricKeys, parseHaMessage, sensorMetricKey, validateEntityMappings } from "../support/02-validate-entity-mappings-to-home-assistant-bridge.js";
import "../core.js";

declare module "../core.js" {
  interface HomeAssistantConnectionBridgeInternals {
    start(): void;
    availability(now?: unknown ): SensorMetricAvailability[];
    recoverHistory(sensorId: string, metric: string, from: string, to: string): Promise<SensorHistoryRecoveryResult>;
    normalizeHistoryValue(target: EntityTarget, state: HaState): number | null;
    configuredMappings(): HomeAssistantEntityMapping[];
    configuredOpeningTargets(): OpeningTarget[];
    combinedMappingFingerprint(mappings: HomeAssistantEntityMapping[], openings?: unknown ): string;
    registerMapping(mapping: HomeAssistantEntityMapping): void;
    registerEntity(entityId: string, target: EntityTarget): void;
    registerOpening(target: OpeningTarget): void;
    stop(): void;
    restart(): void;
    refreshMappings(): void;
    connect(): void;
    onMessage(raw: string): void;
    handleAuthenticated(): void;
  }

  interface HomeAssistantConnectionBridgeCore {
    start(): void;
    availability(now?: unknown ): SensorMetricAvailability[];
    recoverHistory(sensorId: string, metric: string, from: string, to: string): Promise<SensorHistoryRecoveryResult>;
    stop(): void;
    restart(): void;
    refreshMappings(): void;
  }
}
