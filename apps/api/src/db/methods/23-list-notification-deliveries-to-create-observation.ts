import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { DEFAULT_ELECTRICITY_PRICE_ENDPOINT, fixedPlanElementOpeningState } from "@climate-twin/contracts";
import type {
  AreaEquipment,
  AreaEquipmentInput,
  AreaEquipmentPatch,
  EquipmentAttachment,
  EquipmentLink,
  EquipmentLinkInput,
  EquipmentLinkPatch,
  ActionPlaybook,
  ActionPlaybookInput,
  ActionRun,
  ActionRunStartInput,
  AlertEvent,
  AlertDeliveryPolicy,
  AlertRule,
  DailyAnalyticsFindingsSnapshot,
  NotificationDeliveryStage,
  NotificationDeliveryStatus,
  NotificationSubjectKind,
  Floor,
  GeoCoordinate,
  House,
  HouseLocation,
  HouseMapPlacement,
  IOSNotificationRegistration,
  IOSNotificationRegistrationInput,
  MaintenanceTask,
  MaintenanceTaskChangedField,
  MaintenanceTaskInput,
  MaintenanceTaskPatch,
  MaintenanceTaskRevision,
  MaintenanceTaskRevisionActor,
  ManualObservation,
  ManualObservationInput,
  ManualObservationPatch,
  MeasurementDefinition,
  MeasurementSample,
  ObservationChangedField,
  ObservationConfidence,
  ObservationRevision,
  ObservationRevisionActor,
  ObservationSource,
  ObservationTimePrecision,
  OpeningStateObservation,
  OpeningStateObservationInput,
  OutdoorConditions,
  OutdoorTemperatureSample,
  Property,
  PropertyElectricityConfig,
  PropertyElectricityConfigInput,
  PropertyElectricityPricePoint,
  PropertyArea,
  PropertyAreaInput,
  PropertyAreaPatch,
  PropertyCreateInput,
  PropertyNote,
  PropertyNoteInput,
  PropertyNotePatch,
  PropertyPatch,
  Reading,
  Sensor,
  SecurityAuditEvent,
  SecurityAuditEventType,
  SecurityAuditOutcome,
  SecurityAuditSubjectType,
  StaticParameter,
  StugubyHouseLink,
  StugubyPropertyLink,
  TenantMemberRole,
  Wall,
  WeatherBackfillState,
  WeatherOutageComponent,
  WeatherProviderName,
} from "@climate-twin/contracts";
import {
  apnsNotificationSnapshot,
  alertNotificationBindings,
  legacyNotificationDestinationRef,
  notificationSnapshot,
  operationalNotificationSnapshot,
  type AlertNotificationBindings,
} from "../../notification-snapshot.js";
import type { APNSDestination } from "../../apns.js";
import {
  DEFAULT_ALERT_DELIVERY_POLICY,
  normalizeAlertDeliveryPolicy,
  notificationScheduleDecision,
  policyFromJson,
  policyJson,
} from "../../notification-policy.js";
import type { EnergyCostAggregateQuery, EnergyCostAggregateRecord, MeasurementCoverageRecord } from "../../timeseries/types.js";
import { CORE_SCHEMA_SQL } from "../migrations/core-schema.js";
import { NotificationChannel, OBSERVATION_CHANGED_FIELDS, boundedCollectionLimit } from "../support/01-json-value-to-area-equipment-row.js";
import { ActionPlaybookRow, ActionRunRow, LocalObservationRevisionActor, ObservationRevisionRow, ObservationRow, StoredObservation } from "../support/02-equipment-attachment-row-to-sensor-data-gap-state.js";
import { ClimateDataValidationError } from "../support/03-sensor-data-gap-row-to-canonical-json-value.js";
import { actionPlaybookFromRow } from "../support/04-canonical-json-value-to-action-playbook-from-row.js";
import { actionRunFromRow, canonicalObservationCreateTime, observationFromRow, observationRevisionFromRow } from "../support/05-action-run-from-row-to-canonical-observation-create-.js";
import { registerDatabaseMethods } from "../core.js";

