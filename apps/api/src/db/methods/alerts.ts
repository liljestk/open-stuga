import { randomUUID } from "node:crypto";
import type { AlertEvent, AlertRule, MeasurementSample, NotificationDeliveryStage } from "@climate-twin/contracts";
import { normalizeAlertDeliveryPolicy, policyJson, notificationScheduleDecision } from "../../notification-policy.js";
import { AlertTransition, DueAlertCondition } from "../support/record-types.js";
import { boundedCollectionLimit } from "../support/domain-limits.js";
import { AlertRuleRow, AlertEventRow, MeasurementSampleRow } from "../support/row-types.js";
import { ruleFromRow, eventFromRow, measurementSampleFromRow } from "../support/row-mappers.js";
import { registerDatabaseMethods } from "../core.js";
import { apnsNotificationSnapshot, alertNotificationBindings, notificationSnapshot, type AlertNotificationBindings } from "../../notification-snapshot.js";

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

declare module "../core.js" {
  interface DatabaseInternals {
    listAlertRules(): AlertRule[];
    getAlertRule(id: string): AlertRule | null;
    saveAlertRule(input: Omit<AlertRule, "id"> & {
            id?: string;
        }): AlertRule;
    updateAlertRule(id: string, patch: Partial<Omit<AlertRule, "id">>): AlertRule | null;
    deleteAlertRule(id: string): boolean;
    createAlertEvent(input: Omit<AlertEvent, "id" | "acknowledgedAt" | "resolvedAt">): AlertEvent;
    applyAlertSample(rule: AlertRule, sample: MeasurementSample, conditionMet: boolean, notificationBindings?: AlertNotificationBindings): AlertTransition;
    listPendingAlertEvaluationSamples(limit?: number): Array<{
            queueId: number;
            sample: MeasurementSample;
        }>;
    completeAlertEvaluationSample(queueId: number): boolean;
    listDueAlertConditions(now?: Date, limit?: number): DueAlertCondition[];
    enqueueAlertFollowup(event: AlertEvent, rule: AlertRule, stage: Extract<NotificationDeliveryStage, "escalation" | "reminder">, sequence: number, bindings: AlertNotificationBindings, now?: Date): number;
    clearAlertEvaluationState(): void;
    listAlertEvents(limit?: number, activeOnly?: boolean, offset?: number): AlertEvent[];
    activeAlert(ruleId: string, sensorId: string): AlertEvent | null;
    acknowledgeAlert(id: string, timestamp: string): AlertEvent | null;
    resolveAlert(id: string, timestamp: string): AlertEvent | null;
    getAlertEvent(id: string): AlertEvent | null;
  }

  interface ClimateDatabaseCore {
    listAlertRules(): AlertRule[];
    getAlertRule(id: string): AlertRule | null;
    saveAlertRule(input: Omit<AlertRule, "id"> & {
            id?: string;
        }): AlertRule;
    updateAlertRule(id: string, patch: Partial<Omit<AlertRule, "id">>): AlertRule | null;
    deleteAlertRule(id: string): boolean;
    createAlertEvent(input: Omit<AlertEvent, "id" | "acknowledgedAt" | "resolvedAt">): AlertEvent;
    applyAlertSample(rule: AlertRule, sample: MeasurementSample, conditionMet: boolean, notificationBindings?: AlertNotificationBindings): AlertTransition;
    listPendingAlertEvaluationSamples(limit?: number): Array<{
            queueId: number;
            sample: MeasurementSample;
        }>;
    completeAlertEvaluationSample(queueId: number): boolean;
    listDueAlertConditions(now?: Date, limit?: number): DueAlertCondition[];
    enqueueAlertFollowup(event: AlertEvent, rule: AlertRule, stage: Extract<NotificationDeliveryStage, "escalation" | "reminder">, sequence: number, bindings: AlertNotificationBindings, now?: Date): number;
    clearAlertEvaluationState(): void;
    listAlertEvents(limit?: number, activeOnly?: boolean, offset?: number): AlertEvent[];
    activeAlert(ruleId: string, sensorId: string): AlertEvent | null;
    acknowledgeAlert(id: string, timestamp: string): AlertEvent | null;
    resolveAlert(id: string, timestamp: string): AlertEvent | null;
    getAlertEvent(id: string): AlertEvent | null;
  }
}

