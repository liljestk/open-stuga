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
import type { TapoHistoryExportEnqueueResult, TapoHistoryExportJob, TapoHistoryExportJobFilter, TapoHistoryExportJobInput, TapoHistoryExportJobRow } from "../tapo-history-export-types.js";
import { ClimateDataValidationError } from "../support/03-sensor-data-gap-row-to-canonical-json-value.js";
import { TAPO_HISTORY_EXPORT_TRANSITIONS, normalizedSha256, normalizedTapoHistoryText, normalizedTapoHistoryTimestamp, tapoHistoryExportJobFromRow } from "../support/06-canonical-observation-patch-time-to-outdoor-location.js";
import { registerDatabaseMethods } from "../core.js";

registerDatabaseMethods({
  /** Creates one durable export request, returning the prior job when its idempotency key already exists. */
  enqueueTapoHistoryExportJob(
      input: TapoHistoryExportJobInput,
      createdAt = new Date().toISOString(),
    ): TapoHistoryExportEnqueueResult {
      if (input.provider !== "appium" && input.provider !== "private-cloud") {
        throw new ClimateDataValidationError(422, "INVALID_TAPO_EXPORT_PROVIDER", "Unsupported Tapo history export provider");
      }
      const sensor = this.getSensor(input.sensorId);
      if (!sensor) throw new ClimateDataValidationError(404, "SENSOR_NOT_FOUND", `Sensor ${input.sensorId} does not exist`);
      const expectedDeviceId = normalizedTapoHistoryText(input.expectedDeviceId, "expectedDeviceId", 500);
      if (sensor.tpLinkDeviceId && sensor.tpLinkDeviceId !== expectedDeviceId) {
        throw new ClimateDataValidationError(
          409,
          "TAPO_EXPORT_DEVICE_MISMATCH",
          `Expected device ${expectedDeviceId} does not match sensor ${sensor.id}`,
        );
      }
      const deviceName = normalizedTapoHistoryText(input.deviceName ?? sensor.name, "deviceName", 500);
      const house = this.getHouse(sensor.houseId);
      if (!house) throw new ClimateDataValidationError(409, "TAPO_EXPORT_CONTEXT_MISSING", "Sensor house does not exist");
      const timeZone = normalizedTapoHistoryText(input.timeZone ?? house.timezone, "timeZone", 100);
      try {
        new Intl.DateTimeFormat("en-US", { timeZone }).format(0);
      } catch {
        throw new ClimateDataValidationError(422, "INVALID_TAPO_EXPORT_TIMEZONE", "timeZone must be a valid IANA timezone");
      }
      const metric = normalizedTapoHistoryText(input.metric, "metric", 200);
      if (!this.getMeasurementDefinition(metric)) {
        throw new ClimateDataValidationError(404, "TAPO_EXPORT_METRIC_NOT_FOUND", `Unknown measurement metric: ${metric}`);
      }
      const expectedRecipient = input.expectedRecipient === null
        ? null
        : normalizedTapoHistoryText(input.expectedRecipient, "expectedRecipient", 320).toLowerCase();
      if (expectedRecipient !== null) {
        const separator = expectedRecipient.lastIndexOf("@");
        if (separator < 1 || separator === expectedRecipient.length - 1) {
          throw new ClimateDataValidationError(422, "INVALID_TAPO_EXPORT_RECIPIENT", "expectedRecipient must be an email address");
        }
      } else if (input.provider === "appium") {
        throw new ClimateDataValidationError(422, "INVALID_TAPO_EXPORT_RECIPIENT", "Appium exports require expectedRecipient");
      }
      const rangeStart = normalizedTapoHistoryTimestamp(input.rangeStart, "rangeStart");
      const rangeEnd = normalizedTapoHistoryTimestamp(input.rangeEnd, "rangeEnd");
      if (Date.parse(rangeStart) >= Date.parse(rangeEnd)) {
        throw new ClimateDataValidationError(422, "INVALID_TAPO_EXPORT_RANGE", "rangeStart must be before rangeEnd");
      }
      if (!Number.isInteger(input.intervalMinutes) || input.intervalMinutes < 1 || input.intervalMinutes > 525_600) {
        throw new ClimateDataValidationError(
          422,
          "INVALID_TAPO_EXPORT_INTERVAL",
          "intervalMinutes must be an integer between 1 and 525600",
        );
      }
      const maxAttempts = input.maxAttempts ?? 5;
      if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100) {
        throw new ClimateDataValidationError(422, "INVALID_TAPO_EXPORT_ATTEMPTS", "maxAttempts must be between 1 and 100");
      }
      const normalizedCreatedAt = normalizedTapoHistoryTimestamp(createdAt, "createdAt");
      const availableAt = normalizedTapoHistoryTimestamp(input.availableAt ?? normalizedCreatedAt, "availableAt");
      const naturalKey = [
        input.provider, sensor.id, expectedDeviceId, deviceName, timeZone, metric, rangeStart, rangeEnd,
        String(input.intervalMinutes),
      ].join("\u0000");
      const dedupeKey = input.dedupeKey === undefined
        ? `request:${createHash("sha256").update(naturalKey).digest("hex")}`
        : normalizedTapoHistoryText(input.dedupeKey, "dedupeKey", 500);

      return this.immediateTransaction(() => {
        const existingRow = this.db.prepare("SELECT * FROM tapo_history_export_jobs WHERE dedupe_key = ?")
          .get(dedupeKey) as unknown as TapoHistoryExportJobRow | undefined;
        if (existingRow) {
          const existing = tapoHistoryExportJobFromRow(existingRow);
          if (existing.provider !== input.provider || existing.sensorId !== sensor.id
            || existing.expectedDeviceId !== expectedDeviceId || existing.deviceName !== deviceName
            || existing.timeZone !== timeZone || existing.metric !== metric
            || existing.rangeStart !== rangeStart || existing.rangeEnd !== rangeEnd
            || existing.intervalMinutes !== input.intervalMinutes) {
            throw new ClimateDataValidationError(
              409,
              "TAPO_EXPORT_DEDUPE_COLLISION",
              "The Tapo export idempotency key is already associated with a different request",
            );
          }
          return { job: existing, created: false };
        }
        const id = input.id === undefined ? randomUUID() : normalizedTapoHistoryText(input.id, "id", 200);
        if (this.getTapoHistoryExportJob(id)) {
          throw new ClimateDataValidationError(
            409,
            "TAPO_EXPORT_ID_COLLISION",
            "The Tapo export job id is already associated with a different request",
          );
        }
        this.db.prepare(`INSERT INTO tapo_history_export_jobs (
            id, dedupe_key, provider, sensor_id, expected_device_id, device_name, time_zone, metric, expected_recipient,
            range_start, range_end, interval_minutes, status, attempt_count, max_attempts,
            available_at, lease_owner, lease_token, lease_expires_at, heartbeat_at, submitted_at,
            deployment_fingerprint, acceptance_revision, mailbox_message_id, source_artifact_sha256, source_artifact_bytes,
            parser_version, source_schema_signature, expected_schema_signature,
            staged_sample_count, consumed_sample_count, last_error,
            attention_reason, created_at, updated_at, completed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, NULL, NULL, NULL, NULL, NULL,
            NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, 0, NULL, NULL, ?, ?, NULL)`)
          .run(
            id, dedupeKey, input.provider, sensor.id, expectedDeviceId, deviceName, timeZone, metric, expectedRecipient,
            rangeStart, rangeEnd, input.intervalMinutes, maxAttempts, availableAt,
            normalizedCreatedAt, normalizedCreatedAt,
          );
        if (dedupeKey.startsWith("canary:") && !dedupeKey.startsWith("canary:renewal:")) {
          this.db.prepare(`DELETE FROM tapo_history_canary_approvals
            WHERE canary_job_id IN (
              SELECT prior.id FROM tapo_history_export_jobs AS prior
              WHERE prior.sensor_id = ? AND prior.expected_device_id = ? AND prior.device_name = ?
                AND prior.time_zone = ? AND prior.interval_minutes = ?
            )`).run(sensor.id, expectedDeviceId, deviceName, timeZone, input.intervalMinutes);
          this.db.prepare(`UPDATE tapo_history_export_jobs SET status = 'needs-attention',
              attention_reason = 'Target relocked for manual Tapo canary recertification', updated_at = ?
            WHERE id <> ? AND provider = 'appium' AND dedupe_key NOT LIKE 'canary:%'
              AND sensor_id = ? AND expected_device_id = ? AND device_name = ?
              AND time_zone = ? AND interval_minutes = ?
              AND status IN ('claimed', 'running', 'waiting-email')`)
            .run(normalizedCreatedAt, id, sensor.id, expectedDeviceId, deviceName, timeZone, input.intervalMinutes);
        }
        return { job: this.getTapoHistoryExportJob(id)!, created: true };
      });
    },
  getTapoHistoryExportJob(id: string): TapoHistoryExportJob | null {
      const row = this.db.prepare(`SELECT job.* FROM tapo_history_export_jobs AS job
        JOIN sensors AS sensor ON sensor.id = job.sensor_id
        JOIN houses AS house ON house.id = sensor.house_id
        WHERE job.id = ? AND house.deleted_at IS NULL`)
        .get(id) as unknown as TapoHistoryExportJobRow | undefined;
      return row ? tapoHistoryExportJobFromRow(row) : null;
    },
  getTapoHistoryExportJobByDedupeKey(dedupeKey: string): TapoHistoryExportJob | null {
      const key = normalizedTapoHistoryText(dedupeKey, "dedupeKey", 500);
      const row = this.db.prepare(`SELECT job.* FROM tapo_history_export_jobs AS job
        JOIN sensors AS sensor ON sensor.id = job.sensor_id
        JOIN houses AS house ON house.id = sensor.house_id
        WHERE job.dedupe_key = ? AND house.deleted_at IS NULL`)
        .get(key) as unknown as TapoHistoryExportJobRow | undefined;
      return row ? tapoHistoryExportJobFromRow(row) : null;
    },
  listTapoHistoryExportJobs(filter: TapoHistoryExportJobFilter = {}): TapoHistoryExportJob[] {
      const conditions: string[] = ["house.deleted_at IS NULL"];
      const parameters: string[] = [];
      if (filter.statuses) {
        const statuses = [...new Set(filter.statuses)];
        if (statuses.length === 0) return [];
        if (statuses.some((status) => !(status in TAPO_HISTORY_EXPORT_TRANSITIONS))) {
          throw new ClimateDataValidationError(422, "INVALID_TAPO_EXPORT_STATUS", "Unsupported Tapo export status");
        }
        conditions.push(`job.status IN (${statuses.map(() => "?").join(",")})`);
        parameters.push(...statuses);
      }
      if (filter.provider) {
        if (filter.provider !== "appium" && filter.provider !== "private-cloud") {
          throw new ClimateDataValidationError(422, "INVALID_TAPO_EXPORT_PROVIDER", "Unsupported Tapo history export provider");
        }
        conditions.push("job.provider = ?");
        parameters.push(filter.provider);
      }
      if (filter.sensorId) {
        conditions.push("job.sensor_id = ?");
        parameters.push(filter.sensorId);
      }
      const limit = Math.max(1, Math.min(1_000, Math.trunc(filter.limit ?? 100)));
      const where = `WHERE ${conditions.join(" AND ")}`;
      const direction = filter.oldestFirst === true ? "ASC" : "DESC";
      const rows = this.db.prepare(`SELECT job.* FROM tapo_history_export_jobs AS job
        JOIN sensors AS sensor ON sensor.id = job.sensor_id
        JOIN houses AS house ON house.id = sensor.house_id ${where}
        ORDER BY job.created_at ${direction}, job.id ${direction} LIMIT ?`).all(...parameters, limit) as unknown as TapoHistoryExportJobRow[];
      return rows.map(tapoHistoryExportJobFromRow);
    },
  hasOpenTapoHistoryCanary(): boolean {
      return Boolean(this.db.prepare(`SELECT 1 AS present FROM tapo_history_export_jobs AS job
        JOIN sensors AS sensor ON sensor.id = job.sensor_id
        JOIN houses AS house ON house.id = sensor.house_id
        WHERE job.dedupe_key LIKE 'canary:%' AND job.status NOT IN ('completed', 'cancelled')
          AND house.deleted_at IS NULL LIMIT 1`).get());
    },
  countWaitingTapoHistoryExportEmails(): number {
      const row = this.db.prepare(`SELECT COUNT(*) AS count FROM tapo_history_export_jobs AS job
        JOIN sensors AS sensor ON sensor.id = job.sensor_id
        JOIN houses AS house ON house.id = sensor.house_id
        WHERE job.provider = 'appium' AND job.status = 'waiting-email' AND house.deleted_at IS NULL`).get() as { count: number };
      return Number(row.count);
    },
  hasRecentTapoHistoryCanaryApproval(deploymentFingerprint: string, notBefore: string): boolean {
      const fingerprint = normalizedSha256(deploymentFingerprint, "deploymentFingerprint");
      const cutoff = normalizedTapoHistoryTimestamp(notBefore, "notBefore");
      return Boolean(this.db.prepare(`SELECT 1 AS approved FROM tapo_history_canary_approvals AS approval
        JOIN tapo_history_export_jobs AS job ON job.id = approval.canary_job_id
        WHERE approval.deployment_fingerprint = ? AND approval.approved_at >= ?
          AND job.status = 'completed' AND job.dedupe_key LIKE 'canary:%'
        LIMIT 1`).get(fingerprint, cutoff));
    },
  approveTapoHistoryDeploymentFromCanary(
      canaryJobId: string,
      acceptanceRevision: string,
      approvedAt = new Date().toISOString(),
    ): void {
      const at = normalizedTapoHistoryTimestamp(approvedAt, "approvedAt");
      const revision = normalizedSha256(acceptanceRevision, "acceptanceRevision");
      this.immediateTransaction(() => {
        const row = this.db.prepare("SELECT * FROM tapo_history_export_jobs WHERE id = ?")
          .get(canaryJobId) as unknown as TapoHistoryExportJobRow | undefined;
        if (!row || row.status !== "completed" || !row.dedupe_key.startsWith("canary:")
          || !row.deployment_fingerprint || !row.source_schema_signature) {
          throw new ClimateDataValidationError(
            409,
            "TAPO_CANARY_NOT_APPROVABLE",
            "Only a completed canary tied to an attested deployment can approve automation",
          );
        }
        const fingerprint = normalizedSha256(row.deployment_fingerprint, "deploymentFingerprint");
        this.db.prepare(`DELETE FROM tapo_history_canary_approvals WHERE deployment_fingerprint = ?
          AND canary_job_id IN (
            SELECT id FROM tapo_history_export_jobs
            WHERE sensor_id = ? AND expected_device_id = ? AND device_name = ?
              AND time_zone = ? AND interval_minutes = ?
          )`).run(
          fingerprint,
          row.sensor_id,
          row.expected_device_id,
          row.device_name,
          row.time_zone,
          row.interval_minutes,
        );
        this.db.prepare(`INSERT INTO tapo_history_canary_approvals
            (deployment_fingerprint, canary_job_id, acceptance_revision, schema_signature, approved_at)
            VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(deployment_fingerprint, canary_job_id) DO UPDATE SET
            acceptance_revision = excluded.acceptance_revision,
            schema_signature = excluded.schema_signature,
            approved_at = excluded.approved_at`)
          .run(fingerprint, canaryJobId, revision, row.source_schema_signature, at);
      });
    },
  /** A newly requested canary durably relocks its exact device/timezone/interval scope. */
  revokeTapoHistoryCanaryApprovalsForTarget(canaryJobId: string): number {
      const row = this.db.prepare("SELECT * FROM tapo_history_export_jobs WHERE id = ?")
        .get(canaryJobId) as unknown as TapoHistoryExportJobRow | undefined;
      if (!row || !row.dedupe_key.startsWith("canary:")) {
        throw new ClimateDataValidationError(409, "TAPO_CANARY_NOT_FOUND", "Canary target does not exist");
      }
      const result = this.db.prepare(`DELETE FROM tapo_history_canary_approvals
        WHERE canary_job_id IN (
          SELECT id FROM tapo_history_export_jobs
          WHERE sensor_id = ? AND expected_device_id = ? AND device_name = ?
            AND time_zone = ? AND interval_minutes = ?
        )`).run(row.sensor_id, row.expected_device_id, row.device_name, row.time_zone, row.interval_minutes);
      return Number(result.changes);
    },
  /** Relock an ordinary job's exact target when a vendor CSV drifts from its approved canary. */
  revokeTapoHistoryCanaryApprovalsForJobTarget(jobId: string): number {
      const row = this.db.prepare("SELECT * FROM tapo_history_export_jobs WHERE id = ?")
        .get(jobId) as unknown as TapoHistoryExportJobRow | undefined;
      if (!row) {
        throw new ClimateDataValidationError(404, "TAPO_EXPORT_NOT_FOUND", "Tapo export target does not exist");
      }
      const result = this.db.prepare(`DELETE FROM tapo_history_canary_approvals
        WHERE canary_job_id IN (
          SELECT id FROM tapo_history_export_jobs
          WHERE sensor_id = ? AND expected_device_id = ? AND device_name = ?
            AND time_zone = ? AND interval_minutes = ?
        )`).run(row.sensor_id, row.expected_device_id, row.device_name, row.time_zone, row.interval_minutes);
      return Number(result.changes);
    },
  tapoHistoryCanaryRenewalTarget(
      deploymentFingerprint: string,
      acceptanceRevision: string,
      approvedNotAfter: string,
    ): TapoHistoryExportJob | null {
      const fingerprint = normalizedSha256(deploymentFingerprint, "deploymentFingerprint");
      const revision = normalizedSha256(acceptanceRevision, "acceptanceRevision");
      const cutoff = normalizedTapoHistoryTimestamp(approvedNotAfter, "approvedNotAfter");
      const row = this.db.prepare(`SELECT candidate.* FROM tapo_history_export_jobs AS candidate
        WHERE candidate.provider = 'appium' AND candidate.dedupe_key NOT LIKE 'canary:%'
          AND candidate.status IN ('queued', 'failed') AND candidate.attempt_count < candidate.max_attempts
          AND EXISTS (
            SELECT 1 FROM tapo_history_canary_approvals AS approval
            JOIN tapo_history_export_jobs AS canary ON canary.id = approval.canary_job_id
            WHERE approval.deployment_fingerprint = ? AND approval.acceptance_revision = ?
              AND approval.approved_at <= ? AND canary.status = 'completed'
              AND canary.sensor_id = candidate.sensor_id
              AND canary.expected_device_id = candidate.expected_device_id
              AND canary.device_name = candidate.device_name
              AND canary.time_zone = candidate.time_zone
              AND canary.interval_minutes = candidate.interval_minutes
          )
          AND NOT EXISTS (
            SELECT 1 FROM tapo_history_export_jobs AS pending_canary
            WHERE pending_canary.dedupe_key LIKE 'canary:%'
              AND pending_canary.status NOT IN ('completed', 'cancelled')
              AND pending_canary.sensor_id = candidate.sensor_id
              AND pending_canary.expected_device_id = candidate.expected_device_id
              AND pending_canary.device_name = candidate.device_name
              AND pending_canary.time_zone = candidate.time_zone
              AND pending_canary.interval_minutes = candidate.interval_minutes
          )
        ORDER BY candidate.created_at, candidate.id LIMIT 1`)
        .get(fingerprint, revision, cutoff) as unknown as TapoHistoryExportJobRow | undefined;
      return row ? tapoHistoryExportJobFromRow(row) : null;
    },
});
