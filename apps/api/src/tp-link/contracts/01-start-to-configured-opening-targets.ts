import { type ChildProcess } from "node:child_process";
import type { TpLinkDiscoveredDevice } from "@climate-twin/contracts";
import type {
  SensorHistoryRecoveryResult,
} from "../../sensor-gap-recovery.js";
import { PendingTpLinkHistoryRequest, TapoOpeningTarget, TpLinkHistoryResultMessage } from "../support/01-tp-link-local-climate-history-capability-revision-to.js";
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
