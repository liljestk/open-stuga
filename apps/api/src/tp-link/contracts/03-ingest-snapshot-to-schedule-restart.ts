import type {
  SensorMetricAvailability,
} from "../../sensor-gap-recovery.js";
import { TpLinkContactEventsMessage, TpLinkSnapshotMessage } from "../support/01-tp-link-local-climate-history-capability-revision-to.js";
import "../core.js";

declare module "../core.js" {
  interface TpLinkConnectionBridgeInternals {
    ingestContactEvents(message: TpLinkContactEventsMessage): void;
    ingestSnapshot(message: TpLinkSnapshotMessage): void;
    publishStatusIfNeeded(nowMs?: number): void;
    notifyAvailabilityChangeIfNeeded(now?: Date): void;
    availability(now?: Date): SensorMetricAvailability[];
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
    availability(now?: Date): SensorMetricAvailability[];
  }
}
