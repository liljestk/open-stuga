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
import { PendingTpLinkHistoryRequest, TapoOpeningTarget, TpLinkHistoryResultMessage, importTpLinkMappingFile, nonEmptyString, safeTpLinkHistoryFailure, validateTpLinkDeviceMappings } from "../support/01-tp-link-local-climate-history-capability-revision-to.js";
import "../core.js";

declare module "../core.js" {
  interface TpLinkConnectionBridgeInternals {
    start(): void;
    listDiscoveredDevices(): TpLinkDiscoveredDevice[];
    ownsSensor(sensorId: string): boolean;
    recoverHistory(sensorId: string, metric: string, from: string, to: string): Promise<SensorHistoryRecoveryResult>;
    recoverHistoryIsolated(
        sensorId: string,
        metric: string,
        from: string,
        to: string,
      ): Promise<SensorHistoryRecoveryResult>;
    runLiveHistoryRequest(
        child: ChildProcess,
        requestId: string,
        deviceId: string,
        sensorId: string,
        metric: string,
        fromMs: number,
        toMs: number,
        canonicalUnit: string,
      ): Promise<SensorHistoryRecoveryResult>;
    settlePendingHistory(
        pending: PendingTpLinkHistoryRequest,
        result: SensorHistoryRecoveryResult | Error,
      ): void;
    failPendingHistory(child: ChildProcess, message: string): void;
    runHistoryHelper(
        requestId: string,
        deviceId: string,
        sensorId: string,
        metric: string,
        fromMs: number,
        toMs: number,
        canonicalUnit: string,
      ): Promise<SensorHistoryRecoveryResult>;
    pausePollingForHistory(): Promise<void>;
    validateHistoryResult(
        message: TpLinkHistoryResultMessage,
        requestId: string,
        deviceId: string,
        sensorId: string,
        metric: string,
        fromMs: number,
        toMs: number,
        canonicalUnit: string,
      ): SensorHistoryRecoveryResult;
    resolvedMappings(): Map<string, string>;
    configuredOpeningTargets(): TapoOpeningTarget[];
  }

  interface TpLinkConnectionBridgeCore {
    start(): void;
    listDiscoveredDevices(): TpLinkDiscoveredDevice[];
    ownsSensor(sensorId: string): boolean;
    recoverHistory(sensorId: string, metric: string, from: string, to: string): Promise<SensorHistoryRecoveryResult>;
  }
}
