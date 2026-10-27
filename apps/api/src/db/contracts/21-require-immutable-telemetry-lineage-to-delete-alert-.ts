import type {
  AlertEvent,
  AlertRule,
  IOSNotificationRegistration,
  IOSNotificationRegistrationInput,
} from "@climate-twin/contracts";
import type { APNSDestination } from "../../apns.js";
import { TelemetryArchiveWatermarks, TelemetryCascadeScope } from "../support/01-json-value-to-area-equipment-row.js";
import "../core.js";

declare module "../core.js" {
  interface DatabaseInternals {
    requireImmutableTelemetryLineage(
        scope: Exclude<TelemetryCascadeScope, "house-location">,
        resourceId: string,
      ): void;
    telemetryArchivePageSize(limit: number): number;
    purgeReadingsBefore(timestamp: string, batchSize?: number, archivedThrough?: TelemetryArchiveWatermarks): number;
    saveIOSNotificationRegistration(userId: string, id: string, input: IOSNotificationRegistrationInput, now?: Date): IOSNotificationRegistration;
    getIOSNotificationRegistration(userId: string, id: string): IOSNotificationRegistration | null;
    deleteIOSNotificationRegistration(userId: string, id: string): boolean;
    disableIOSNotificationRegistration(id: string): boolean;
    getIOSPushDestination(id: string): APNSDestination | null;
    getIOSPushDestinationForAlert(id: string, eventId: string): APNSDestination | null;
    listIOSPushDestinations(houseId: string, severity: AlertEvent["severity"]): APNSDestination[];
    listAlertRules(): AlertRule[];
    getAlertRule(id: string): AlertRule | null;
    saveAlertRule(input: Omit<AlertRule, "id"> & {
            id?: string;
        }): AlertRule;
    updateAlertRule(id: string, patch: Partial<Omit<AlertRule, "id">>): AlertRule | null;
    deleteAlertRule(id: string): boolean;
  }

  interface ClimateDatabaseCore {
    purgeReadingsBefore(timestamp: string, batchSize?: number, archivedThrough?: TelemetryArchiveWatermarks): number;
    saveIOSNotificationRegistration(userId: string, id: string, input: IOSNotificationRegistrationInput, now?: Date): IOSNotificationRegistration;
    getIOSNotificationRegistration(userId: string, id: string): IOSNotificationRegistration | null;
    deleteIOSNotificationRegistration(userId: string, id: string): boolean;
    disableIOSNotificationRegistration(id: string): boolean;
    getIOSPushDestination(id: string): APNSDestination | null;
    getIOSPushDestinationForAlert(id: string, eventId: string): APNSDestination | null;
    listIOSPushDestinations(houseId: string, severity: AlertEvent["severity"]): APNSDestination[];
    listAlertRules(): AlertRule[];
    getAlertRule(id: string): AlertRule | null;
    saveAlertRule(input: Omit<AlertRule, "id"> & {
            id?: string;
        }): AlertRule;
    updateAlertRule(id: string, patch: Partial<Omit<AlertRule, "id">>): AlertRule | null;
    deleteAlertRule(id: string): boolean;
  }
}
