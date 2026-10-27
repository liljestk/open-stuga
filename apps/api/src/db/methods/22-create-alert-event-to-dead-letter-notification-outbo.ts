import { randomUUID } from "node:crypto";
import type { AlertDeliveryPolicy, AlertEvent, AlertRule, MeasurementSample, NotificationChannel, NotificationDeliveryStage, NotificationSubjectKind } from "@climate-twin/contracts";
import {
  apnsNotificationSnapshot,
  alertNotificationBindings,
  notificationSnapshot,
  operationalNotificationSnapshot,
  type AlertNotificationBindings,
} from "../../notification-snapshot.js";
import {
  DEFAULT_ALERT_DELIVERY_POLICY,
  normalizeAlertDeliveryPolicy,
  notificationScheduleDecision,
  policyFromJson,
  policyJson,
} from "../../notification-policy.js";
import { AlertTransition, DueAlertCondition, NotificationOutboxItem, boundedCollectionLimit } from "../support/01-json-value-to-area-equipment-row.js";
import { AlertEventRow, AlertRuleRow, MeasurementSampleRow } from "../support/02-equipment-attachment-row-to-sensor-data-gap-state.js";
import { eventFromRow, measurementSampleFromRow, ruleFromRow } from "../support/04-canonical-json-value-to-action-playbook-from-row.js";
import { registerDatabaseMethods } from "../core.js";

export const PENDING_ALERT_EVALUATION_SAMPLES_SQL = `SELECT queue.measurement_sample_id AS queue_id,
    sample.sensor_id, sample.metric, sample.value, sample.canonical_unit,
    sample.timestamp, sample.source, sample.quality
  FROM alert_evaluation_queue queue
  CROSS JOIN measurement_samples sample ON sample.id = queue.measurement_sample_id
  CROSS JOIN sensors sensor ON sensor.id = sample.sensor_id
  CROSS JOIN houses house ON house.id = sensor.house_id
  WHERE house.deleted_at IS NULL
  ORDER BY queue.measurement_sample_id
  LIMIT ?`;

