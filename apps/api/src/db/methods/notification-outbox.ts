import { randomUUID } from "node:crypto";
import type { AlertDeliveryPolicy, NotificationChannel, NotificationDeliveryStage, NotificationSubjectKind, NotificationDeliveryStatus } from "@climate-twin/contracts";
import { alertNotificationBindings, operationalNotificationSnapshot } from "../../notification-snapshot.js";
import { DEFAULT_ALERT_DELIVERY_POLICY, normalizeAlertDeliveryPolicy, notificationScheduleDecision, policyFromJson, policyJson } from "../../notification-policy.js";
import { NotificationOutboxItem } from "../support/record-types.js";
import { boundedCollectionLimit } from "../support/domain-limits.js";
import { registerDatabaseMethods } from "../core.js";

// Deliveries whose alert belongs to a deleted house are hidden everywhere.
const VISIBLE_DELIVERIES = `SELECT id, subject_kind, subject_id, stage, sequence, channel, destination_id, attempts, max_attempts,
    available_at, created_at, delivered_at, dead_lettered_at, abandoned_at, last_error
  FROM notification_outbox
  WHERE (subject_kind <> 'alert' OR EXISTS (
    SELECT 1 FROM alert_events AS event
    JOIN sensors AS sensor ON sensor.id = event.sensor_id
    JOIN houses AS house ON house.id = sensor.house_id
    WHERE event.id = notification_outbox.subject_id AND house.deleted_at IS NULL
  ))`;

interface DeliveryRow {
  id: string; subject_kind: NotificationSubjectKind; subject_id: string; stage: NotificationDeliveryStage; sequence: number;
  channel: NotificationChannel; destination_id: string; attempts: number; max_attempts: number; available_at: string;
  created_at: string; delivered_at: string | null; dead_lettered_at: string | null;
  abandoned_at: string | null; last_error: string | null;
}

function deliveryFromRow(row: DeliveryRow): NotificationDeliveryStatus {
  return {
    id: row.id, subjectKind: row.subject_kind, subjectId: row.subject_id, stage: row.stage, sequence: row.sequence,
    channel: row.channel, destinationId: row.destination_id, attempts: row.attempts, maxAttempts: row.max_attempts,
    availableAt: row.available_at, createdAt: row.created_at, deliveredAt: row.delivered_at,
    deadLetteredAt: row.dead_lettered_at, abandonedAt: row.abandoned_at, lastError: row.last_error,
  };
}

declare module "../core.js" {
  interface DatabaseInternals {
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
    claimNotificationOutbox(limit?: number, now?: Date): NotificationOutboxItem[];
    completeNotificationOutbox(id: string, lockToken: string, deliveredAt?: Date): boolean;
    failNotificationOutbox(id: string, lockToken: string, error: string, retryAt: Date): boolean;
    deadLetterNotificationOutbox(id: string, lockToken: string, error: string, at?: Date): boolean;
    listNotificationDeliveries(limit?: number): NotificationDeliveryStatus[];
    getNotificationDelivery(id: string): NotificationDeliveryStatus | null;
    retryNotificationDelivery(id: string, at?: Date): boolean;
    releaseNotificationOutbox(id: string, lockToken: string, availableAt?: Date): boolean;
    abandonNotificationOutbox(id: string, lockToken: string, reason: string, abandonedAt?: Date): boolean;
    pruneNotificationDeliveryHistory(deliveredBefore: Date, terminalBefore: Date): number;
    pendingNotificationCount(): number;
  }

  interface ClimateDatabaseCore {
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
    claimNotificationOutbox(limit?: number, now?: Date): NotificationOutboxItem[];
    completeNotificationOutbox(id: string, lockToken: string, deliveredAt?: Date): boolean;
    failNotificationOutbox(id: string, lockToken: string, error: string, retryAt: Date): boolean;
    deadLetterNotificationOutbox(id: string, lockToken: string, error: string, at?: Date): boolean;
    listNotificationDeliveries(limit?: number): NotificationDeliveryStatus[];
    getNotificationDelivery(id: string): NotificationDeliveryStatus | null;
    retryNotificationDelivery(id: string, at?: Date): boolean;
    releaseNotificationOutbox(id: string, lockToken: string, availableAt?: Date): boolean;
    abandonNotificationOutbox(id: string, lockToken: string, reason: string, abandonedAt?: Date): boolean;
    pruneNotificationDeliveryHistory(deliveredBefore: Date, terminalBefore: Date): number;
    pendingNotificationCount(): number;
  }
}