registerDatabaseMethods({
  listAlertRules(): AlertRule[] {
      return (this.db.prepare(`SELECT rule.* FROM alert_rules AS rule
        LEFT JOIN sensors AS sensor ON sensor.id = rule.sensor_id
        LEFT JOIN houses AS house ON house.id = sensor.house_id
        WHERE rule.retired_at IS NULL AND (rule.sensor_id IS NULL OR house.deleted_at IS NULL)
        ORDER BY rule.name`)
        .all() as unknown as AlertRuleRow[]).map(ruleFromRow);
    },
  getAlertRule(id: string): AlertRule | null {
      const row = this.db.prepare(`SELECT rule.* FROM alert_rules AS rule
        LEFT JOIN sensors AS sensor ON sensor.id = rule.sensor_id
        LEFT JOIN houses AS house ON house.id = sensor.house_id
        WHERE rule.id = ? AND rule.retired_at IS NULL
          AND (rule.sensor_id IS NULL OR house.deleted_at IS NULL)`)
        .get(id) as unknown as AlertRuleRow | undefined;
      return row ? ruleFromRow(row) : null;
    },
  saveAlertRule(input: Omit<AlertRule, "id"> & { id?: string }): AlertRule {
      const deliveryPolicy = normalizeAlertDeliveryPolicy(input.deliveryPolicy);
      const rule: AlertRule = {
        ...input,
        id: input.id ?? randomUUID(),
        deliveryPolicy,
      };
      this.db.prepare(`INSERT INTO alert_rules
        (id, name, sensor_id, metric, operator, threshold, duration_seconds, severity, enabled, webhook_enabled,
         telegram_enabled, delivery_policy_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(rule.id, rule.name, rule.sensorId, rule.metric, rule.operator, rule.threshold, rule.durationSeconds,
          rule.severity, rule.enabled ? 1 : 0, rule.webhookEnabled ? 1 : 0, rule.telegramEnabled ? 1 : 0,
          policyJson(deliveryPolicy));
      return rule;
    },
  updateAlertRule(id: string, patch: Partial<Omit<AlertRule, "id">>): AlertRule | null {
      return this.immediateTransaction(() => {
        const current = this.getAlertRule(id);
        if (!current) return null;
        const deliveryPolicy = normalizeAlertDeliveryPolicy(patch.deliveryPolicy ?? current.deliveryPolicy);
        const rule: AlertRule = {
          ...current,
          ...patch,
          id,
          deliveryPolicy,
        };
        this.db.prepare(`UPDATE alert_rules SET name = ?, sensor_id = ?, metric = ?, operator = ?, threshold = ?,
          duration_seconds = ?, severity = ?, enabled = ?, webhook_enabled = ?, telegram_enabled = ?,
          delivery_policy_json = ? WHERE id = ?`)
          .run(rule.name, rule.sensorId, rule.metric, rule.operator, rule.threshold, rule.durationSeconds, rule.severity,
            rule.enabled ? 1 : 0, rule.webhookEnabled ? 1 : 0, rule.telegramEnabled ? 1 : 0,
            policyJson(deliveryPolicy), id);
        if (Object.keys(patch).some((key) => !["name", "severity", "webhookEnabled", "telegramEnabled"].includes(key))) {
          this.db.prepare("DELETE FROM alert_evaluation_state WHERE rule_id = ?").run(id);
        }
        return rule;
      });
    },
  deleteAlertRule(id: string): boolean {
      return this.immediateTransaction(() => {
        if (!this.getAlertRule(id)) return false;
        const retiredAt = new Date().toISOString();
        const retired = Number(this.db.prepare(`UPDATE alert_rules SET retired_at = ?, enabled = 0
          WHERE id = ? AND retired_at IS NULL`).run(retiredAt, id).changes) > 0;
        if (!retired) return false;
        this.db.prepare("DELETE FROM alert_evaluation_state WHERE rule_id = ?").run(id);
        this.db.prepare(`UPDATE alert_events SET resolved_at = COALESCE(
          resolved_at, CASE WHEN started_at > ? THEN started_at ELSE ? END
        ) WHERE rule_id = ?`).run(retiredAt, retiredAt, id);
        return true;
      });
    },
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
});