registerDatabaseMethods({
  listNotificationDeliveries(limit = 200): NotificationDeliveryStatus[] {
      return (this.db.prepare(`SELECT id, subject_kind, subject_id, stage, sequence, channel, destination_id, attempts, max_attempts,
          available_at, created_at, delivered_at, dead_lettered_at, abandoned_at, last_error
        FROM notification_outbox
        WHERE subject_kind <> 'alert' OR EXISTS (
          SELECT 1 FROM alert_events AS event
          JOIN sensors AS sensor ON sensor.id = event.sensor_id
          JOIN houses AS house ON house.id = sensor.house_id
          WHERE event.id = notification_outbox.subject_id AND house.deleted_at IS NULL
        )
        ORDER BY created_at DESC LIMIT ?`).all(boundedCollectionLimit(limit)) as Array<{
          id: string; subject_kind: NotificationSubjectKind; subject_id: string; stage: NotificationDeliveryStage; sequence: number;
          channel: NotificationChannel; destination_id: string; attempts: number; max_attempts: number; available_at: string;
          created_at: string; delivered_at: string | null; dead_lettered_at: string | null;
          abandoned_at: string | null; last_error: string | null;
        }>).map((row) => ({
          id: row.id, subjectKind: row.subject_kind, subjectId: row.subject_id, stage: row.stage, sequence: row.sequence,
          channel: row.channel, destinationId: row.destination_id, attempts: row.attempts, maxAttempts: row.max_attempts,
          availableAt: row.available_at, createdAt: row.created_at, deliveredAt: row.delivered_at,
          deadLetteredAt: row.dead_lettered_at, abandonedAt: row.abandoned_at, lastError: row.last_error,
        }));
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
  listActionPlaybooks(metric?: string, enabledOnly = false): ActionPlaybook[] {
      const clauses: string[] = [];
      const parameters: string[] = [];
      if (metric) { clauses.push("metric = ?"); parameters.push(metric); }
      if (enabledOnly) clauses.push("enabled = 1");
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      return (this.db.prepare(`SELECT * FROM action_playbooks ${where} ORDER BY built_in DESC, name`)
        .all(...parameters) as unknown as ActionPlaybookRow[]).map(actionPlaybookFromRow);
    },
  getActionPlaybook(id: string): ActionPlaybook | null {
      const row = this.db.prepare("SELECT * FROM action_playbooks WHERE id = ?").get(id) as unknown as ActionPlaybookRow | undefined;
      return row ? actionPlaybookFromRow(row) : null;
    },
  saveActionPlaybook(input: ActionPlaybookInput): ActionPlaybook {
      if (!this.getMeasurementDefinition(input.metric)) {
        throw new ClimateDataValidationError(404, "UNKNOWN_METRIC", `Unknown measurement metric: ${input.metric}`);
      }
      const now = new Date().toISOString();
      const id = input.id ?? randomUUID();
      const instructions = [...new Set(input.instructions.map((item) => item.trim()).filter(Boolean))];
      if (!input.name.trim() || !input.description.trim() || instructions.length === 0 || instructions.length > 20) {
        throw new ClimateDataValidationError(400, "INVALID_PLAYBOOK", "A playbook requires a name, description, and 1–20 instructions");
      }
      this.db.prepare(`INSERT INTO action_playbooks(
        id, name, description, instructions_json, metric, goal, minimum_improvement, target_value,
        wait_seconds, verification_window_seconds, enabled, built_in, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`)
        .run(id, input.name.trim(), input.description.trim(), JSON.stringify(instructions), input.metric, input.goal,
          input.minimumImprovement, input.targetValue, input.waitSeconds, input.verificationWindowSeconds,
          input.enabled === false ? 0 : 1, now, now);
      return this.getActionPlaybook(id)!;
    },
  updateActionPlaybook(id: string, patch: Partial<ActionPlaybookInput>): ActionPlaybook | null {
      const current = this.getActionPlaybook(id);
      if (!current) return null;
      const next: ActionPlaybookInput = {
        name: patch.name ?? current.name,
        description: patch.description ?? current.description,
        instructions: patch.instructions ?? current.instructions,
        metric: patch.metric ?? current.metric,
        goal: patch.goal ?? current.goal,
        minimumImprovement: patch.minimumImprovement ?? current.minimumImprovement,
        targetValue: patch.targetValue === undefined ? current.targetValue : patch.targetValue,
        waitSeconds: patch.waitSeconds ?? current.waitSeconds,
        verificationWindowSeconds: patch.verificationWindowSeconds ?? current.verificationWindowSeconds,
        enabled: patch.enabled ?? current.enabled,
      };
      if (!this.getMeasurementDefinition(next.metric)) {
        throw new ClimateDataValidationError(404, "UNKNOWN_METRIC", `Unknown measurement metric: ${next.metric}`);
      }
      const instructions = [...new Set(next.instructions.map((item) => item.trim()).filter(Boolean))];
      if (!next.name.trim() || !next.description.trim() || instructions.length === 0 || instructions.length > 20) {
        throw new ClimateDataValidationError(400, "INVALID_PLAYBOOK", "A playbook requires a name, description, and 1–20 instructions");
      }
      this.db.prepare(`UPDATE action_playbooks SET name = ?, description = ?, instructions_json = ?, metric = ?,
        goal = ?, minimum_improvement = ?, target_value = ?, wait_seconds = ?, verification_window_seconds = ?,
        enabled = ?, updated_at = ? WHERE id = ?`)
        .run(next.name.trim(), next.description.trim(), JSON.stringify(instructions), next.metric, next.goal,
          next.minimumImprovement, next.targetValue, next.waitSeconds, next.verificationWindowSeconds,
          next.enabled === false ? 0 : 1, new Date().toISOString(), id);
      return this.getActionPlaybook(id);
    },
  listActionRuns(options: {
      houseId?: string;
      sensorId?: string;
      alertEventId?: string;
      activeOnly?: boolean;
      limit?: number;
    } = {}): ActionRun[] {
      const clauses: string[] = [];
      const parameters: Array<string | number> = [];
      if (options.houseId) {
        clauses.push("sensor.house_id = ?");
        parameters.push(options.houseId);
      }
      if (options.sensorId) { clauses.push("run.sensor_id = ?"); parameters.push(options.sensorId); }
      if (options.alertEventId) { clauses.push("run.alert_event_id = ?"); parameters.push(options.alertEventId); }
      if (options.activeOnly) clauses.push("run.status IN ('active', 'waiting')");
      const where = ["house.deleted_at IS NULL", ...clauses].join(" AND ");
      const requestedLimit = options.limit ?? 500;
      const limit = Number.isFinite(requestedLimit)
        ? Math.min(500, Math.max(1, Math.trunc(requestedLimit)))
        : 500;
      return (this.db.prepare(`SELECT run.* FROM action_runs AS run
        JOIN sensors AS sensor ON sensor.id = run.sensor_id
        JOIN houses AS house ON house.id = sensor.house_id
        WHERE ${where} ORDER BY run.updated_at DESC, run.id DESC LIMIT ?`)
        .all(...parameters, limit) as unknown as ActionRunRow[]).map(actionRunFromRow);
    },
  getActionRun(id: string): ActionRun | null {
      const row = this.db.prepare(`SELECT run.* FROM action_runs AS run
        JOIN sensors AS sensor ON sensor.id = run.sensor_id
        JOIN houses AS house ON house.id = sensor.house_id
        WHERE run.id = ? AND house.deleted_at IS NULL`).get(id) as unknown as ActionRunRow | undefined;
      return row ? actionRunFromRow(row) : null;
    },
  startActionRun(input: ActionRunStartInput, now = new Date()): ActionRun {
      const playbook = this.getActionPlaybook(input.playbookId);
      if (!playbook || !playbook.enabled) throw new ClimateDataValidationError(404, "PLAYBOOK_NOT_FOUND", "Action playbook not found");
      const sensor = this.getSensor(input.sensorId);
      if (!sensor || !sensor.enabled) throw new ClimateDataValidationError(404, "SENSOR_NOT_FOUND", "Sensor not found or disabled");
      const baseline = this.getLatestMeasurementSample(sensor.id, playbook.metric);
      if (!baseline || baseline.quality === "stale") {
        throw new ClimateDataValidationError(409, "BASELINE_UNAVAILABLE", "A fresh baseline sample is required before starting this action");
      }
      if (input.alertEventId) {
        const event = this.getAlertEvent(input.alertEventId);
        if (!event || event.sensorId !== sensor.id || event.metric !== playbook.metric) {
          throw new ClimateDataValidationError(409, "ALERT_MISMATCH", "The alert does not match the selected sensor and playbook metric");
        }
      }
      if (input.maintenanceTaskId) {
        const task = this.getMaintenanceTask(input.maintenanceTaskId);
        if (!task) {
          throw new ClimateDataValidationError(404, "MAINTENANCE_TASK_NOT_FOUND", "Maintenance task not found");
        }
        const house = this.getHouse(sensor.houseId);
        if (!house || task.propertyId !== house.propertyId || (task.houseId !== null && task.houseId !== house.id)) {
          throw new ClimateDataValidationError(
            409,
            "MAINTENANCE_TASK_SCOPE_MISMATCH",
            "Maintenance task does not belong to the selected sensor's Home or property",
          );
        }
      }
      const duplicate = this.db.prepare(`SELECT 1 FROM action_runs
        WHERE playbook_id = ? AND sensor_id = ? AND status IN ('active', 'waiting') LIMIT 1`)
        .get(playbook.id, sensor.id);
      if (duplicate) throw new ClimateDataValidationError(409, "ACTION_ALREADY_ACTIVE", "This action is already active for the sensor");
      const timestamp = now.toISOString();
      const id = randomUUID();
      this.db.prepare(`INSERT INTO action_runs(
        id, playbook_id, alert_event_id, maintenance_task_id, sensor_id, metric, status, started_at,
        action_completed_at, verify_after, verification_deadline, baseline_value, baseline_timestamp,
        result_value, result_timestamp, improvement, sample_count, operator_note, verification_note,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, NULL, NULL, NULL, ?, ?, NULL, NULL, NULL, 0, ?, NULL, ?, ?)`)
        .run(id, playbook.id, input.alertEventId ?? null, input.maintenanceTaskId ?? null, sensor.id, playbook.metric,
          timestamp, baseline.value, baseline.timestamp, input.operatorNote?.trim() || null, timestamp, timestamp);
      return this.getActionRun(id)!;
    },
  completeActionRun(id: string, now = new Date()): ActionRun | null {
      const run = this.getActionRun(id);
      if (!run) return null;
      if (run.status !== "active") {
        throw new ClimateDataValidationError(409, "INVALID_ACTION_STATE", "Only an active action can be marked complete");
      }
      const playbook = this.getActionPlaybook(run.playbookId)!;
      const verifyAfter = new Date(now.getTime() + playbook.waitSeconds * 1_000);
      const deadline = new Date(verifyAfter.getTime() + playbook.verificationWindowSeconds * 1_000);
      this.db.prepare(`UPDATE action_runs SET status = 'waiting', action_completed_at = ?, verify_after = ?,
        verification_deadline = ?, updated_at = ? WHERE id = ? AND status = 'active'`)
        .run(now.toISOString(), verifyAfter.toISOString(), deadline.toISOString(), now.toISOString(), id);
      return this.getActionRun(id);
    },
  cancelActionRun(id: string, note: string | null = null, now = new Date()): ActionRun | null {
      const run = this.getActionRun(id);
      if (!run) return null;
      if (!['active', 'waiting'].includes(run.status)) return run;
      this.db.prepare(`UPDATE action_runs SET status = 'cancelled', verification_note = ?, updated_at = ? WHERE id = ?`)
        .run(note?.trim() || "Cancelled by operator", now.toISOString(), id);
      return this.getActionRun(id);
    },
  verifyActionRun(id: string, candidateSamples: MeasurementSample[], now = new Date()): ActionRun | null {
      const run = this.getActionRun(id);
      if (!run || run.status !== "waiting" || !run.verifyAfter || !run.verificationDeadline
        || Date.parse(run.verifyAfter) > now.getTime()) return run;
      const playbook = this.getActionPlaybook(run.playbookId);
      if (!playbook) return run;
      const windowEnd = new Date(Math.min(now.getTime(), Date.parse(run.verificationDeadline))).toISOString();
      const evidenceFrom = new Date(Math.max(Date.parse(run.verifyAfter), Date.parse(run.baselineTimestamp) + 1)).toISOString();
      const samples = candidateSamples
        .filter((sample) => sample.sensorId === run.sensorId && sample.metric === run.metric
          && sample.timestamp >= evidenceFrom && sample.timestamp <= windowEnd && sample.quality !== "stale")
        .sort((left, right) => left.timestamp.localeCompare(right.timestamp));
      const latest = samples.at(-1) ?? null;
      let improvement: number | null = null;
      let succeeded = false;
      if (latest) {
        improvement = playbook.goal === "decrease" || playbook.goal === "below"
          ? run.baselineValue - latest.value
          : latest.value - run.baselineValue;
        succeeded = playbook.goal === "decrease"
          ? improvement >= playbook.minimumImprovement
          : playbook.goal === "increase"
            ? improvement >= playbook.minimumImprovement
            : playbook.goal === "below"
              ? latest.value <= (playbook.targetValue ?? -Infinity)
              : latest.value >= (playbook.targetValue ?? Infinity);
      }
      const expired = now.getTime() >= Date.parse(run.verificationDeadline);
      const status = succeeded ? "verified" : expired ? "not-improved" : "waiting";
      const note = succeeded
        ? "The measured result met the playbook verification goal."
        : expired
          ? latest ? "The verification window ended without meeting the goal." : "No fresh verification samples arrived before the deadline."
          : null;
      this.db.prepare(`UPDATE action_runs SET status = ?, result_value = ?, result_timestamp = ?, improvement = ?,
        sample_count = ?, verification_note = ?, updated_at = ? WHERE id = ? AND status = 'waiting'`)
        .run(status, latest?.value ?? null, latest?.timestamp ?? null, improvement, samples.length, note,
          now.toISOString(), run.id);
      return this.getActionRun(run.id);
    },
  verifyDueActionRuns(now = new Date()): ActionRun[] {
      const due = (this.db.prepare(`SELECT run.* FROM action_runs AS run
        JOIN sensors AS sensor ON sensor.id = run.sensor_id
        JOIN houses AS house ON house.id = sensor.house_id
        WHERE run.status = 'waiting' AND run.verify_after <= ? AND house.deleted_at IS NULL
        ORDER BY run.verify_after LIMIT 200`)
        .all(now.toISOString()) as unknown as ActionRunRow[]).map(actionRunFromRow);
      const changed: ActionRun[] = [];
      for (const run of due) {
        if (!run.verifyAfter || !run.verificationDeadline) continue;
        const windowEnd = new Date(Math.min(now.getTime(), Date.parse(run.verificationDeadline))).toISOString();
        const evidenceFrom = new Date(Math.max(Date.parse(run.verifyAfter), Date.parse(run.baselineTimestamp) + 1)).toISOString();
        const samples = this.measurementHistory(run.sensorId, run.metric, evidenceFrom, windowEnd, 10_000)
          .filter((sample) => sample.quality !== "stale");
        const updated = this.verifyActionRun(run.id, samples, now);
        if (!updated) continue;
        if (updated.status !== run.status || updated.sampleCount !== run.sampleCount || updated.resultValue !== run.resultValue) changed.push(updated);
      }
      return changed;
    },
  listObservations(houseId?: string): ManualObservation[] {
      const rows = (houseId
        ? this.db.prepare(`SELECT observation.* FROM observations AS observation
            JOIN houses AS house ON house.id = observation.house_id
            WHERE observation.house_id = ? AND house.deleted_at IS NULL ORDER BY observation.occurred_at DESC`).all(houseId)
        : this.db.prepare(`SELECT observation.* FROM observations AS observation
            JOIN houses AS house ON house.id = observation.house_id
            WHERE house.deleted_at IS NULL ORDER BY observation.occurred_at DESC`).all()) as unknown as ObservationRow[];
      return rows.map(observationFromRow);
    },
  getObservation(id: string): StoredObservation | null {
      const row = this.db.prepare(`SELECT observation.* FROM observations AS observation
        JOIN houses AS house ON house.id = observation.house_id
        WHERE observation.id = ? AND house.deleted_at IS NULL`).get(id) as unknown as ObservationRow | undefined;
      return row ? observationFromRow(row) : null;
    },
  getOrCreateObservation(
      input: ManualObservationInput,
      actor: LocalObservationRevisionActor = "local-rest",
    ): { observation: ManualObservation; created: boolean } {
      return this.immediateTransaction(() => {
        if (input.id) {
          const existing = this.getObservation(input.id);
          if (existing) {
            const temporal = canonicalObservationCreateTime(input, existing.createdAt);
            const matches = existing.houseId === input.houseId
              && existing.floorId === input.floorId
              && existing.sensorId === (input.sensorId ?? null)
              && existing.kind === input.kind
              && existing.severity === input.severity
              && existing.note === input.note
              && existing.x === (input.x ?? null)
              && existing.y === (input.y ?? null)
              && existing.occurredAt === temporal.occurredAt
              && existing.timePrecision === temporal.timePrecision
              && existing.validFrom === temporal.validFrom
              && existing.validTo === temporal.validTo
              && existing.source === (input.source ?? "unknown")
              && existing.sourceDetail === (input.sourceDetail ?? null)
              && existing.confidence === (input.confidence ?? "uncertain");
            if (!matches) {
              throw new ClimateDataValidationError(
                409,
                "OBSERVATION_ID_CONFLICT",
                `Observation ${input.id} already exists with different content`,
              );
            }
            return { observation: existing, created: false };
          }
        }
        return { observation: this.createObservation(input, actor), created: true };
      });
    },
  listObservationRevisions(observationId: string): ObservationRevision[] {
      const rows = this.db.prepare(`SELECT * FROM observation_revisions
        WHERE observation_id = ? ORDER BY revision`).all(observationId) as unknown as ObservationRevisionRow[];
      return rows.map(observationRevisionFromRow);
    },
  createObservation(input: ManualObservationInput, actor: LocalObservationRevisionActor = "local-rest"): ManualObservation {
      return this.immediateTransaction(() => {
        const createdAt = new Date().toISOString();
        const temporal = canonicalObservationCreateTime(input, createdAt);
        const observation: StoredObservation = {
          id: input.id ?? randomUUID(),
          houseId: input.houseId,
          floorId: input.floorId,
          sensorId: input.sensorId ?? null,
          kind: input.kind,
          severity: input.severity,
          note: input.note,
          x: input.x ?? null,
          y: input.y ?? null,
          ...temporal,
          createdAt,
          source: input.source ?? "unknown",
          sourceDetail: input.sourceDetail ?? null,
          confidence: input.confidence ?? "uncertain",
          status: "open",
          resolutionNote: null,
          resolvedAt: null,
          revision: 1,
          updatedAt: createdAt,
        };
        this.validateObservation(observation);
        this.db.prepare(`INSERT INTO observations
          (id, house_id, floor_id, sensor_id, kind, severity, note, x, y, occurred_at, created_at,
           time_precision, valid_from, valid_to, source, source_detail, confidence, revision, updated_at,
           status, resolution_note, resolved_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(observation.id, observation.houseId, observation.floorId, observation.sensorId, observation.kind,
            observation.severity, observation.note, observation.x, observation.y, observation.occurredAt,
            observation.createdAt, observation.timePrecision, observation.validFrom, observation.validTo,
            observation.source, observation.sourceDetail, observation.confidence, observation.revision, observation.updatedAt,
            observation.status, observation.resolutionNote, observation.resolvedAt);
        this.insertObservationRevision(observation, actor, [...OBSERVATION_CHANGED_FIELDS]);
        return observation;
      });
    },
});