registerDatabaseMethods({
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
    }): number {
      const sequence = input.sequence ?? 0;
      if (!Number.isSafeInteger(sequence) || sequence < 0 || !input.subjectId) return 0;
      const now = input.now ?? new Date();
      const policy = normalizeAlertDeliveryPolicy(input.policy ?? DEFAULT_ALERT_DELIVERY_POLICY);
      const schedule = notificationScheduleDecision(policy, input.severity ?? "warning", now);
      const enqueue = this.db.prepare(`INSERT OR IGNORE INTO notification_outbox
        (id, subject_kind, subject_id, event_id, stage, sequence, channel, destination_id, attempts, max_attempts,
         available_at, locked_at, lock_token, last_error, created_at, delivered_at, payload_json, destination_ref,
         policy_json, dead_lettered_at, abandoned_at)
        VALUES (?, ?, ?, NULL, ?, ?, ?, ?, 0, ?, ?, NULL, NULL, NULL, ?, NULL, ?, ?, ?, NULL, NULL)`);
      let inserted = 0;
      if (input.webhookEnabled) {
        const destinations = alertNotificationBindings(input.config, { houseLabel: null, sensorLabel: null })
          .webhookDestinations;
        for (const destination of destinations) {
          const snapshot = operationalNotificationSnapshot("webhook", input.config, {
            type: input.type,
            subjectId: input.subjectId,
            text: input.text,
            data: input.data,
            silent: schedule.silent || input.severity === "info",
          }, destination.destinationId);
          inserted += Number(enqueue.run(randomUUID(), input.subjectKind, input.subjectId, input.stage, sequence,
            "webhook", destination.destinationId, policy.maxAttempts, schedule.deliverAt.toISOString(), now.toISOString(),
            snapshot.payloadJson, snapshot.destinationRef, policyJson(policy)).changes);
        }
      }
      if (input.telegramEnabled) {
        const snapshot = operationalNotificationSnapshot("telegram", input.config, {
          type: input.type,
          subjectId: input.subjectId,
          text: input.text,
          data: input.data,
          silent: schedule.silent || input.severity === "info",
        });
        inserted += Number(enqueue.run(randomUUID(), input.subjectKind, input.subjectId, input.stage, sequence, "telegram",
          "primary", policy.maxAttempts, schedule.deliverAt.toISOString(), now.toISOString(), snapshot.payloadJson,
          snapshot.destinationRef, policyJson(policy)).changes);
      }
      return inserted;
    },
  claimNotificationOutbox(limit = 20, now = new Date()): NotificationOutboxItem[] {
      return this.immediateTransaction(() => {
        const nowIso = now.toISOString();
        const staleLock = new Date(now.getTime() - 5 * 60_000).toISOString();
        const rows = this.db.prepare(`SELECT id, subject_kind, subject_id, event_id, stage, sequence, channel, destination_id,
            payload_json, destination_ref, policy_json, max_attempts, attempts FROM notification_outbox
          WHERE delivered_at IS NULL AND dead_lettered_at IS NULL AND abandoned_at IS NULL AND available_at <= ?
            AND (locked_at IS NULL OR locked_at <= ?)
            AND (subject_kind <> 'alert' OR EXISTS (
              SELECT 1 FROM alert_events AS event
              JOIN sensors AS sensor ON sensor.id = event.sensor_id
              JOIN houses AS house ON house.id = sensor.house_id
              WHERE event.id = notification_outbox.subject_id AND house.deleted_at IS NULL
            ))
          ORDER BY available_at, created_at LIMIT ?`).all(nowIso, staleLock, limit) as Array<{
            id: string;
            subject_kind: NotificationSubjectKind;
            subject_id: string;
            event_id: string | null;
            stage: NotificationDeliveryStage;
            sequence: number;
            channel: NotificationChannel;
            destination_id: string;
            payload_json: string;
            destination_ref: string;
            policy_json: string;
            max_attempts: number;
            attempts: number;
          }>;
        return rows.flatMap((row) => {
          const lockToken = randomUUID();
          const changed = Number(this.db.prepare(`UPDATE notification_outbox SET locked_at = ?, lock_token = ?
            WHERE id = ? AND delivered_at IS NULL AND dead_lettered_at IS NULL AND abandoned_at IS NULL
              AND (locked_at IS NULL OR locked_at <= ?)`)
            .run(nowIso, lockToken, row.id, staleLock).changes);
          return changed ? [{
            id: row.id,
            subjectKind: row.subject_kind,
            subjectId: row.subject_id,
            eventId: row.event_id,
            stage: row.stage,
            sequence: row.sequence,
            channel: row.channel,
            destinationId: row.destination_id,
            payloadJson: row.payload_json,
            destinationRef: row.destination_ref,
            policy: policyFromJson(row.policy_json),
            maxAttempts: row.max_attempts,
            attempts: row.attempts,
            lockToken,
          }] : [];
        });
      });
    },
  completeNotificationOutbox(id: string, lockToken: string, deliveredAt = new Date()): boolean {
      return Number(this.db.prepare(`UPDATE notification_outbox SET delivered_at = ?, locked_at = NULL, lock_token = NULL,
        last_error = NULL WHERE id = ? AND lock_token = ? AND delivered_at IS NULL`)
        .run(deliveredAt.toISOString(), id, lockToken).changes) > 0;
    },
  failNotificationOutbox(id: string, lockToken: string, error: string, retryAt: Date): boolean {
      return Number(this.db.prepare(`UPDATE notification_outbox SET attempts = attempts + 1, available_at = ?,
        locked_at = NULL, lock_token = NULL, last_error = ? WHERE id = ? AND lock_token = ? AND delivered_at IS NULL`)
        .run(retryAt.toISOString(), error.slice(0, 500), id, lockToken).changes) > 0;
    },
  deadLetterNotificationOutbox(id: string, lockToken: string, error: string, at = new Date()): boolean {
      return Number(this.db.prepare(`UPDATE notification_outbox SET attempts = attempts + 1, dead_lettered_at = ?,
        locked_at = NULL, lock_token = NULL, last_error = ?
        WHERE id = ? AND lock_token = ? AND delivered_at IS NULL AND dead_lettered_at IS NULL`)
        .run(at.toISOString(), error.slice(0, 500), id, lockToken).changes) > 0;
    },
  listNotificationDeliveries(limit = 200): NotificationDeliveryStatus[] {
      return (this.db.prepare(`${VISIBLE_DELIVERIES} ORDER BY created_at DESC LIMIT ?`)
        .all(boundedCollectionLimit(limit)) as unknown as DeliveryRow[]).map(deliveryFromRow);
    },
  getNotificationDelivery(id: string): NotificationDeliveryStatus | null {
      const row = this.db.prepare(`${VISIBLE_DELIVERIES} AND id = ?`).get(id) as DeliveryRow | undefined;
      return row ? deliveryFromRow(row) : null;
    },
  retryNotificationDelivery(id: string, at = new Date()): boolean {
      return Number(this.db.prepare(`UPDATE notification_outbox SET attempts = 0, available_at = ?, locked_at = NULL,
        lock_token = NULL, dead_lettered_at = NULL, abandoned_at = NULL, last_error = NULL
        WHERE id = ? AND delivered_at IS NULL AND (dead_lettered_at IS NOT NULL OR abandoned_at IS NOT NULL)
          AND (subject_kind <> 'alert' OR EXISTS (
            SELECT 1 FROM alert_events AS event
            JOIN sensors AS sensor ON sensor.id = event.sensor_id
            JOIN houses AS house ON house.id = sensor.house_id
            WHERE event.id = notification_outbox.subject_id AND house.deleted_at IS NULL
          ))`)
        .run(at.toISOString(), id).changes) > 0;
    },
  releaseNotificationOutbox(id: string, lockToken: string, availableAt = new Date()): boolean {
      return Number(this.db.prepare(`UPDATE notification_outbox SET available_at = ?, locked_at = NULL,
        lock_token = NULL WHERE id = ? AND lock_token = ? AND delivered_at IS NULL`)
        .run(availableAt.toISOString(), id, lockToken).changes) > 0;
    },
  abandonNotificationOutbox(id: string, lockToken: string, reason: string, abandonedAt = new Date()): boolean {
      return Number(this.db.prepare(`UPDATE notification_outbox SET abandoned_at = ?, locked_at = NULL,
        lock_token = NULL, last_error = ? WHERE id = ? AND lock_token = ? AND delivered_at IS NULL
          AND abandoned_at IS NULL`)
        .run(abandonedAt.toISOString(), reason.slice(0, 500), id, lockToken).changes) > 0;
    },
  pruneNotificationDeliveryHistory(deliveredBefore: Date, terminalBefore: Date): number {
      return Number(this.db.prepare(`DELETE FROM notification_outbox
        WHERE (delivered_at IS NOT NULL AND delivered_at < ?)
          OR (delivered_at IS NULL AND dead_lettered_at IS NOT NULL AND dead_lettered_at < ?)
          OR (delivered_at IS NULL AND abandoned_at IS NOT NULL AND abandoned_at < ?)`)
        .run(deliveredBefore.toISOString(), terminalBefore.toISOString(), terminalBefore.toISOString()).changes);
    },
  pendingNotificationCount(): number {
      return Number((this.db.prepare(`SELECT COUNT(*) AS count FROM notification_outbox
        WHERE delivered_at IS NULL AND dead_lettered_at IS NULL AND abandoned_at IS NULL
          AND (subject_kind <> 'alert' OR EXISTS (
            SELECT 1 FROM alert_events AS event
            JOIN sensors AS sensor ON sensor.id = event.sensor_id
            JOIN houses AS house ON house.id = sensor.house_id
            WHERE event.id = notification_outbox.subject_id AND house.deleted_at IS NULL
          ))`)
        .get() as { count: number }).count);
    },
});