registerDatabaseMethods({
  createAlertEvent(input: Omit<AlertEvent, "id" | "acknowledgedAt" | "resolvedAt">): AlertEvent {
      const event: AlertEvent = { ...input, id: randomUUID(), acknowledgedAt: null, resolvedAt: null };
      this.db.prepare(`INSERT INTO alert_events
        (id, rule_id, sensor_id, metric, value, threshold, severity, started_at, acknowledged_at, resolved_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(event.id, event.ruleId, event.sensorId, event.metric, event.value, event.threshold, event.severity,
          event.startedAt, null, null);
      return event;
    },
  applyAlertSample(
      rule: AlertRule,
      sample: MeasurementSample,
      conditionMet: boolean,
      notificationBindings?: AlertNotificationBindings,
    ): AlertTransition {
      return this.immediateTransaction(() => {
        const state = this.db.prepare(`SELECT latest_timestamp, condition_since FROM alert_evaluation_state
          WHERE rule_id = ? AND sensor_id = ?`).get(rule.id, sample.sensorId) as {
            latest_timestamp: string;
            condition_since: string | null;
          } | undefined;
        const sampleMs = Date.parse(sample.timestamp);
        if (state && sampleMs <= Date.parse(state.latest_timestamp)) {
          return { ignoredAsStale: true, created: null, resolved: null };
        }
        const active = this.activeAlert(rule.id, sample.sensorId);
        const conditionSince = conditionMet ? state?.condition_since ?? sample.timestamp : null;
        this.db.prepare(`INSERT INTO alert_evaluation_state(rule_id, sensor_id, latest_timestamp, condition_since)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(rule_id, sensor_id) DO UPDATE SET
            latest_timestamp = excluded.latest_timestamp,
            condition_since = excluded.condition_since`)
          .run(rule.id, sample.sensorId, sample.timestamp, conditionSince);

        if (!conditionMet) {
          if (!active) return { ignoredAsStale: false, created: null, resolved: null };
          const resolvedAt = new Date(Math.max(sampleMs, Date.parse(active.startedAt))).toISOString();
          this.db.prepare("UPDATE alert_events SET resolved_at = COALESCE(resolved_at, ?) WHERE id = ?")
            .run(resolvedAt, active.id);
          return { ignoredAsStale: false, created: null, resolved: this.getAlertEvent(active.id) };
        }
        if (active || !conditionSince || sampleMs - Date.parse(conditionSince) < rule.durationSeconds * 1_000) {
          return { ignoredAsStale: false, created: null, resolved: null };
        }
        const created = this.createAlertEvent({
          ruleId: rule.id,
          sensorId: sample.sensorId,
          metric: rule.metric,
          value: sample.value,
          threshold: rule.threshold,
          severity: rule.severity,
          startedAt: conditionSince,
        });
        if (sample.source !== "mock" && sample.source !== "replay") {
          const now = new Date();
          const policy = normalizeAlertDeliveryPolicy(rule.deliveryPolicy);
          const schedule = notificationScheduleDecision(policy, created.severity, now);
          const sensor = this.getSensor(created.sensorId);
          const house = sensor ? this.getHouse(sensor.houseId) : null;
          const bindings = notificationBindings ?? alertNotificationBindings(undefined, {
            houseLabel: house?.name ?? null,
            sensorLabel: sensor?.name ?? null,
          });
          const enqueue = this.db.prepare(`INSERT OR IGNORE INTO notification_outbox
            (id, subject_kind, subject_id, event_id, stage, sequence, channel, destination_id, attempts, max_attempts,
             available_at, locked_at, lock_token, last_error, created_at, delivered_at, payload_json,
             destination_ref, policy_json, dead_lettered_at, abandoned_at)
            VALUES (?, 'alert', ?, ?, 'initial', 0, ?, ?, 0, ?, ?, NULL, NULL, NULL, ?, NULL, ?, ?, ?, NULL, NULL)`);
          if (rule.webhookEnabled) {
            for (const destination of bindings.webhookDestinations) {
              const snapshot = notificationSnapshot(
                "webhook", created, rule, bindings, schedule.silent, "initial", destination.destinationId,
              );
              enqueue.run(randomUUID(), created.id, created.id, "webhook", destination.destinationId, policy.maxAttempts,
                schedule.deliverAt.toISOString(), now.toISOString(), snapshot.payloadJson, snapshot.destinationRef, policyJson(policy));
            }
          }
          if (rule.telegramEnabled) {
            const snapshot = notificationSnapshot("telegram", created, rule, bindings, schedule.silent);
            enqueue.run(randomUUID(), created.id, created.id, "telegram", "primary", policy.maxAttempts,
              schedule.deliverAt.toISOString(), now.toISOString(), snapshot.payloadJson, snapshot.destinationRef, policyJson(policy));
          }
          for (const destination of bindings.apnsEnabled && house
            ? this.listIOSPushDestinations(house.id, created.severity)
            : []) {
            const notification = apnsNotificationSnapshot(
              created,
              rule,
              bindings,
              destination,
              bindings.apnsProviderRef,
              schedule.silent,
            );
            enqueue.run(
              randomUUID(),
              created.id,
              created.id,
              "apns",
              destination.registrationId,
              policy.maxAttempts,
              schedule.deliverAt.toISOString(),
              now.toISOString(),
              notification.payloadJson,
              notification.destinationRef,
              policyJson(policy),
            );
          }
        }
        return { ignoredAsStale: false, created, resolved: null };
      });
    },
  listPendingAlertEvaluationSamples(limit = 500): Array<{
      queueId: number;
      sample: MeasurementSample;
    }> {
      // CROSS JOIN is intentional: SQLite must drive this hot path from the
      // bounded durable queue, including when the queue is empty.
      const rows = this.db.prepare(PENDING_ALERT_EVALUATION_SAMPLES_SQL)
        .all(boundedCollectionLimit(limit)) as unknown as Array<MeasurementSampleRow & {
          queue_id: number;
        }>;
      return rows.map((row) => ({
        queueId: row.queue_id,
        sample: measurementSampleFromRow(row),
      }));
    },
  completeAlertEvaluationSample(queueId: number): boolean {
      if (!Number.isSafeInteger(queueId) || queueId < 1) return false;
      return Number(this.db.prepare("DELETE FROM alert_evaluation_queue WHERE measurement_sample_id = ?")
        .run(queueId).changes) > 0;
    },
  listDueAlertConditions(now = new Date(), limit = 500): DueAlertCondition[] {
      const rows = this.db.prepare(`SELECT rule.*, state.sensor_id AS pending_sensor_id,
          state.condition_since AS pending_condition_since, state.latest_timestamp AS pending_latest_timestamp
        FROM alert_evaluation_state state
        JOIN alert_rules rule ON rule.id = state.rule_id
        JOIN sensors sensor ON sensor.id = state.sensor_id
        JOIN houses house ON house.id = sensor.house_id
        WHERE rule.enabled = 1 AND rule.retired_at IS NULL AND state.condition_since IS NOT NULL
          AND house.deleted_at IS NULL
          AND datetime(state.condition_since, '+' || rule.duration_seconds || ' seconds') <= datetime(?)
          AND NOT EXISTS (
            SELECT 1 FROM alert_events event
            WHERE event.rule_id = rule.id AND event.sensor_id = state.sensor_id AND event.resolved_at IS NULL
          )
        ORDER BY state.condition_since LIMIT ?`).all(now.toISOString(), boundedCollectionLimit(limit)) as unknown as Array<AlertRuleRow & {
          pending_sensor_id: string;
          pending_condition_since: string;
          pending_latest_timestamp: string;
        }>;
      return rows.map((row) => ({
        rule: ruleFromRow(row),
        sensorId: row.pending_sensor_id,
        conditionSince: row.pending_condition_since,
        latestTimestamp: row.pending_latest_timestamp,
      }));
    },
  enqueueAlertFollowup(
      event: AlertEvent,
      rule: AlertRule,
      stage: Extract<NotificationDeliveryStage, "escalation" | "reminder">,
      sequence: number,
      bindings: AlertNotificationBindings,
      now = new Date(),
    ): number {
      if (event.resolvedAt || event.acknowledgedAt || sequence < 0 || !Number.isInteger(sequence)) return 0;
      const policy = normalizeAlertDeliveryPolicy(rule.deliveryPolicy);
      const schedule = notificationScheduleDecision(policy, event.severity, now);
      const enqueue = this.db.prepare(`INSERT OR IGNORE INTO notification_outbox
        (id, subject_kind, subject_id, event_id, stage, sequence, channel, destination_id, attempts, max_attempts,
         available_at, locked_at, lock_token, last_error, created_at, delivered_at, payload_json, destination_ref,
         policy_json, dead_lettered_at, abandoned_at)
        VALUES (?, 'alert', ?, ?, ?, ?, ?, ?, 0, ?, ?, NULL, NULL, NULL, ?, NULL, ?, ?, ?, NULL, NULL)`);
      let inserted = 0;
      if (rule.webhookEnabled) {
        for (const destination of bindings.webhookDestinations) {
          const snapshot = notificationSnapshot(
            "webhook", event, rule, bindings, schedule.silent, stage, destination.destinationId,
          );
          inserted += Number(enqueue.run(randomUUID(), event.id, event.id, stage, sequence, "webhook",
            destination.destinationId, policy.maxAttempts, schedule.deliverAt.toISOString(), now.toISOString(),
            snapshot.payloadJson, snapshot.destinationRef, policyJson(policy)).changes);
        }
      }
      if (rule.telegramEnabled) {
        const snapshot = notificationSnapshot("telegram", event, rule, bindings, schedule.silent, stage);
        inserted += Number(enqueue.run(randomUUID(), event.id, event.id, stage, sequence, "telegram", "primary", policy.maxAttempts,
          schedule.deliverAt.toISOString(), now.toISOString(), snapshot.payloadJson, snapshot.destinationRef, policyJson(policy)).changes);
      }
      const sensor = this.getSensor(event.sensorId);
      for (const destination of bindings.apnsEnabled && sensor
        ? this.listIOSPushDestinations(sensor.houseId, event.severity)
        : []) {
        const notification = apnsNotificationSnapshot(
          event,
          rule,
          bindings,
          destination,
          bindings.apnsProviderRef,
          schedule.silent,
          stage,
        );
        inserted += Number(enqueue.run(
          randomUUID(),
          event.id,
          event.id,
          stage,
          sequence,
          "apns",
          destination.registrationId,
          policy.maxAttempts,
          schedule.deliverAt.toISOString(),
          now.toISOString(),
          notification.payloadJson,
          notification.destinationRef,
          policyJson(policy),
        ).changes);
      }
      return inserted;
    },
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
  clearAlertEvaluationState(): void {
      this.db.prepare("DELETE FROM alert_evaluation_state").run();
    },
  listAlertEvents(limit = 200, activeOnly = false, offset = 0): AlertEvent[] {
      const rows = this.db.prepare(`SELECT event.* FROM alert_events AS event
        JOIN sensors AS sensor ON sensor.id = event.sensor_id
        JOIN houses AS house ON house.id = sensor.house_id
        WHERE house.deleted_at IS NULL ${activeOnly ? "AND event.resolved_at IS NULL" : ""}
        ORDER BY event.started_at DESC LIMIT ? OFFSET ?`).all(limit, offset) as unknown as AlertEventRow[];
      return rows.map(eventFromRow);
    },
  activeAlert(ruleId: string, sensorId: string): AlertEvent | null {
      const row = this.db.prepare(`SELECT * FROM alert_events
        WHERE rule_id = ? AND sensor_id = ? AND resolved_at IS NULL ORDER BY started_at DESC LIMIT 1`)
        .get(ruleId, sensorId) as unknown as AlertEventRow | undefined;
      return row ? eventFromRow(row) : null;
    },
  acknowledgeAlert(id: string, timestamp: string): AlertEvent | null {
      this.db.prepare("UPDATE alert_events SET acknowledged_at = COALESCE(acknowledged_at, ?) WHERE id = ?").run(timestamp, id);
      return this.getAlertEvent(id);
    },
  resolveAlert(id: string, timestamp: string): AlertEvent | null {
      const current = this.getAlertEvent(id);
      if (!current) return null;
      const safeTimestamp = new Date(Math.max(Date.parse(timestamp), Date.parse(current.startedAt))).toISOString();
      this.db.prepare("UPDATE alert_events SET resolved_at = COALESCE(resolved_at, ?) WHERE id = ?").run(safeTimestamp, id);
      return this.getAlertEvent(id);
    },
  getAlertEvent(id: string): AlertEvent | null {
      const row = this.db.prepare(`SELECT event.* FROM alert_events AS event
        JOIN sensors AS sensor ON sensor.id = event.sensor_id
        JOIN houses AS house ON house.id = sensor.house_id
        WHERE event.id = ? AND house.deleted_at IS NULL`).get(id) as unknown as AlertEventRow | undefined;
      return row ? eventFromRow(row) : null;
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
});
