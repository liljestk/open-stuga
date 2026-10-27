import type {
  ActionPlaybook,
  ActionPlaybookInput,
  ActionRun,
  ActionRunStartInput,
  NotificationDeliveryStatus,
  ManualObservation,
  ManualObservationInput,
  MeasurementSample,
  ObservationRevision,
} from "@climate-twin/contracts";
import { LocalObservationRevisionActor, StoredObservation } from "../support/02-equipment-attachment-row-to-sensor-data-gap-state.js";
import "../core.js";

declare module "../core.js" {
  interface DatabaseInternals {
    listNotificationDeliveries(limit?: number): NotificationDeliveryStatus[];
    retryNotificationDelivery(id: string, at?: Date): boolean;
    releaseNotificationOutbox(id: string, lockToken: string, availableAt?: Date): boolean;
    abandonNotificationOutbox(id: string, lockToken: string, reason: string, abandonedAt?: Date): boolean;
    pruneNotificationDeliveryHistory(deliveredBefore: Date, terminalBefore: Date): number;
    pendingNotificationCount(): number;
    listActionPlaybooks(metric?: string, enabledOnly?: boolean): ActionPlaybook[];
    getActionPlaybook(id: string): ActionPlaybook | null;
    saveActionPlaybook(input: ActionPlaybookInput): ActionPlaybook;
    updateActionPlaybook(id: string, patch: Partial<ActionPlaybookInput>): ActionPlaybook | null;
    listActionRuns(options?: {
            houseId?: string;
            sensorId?: string;
            alertEventId?: string;
            activeOnly?: boolean;
            limit?: number;
        }): ActionRun[];
    getActionRun(id: string): ActionRun | null;
    startActionRun(input: ActionRunStartInput, now?: Date): ActionRun;
    completeActionRun(id: string, now?: Date): ActionRun | null;
    cancelActionRun(id: string, note?: string | null, now?: Date): ActionRun | null;
    verifyActionRun(id: string, samples: MeasurementSample[], now?: Date): ActionRun | null;
    verifyDueActionRuns(now?: Date): ActionRun[];
    listObservations(houseId?: string): ManualObservation[];
    getObservation(id: string): StoredObservation | null;
    getOrCreateObservation(input: ManualObservationInput, actor?: LocalObservationRevisionActor): {
            observation: ManualObservation;
            created: boolean;
        };
    listObservationRevisions(observationId: string): ObservationRevision[];
    createObservation(input: ManualObservationInput, actor?: LocalObservationRevisionActor): ManualObservation;
  }

  interface ClimateDatabaseCore {
    listNotificationDeliveries(limit?: number): NotificationDeliveryStatus[];
    retryNotificationDelivery(id: string, at?: Date): boolean;
    releaseNotificationOutbox(id: string, lockToken: string, availableAt?: Date): boolean;
    abandonNotificationOutbox(id: string, lockToken: string, reason: string, abandonedAt?: Date): boolean;
    pruneNotificationDeliveryHistory(deliveredBefore: Date, terminalBefore: Date): number;
    pendingNotificationCount(): number;
    listActionPlaybooks(metric?: string, enabledOnly?: boolean): ActionPlaybook[];
    getActionPlaybook(id: string): ActionPlaybook | null;
    saveActionPlaybook(input: ActionPlaybookInput): ActionPlaybook;
    updateActionPlaybook(id: string, patch: Partial<ActionPlaybookInput>): ActionPlaybook | null;
    listActionRuns(options?: {
            houseId?: string;
            sensorId?: string;
            alertEventId?: string;
            activeOnly?: boolean;
            limit?: number;
        }): ActionRun[];
    getActionRun(id: string): ActionRun | null;
    startActionRun(input: ActionRunStartInput, now?: Date): ActionRun;
    completeActionRun(id: string, now?: Date): ActionRun | null;
    cancelActionRun(id: string, note?: string | null, now?: Date): ActionRun | null;
    verifyActionRun(id: string, samples: MeasurementSample[], now?: Date): ActionRun | null;
    verifyDueActionRuns(now?: Date): ActionRun[];
    listObservations(houseId?: string): ManualObservation[];
    getObservation(id: string): StoredObservation | null;
    getOrCreateObservation(input: ManualObservationInput, actor?: LocalObservationRevisionActor): {
            observation: ManualObservation;
            created: boolean;
        };
    listObservationRevisions(observationId: string): ObservationRevision[];
    createObservation(input: ManualObservationInput, actor?: LocalObservationRevisionActor): ManualObservation;
  }
}
