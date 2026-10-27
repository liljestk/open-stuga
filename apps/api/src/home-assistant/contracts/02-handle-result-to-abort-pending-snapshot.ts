import type { OpeningState } from "@climate-twin/contracts";
import { EntityTarget, HaMessage, HaState, OpeningTarget } from "../support/01-home-assistant-measurement-binding-to-validate-entit.js";
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
    refreshOpeningStateHeartbeats(now?: number): void;
    applyState(state: HaState, fallbackTimestamp?: string): (EntityTarget & { timestamp: string; value: number }) | null;
    ingestMeasurementUpdate(update: EntityTarget & { timestamp: string; value: number }): void;
    ingestCachedClimate(sensorId: string, timestamp: string): void;
    scheduleReconnect(): void;
    clearConnectionTimers(): void;
    abortPendingSnapshot(error: string): void;
  }
}
