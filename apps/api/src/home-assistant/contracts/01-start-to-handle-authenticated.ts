import type {
  SensorHistoryRecoveryResult,
  SensorMetricAvailability,
} from "../../sensor-gap-recovery.js";
import { EntityTarget, HaState, HomeAssistantEntityMapping, OpeningTarget } from "../support/01-home-assistant-measurement-binding-to-validate-entit.js";
import "../core.js";

declare module "../core.js" {
  interface HomeAssistantConnectionBridgeInternals {
    start(): void;
    availability(now?: Date): SensorMetricAvailability[];
    recoverHistory(sensorId: string, metric: string, from: string, to: string): Promise<SensorHistoryRecoveryResult>;
    normalizeHistoryValue(target: EntityTarget, state: HaState): number | null;
    configuredMappings(): HomeAssistantEntityMapping[];
    configuredOpeningTargets(): OpeningTarget[];
    combinedMappingFingerprint(mappings: HomeAssistantEntityMapping[], openings?: OpeningTarget[]): string;
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
    availability(now?: Date): SensorMetricAvailability[];
    recoverHistory(sensorId: string, metric: string, from: string, to: string): Promise<SensorHistoryRecoveryResult>;
    stop(): void;
    restart(): void;
    refreshMappings(): void;
  }
}
