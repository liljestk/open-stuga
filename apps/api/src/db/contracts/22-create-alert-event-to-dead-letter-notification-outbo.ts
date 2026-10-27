import type {
  AlertEvent,
  AlertDeliveryPolicy,
  AlertRule,
  NotificationDeliveryStage,
  NotificationSubjectKind,
  MeasurementSample,
} from "@climate-twin/contracts";
import {
  type AlertNotificationBindings,
} from "../../notification-snapshot.js";
import { AlertTransition, DueAlertCondition, NotificationOutboxItem } from "../support/01-json-value-to-area-equipment-row.js";
import "../core.js";

declare module "../core.js" {
  interface DatabaseInternals {
    createAlertEvent(input: Omit<AlertEvent, "id" | "acknowledgedAt" | "resolvedAt">): AlertEvent;
    applyAlertSample(rule: AlertRule, sample: MeasurementSample, conditionMet: boolean, notificationBindings?: AlertNotificationBindings): AlertTransition;
    listPendingAlertEvaluationSamples(limit?: number): Array<{
            queueId: number;
            sample: MeasurementSample;
        }>;
    completeAlertEvaluationSample(queueId: number): boolean;
    listDueAlertConditions(now?: Date, limit?: number): DueAlertCondition[];
    enqueueAlertFollowup(event: AlertEvent, rule: AlertRule, stage: Extract<NotificationDeliveryStage, "escalation" | "reminder">, sequence: number, bindings: AlertNotificationBindings, now?: Date): number;
    enqueueOperationalNotification(input: {
            subjectKind: Extract<NotificationSubjectKind, "maintenance" | "action-run" | "system">;
            subjectId: string;
            stage: Extract<NotificationDeliveryStage, "due" | "verification" | "initial" | "resolved">;
            sequence?: number;
            policy?: AlertDeliveryPolicy;
            severity?: "info" | "warning" | "critical";
            webhookEnabled: boolean;
            telegramEnabled: boolean;
            config?: import("../../config.js").AppConfig;
            type: "maintenance.due" | "action.verification" | "system.health";
            text: string;
            data: unknown;
            now?: Date;
        }): number;
    clearAlertEvaluationState(): void;
    listAlertEvents(limit?: number, activeOnly?: boolean, offset?: number): AlertEvent[];
    activeAlert(ruleId: string, sensorId: string): AlertEvent | null;
    acknowledgeAlert(id: string, timestamp: string): AlertEvent | null;
    resolveAlert(id: string, timestamp: string): AlertEvent | null;
    getAlertEvent(id: string): AlertEvent | null;
    claimNotificationOutbox(limit?: number, now?: Date): NotificationOutboxItem[];
    completeNotificationOutbox(id: string, lockToken: string, deliveredAt?: Date): boolean;
    failNotificationOutbox(id: string, lockToken: string, error: string, retryAt: Date): boolean;
    deadLetterNotificationOutbox(id: string, lockToken: string, error: string, at?: Date): boolean;
  }

  interface ClimateDatabaseCore {
    createAlertEvent(input: Omit<AlertEvent, "id" | "acknowledgedAt" | "resolvedAt">): AlertEvent;
    applyAlertSample(rule: AlertRule, sample: MeasurementSample, conditionMet: boolean, notificationBindings?: AlertNotificationBindings): AlertTransition;
    listPendingAlertEvaluationSamples(limit?: number): Array<{
            queueId: number;
            sample: MeasurementSample;
        }>;
    completeAlertEvaluationSample(queueId: number): boolean;
    listDueAlertConditions(now?: Date, limit?: number): DueAlertCondition[];
    enqueueAlertFollowup(event: AlertEvent, rule: AlertRule, stage: Extract<NotificationDeliveryStage, "escalation" | "reminder">, sequence: number, bindings: AlertNotificationBindings, now?: Date): number;
    enqueueOperationalNotification(input: {
            subjectKind: Extract<NotificationSubjectKind, "maintenance" | "action-run" | "system">;
            subjectId: string;
            stage: Extract<NotificationDeliveryStage, "due" | "verification" | "initial" | "resolved">;
            sequence?: number;
            policy?: AlertDeliveryPolicy;
            severity?: "info" | "warning" | "critical";
            webhookEnabled: boolean;
            telegramEnabled: boolean;
            config?: import("../../config.js").AppConfig;
            type: "maintenance.due" | "action.verification" | "system.health";
            text: string;
            data: unknown;
            now?: Date;
        }): number;
    clearAlertEvaluationState(): void;
    listAlertEvents(limit?: number, activeOnly?: boolean, offset?: number): AlertEvent[];
    activeAlert(ruleId: string, sensorId: string): AlertEvent | null;
    acknowledgeAlert(id: string, timestamp: string): AlertEvent | null;
    resolveAlert(id: string, timestamp: string): AlertEvent | null;
    getAlertEvent(id: string): AlertEvent | null;
    claimNotificationOutbox(limit?: number, now?: Date): NotificationOutboxItem[];
    completeNotificationOutbox(id: string, lockToken: string, deliveredAt?: Date): boolean;
    failNotificationOutbox(id: string, lockToken: string, error: string, retryAt: Date): boolean;
    deadLetterNotificationOutbox(id: string, lockToken: string, error: string, at?: Date): boolean;
  }
}
