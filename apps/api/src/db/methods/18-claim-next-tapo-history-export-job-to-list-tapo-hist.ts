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
import { ClimateDataValidationError, TapoHistoryClaimOptions, TapoHistoryExportClaim, TapoHistoryExportJob, TapoHistoryExportJobRow, TapoHistoryExportProvider, TapoHistoryExportTransition } from "../support/03-sensor-data-gap-row-to-canonical-json-value.js";
import { TAPO_HISTORY_EXPORT_TRANSITIONS, normalizedSha256, normalizedTapoHistoryText, normalizedTapoHistoryTimestamp, tapoHistoryExportJobFromRow } from "../support/06-canonical-observation-patch-time-to-outdoor-location.js";
import { registerDatabaseMethods } from "../core.js";

registerDatabaseMethods({
  /** Atomically leases the oldest runnable job. Expired workers can be reclaimed, but never after maxAttempts. */
  claimNextTapoHistoryExportJob(
      leaseOwner: string,
      claimedAt: string,
      leaseUntil: string,
      providers: readonly TapoHistoryExportProvider[] = ["appium", "private-cloud"],
      reclaimNotAfter = claimedAt,
      options: TapoHistoryClaimOptions = {},
    ): TapoHistoryExportClaim | null {
      const owner = normalizedTapoHistoryText(leaseOwner, "leaseOwner", 500);
      const now = normalizedTapoHistoryTimestamp(claimedAt, "claimedAt");
      const expiresAt = normalizedTapoHistoryTimestamp(leaseUntil, "leaseUntil");
      const reclaimCutoff = normalizedTapoHistoryTimestamp(reclaimNotAfter, "reclaimNotAfter");
      const deploymentFingerprint = options.deploymentFingerprint === undefined
        ? null
        : normalizedSha256(options.deploymentFingerprint, "deploymentFingerprint");
      const acceptanceRevision = options.acceptanceRevision === undefined
        ? null
        : normalizedSha256(options.acceptanceRevision, "acceptanceRevision");
      const approvalNotBefore = options.requireApprovedTarget === true
        ? normalizedTapoHistoryTimestamp(options.approvalNotBefore ?? "", "approvalNotBefore")
        : null;
      const requiredAcceptanceRevision = options.requireApprovedTarget === true
        ? normalizedSha256(options.requiredAcceptanceRevision ?? "", "requiredAcceptanceRevision")
        : null;
      if (options.requireApprovedTarget === true && !deploymentFingerprint) {
        throw new ClimateDataValidationError(
          422,
          "INVALID_TAPO_EXPORT_FIELD",
          "deploymentFingerprint is required when target approval is enforced",
        );
      }
      if (Date.parse(expiresAt) <= Date.parse(now)) {
        throw new ClimateDataValidationError(422, "INVALID_TAPO_EXPORT_LEASE", "leaseUntil must be after claimedAt");
      }
      const allowedProviders = [...new Set(providers)];
      if (allowedProviders.length === 0) return null;
      if (allowedProviders.some((provider) => provider !== "appium" && provider !== "private-cloud")) {
        throw new ClimateDataValidationError(422, "INVALID_TAPO_EXPORT_PROVIDER", "Unsupported Tapo history export provider");
      }
      const placeholders = allowedProviders.map(() => "?").join(",");
      const maxOutstandingAppium = options.maxOutstandingAppium ?? null;
      if (maxOutstandingAppium !== null
        && (!Number.isSafeInteger(maxOutstandingAppium) || maxOutstandingAppium < 1 || maxOutstandingAppium > 10)) {
        throw new ClimateDataValidationError(
          422,
          "INVALID_TAPO_EXPORT_FIELD",
          "maxOutstandingAppium must be an integer from 1 through 10",
        );
      }
      const canaryPredicate = options.canaryOnly === true ? "AND dedupe_key LIKE 'canary:%'" : "";
      const canaryOrder = options.preferCanary === true ? "CASE WHEN dedupe_key LIKE 'canary:%' THEN 0 ELSE 1 END," : "";
      const approvalPredicate = options.requireApprovedTarget === true ? `AND dedupe_key NOT LIKE 'canary:%'
        AND EXISTS (
          SELECT 1 FROM tapo_history_canary_approvals AS approval
          JOIN tapo_history_export_jobs AS canary ON canary.id = approval.canary_job_id
          WHERE approval.deployment_fingerprint = ? AND approval.approved_at >= ?
            AND approval.acceptance_revision = ?
            AND length(approval.schema_signature) = 64
            AND canary.status = 'completed' AND canary.dedupe_key LIKE 'canary:%'
            AND canary.sensor_id = tapo_history_export_jobs.sensor_id
            AND canary.expected_device_id = tapo_history_export_jobs.expected_device_id
            AND canary.device_name = tapo_history_export_jobs.device_name
            AND canary.time_zone = tapo_history_export_jobs.time_zone
            AND canary.interval_minutes = tapo_history_export_jobs.interval_minutes
        )` : "";
      return this.immediateTransaction(() => {
        if (maxOutstandingAppium !== null && allowedProviders.includes("appium")) {
          const outstanding = this.db.prepare(`SELECT COUNT(*) AS count FROM tapo_history_export_jobs
            WHERE provider = 'appium' AND (
              status = 'waiting-email'
              OR (status IN ('claimed', 'running') AND lease_expires_at IS NOT NULL AND lease_expires_at > ?)
            )`).get(reclaimCutoff) as { count: number };
          if (Number(outstanding.count) >= maxOutstandingAppium) return null;
        }
        const row = this.db.prepare(`SELECT * FROM tapo_history_export_jobs
          WHERE provider IN (${placeholders}) ${canaryPredicate} AND attempt_count < max_attempts AND (
            (status IN ('queued', 'failed') AND available_at <= ?)
            OR (status IN ('claimed', 'running') AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
          ) ${approvalPredicate} AND NOT EXISTS (
            SELECT 1 FROM tapo_history_export_jobs active
            WHERE active.lease_owner = ? AND active.lease_expires_at IS NOT NULL
              AND active.lease_expires_at > ?
          )
          ORDER BY ${canaryOrder} CASE WHEN status IN ('claimed', 'running') THEN 0 ELSE 1 END,
            COALESCE(lease_expires_at, available_at), created_at, id LIMIT 1`)
          .get(
            ...allowedProviders,
            now,
            reclaimCutoff,
            ...(options.requireApprovedTarget === true
              ? [deploymentFingerprint!, approvalNotBefore!, requiredAcceptanceRevision!]
              : []),
            owner,
            reclaimCutoff,
          ) as unknown as TapoHistoryExportJobRow | undefined;
        if (!row) return null;
        const approvedSchema = options.requireApprovedTarget === true
          ? this.db.prepare(`SELECT approval.schema_signature FROM tapo_history_canary_approvals AS approval
              JOIN tapo_history_export_jobs AS canary ON canary.id = approval.canary_job_id
              WHERE approval.deployment_fingerprint = ? AND approval.approved_at >= ?
                AND approval.acceptance_revision = ? AND canary.status = 'completed'
                AND canary.dedupe_key LIKE 'canary:%'
                AND canary.sensor_id = ? AND canary.expected_device_id = ?
                AND canary.device_name = ? AND canary.time_zone = ? AND canary.interval_minutes = ?
              ORDER BY approval.approved_at DESC, approval.canary_job_id DESC LIMIT 1`)
            .get(
              deploymentFingerprint!, approvalNotBefore!, requiredAcceptanceRevision!,
              row.sensor_id, row.expected_device_id, row.device_name, row.time_zone, row.interval_minutes,
            ) as { schema_signature: string } | undefined
          : undefined;
        if (options.requireApprovedTarget === true && !approvedSchema) return null;
        const leaseToken = randomUUID();
        const result = this.db.prepare(`UPDATE tapo_history_export_jobs SET
            status = 'claimed', attempt_count = attempt_count + 1, lease_owner = ?, lease_token = ?,
            lease_expires_at = ?, heartbeat_at = ?, deployment_fingerprint = ?, acceptance_revision = ?,
            expected_schema_signature = ?, last_error = NULL, attention_reason = NULL, updated_at = ?
          WHERE id = ? AND attempt_count < max_attempts AND (
            (status IN ('queued', 'failed') AND available_at <= ?)
            OR (status IN ('claimed', 'running') AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
          )`).run(
            owner, leaseToken, expiresAt, now, deploymentFingerprint, acceptanceRevision,
            approvedSchema?.schema_signature ?? null,
            now, row.id, now, reclaimCutoff,
          );
        if (Number(result.changes) === 0) return null;
        if (row.dedupe_key.startsWith("canary:") && !row.dedupe_key.startsWith("canary:renewal:")) {
          this.revokeTapoHistoryCanaryApprovalsForTarget(row.id);
        }
        return { job: this.getTapoHistoryExportJob(row.id)!, leaseToken };
      });
    },
  /** Final-attempt worker crashes must not leave an active-looking lease forever. */
  expireExhaustedTapoHistoryExportLeases(
      now = new Date().toISOString(),
      reclaimNotAfter = now,
    ): number {
      const at = normalizedTapoHistoryTimestamp(now, "now");
      const reclaimCutoff = normalizedTapoHistoryTimestamp(reclaimNotAfter, "reclaimNotAfter");
      const result = this.db.prepare(`UPDATE tapo_history_export_jobs SET
          status = 'failed', lease_owner = NULL, lease_token = NULL, lease_expires_at = NULL,
          last_error = 'The final mobile-worker attempt ended without a terminal status', updated_at = ?
        WHERE status IN ('claimed', 'running') AND lease_expires_at IS NOT NULL
          AND lease_expires_at <= ? AND attempt_count >= max_attempts`).run(at, reclaimCutoff);
      return Number(result.changes);
    },
  heartbeatTapoHistoryExportJob(
      id: string,
      leaseToken: string,
      heartbeatAt: string,
      leaseUntil: string,
    ): TapoHistoryExportJob | null {
      const token = normalizedTapoHistoryText(leaseToken, "leaseToken", 500);
      const heartbeat = normalizedTapoHistoryTimestamp(heartbeatAt, "heartbeatAt");
      const expiresAt = normalizedTapoHistoryTimestamp(leaseUntil, "leaseUntil");
      if (Date.parse(expiresAt) <= Date.parse(heartbeat)) {
        throw new ClimateDataValidationError(422, "INVALID_TAPO_EXPORT_LEASE", "leaseUntil must be after heartbeatAt");
      }
      const result = this.db.prepare(`UPDATE tapo_history_export_jobs SET
          heartbeat_at = ?, lease_expires_at = ?, updated_at = ?
        WHERE id = ? AND lease_token = ? AND status IN ('claimed', 'running')
          AND lease_expires_at IS NOT NULL AND lease_expires_at > ?`)
        .run(heartbeat, expiresAt, heartbeat, id, token, heartbeat);
      return Number(result.changes) > 0 ? this.getTapoHistoryExportJob(id) : null;
    },
  /** Rotates the mailbox capability for each newly leased mobile attempt. */
  rotateTapoHistoryExportRecipient(
      id: string,
      leaseToken: string,
      expectedRecipient: string,
      rotatedAt = new Date().toISOString(),
    ): TapoHistoryExportJob | null {
      const token = normalizedTapoHistoryText(leaseToken, "leaseToken", 500);
      const recipient = normalizedTapoHistoryText(expectedRecipient, "expectedRecipient", 320).toLowerCase();
      const separator = recipient.lastIndexOf("@");
      if (separator < 1 || separator === recipient.length - 1) {
        throw new ClimateDataValidationError(422, "INVALID_TAPO_EXPORT_RECIPIENT", "expectedRecipient must be an email address");
      }
      const at = normalizedTapoHistoryTimestamp(rotatedAt, "rotatedAt");
      const result = this.db.prepare(`UPDATE tapo_history_export_jobs SET expected_recipient = ?,
          submitted_at = NULL, mailbox_message_id = NULL, updated_at = ?
        WHERE id = ? AND lease_token = ? AND status = 'claimed'
          AND lease_expires_at IS NOT NULL AND lease_expires_at > ?`)
        .run(recipient, at, id, token, at);
      return Number(result.changes) > 0 ? this.getTapoHistoryExportJob(id) : null;
    },
  transitionTapoHistoryExportJob(id: string, transition: TapoHistoryExportTransition): TapoHistoryExportJob | null {
      const at = normalizedTapoHistoryTimestamp(transition.at ?? new Date().toISOString(), "at");
      const hasExpectedRecipient = Object.prototype.hasOwnProperty.call(transition, "expectedRecipient");
      const expectedRecipient = transition.expectedRecipient === null || transition.expectedRecipient === undefined
        ? null
        : normalizedTapoHistoryText(transition.expectedRecipient, "expectedRecipient", 320).toLowerCase();
      const hasExpectedSubmittedAt = Object.prototype.hasOwnProperty.call(transition, "expectedSubmittedAt");
      const expectedSubmittedAt = transition.expectedSubmittedAt === null || transition.expectedSubmittedAt === undefined
        ? null
        : normalizedTapoHistoryTimestamp(transition.expectedSubmittedAt, "expectedSubmittedAt");
      if (!(transition.status in TAPO_HISTORY_EXPORT_TRANSITIONS)) {
        throw new ClimateDataValidationError(422, "INVALID_TAPO_EXPORT_STATUS", "Unsupported Tapo export status");
      }
      return this.immediateTransaction(() => {
        const currentRow = this.db.prepare("SELECT * FROM tapo_history_export_jobs WHERE id = ?")
          .get(id) as unknown as TapoHistoryExportJobRow | undefined;
        if (!currentRow) return null;
        const current = tapoHistoryExportJobFromRow(currentRow);
        if ((hasExpectedRecipient && current.expectedRecipient !== expectedRecipient)
          || (hasExpectedSubmittedAt && current.submittedAt !== expectedSubmittedAt)) {
          throw new ClimateDataValidationError(
            409,
            "TAPO_EXPORT_GENERATION_CHANGED",
            "The Tapo export mailbox attempt changed while an asynchronous operation was in flight",
          );
        }
        const workerOwned = current.status === "claimed" || current.status === "running";
        if (workerOwned && (!transition.leaseToken || transition.leaseToken !== currentRow.lease_token
          || !current.leaseExpiresAt || Date.parse(current.leaseExpiresAt) <= Date.parse(at))) {
          throw new ClimateDataValidationError(409, "TAPO_EXPORT_LEASE_LOST", "The Tapo export worker lease is missing or expired");
        }
        if (current.status === transition.status) return current;
        if (!TAPO_HISTORY_EXPORT_TRANSITIONS[current.status].includes(transition.status)) {
          throw new ClimateDataValidationError(
            409,
            "INVALID_TAPO_EXPORT_TRANSITION",
            `Cannot transition a Tapo export from ${current.status} to ${transition.status}`,
          );
        }
        const keepLease = transition.status === "running";
        const availableAt = transition.status === "queued" || transition.status === "failed"
          ? normalizedTapoHistoryTimestamp(transition.availableAt ?? at, "availableAt")
          : current.availableAt;
        const error = transition.error === undefined || transition.error === null
          ? null
          : normalizedTapoHistoryText(transition.error, "error", 2_000);
        const attentionReason = transition.attentionReason === undefined || transition.attentionReason === null
          ? null
          : normalizedTapoHistoryText(transition.attentionReason, "attentionReason", 2_000);
        this.db.prepare(`UPDATE tapo_history_export_jobs SET status = ?, available_at = ?,
            lease_owner = ?, lease_token = ?, lease_expires_at = ?, heartbeat_at = ?,
            submitted_at = ?, last_error = ?, attention_reason = ?, updated_at = ?, completed_at = ?
          WHERE id = ?`)
          .run(
            transition.status,
            availableAt,
            keepLease ? currentRow.lease_owner : null,
            keepLease ? currentRow.lease_token : null,
            keepLease ? currentRow.lease_expires_at : null,
            keepLease ? at : currentRow.heartbeat_at,
            transition.status === "waiting-email" ? at : currentRow.submitted_at,
            transition.status === "failed" ? error : null,
            transition.status === "needs-attention" ? attentionReason : null,
            at,
            transition.status === "completed" ? at : null,
            id,
          );
        return this.getTapoHistoryExportJob(id)!;
      });
    },
  /** Cancellation fences worker mutations while retaining the target cool-down tombstone. */
  cancelTapoHistoryExportJob(id: string, cancelledAt = new Date().toISOString()): TapoHistoryExportJob | null {
      const at = normalizedTapoHistoryTimestamp(cancelledAt, "cancelledAt");
      const result = this.db.prepare(`UPDATE tapo_history_export_jobs SET status = 'cancelled',
          attention_reason = NULL,
          updated_at = ?, completed_at = NULL
        WHERE id = ? AND status NOT IN ('completed', 'cancelled')`).run(at, id);
      if (Number(result.changes) > 0) return this.getTapoHistoryExportJob(id);
      return this.getTapoHistoryExportJob(id);
    },
  requeueTapoHistoryExportJob(
      id: string,
      availableAt = new Date().toISOString(),
      resetAttempts = false,
    ): TapoHistoryExportJob | null {
      const at = normalizedTapoHistoryTimestamp(availableAt, "availableAt");
      const result = this.db.prepare(`UPDATE tapo_history_export_jobs SET status = 'queued',
          attempt_count = CASE WHEN ? = 1 OR status = 'cancelled' THEN 0 ELSE attempt_count END,
          available_at = ?,
          lease_owner = CASE WHEN status = 'cancelled' THEN lease_owner ELSE NULL END,
          lease_token = CASE WHEN status = 'cancelled' THEN lease_token ELSE NULL END,
          lease_expires_at = CASE WHEN status = 'cancelled' THEN lease_expires_at ELSE NULL END,
          submitted_at = NULL, mailbox_message_id = NULL,
          last_error = NULL, attention_reason = NULL, updated_at = ?, completed_at = NULL
        WHERE id = ? AND status IN ('failed', 'needs-attention', 'cancelled')`).run(resetAttempts ? 1 : 0, at, at, id);
      return Number(result.changes) > 0 ? this.getTapoHistoryExportJob(id) : null;
    },
  attachTapoHistoryExportMailboxMessage(
      id: string,
      mailboxMessageId: string,
      receivedAt = new Date().toISOString(),
    ): TapoHistoryExportJob | null {
      const messageId = normalizedTapoHistoryText(mailboxMessageId, "mailboxMessageId", 1_000);
      const at = normalizedTapoHistoryTimestamp(receivedAt, "receivedAt");
      return this.immediateTransaction(() => {
        const current = this.getTapoHistoryExportJob(id);
        if (!current) return null;
        const owner = this.db.prepare("SELECT id FROM tapo_history_export_jobs WHERE mailbox_message_id = ?")
          .get(messageId) as { id: string } | undefined;
        if (owner && owner.id !== id) {
          throw new ClimateDataValidationError(
            409,
            "TAPO_EXPORT_MAILBOX_MESSAGE_CLAIMED",
            "The mailbox message has already been assigned to another Tapo export job",
          );
        }
        if (current.mailboxMessageId === messageId) return current;
        if (current.mailboxMessageId !== null) {
          throw new ClimateDataValidationError(
            409,
            "TAPO_EXPORT_MAILBOX_MESSAGE_MISMATCH",
            "The Tapo export job is already associated with a different mailbox message",
          );
        }
        if (current.status === "cancelled") {
          throw new ClimateDataValidationError(409, "TAPO_EXPORT_CANCELLED", "A cancelled Tapo export cannot accept mail");
        }
        this.db.prepare("UPDATE tapo_history_export_jobs SET mailbox_message_id = ?, updated_at = ? WHERE id = ?")
          .run(messageId, at, id);
        return this.getTapoHistoryExportJob(id)!;
      });
    },
  listTapoHistoryExportMailboxMessageIds(jobId?: string): string[] {
      const rows = (jobId
        ? this.db.prepare(`SELECT mailbox_message_id FROM tapo_history_export_jobs
            WHERE id = ? AND mailbox_message_id IS NOT NULL`).all(jobId)
        : this.db.prepare(`SELECT mailbox_message_id FROM tapo_history_export_jobs
            WHERE mailbox_message_id IS NOT NULL ORDER BY updated_at, id`).all()) as Array<{ mailbox_message_id: string }>;
      return rows.map((row) => row.mailbox_message_id);
    },
});
